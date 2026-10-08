import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const commit = 'a956835d020762cb2b570053af06f643a11c0ecc';
const snapshotRoot = 'vendor/codex-0.160.0';
const skillPrefix = 'codex-rs/skills/src/assets/samples/imagegen/';
const skillFiles = [
  'SKILL.md', 'LICENSE.txt', 'agents/openai.yaml', 'assets/imagegen.png', 'assets/imagegen-small.svg',
  'references/cli.md', 'references/codex-network.md', 'references/image-api.md', 'references/prompting.md', 'references/sample-prompts.md',
  'scripts/image_gen.py', 'scripts/remove_chroma_key.py',
];
const upstreamFiles = [
  'LICENSE', 'NOTICE', 'codex-rs/Cargo.toml', 'codex-rs/protocol/src/models.rs', 'codex-rs/utils/image/src/lib.rs',
  'codex-rs/codex-api/src/images.rs', 'codex-rs/codex-api/src/endpoint/images.rs', 'codex-rs/ext/items/src/image_generation.rs',
  'codex-rs/ext/image-generation/BUILD.bazel', 'codex-rs/ext/image-generation/Cargo.toml', 'codex-rs/ext/image-generation/imagegen_description.md',
  ...['artifact', 'backend', 'extension', 'lib', 'tests', 'tool'].map((name) => `codex-rs/ext/image-generation/src/${name}.rs`),
  ...skillFiles.map((path) => skillPrefix + path),
];
const digest = (algorithm, bytes) => createHash(algorithm).update(bytes).digest('hex');
async function files(root, prefix = '') {
  const result = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) result.push(...await files(root, path));
    else { assert.ok(entry.isFile(), `non-file resource: ${path}`); result.push(path); }
  }
  return result.sort();
}

async function verify(root) {
  const manifest = JSON.parse(await readFile(join(root, 'resources.json'), 'utf8'));
  assert.equal(manifest.baseline.commit, commit, 'baseline commit mismatch');
  assert.equal(manifest.baseline.version, '0.160.0', 'baseline version mismatch');
  assert.equal(manifest.baseline.license, 'Apache-2.0', 'license mismatch');
  assert.deepEqual(manifest.snapshots.map((entry) => entry.upstreamPath).sort(), [...upstreamFiles].sort(), 'snapshot manifest inventory mismatch');
  assert.deepEqual(await files(join(root, snapshotRoot)), [...upstreamFiles].sort(), 'snapshot inventory mismatch');
  assert.deepEqual(manifest.runtime.map((entry) => entry.path).sort(), skillFiles.map((path) => `skills/imagegen/${path}`).sort(), 'runtime manifest inventory mismatch');
  assert.deepEqual(await files(join(root, 'skills/imagegen')), [...skillFiles].sort(), 'runtime inventory mismatch');

  const originals = new Map();
  for (const entry of manifest.snapshots) {
    assert.equal(entry.path, `${snapshotRoot}/${entry.upstreamPath}`, 'snapshot path mismatch');
    assert.equal(entry.url, `https://github.com/openai/codex/blob/${commit}/${entry.upstreamPath}`, 'immutable source mismatch');
    assert.equal(entry.modified, false, 'snapshot must remain unmodified');
    const bytes = await readFile(join(root, entry.path));
    assert.equal(digest('sha256', bytes), entry.sha256, `snapshot hash mismatch: ${entry.path}`);
    assert.equal(bytes.length, entry.size, `snapshot size mismatch: ${entry.path}`);
    const blob = Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes]);
    assert.equal(digest('sha1', blob), entry.gitBlobSha1, `Git blob mismatch: ${entry.path}`);
    originals.set(entry.path, entry.sha256);
  }
  for (const entry of manifest.runtime) {
    const expectedSnapshot = `${snapshotRoot}/${skillPrefix}${entry.path.slice('skills/imagegen/'.length)}`;
    assert.equal(entry.snapshot, expectedSnapshot, 'runtime source mapping mismatch');
    const sha256 = digest('sha256', await readFile(join(root, entry.path)));
    assert.equal(sha256, entry.sha256, `runtime hash mismatch: ${entry.path}`);
    assert.equal(entry.modified, sha256 !== originals.get(entry.snapshot), `modified marker mismatch: ${entry.path}`);
    if (entry.modified) {
      assert.ok(entry.modifiedOn && entry.adaptation, `missing adaptation record: ${entry.path}`);
      const text = await readFile(join(root, entry.path), 'utf8');
      assert.match(text, /modified from the fixed Codex 0\.160\.0 snapshot/, 'missing prominent modified notice');
    }
  }
  console.log('Resource audit passed: 29 upstream files; 12 runtime resources; immutable hashes, Git blobs and modified notices verified.');
}

const args = process.argv.slice(2);
const root = args.length === 0 ? resolve(fileURLToPath(new URL('..', import.meta.url))) : args.length === 2 && args[0] === '--root' ? resolve(args[1]) : undefined;
if (!root) { console.error('Usage: node scripts/verify-resources.mjs [--root PACKAGE_DIRECTORY]'); process.exitCode = 1; }
else await verify(root).catch((error) => { console.error(error.message); process.exitCode = 1; });
