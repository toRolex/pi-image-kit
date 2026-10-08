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
  const calls: ToolCall[] = [
    ...Array.from({ length: scenario.searches ?? 0 }, (_, i) => ({ type: 'toolCall' as const, id: `search-${i}`, name: 'tool_search', arguments: { query: legacy && i > 0 ? 'select:image_generate' : 'image generation transparent', limit: 1 } })),
    { type: 'toolCall', id: 'generate', name: 'image_generate', arguments: scenario.args ?? { prompt: 'A tiny transparent blue dot', transparent_background: true } },
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
  { prompt: 'an edit', referenced_image_paths: ['/tmp/reference.png'] },
  { prompt: 'an edit', num_last_images_to_include: 1 },
] as JsonObject[])) {
  test(`invalid or future edit input does not send a generation request: ${JSON.stringify(args)}`, async () => {
    const value = await run({ args });
    try {
      assert.equal(value.requests.length, 0);
      assert.equal(value.result?.role === 'toolResult' && value.result.isError, true);
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
