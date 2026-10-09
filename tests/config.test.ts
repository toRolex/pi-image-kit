import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadConfig, loadExposure } from '../src/config.js';

const endpoint = 'https://global-private.invalid/v1';
const secret = 'dummy-global-secret';
const projectSecret = 'dummy-project-secret';
const overrideError = 'image-kit 项目更改 endpoint 时必须显式配置有效 apiKey；不会继承全局密钥。';

async function fixture(global: Record<string, unknown> | undefined, project: Record<string, unknown> | undefined, check: (cwd: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'image-kit-config-'));
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    const agentDir = join(dir, 'agent');
    await mkdir(agentDir);
    await mkdir(join(dir, '.pi'));
    if (global) await writeFile(join(agentDir, 'image-kit.json'), JSON.stringify(global));
    if (project) await writeFile(join(dir, '.pi', 'image-kit.json'), JSON.stringify(project));
    process.env.PI_CODING_AGENT_DIR = agentDir;
    await check(dir);
  } finally {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
    await rm(dir, { recursive: true, force: true });
  }
}

for (const changed of ['https://project-private.invalid/v1', 'https://global-private.invalid/other']) {
  for (const apiKey of [undefined, '', '   ', null, 42]) {
    test(`项目更改基址且无有效项目密钥拒绝：${changed} / ${JSON.stringify(apiKey)}`, async () => {
      await fixture({ endpoint, apiKey: secret }, { endpoint: changed, apiKey, exposure: 'deferred' }, async (cwd) => {
        // 注册只读 exposure；凭据隔离在执行配置加载时检查。
        assert.equal(await loadExposure(cwd), 'deferred');
        await assert.rejects(loadConfig(cwd), { message: overrideError });
      });
    });
  }
}

for (const project of [{ endpoint }, { endpoint: `${endpoint}/` }, { endpoint: `${endpoint}///` }, { timeoutMs: 1000 }]) {
  test(`同基址或仅其它字段仍可继承：${JSON.stringify(project)}`, async () => {
    await fixture({ endpoint, apiKey: secret }, project, async (cwd) => {
      const config = await loadConfig(cwd);
      assert.equal(config.endpoint, endpoint);
      assert.equal(config.apiKey, secret);
      assert.equal(config.timeoutMs, 'timeoutMs' in project ? 1000 : 120_000);
    });
  });
}

test('更改基址并显式配置项目密钥正常', async () => {
  const changed = 'https://project-private.invalid/v2';
  await fixture({ endpoint, apiKey: secret }, { endpoint: changed, apiKey: projectSecret }, async (cwd) => {
    const config = await loadConfig(cwd);
    assert.equal(config.endpoint, changed);
    assert.equal(config.apiKey, projectSecret);
  });
});

test('全局仅密钥不能授权项目基址', async () => {
  await fixture({ apiKey: secret }, { endpoint }, async (cwd) => {
    assert.equal(await loadExposure(cwd), 'direct');
    await assert.rejects(loadConfig(cwd), { message: overrideError });
  });
});

for (const source of ['project', 'global']) {
  test(`仅${source}完整配置正常`, async () => {
    const value = { endpoint, apiKey: secret };
    await fixture(source === 'global' ? value : undefined, source === 'project' ? value : undefined, async (cwd) => {
      const config = await loadConfig(cwd);
      assert.equal(config.endpoint, endpoint);
      assert.equal(config.apiKey, secret);
    });
  });
}

test('同基址项目空密钥不回退全局密钥', async () => {
  await fixture({ endpoint, apiKey: secret }, { endpoint, apiKey: '' }, async (cwd) => {
    await assert.rejects(loadConfig(cwd), /配置 endpoint 与 apiKey/);
  });
});

test('无凭据仍可加载 exposure', async () => {
  await fixture(undefined, { exposure: 'deferred' }, async (cwd) => {
    assert.equal(await loadExposure(cwd), 'deferred');
    await assert.rejects(loadConfig(cwd), /配置 endpoint 与 apiKey/);
  });
});
