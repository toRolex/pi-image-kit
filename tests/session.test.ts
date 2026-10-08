import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, createToolSearchExtension } from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream, InMemoryCredentialStore, type AssistantMessage, type ToolCall, type JsonObject } from '@earendil-works/pi-ai';

// Public session seam. The scripted provider replaces only the external LLM;
// package discovery, schemas, tool execution, HTTP, and session history are real.
const root = resolve(import.meta.dirname, '..');
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jxioAAAAASUVORK5CYII=';
// 原有输出样本仅检验结果契约；输入样本必须能完整解码。
const referencePng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const secret = 'dummy-secret-do-not-leak';
interface Scenario {
  args?: JsonObject;
  status?: number;
  body?: unknown;
  delay?: boolean;
  config?: Record<string, unknown>;
  searches?: number;
  legacySearch?: string;
  saveFailure?: boolean;
  bodyDelay?: boolean;
  rawConfig?: string;
  references?: { name: string; bytes: Buffer }[];
  referenceArgs?: JsonObject;
}
async function run(scenario: Scenario = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'image-kit-test-'));
  const requests: { path: string; authorization?: string; body: unknown }[] = [];
  const server = createServer(async (req, res) => {
    let data = '';
    for await (const chunk of req) data += chunk;
    requests.push({ path: req.url!, authorization: req.headers.authorization, body: JSON.parse(data) });
    if (scenario.delay) return;
    res.writeHead(scenario.status ?? 200, { 'Content-Type': 'application/json' });
    if (scenario.bodyDelay) { res.flushHeaders(); return; }
    res.end(JSON.stringify(scenario.body === undefined ? { data: [{ b64_json: png }, { b64_json: 'ignored' }], background: 'transparent' } : scenario.body));
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  server.unref();
  const address = server.address() as { port: number };
  await mkdir(join(dir, '.pi'));
  if (scenario.saveFailure) await writeFile(join(dir, 'blocked'), 'not a directory');
  await writeFile(join(dir, '.pi', 'image-kit.json'), scenario.rawConfig ?? JSON.stringify({ endpoint: `http://127.0.0.1:${address.port}/v1`, apiKey: secret, ...(scenario.saveFailure ? { saveDirectory: join(dir, 'blocked') } : {}), ...scenario.config }));
  await writeFile(join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
  const legacy = scenario.legacySearch;
  const legacyConfig = join(dir, 'tool-search.toml');
  const legacyAdapter = join(dir, 'legacy-search.ts');
  if (legacy) {
    await writeFile(legacyConfig, '[tools]\ndeferred = ["image_generate"]\n');
    // Use the real pi extension loader, including its host module mapping.
    // Native Node import would resolve the deployed package's stale peer tree.
    await writeFile(legacyAdapter, `import { createToolSearchExtension } from ${JSON.stringify(legacy)}; export default (pi) => createToolSearchExtension(pi, ${JSON.stringify(legacyConfig)});`);
  }
  const settings = SettingsManager.inMemory({ packages: [root, root], defaultTools: legacy ? ['tool_search', 'image_generate'] : scenario.searches ? ['tool_search'] : ['image_generate'], retry: { enabled: false }, compaction: { enabled: false } });
  const loader = new DefaultResourceLoader({ cwd: dir, agentDir: join(dir, 'agent'), settingsManager: settings, noContextFiles: true, noPromptTemplates: true, noThemes: true, disabledBuiltinExtensions: ['mcp'], additionalExtensionPaths: legacy ? [legacyAdapter] : [], extensionFactories: !legacy && scenario.searches ? [createToolSearchExtension()] : [] });
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, modelsStorePath: join(dir, 'models.json'), refreshOnCreate: false, allowModelNetwork: false });
  const paths: string[] = [];
  for (const reference of scenario.references ?? []) {
    const path = join(dir, reference.name);
    await writeFile(path, reference.bytes);
    paths.push(path);
  }
  const calls: ToolCall[] = [
    ...Array.from({ length: scenario.searches ?? 0 }, (_, i) => ({ type: 'toolCall' as const, id: `search-${i}`, name: 'tool_search', arguments: { query: legacy && i > 0 ? 'select:image_generate' : 'image generation transparent', limit: 1 } })),
    { type: 'toolCall', id: 'generate', name: 'image_generate', arguments: scenario.references ? { prompt: '保留蓝点，移除背景', referenced_image_paths: paths, ...scenario.referenceArgs } : scenario.args ?? { prompt: 'A tiny transparent blue dot', transparent_background: true } },
  ];
  let step = 0;
  const modelInputs: unknown[] = [];
  runtime.registerProvider('image-kit-fake', {
    api: 'image-kit-fake', apiKey: 'dummy-llm', baseUrl: 'http://127.0.0.1/never-called',
    models: [{ id: 'scripted', name: 'Scripted test LLM', reasoning: false, input: ['text', 'image'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1024 }],
    streamSimple(model, context) {
      modelInputs.push(context);
      const call = calls[step++];
      const message: AssistantMessage = { role: 'assistant', api: model.api, provider: model.provider, model: model.id, content: call ? [call] : [{ type: 'text', text: 'Done' }], stopReason: call ? 'toolUse' : 'stop', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: Date.now() };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: 'done', reason: message.stopReason as 'toolUse' | 'stop', message });
      return stream;
    },
  });
  const oldCwd = process.cwd();
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.chdir(dir);
  process.env.PI_CODING_AGENT_DIR = join(dir, 'agent');
  await loader.reload();
  const { session, extensionsResult } = await createAgentSession({ cwd: dir, agentDir: join(dir, 'agent'), settingsManager: settings, sessionManager: SessionManager.inMemory(dir), modelRuntime: runtime, model: runtime.getModel('image-kit-fake', 'scripted')!, resourceLoader: loader });
  try {
    await session.bindExtensions({});
    const initiallyActive = session.getActiveToolNames();
    await session.prompt('请生成透明蓝点；按要求的模型，不要使用 CLI。');
    const messages = session.messages;
    const result = messages.find((m) => m.role === 'toolResult' && m.toolCallId === 'generate');
    return { requests, messages, result, initiallyActive, finallyActive: session.getActiveToolNames(), tools: session.getAllTools(), skills: loader.getSkills(), errors: extensionsResult.errors, modelInputs, dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  } finally {
    session.dispose();
    process.chdir(oldCwd);
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
}

test('standard package discovers one image tool and generates a displayed first image with saved original', async () => {
  const value = await run();
  try {
    assert.deepEqual(value.errors, []);
    assert.equal(value.tools.filter((tool) => tool.name === 'image_generate').length, 1);
    assert.equal(value.skills.skills.filter((skill) => skill.name === 'imagegen').length, 1);
    assert.equal(value.requests.length, 1);
    assert.deepEqual(value.requests[0], { path: '/v1/images/generations', authorization: `Bearer ${secret}`, body: { prompt: 'A tiny transparent blue dot', model: 'gpt-image-2.5', background: 'transparent', quality: 'auto', size: 'auto' } });
    assert.ok(value.result && value.result.role === 'toolResult');
    assert.equal(value.result.isError, false);
    assert.deepEqual(value.result.content.find((c) => c.type === 'image'), { type: 'image', data: png, mimeType: 'image/png' });
    const details = value.result.details as { savedPath: string; model: string; transparency: { requested: boolean; verified: boolean }; original: { source: string; version: number; path: string; sha256: string } };
    assert.equal(details.model, 'gpt-image-2.5');
    assert.equal(details.transparency.requested, true);
    assert.equal(details.transparency.verified, false);
    assert.equal(details.original.source, 'pi-image-kit');
    assert.equal(details.original.version, 1);
    assert.equal(details.original.path, details.savedPath);
    assert.deepEqual(await readFile(details.savedPath), Buffer.from(png, 'base64'));
    assert.ok(!JSON.stringify({ messages: value.messages, modelInputs: value.modelInputs }).includes(secret));
  } finally { await value.cleanup(); }
});

test('一张绝对路径原图通过唯一会话工具完成 JSON 编辑并显示保存结果', async () => {
  const value = await run({ references: [{ name: 'reference.not-png', bytes: Buffer.from(referencePng, 'base64') }], referenceArgs: { transparent_background: true, model: 'gpt-image-2', model_source: 'user' } });
  try {
    assert.deepEqual(value.errors, []);
    assert.equal(value.tools.filter((tool) => tool.name === 'image_generate').length, 1);
    assert.deepEqual(value.requests, [{ path: '/v1/images/edits', authorization: `Bearer ${secret}`, body: { prompt: '保留蓝点，移除背景', model: 'gpt-image-2', background: 'transparent', quality: 'auto', size: 'auto', images: [{ image_url: `data:image/png;base64,${referencePng}` }] } }]);
    assert.ok(value.result?.role === 'toolResult' && !value.result.isError);
    assert.deepEqual(value.result.content.find((c) => c.type === 'image'), { type: 'image', data: png, mimeType: 'image/png' });
    const details = value.result.details as { savedPath: string; transparency: { requested: boolean; verified: boolean } };
    assert.deepEqual(await readFile(details.savedPath), Buffer.from(png, 'base64'));
    assert.equal(details.transparency.requested, true);
    assert.equal(details.transparency.verified, false);
  } finally { await value.cleanup(); }
});

// 3001×1 的 BMP 超过 pi 默认预览宽度；编辑转换格式也不能缩小原图。
function wideBmp(): Buffer {
  const bytes = Buffer.alloc(54 + 9004);
  bytes.write('BM');
  bytes.writeUInt32LE(bytes.length, 2);
  bytes.writeUInt32LE(54, 10);
  bytes.writeUInt32LE(40, 14);
  bytes.writeInt32LE(3001, 18);
  bytes.writeInt32LE(1, 22);
  bytes.writeUInt16LE(1, 26);
  bytes.writeUInt16LE(24, 28);
  return bytes;
}

test('五张路径按顺序编辑，保留 PNG/JPEG/WebP 字节并将 GIF/BMP 转 PNG，原图不缩放', async () => {
  const jpeg = '/9j/4AAQSkZJRgABAgAAAQABAAD/wAARCAABAAEDAREAAhEBAxEB/9sAQwAGBAUGBQQGBgUGBwcGCAoQCgoJCQoUDg8MEBcUGBgXFBYWGh0lHxobIxwWFiAsICMmJykqKRkfLTAtKDAlKCko/9sAQwEHBwcKCAoTCgoTKBoWGigoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgo/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD5UoA//9k=';
  const webp = 'UklGRhoAAABXRUJQVlA4TA4AAAAvAAAAEM1VICICEREJAA==';
  const gif = 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
  const value = await run({ references: [
    { name: '1.jpg', bytes: Buffer.from(referencePng, 'base64') },
    { name: '2.png', bytes: Buffer.from(webp, 'base64') },
    { name: '3.gif', bytes: Buffer.from(gif, 'base64') },
    { name: '4.bmp', bytes: wideBmp() },
    { name: '5.png', bytes: Buffer.from(jpeg, 'base64') },
  ], referenceArgs: { model: 'gpt-image-2.5-flare', model_source: 'agent' } });
  try {
    assert.equal(value.requests.length, 1);
    assert.equal(value.requests[0].path, '/v1/images/edits');
    const body = value.requests[0].body as { model: string; background: string; images: { image_url: string }[] };
    assert.equal(body.model, 'gpt-image-2.5');
    assert.equal(body.background, 'opaque');
    assert.equal(body.images.length, 5);
    assert.equal(body.images[0].image_url, `data:image/png;base64,${referencePng}`);
    assert.equal(body.images[1].image_url, `data:image/webp;base64,${webp}`);
    assert.match(body.images[2].image_url, /^data:image\/png;base64,/);
    const converted = Buffer.from(body.images[3].image_url.split(',')[1], 'base64');
    assert.equal(converted.readUInt32BE(16), 3001);
    assert.equal(converted.readUInt32BE(20), 1);
    assert.equal(body.images[4].image_url, `data:image/jpeg;base64,${jpeg}`);
    assert.ok(value.result?.role === 'toolResult' && !value.result.isError);
  } finally { await value.cleanup(); }
});

for (const model of ['gpt-image-2', 'gpt-image-2.5', 'gpt-image-2.5-flare', 'gpt-image-2.5-sunburst']) {
  test(`user-explicit ${model} reaches the service verbatim, independent of agent basis`, async () => {
    const value = await run({ args: { prompt: 'a blue dot', model, model_source: 'user', model_selection_basis: 'irrelevant agent preference for another model' } });
    try {
      assert.deepEqual(value.requests[0].body, { prompt: 'a blue dot', model, background: 'opaque', quality: 'auto', size: 'auto' });
      assert.equal(value.result?.role === 'toolResult' && value.result.isError, false);
      assert.ok(value.result?.role === 'toolResult' && value.result.content.some((c) => c.type === 'image'));
    } finally { await value.cleanup(); }
  });
}

test('agent choice without task evidence uses default, while evidenced choice retains its ID', async () => {
  for (const basis of [undefined, ' ', 'User supplied verified task evidence for this candidate']) {
    const value = await run({ args: { prompt: 'a blue dot', model: 'gpt-image-2.5-flare', model_source: 'agent', ...(basis === undefined ? {} : { model_selection_basis: basis }) } });
    try {
      assert.equal((value.requests[0].body as { model: string }).model, basis?.trim() ? 'gpt-image-2.5-flare' : 'gpt-image-2.5');
    } finally { await value.cleanup(); }
  }
});

test('candidate-external model awaits policy confirmation and does not send a request', async () => {
  const value = await run({ args: { prompt: 'a dot', model: 'future-image-model' } });
  try {
    assert.equal(value.requests.length, 0);
    assert.equal(value.result?.role === 'toolResult' && value.result.isError, true);
    assert.match(JSON.stringify(value.result), /策略待用户确认/);
    assert.match(JSON.stringify(value.result), /不是永久拒绝/);
  } finally { await value.cleanup(); }
});

test('saving failure keeps image and an original fallback, with warning but no saved path', async () => {
  const value = await run({ saveFailure: true });
  try {
    assert.equal(value.requests.length, 1);
    assert.ok(value.result?.role === 'toolResult');
    assert.equal(value.result.isError, false);
    assert.ok(value.result.content.some((c) => c.type === 'image' && c.data === png));
    const details = value.result.details as { savedPath?: string; warning?: string; original: { base64: string; path?: string } };
    assert.equal(details.savedPath, undefined);
    assert.equal(details.original.path, undefined);
    assert.equal(details.original.base64, png);
    assert.match(details.warning!, /保存失败/);
    assert.match(JSON.stringify(value.result.content), /Warning/);
  } finally { await value.cleanup(); }
});

test('saving can be disabled without warnings; unknown transparent support remains unknown', async () => {
  const value = await run({ config: { saveDirectory: false }, body: { data: [{ b64_json: png }] } });
  try {
    assert.ok(value.result?.role === 'toolResult');
    assert.equal(value.result.isError, false);
    const details = value.result.details as { savedPath?: string; warning?: string; transparency: { reported: string; verified: boolean }; original: { base64: string } };
    assert.equal(details.savedPath, undefined);
    assert.equal(details.warning, undefined);
    assert.equal(details.transparency.reported, 'unknown');
    assert.equal(details.transparency.verified, false);
    assert.equal(details.original.base64, png);
  } finally { await value.cleanup(); }
});

for (const scenario of [
  { name: '401 echoing a secret', status: 401, body: { error: `Bearer ${secret}`, privateUrl: 'https://private.invalid/service' }, error: /HTTP 401/ },
  { name: 'timeout waiting for headers', delay: true, config: { timeoutMs: 30 }, error: /超时/ },
  { name: 'empty response data', body: { data: [] }, error: /首项结果/ },
  { name: 'unusable first item with a valid later image', body: { data: [{ url: `https://private.invalid/${secret}` }, { b64_json: png }] }, error: /首项结果/ },
  { name: 'non-image base64 first item', body: { data: [{ b64_json: Buffer.from(secret).toString('base64') }] }, error: /不是可展示/ },
  { name: 'null service response', body: null, error: /首项结果/ },
]) {
  test(`${scenario.name} is a visible error, does not retry or fall back, and never leaks dummy credentials`, async () => {
    const value = await run(scenario);
    try {
      assert.equal(value.requests.length, 1);
      assert.ok(value.result?.role === 'toolResult');
      assert.equal(value.result.isError, true);
      assert.ok(!value.result.content.some((c) => c.type === 'image'));
      assert.match(JSON.stringify(value.result), scenario.error);
      const visible = JSON.stringify({ messages: value.messages, errors: value.errors, modelInputs: value.modelInputs });
      assert.ok(!visible.includes(secret));
      assert.ok(!visible.includes('private.invalid'));
      assert.deepEqual(value.messages.filter((m) => m.role === 'toolResult').map((m) => m.role === 'toolResult' && m.toolName), ['image_generate']);
    } finally { await value.cleanup(); }
  });
}

for (const args of ([
  { prompt: '' }, { prompt: 'a dot', model: 1 }, { prompt: 'a dot', transparent_background: 'yes' },
  { prompt: 'an edit', referenced_image_paths: ['/tmp/pi-image-kit-missing-reference.png'] },
  { prompt: 'an edit', referenced_image_paths: ['relative.png'] },
  { prompt: 'an edit', referenced_image_paths: Array(6).fill('/tmp/reference.png') },
  { prompt: 'an edit', referenced_image_paths: ['/tmp/reference.png'], num_last_images_to_include: 1 },
  ...[0, 6, -1, 1.5, '1', 1, 5].map((count) => ({ prompt: 'an edit', num_last_images_to_include: count })),
  { prompt: 'an edit', referenced_image_paths: [], num_last_images_to_include: 1 },
] as JsonObject[])) {
  test(`invalid or future edit input does not send a generation request: ${JSON.stringify(args)}`, async () => {
    const value = await run({ args });
    try {
      assert.equal(value.requests.length, 0);
      assert.equal(value.result?.role === 'toolResult' && value.result.isError, true);
    } finally { await value.cleanup(); }
  });
}

test('空路径数组保持无引用的 generation 语义', async () => {
  const value = await run({ args: { prompt: '一颗蓝点', referenced_image_paths: [] } });
  try {
    assert.equal(value.requests.length, 1);
    assert.equal(value.requests[0].path, '/v1/images/generations');
    assert.ok(!('images' in (value.requests[0].body as object)));
    assert.ok(value.result?.role === 'toolResult' && !value.result.isError);
  } finally { await value.cleanup(); }
});

for (const bytes of [Buffer.from('not an image'), Buffer.from(referencePng, 'base64').subarray(0, 24)]) {
  test('不可解码或截断的参考图片明确报错且不发送请求', async () => {
    const value = await run({ references: [{ name: 'invalid.png', bytes }] });
    try {
      assert.equal(value.requests.length, 0);
      assert.ok(value.result?.role === 'toolResult' && value.result.isError);
      assert.match(JSON.stringify(value.result), /无法解码/);
    } finally { await value.cleanup(); }
  });
}

for (const model of ['gpt-image-2', 'gpt-image-2.5', 'gpt-image-2.5-flare', 'gpt-image-2.5-sunburst']) {
  test(`路径编辑显式模型 ${model} 原样发送，未知透明效果不作保证`, async () => {
    const value = await run({ references: [{ name: 'input.png', bytes: Buffer.from(referencePng, 'base64') }], referenceArgs: { model, model_source: 'user', model_selection_basis: '无关 agent 偏好', transparent_background: true }, body: { data: [{ b64_json: png }] } });
    try {
      assert.equal(value.requests.length, 1);
      assert.equal(value.requests[0].path, '/v1/images/edits');
      assert.equal((value.requests[0].body as { model: string }).model, model);
      assert.equal((value.requests[0].body as { background: string }).background, 'transparent');
      assert.ok(value.result?.role === 'toolResult' && !value.result.isError);
      const details = value.result.details as { transparency: { reported: string; verified: boolean } };
      assert.equal(details.transparency.reported, 'unknown');
      assert.equal(details.transparency.verified, false);
    } finally { await value.cleanup(); }
  });
}

test('路径编辑有依据的 agent 选档保留原模型；候选外模型不发请求', async () => {
  for (const model of ['gpt-image-2.5-flare', 'future-image-model']) {
    const value = await run({ references: [{ name: 'input.png', bytes: Buffer.from(referencePng, 'base64') }], referenceArgs: { model, model_source: 'agent', model_selection_basis: '用户提供已验证的任务依据' } });
    try {
      assert.equal(value.requests.length, model === 'future-image-model' ? 0 : 1);
      if (value.requests.length) assert.equal((value.requests[0].body as { model: string }).model, model);
      else assert.match(JSON.stringify(value.result), /策略待用户确认/);
    } finally { await value.cleanup(); }
  }
});

test('路径编辑落盘失败仍显示首图和 warning，不改取后续项', async () => {
  const value = await run({ references: [{ name: 'input.png', bytes: Buffer.from(referencePng, 'base64') }], saveFailure: true });
  try {
    assert.equal(value.requests.length, 1);
    assert.equal(value.requests[0].path, '/v1/images/edits');
    assert.ok(value.result?.role === 'toolResult' && !value.result.isError);
    assert.deepEqual(value.result.content.find((c) => c.type === 'image'), { type: 'image', data: png, mimeType: 'image/png' });
    const details = value.result.details as { warning: string; savedPath?: string; original: { base64: string } };
    assert.equal(details.savedPath, undefined);
    assert.equal(details.original.base64, png);
    assert.match(details.warning, /保存失败/);
    assert.match(JSON.stringify(value.result.content), /Warning/);
  } finally { await value.cleanup(); }
});

for (const scenario of [
  { status: 401, body: { error: secret }, error: /HTTP 401/ },
  { delay: true, config: { timeoutMs: 30 }, error: /超时/ },
  { body: { data: [{ url: 'https://private.invalid/image' }, { b64_json: png }] }, error: /首项结果/ },
]) {
  test('路径编辑服务失败明确返回错误，不转 generation/模型/认证/CLI', async () => {
    const value = await run({ ...scenario, references: [{ name: 'input.png', bytes: Buffer.from(referencePng, 'base64') }] });
    try {
      assert.equal(value.requests.length, 1);
      assert.equal(value.requests[0].path, '/v1/images/edits');
      assert.equal(value.requests[0].authorization, `Bearer ${secret}`);
      assert.equal((value.requests[0].body as { model: string }).model, 'gpt-image-2.5');
      assert.ok(value.result?.role === 'toolResult' && value.result.isError);
      assert.match(JSON.stringify(value.result), scenario.error);
      assert.ok(!value.result.content.some((c) => c.type === 'image'));
      assert.ok(!JSON.stringify({ messages: value.messages, modelInputs: value.modelInputs }).includes(secret));
      assert.deepEqual(value.messages.filter((m) => m.role === 'toolResult').map((m) => m.role === 'toolResult' && m.toolName), ['image_generate']);
    } finally { await value.cleanup(); }
  });
}

test('missing API key is a local configuration error and makes no service request', async () => {
  const value = await run({ config: { apiKey: '' } });
  try {
    assert.equal(value.requests.length, 0);
    assert.match(JSON.stringify(value.result), /配置 endpoint 与 apiKey/);
    assert.ok(!JSON.stringify(value.messages).includes(secret));
  } finally { await value.cleanup(); }
});

test('malformed configuration does not expose parser contents or dummy secret in discovery diagnostics', async () => {
  const value = await run({ rawConfig: `{"apiKey":"${secret}", invalid` });
  try {
    assert.equal(value.requests.length, 0);
    assert.ok(value.errors.length > 0);
    assert.ok(!JSON.stringify({ messages: value.messages, errors: value.errors, modelInputs: value.modelInputs }).includes(secret));
  } finally { await value.cleanup(); }
});

test('timeout while reading response body is reported as timeout without leaked service text', async () => {
  const value = await run({ bodyDelay: true, config: { timeoutMs: 30 } });
  try {
    assert.equal(value.requests.length, 1);
    assert.equal(value.result?.role === 'toolResult' && value.result.isError, true);
    assert.match(JSON.stringify(value.result), /超时/);
    assert.ok(!JSON.stringify({ messages: value.messages, errors: value.errors, modelInputs: value.modelInputs }).includes(secret));
  } finally { await value.cleanup(); }
});

test('builtin deferred discovery activates the existing tool; repeat search does not register again', async () => {
  const value = await run({ searches: 2, config: { exposure: 'deferred' } });
  try {
    assert.deepEqual(value.errors, []);
    assert.equal(value.tools.filter((tool) => tool.name === 'image_generate').length, 1);
    assert.ok(!value.initiallyActive.includes('image_generate'));
    assert.ok(value.finallyActive.includes('image_generate'));
    assert.equal(value.requests.length, 1);
    assert.equal(value.result?.role === 'toolResult' && value.result.isError, false);
    const searches = value.messages.filter((m) => m.role === 'toolResult' && m.toolName === 'tool_search');
    assert.equal(searches.length, 2);
    assert.match(JSON.stringify(searches[0]), /image_generate/);
    assert.ok(value.result?.role === 'toolResult' && value.result.content.some((c) => c.type === 'image'));
  } finally { await value.cleanup(); }
});

test('deployed legacy pi-tool-search hides, keyword-discovers and repeatedly selects the same direct tool', { skip: !process.env.PI_IMAGE_KIT_LEGACY_SEARCH_SOURCE }, async () => {
  const value = await run({ searches: 3, legacySearch: process.env.PI_IMAGE_KIT_LEGACY_SEARCH_SOURCE });
  try {
    assert.deepEqual(value.errors, []);
    assert.equal(value.tools.filter((tool) => tool.name === 'image_generate').length, 1);
    assert.ok(!value.initiallyActive.includes('image_generate'));
    assert.ok(value.finallyActive.includes('image_generate'));
    assert.equal(value.requests.length, 1);
    assert.ok(value.result?.role === 'toolResult' && !value.result.isError);
    const searches = value.messages.filter((m) => m.role === 'toolResult' && m.toolName === 'tool_search');
    assert.equal(searches.length, 3);
    assert.match(JSON.stringify(searches[0]), /image_generate/);
    assert.match(JSON.stringify(searches[2]), /alreadyActive/);
    assert.ok(!JSON.stringify(value.messages).includes(secret));
  } finally { await value.cleanup(); }
});
