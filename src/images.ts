import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { convertToPng } from '@earendil-works/pi-coding-agent';
import type { ImageKitConfig } from './config.ts';

export interface ImageReference { image_url: string }

// 仅识别格式签名，不代表完整解码；参考图仍须通过下方解码校验。
export function imageMime(bytes: Buffer): 'image/png' | 'image/jpeg' | 'image/webp' | undefined {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return undefined;
}

// 对照固定 Codex 的 Original：按内容解码验证，不缩放；PNG/JPEG/WebP 保留原字节，其余转 PNG。
export async function readImageReferences(paths: string[]): Promise<ImageReference[]> {
  const images: ImageReference[] = [];
  for (const path of paths) {
    if (!isAbsolute(path)) throw new Error('参考图片必须使用绝对路径；本次未发送请求。');
    let bytes: Buffer;
    try { bytes = await readFile(path); }
    catch { throw new Error('无法读取参考图片；本次未发送请求。'); }
    const data = bytes.toString('base64');
    // 不传 image/png，避免宿主 PNG 快捷分支跳过解码校验；转换函数不缩放。
    const decoded = await convertToPng(data, 'application/octet-stream');
    if (!decoded) throw new Error('参考文件无法解码为图片；本次未发送请求。');
    const mime = imageMime(bytes);
    const image = mime ? { mimeType: mime, data } : decoded;
    images.push({ image_url: `data:${image.mimeType};base64,${image.data}` });
  }
  return images;
}

export interface ImageRequest {
  prompt: string;
  model: string;
  background: 'transparent' | 'opaque';
  quality: 'auto';
  size: 'auto';
}
export interface ImageResponse {
  data?: { b64_json?: unknown }[];
  background?: unknown;
}

function requestError(timeout: AbortSignal, signal: AbortSignal | undefined, fallback: string): Error {
  if (signal?.aborted) return new Error('图像请求已取消；未切换模型、认证或 CLI。');
  if (timeout.aborted) return new Error('图像请求超时；未重试或切换模型、认证、CLI。');
  return new Error(fallback);
}

// 生成与 JSON 编辑共用传输；不切换 multipart 或 CLI。
export async function requestImage(
  config: ImageKitConfig,
  operation: 'generations' | 'edits',
  request: ImageRequest & { images?: ImageReference[] },
  signal?: AbortSignal,
): Promise<ImageResponse> {
  const timeout = AbortSignal.timeout(config.timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let response: Response;
  try {
    response = await fetch(`${config.endpoint}/images/${operation}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(request),
      signal: combined,
      redirect: 'error',
    });
  } catch {
    throw requestError(timeout, signal, '图像服务网络请求失败；未切换模型、认证或 CLI。');
  }
  // 服务可能回显 Bearer key 或私有 endpoint；响应错误正文与 fetch 异常原文不进入会话。
  if (!response.ok) throw new Error(`图像服务返回 HTTP ${response.status}；未切换模型、认证或 CLI。`);
  try {
    return await response.json() as ImageResponse;
  } catch {
    throw requestError(timeout, signal, '图像服务响应不是有效 JSON。');
  }
}
