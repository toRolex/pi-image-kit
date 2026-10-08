import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const pythonDependencies = ['openai==2.30.0', 'pillow==12.1.0'];
const script = fileURLToPath(new URL('../skills/imagegen/scripts/image_gen.py', import.meta.url));

// 只负责明确授权与受控环境；所有图像参数直接交给完整官方脚本。
export async function runOfficialCli({
  choice,
  authorized,
  endpoint,
  apiKey,
  args,
  cwd = process.cwd(),
  environment = {},
}) {
  if (choice !== 'cli') throw new Error('必须由用户明确选择 CLI；失败、批量、model 不构成授权。');
  if (authorized !== true) throw new Error('须另获费用、网络与数据发送范围授权。');
  if (!endpoint || !apiKey) throw new Error('须配置 endpoint 与 Bearer key；不使用 ChatGPT 登录。');

  const uvArgs = [
    'run',
    '--no-project',
    '--no-config',
    '--with',
    pythonDependencies[0],
    '--with',
    pythonDependencies[1],
    'python',
    script,
    ...args,
  ];
  const env = {
    PATH: process.env.PATH,
    ...environment,
    OPENAI_BASE_URL: endpoint,
    OPENAI_API_KEY: apiKey,
  };
  return new Promise(function (done, reject) {
    const child = spawn('uv', uvArgs, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', function (data) {
      stdout += data;
    });
    child.stderr.on('data', function (data) {
      stderr += data;
    });
    child.on('error', function () {
      reject(new Error('无法启动 uv；未切换路线或模型。'));
    });
    child.on('close', function (code) {
      done({ code, stdout, stderr });
    });
  });
}

// 入口路径可能经过符号链接，例如 macOS 的 /tmp → /private/tmp。
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const separator = argv.indexOf('--');
  const controls = argv.slice(0, separator < 0 ? argv.length : separator);
  try {
    if (
      separator < 0 ||
      controls.some((arg) => !['--choose-cli', '--allow-network-data-cost'].includes(arg))
    ) {
      throw new Error('用法：node scripts/run-image-cli.mjs --choose-cli --allow-network-data-cost -- <官方参数>');
    }
    const result = await runOfficialCli({
      choice: controls.includes('--choose-cli') ? 'cli' : undefined,
      authorized: controls.includes('--allow-network-data-cost'),
      endpoint: process.env.OPENAI_BASE_URL,
      apiKey: process.env.OPENAI_API_KEY,
      args: argv.slice(separator + 1),
    });
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    process.exitCode = result.code ?? 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
