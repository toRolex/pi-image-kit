import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

export interface ImageKitConfig {
  endpoint: string;
  apiKey: string;
  timeoutMs: number;
  saveDirectory: string | false;
  exposure: 'direct' | 'deferred';
}

async function readConfig(path: string): Promise<Record<string, unknown>> {
  try {
    const value: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    // 解析异常、路径与文件内容可能包含密钥，不能插入错误消息。
    throw new Error('image-kit 配置不可读取或不是有效 JSON 对象。');
  }
}

async function readConfigLayers(cwd: string) {
  const global = await readConfig(join(getAgentDir(), 'image-kit.json'));
  const project = await readConfig(join(cwd, '.pi', 'image-kit.json'));
  return { global, project };
}

function parseExposure(exposure: unknown): 'direct' | 'deferred' {
  if (exposure === undefined || exposure === 'direct') return 'direct';
  if (exposure === 'deferred') return 'deferred';
  throw new Error('image-kit exposure 应为 direct 或 deferred。');
}

export async function loadConfig(cwd: string): Promise<ImageKitConfig> {
  const { global, project } = await readConfigLayers(cwd);
  // 认证绑定完整基址，不只绑定 origin；仅忽略末尾斜杠，避免跨路径泄露全局密钥。
  const sameEndpoint = typeof project.endpoint === 'string' && typeof global.endpoint === 'string'
    && project.endpoint.replace(/\/+$/, '') === global.endpoint.replace(/\/+$/, '');
  if (project.endpoint !== undefined && !sameEndpoint
    && typeof global.apiKey === 'string' && global.apiKey.trim()
    && (typeof project.apiKey !== 'string' || !project.apiKey.trim())) {
    throw new Error('image-kit 项目更改 endpoint 时必须显式配置有效 apiKey；不会继承全局密钥。');
  }
  const value = { ...global, ...project };
  if (typeof value.endpoint !== 'string' || typeof value.apiKey !== 'string' || !value.apiKey.trim()) {
    throw new Error('请先在 pi agent 目录或项目 .pi/image-kit.json 配置 endpoint 与 apiKey；不要在会话粘贴密钥。');
  }
  try {
    const url = new URL(value.endpoint);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
  } catch { throw new Error('image-kit endpoint 应为无内嵌认证的 HTTP(S) API 基址。'); }
  if (value.timeoutMs !== undefined && (!Number.isSafeInteger(value.timeoutMs) || (value.timeoutMs as number) <= 0)) {
    throw new Error('image-kit timeoutMs 应为正整数毫秒。');
  }
  if (value.saveDirectory !== undefined && value.saveDirectory !== false && (typeof value.saveDirectory !== 'string' || !isAbsolute(value.saveDirectory))) {
    throw new Error('image-kit saveDirectory 应为绝对目录路径或 false。');
  }
  const exposure = parseExposure(value.exposure);
  return {
    endpoint: value.endpoint.replace(/\/+$/, ''),
    apiKey: value.apiKey,
    timeoutMs: (value.timeoutMs as number | undefined) ?? 120_000,
    saveDirectory: (value.saveDirectory as string | false | undefined) ?? join(cwd, '.pi', 'images'),
    exposure,
  };
}

// 加载包无需凭据；注册仅读取可选 exposure，执行时才检查完整服务配置。
export async function loadExposure(cwd: string): Promise<'direct' | 'deferred'> {
  const { global, project } = await readConfigLayers(cwd);
  return parseExposure({ ...global, ...project }.exposure);
}
