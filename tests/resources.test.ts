import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, cp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, '..');
const audit = join(root, 'scripts', 'verify-resources.mjs');

test('public package resource audit verifies the complete fixed snapshot and all runtime copies', async () => {
  const result = await exec(process.execPath, [audit, '--root', root]);
  assert.match(result.stdout, /29 upstream files; 12 runtime resources/);
});

test('运行 skill 的任意模型选择都须另获 CLI 授权', async () => {
  const skill = await readFile(join(root, 'skills/imagegen/SKILL.md'), 'utf8');
  assert.doesNotMatch(skill, /unless they explicitly requested `gpt-image-1\.5`/);
  assert.match(skill, /指定任意模型都不等于选择 CLI/);
});

test('交付指导只复制并保留 recent 受追踪原图', async () => {
  const skill = await readFile(join(root, 'skills/imagegen/SKILL.md'), 'utf8');
  assert.doesNotMatch(skill, /move or copy/);
  assert.match(skill, /保留受追踪原图/);
});

test('NOTICE 与资源 manifest 的 modified 文件一致', async () => {
  const notice = await readFile(join(root, 'NOTICE'), 'utf8');
  const manifest = JSON.parse(await readFile(join(root, 'resources.json'), 'utf8'));
  for (const entry of manifest.runtime.filter((entry: { modified: boolean }) => entry.modified)) {
    assert.ok(notice.includes(entry.path), `NOTICE 未记录 ${entry.path}`);
  }
  assert.match(notice, /other four references.*remain unchanged/);
  assert.doesNotMatch(notice, /five references.*remain unchanged/);
});

test('public audit detects a missing resource, snapshot byte changes, unmarked adaptation, and unexpected files', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'image-kit-audit-'));
  try {
    for (const path of ['vendor', 'skills', 'resources.json']) await cp(join(root, path), join(temp, path), { recursive: true });
    const original = join(temp, 'vendor/codex-0.160.0/codex-rs/skills/src/assets/samples/imagegen/scripts/image_gen.py');
    const bytes = await readFile(original);
    await writeFile(original, Buffer.concat([bytes, Buffer.from('\n# tampered\n')]));
    await assert.rejects(exec(process.execPath, [audit, '--root', temp]), /snapshot hash mismatch/);
    await writeFile(original, bytes);
    const missing = join(temp, 'skills/imagegen/scripts/remove_chroma_key.py');
    const helper = await readFile(missing);
    await rm(missing);
    await assert.rejects(exec(process.execPath, [audit, '--root', temp]), /runtime inventory mismatch/);
    await writeFile(missing, helper);
    const manifestPath = join(temp, 'resources.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.runtime.find((entry: { path: string }) => entry.path.endsWith('/SKILL.md')).modified = false;
    await writeFile(manifestPath, JSON.stringify(manifest));
    await assert.rejects(exec(process.execPath, [audit, '--root', temp]), /modified marker mismatch/);
    await cp(join(root, 'resources.json'), manifestPath);
    await writeFile(join(temp, 'skills/imagegen/unlisted.txt'), 'not in fixed inventory');
    await assert.rejects(exec(process.execPath, [audit, '--root', temp]), /runtime inventory mismatch/);
  } finally { await rm(temp, { recursive: true, force: true }); }
});
