import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, chmod, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream, InMemoryCredentialStore, type AssistantMessage } from '@earendil-works/pi-ai';

// 真实公开会话执行默认 tool；PATH 哨兵观测是否隐式启动 uv。
for (const scenario of ['失败', '批量', '模型选择']) {
  test(`默认会话${scenario}不启动CLI、不换认证或模型`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cli-no-fallback-'));
    const oldCwd = process.cwd();
    const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
    const oldPath = process.env.PATH;
    const workspace = join(dir, 'workspace');
    const agentDir = join(dir, 'agent');
    const marker = join(dir, 'uv-started');
    const requests: { model: string; auth?: string }[] = [];
    const server = createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk;
      requests.push({ model: JSON.parse(body).model, auth: req.headers.authorization });
      res.writeHead(scenario === '失败' ? 401 : 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ b64_json: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jxioAAAAASUVORK5CYII=' }] }));
    });
    let session;
    try {
      // 只合成污染配置；绝不访问真实个人目录。初始化失败也须恢复环境。
      await mkdir(join(dir, '.pi'), { recursive: true });
      await mkdir(join(dir, 'polluted-agent'));
      await writeFile(join(dir, '.pi', 'image-kit.json'), '{invalid-project-config');
      await writeFile(join(dir, 'polluted-agent', 'image-kit.json'), '{invalid-global-config');
      process.chdir(dir);
      process.env.PI_CODING_AGENT_DIR = join(dir, 'polluted-agent');
      await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
      server.unref();
      const root = resolve(import.meta.dirname, '..');
      await mkdir(join(workspace, '.pi'), { recursive: true });
      await writeFile(join(workspace, '.pi', 'image-kit.json'), JSON.stringify({ endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, apiKey: 'dummy-tool', saveDirectory: false }));
      await writeFile(join(dir, 'uv'), `#!/bin/sh\n/usr/bin/touch '${marker}'\nexit 99\n`);
      await chmod(join(dir, 'uv'), 0o755);
      const settings = SettingsManager.inMemory({ packages: [root], defaultTools: ['image_generate'], retry: { enabled: false }, compaction: { enabled: false } });
      const loader = new DefaultResourceLoader({ cwd: workspace, agentDir, settingsManager: settings, noContextFiles: true, noPromptTemplates: true, noThemes: true, disabledBuiltinExtensions: ['mcp'] });
      const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, modelsStorePath: join(dir, 'models.json'), refreshOnCreate: false, allowModelNetwork: false });
      const count = scenario === '批量' ? 2 : 1;
      const modelId = scenario === '模型选择' ? 'gpt-image-2.5-sunburst' : 'gpt-image-2.5';
      let step = 0;
      runtime.registerProvider('no-fallback', { api: 'no-fallback', apiKey: 'dummy-llm', baseUrl: 'http://127.0.0.1/never-called', models: [{ id: 'scripted', name: 'scripted', reasoning: false, input: ['text', 'image'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }], streamSimple(model) {
        const index = step++;
        const message: AssistantMessage = { role: 'assistant', api: model.api, provider: model.provider, model: model.id, content: index < count ? [{ type: 'toolCall', id: `call-${index}`, name: 'image_generate', arguments: { prompt: `public dot ${index}`, ...(scenario === '模型选择' ? { model: modelId } : {}) } }] : [{ type: 'text', text: '结束；未选择 CLI' }], stopReason: index < count ? 'toolUse' : 'stop', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: Date.now() };
        const stream = createAssistantMessageEventStream();
        stream.push({ type: 'done', reason: message.stopReason as 'toolUse' | 'stop', message });
        return stream;
      } });
      process.env.PATH = `${dir}:${oldPath ?? ''}`;
      process.chdir(workspace);
      process.env.PI_CODING_AGENT_DIR = agentDir;
      await loader.reload();
      assert.deepEqual(loader.getExtensions().errors, []);
      ({ session } = await createAgentSession({ cwd: workspace, agentDir, settingsManager: settings, sessionManager: SessionManager.inMemory(workspace), resourceLoader: loader, modelRuntime: runtime, model: runtime.getModel('no-fallback', 'scripted')! }));
      await session.bindExtensions({});
      await session.prompt(scenario === '失败' ? '生成图片；失败也不要自动改用 CLI。' : scenario === '批量' ? '批量生成两个公开蓝点。' : '生成蓝点，使用 gpt-image-2.5-sunburst。');
      assert.equal(requests.length, count);
      assert.ok(requests.every((request) => request.model === modelId && request.auth === 'Bearer dummy-tool'));
      const results = session.messages.filter((message) => message.role === 'toolResult');
      assert.equal(results.length, count);
      assert.ok(results.every((result) => result.role === 'toolResult' && result.isError === (scenario === '失败')));
      await assert.rejects(access(marker), { code: 'ENOENT' });
    } finally {
      session?.dispose();
      process.chdir(oldCwd);
      if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
      if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
      await rm(dir, { recursive: true, force: true });
    }
  });
}
