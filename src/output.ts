import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ImageResponse } from './images.ts';

export interface ImageDetails {
  model: string;
  savedPath?: string;
  warning?: string;
  transparency: { requested: boolean; reported: 'transparent' | 'opaque' | 'unknown'; verified: false };
  // Original provenance survives pi preview resizing. #4 must check the hash
  // before using a path and must not label arbitrary session previews originals.
  original: { source: 'pi-image-kit'; version: 1; mimeType: string; sha256: string; path?: string; base64?: string };
}

function decodeFirst(response: ImageResponse): { data: string; bytes: Buffer; mimeType: string; extension: string } {
  const data = response?.data?.[0]?.b64_json;
  if (typeof data !== 'string' || !data || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) {
    throw new Error('图像服务首项结果没有可用的 base64 图片；不会改取后续项。');
  }
  const bytes = Buffer.from(data, 'base64');
  if (bytes.toString('base64') !== data) throw new Error('图像服务首项结果不是有效 base64 图片。');
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return { data, bytes, mimeType: 'image/png', extension: 'png' };
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return { data, bytes, mimeType: 'image/jpeg', extension: 'jpg' };
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return { data, bytes, mimeType: 'image/webp', extension: 'webp' };
  throw new Error('图像服务首项结果不是可展示的 PNG、JPEG 或 WebP 图片。');
}

// Shared result exit for generation and future edits. Saving is optional and
// never converts a successful generation into a failed tool result.
export async function imageOutput(response: ImageResponse, model: string, transparent: boolean, saveDirectory: string | false) {
  const image = decodeFirst(response);
  const details: ImageDetails = {
    model,
    transparency: {
      requested: transparent,
      reported: response.background === 'transparent' || response.background === 'opaque' ? response.background : 'unknown',
      verified: false,
    },
    original: {
      source: 'pi-image-kit',
      version: 1,
      mimeType: image.mimeType,
      sha256: createHash('sha256').update(image.bytes).digest('hex'),
    },
  };
  if (saveDirectory !== false) {
    try {
      await mkdir(saveDirectory, { recursive: true });
      const path = join(saveDirectory, `${randomUUID()}.${image.extension}`);
      await writeFile(path, image.bytes, { flag: 'wx' });
      details.savedPath = path;
      details.original.path = path;
    } catch { details.warning = '图片已生成，但保存失败；会话仍返回图片。'; }
  }
  if (!details.original.path) details.original.base64 = image.data;
  const text = [
    `模型：${model}`,
    `透明背景请求：${transparent ? '是' : '否'}；服务报告：${details.transparency.reported}；透明效果未验证。`,
    ...(details.savedPath ? [`保存路径：${details.savedPath}`] : []),
    ...(details.warning ? [`Warning: ${details.warning}`] : []),
  ].join('\n');
  return {
    content: [
      { type: 'image' as const, data: image.data, mimeType: image.mimeType },
      { type: 'text' as const, text },
    ],
    details,
  };
}
