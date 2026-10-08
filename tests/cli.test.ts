import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const harness = new URL('../scripts/run-image-cli.mjs', import.meta.url).href;
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jxioAAAAASUVORK5CYII=';
const expectedPng = Buffer.from(png, 'base64');

type Request = {
  path: string;
  auth: string | undefined;
  body: string;
  type: string | undefined;
};

async function assertPng(output: string): Promise<void> {
  assert.deepEqual(await readFile(output), expectedPng);
}

test('tool失败、批量和model选择都不是CLI授权，不启动进程', async function () {
  const { runOfficialCli } = await import(harness);
  // 即使授权门退化，也不能启动真实 uv。
  const environment = { PATH: '' };
  for (const reason of [undefined, 'tool-failed', 'batch', 'model-selected']) {
    await assert.rejects(runOfficialCli({
      choice: reason,
      authorized: true,
      args: ['generate'],
      endpoint: 'http://127.0.0.1:1/v1',
      apiKey: 'dummy',
      environment,
    }), /明确选择/);
  }
  for (const authorized of [undefined, false, 'true']) {
    await assert.rejects(runOfficialCli({
      choice: 'cli',
      authorized,
      args: ['generate'],
      endpoint: 'http://127.0.0.1:1/v1',
      apiKey: 'dummy',
      environment,
    }), /费用、网络与数据/);
  }
  await assert.rejects(runOfficialCli({
    choice: 'cli',
    authorized: true,
    args: ['generate'],
    apiKey: 'dummy',
    environment,
  }), /endpoint 与 Bearer key/);
  await assert.rejects(runOfficialCli({
    choice: 'cli',
    authorized: true,
    args: ['generate'],
    endpoint: 'http://127.0.0.1:1/v1',
    environment,
  }), /endpoint 与 Bearer key/);
});

test('直接入口和符号链接入口均执行两项独立授权门', async function () {
  const dir = await mkdtemp(join(tmpdir(), 'image-cli-entry-'));
  try {
    const entry = fileURLToPath(harness);
    const linkedEntry = join(dir, 'image-cli.mjs');
    await symlink(entry, linkedEntry);
    const cases = [
      { args: ['--allow-network-data-cost', '--', 'generate'], error: /明确选择/ },
      { args: ['--choose-cli', '--', 'generate'], error: /费用、网络与数据/ },
      { args: ['--choose-cli', '--allow-network-data-cost', '--', 'generate'], error: /endpoint 与 Bearer key/ },
      { args: ['--choose-cli', '--unknown', '--', 'generate'], error: /用法/ },
      { args: ['--choose-cli', '--allow-network-data-cost', 'generate'], error: /用法/ },
    ];
    for (const script of [entry, linkedEntry]) {
      for (const scenario of cases) {
        const result = spawnSync(process.execPath, [script, ...scenario.args], {
          cwd: dir,
          env: { PATH: '', HOME: dir },
          encoding: 'utf8',
          timeout: 10000,
        });
        assert.ifError(result.error);
        assert.equal(result.status, 1, result.stderr);
        assert.match(result.stderr, scenario.error);
        assert.equal(result.stdout, '');
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('明确选择后实际官方generation、显式model、mask edit与batch闭环', { timeout: 240000 }, async function () {
  const { runOfficialCli } = await import(harness);
  const requests: Request[] = [];
  let denied = false;
  const server = createServer(async function (req, res) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({
      path: req.url!,
      auth: req.headers.authorization,
      body: Buffer.concat(chunks).toString('latin1'),
      type: req.headers['content-type'],
    });
    res.writeHead(denied ? 401 : 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(denied ? { error: { message: 'public denied', type: 'authentication_error' } } : { created: 1, data: [{ b64_json: png }] }));
  });
  const dir = await mkdtemp(join(tmpdir(), 'image-cli-'));
  try {
    await new Promise<void>(function (done, reject) {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', function () {
        server.removeListener('error', reject);
        done();
      });
    });
    const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
    const environment = {
      HOME: dir,
      UV_CACHE_DIR: join(tmpdir(), 'pi-image-kit-cli-uv-cache'),
      UV_DEFAULT_INDEX: 'https://pypi.org/simple',
      UV_NO_MANAGED_PYTHON: '1',
    };
    function run(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
      return runOfficialCli({
        choice: 'cli',
        authorized: true,
        endpoint,
        apiKey: 'dummy-cli-key',
        args,
        cwd: dir,
        environment,
      });
    }

    const output = join(dir, 'generated.png');
    const generated = await run(['generate', '--prompt', 'public test dot', '--model', 'gpt-image-2', '--quality', 'high', '--out', output]);
    assert.equal(generated.code, 0, generated.stderr);
    await assertPng(output);
    assert.equal(requests[0].path, '/v1/images/generations');
    const generationBody = JSON.parse(requests[0].body);
    // 官方脚本默认添加结构化前缀；执行器不改写用户 prompt。
    assert.equal(generationBody.prompt, 'Primary request: public test dot');
    assert.equal(generationBody.model, 'gpt-image-2');
    assert.equal(generationBody.quality, 'high');

    const explicit = await run(['generate', '--prompt', 'public second dot', '--model', 'gpt-image-2.5-sunburst', '--out', join(dir, 'explicit.png')]);
    assert.equal(explicit.code, 0, explicit.stderr);
    assert.equal(requests[1].path, '/v1/images/generations');
    const explicitBody = JSON.parse(requests[1].body);
    assert.equal(explicitBody.prompt, 'Primary request: public second dot');
    assert.equal(explicitBody.model, 'gpt-image-2.5-sunburst');
    await assertPng(join(dir, 'explicit.png'));

    const edited = await run(['edit', '--image', output, '--mask', output, '--prompt', 'public edit dot', '--model', 'gpt-image-2.5', '--quality', 'low', '--out', join(dir, 'edited.png')]);
    assert.equal(edited.code, 0, edited.stderr);
    assert.equal(requests[2].path, '/v1/images/edits');
    assert.match(requests[2].type!, /multipart\/form-data/);
    assert.match(requests[2].body, /name="mask"/);
    assert.match(requests[2].body, /gpt-image-2\.5/);
    assert.match(requests[2].body, /name="quality"\r\n\r\nlow/);
    await assertPng(join(dir, 'edited.png'));

    await writeFile(join(dir, 'jobs.jsonl'), '{"prompt":"public batch one","out":"one.png"}\n{"prompt":"public batch two","out":"two.png"}\n');
    const batch = await run(['generate-batch', '--input', join(dir, 'jobs.jsonl'), '--model', 'gpt-image-2.5-flare', '--quality', 'medium', '--out-dir', join(dir, 'batch'), '--concurrency', '2']);
    assert.equal(batch.code, 0, batch.stderr);
    assert.equal(requests.length, 5);
    const batchPrompts: string[] = [];
    for (const req of requests.slice(3)) {
      assert.equal(req.path, '/v1/images/generations');
      const body = JSON.parse(req.body);
      assert.equal(body.model, 'gpt-image-2.5-flare');
      assert.equal(body.quality, 'medium');
      batchPrompts.push(body.prompt);
    }
    // 并发请求顺序不固定，但两个原始 prompt 都必须发送。
    assert.deepEqual(batchPrompts.sort(), ['Primary request: public batch one', 'Primary request: public batch two']);
    for (const name of ['one.png', 'two.png']) {
      await assertPng(join(dir, 'batch', name));
    }
    assert.ok(requests.every((req) => req.auth === 'Bearer dummy-cli-key'));

    // 真实命令入口父环境只有 dummy 污染；不可读取个人凭据后复制。
    const cli = await new Promise<{ code: number | null; stderr: string }>((done, reject) => {
      const child = spawn(process.execPath, [fileURLToPath(harness), '--choose-cli', '--allow-network-data-cost', '--', 'generate', '--prompt', 'public polluted parent', '--model', 'gpt-image-2.5', '--size', '1024x1024', '--n', '1', '--out', join(dir, 'entry.png')], {
        cwd: dir,
        env: { PATH: process.env.PATH, HOME: dir, OPENAI_BASE_URL: endpoint, OPENAI_API_KEY: 'dummy-cli-key', HTTP_PROXY: 'http://127.0.0.1:1', HTTPS_PROXY: 'http://127.0.0.1:1', ALL_PROXY: 'http://127.0.0.1:1', OPENAI_ORG_ID: 'dummy-polluted-org', OPENAI_PROJECT_ID: 'dummy-polluted-project' },
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let stderr = '';
      child.stderr.on('data', (data) => { stderr += data; });
      child.on('error', reject);
      child.on('close', (code) => done({ code, stderr }));
    });
    assert.equal(cli.code, 0, cli.stderr);
    await assertPng(join(dir, 'entry.png'));
    assert.equal(JSON.parse(requests[5].body).size, '1024x1024');
    assert.equal(JSON.parse(requests[5].body).n, 1);
    assert.equal(requests[5].auth, 'Bearer dummy-cli-key');

    denied = true;
    const failed = await run(['generate', '--prompt', 'public rejected dot', '--model', 'gpt-image-2.5-sunburst', '--out', join(dir, 'rejected.png')]);
    assert.notEqual(failed.code, 0);
    assert.match(failed.stderr, /401/);
    assert.equal(requests.length, 7);
    assert.equal(requests[6].path, '/v1/images/generations');
    assert.equal(JSON.parse(requests[6].body).model, 'gpt-image-2.5-sunburst');
    assert.equal(requests[6].auth, 'Bearer dummy-cli-key');
    assert.ok(![cli.stderr, failed.stderr].join('').includes('dummy-cli-key'));
  } finally {
    try {
      if (server.listening) {
        server.closeAllConnections();
        await new Promise<void>(function (done) {
          server.close(function () {
            done();
          });
        });
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});
