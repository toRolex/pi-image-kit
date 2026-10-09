import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { ImageReference } from './images.ts';
import type { ImageDetails } from './output.ts';

export interface RecentReference {
  entryId: string;
  source: 'pi-image-kit-original' | 'session-preview';
}

// details 是可持久化的来源记录，不是任意扩展都无法伪造的签名。
// 仅本包工具的对应调用结果可使用 original；外部工具的同名字段一律忽略。
async function originalReference(value: unknown): Promise<ImageReference> {
  const original = value as Partial<ImageDetails['original']> | undefined;
  if (!original || original.source !== 'pi-image-kit' || original.version !== 1 ||
      !['image/png', 'image/jpeg', 'image/webp'].includes(original.mimeType ?? '') ||
      typeof original.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(original.sha256)) {
    throw new Error('本包会话图片原图来源记录无效；本次未发送请求。');
  }
  let bytes: Buffer;
  if (original.path !== undefined) {
    if (typeof original.path !== 'string' || !isAbsolute(original.path)) {
      throw new Error('本包会话图片原图路径无效；本次未发送请求。');
    }
    try { bytes = await readFile(original.path); }
    catch { throw new Error('本包会话图片原图无法读取；本次未发送请求，不改用预览。'); }
  } else {
    if (typeof original.base64 !== 'string' || !original.base64) {
      throw new Error('本包会话图片原图 base64 无效；本次未发送请求。');
    }
    bytes = Buffer.from(original.base64, 'base64');
    if (bytes.toString('base64') !== original.base64) {
      throw new Error('本包会话图片原图 base64 无效；本次未发送请求。');
    }
  }
  if (createHash('sha256').update(bytes).digest('hex') !== original.sha256) {
    throw new Error('本包会话图片原图 hash 不符，文件可能已被替换；本次未发送请求。');
  }
  return { image_url: `data:${original.mimeType};base64,${bytes.toString('base64')}` };
}

// pi 会转换 schema 参数（例如 1.5 → 1）；以已持久化的原始调用为准拒绝无效数量。
export function recentImageCount(manager: ExtensionContext['sessionManager'], toolCallId: string, converted?: number): number | undefined {
  let count: unknown = converted;
  const branch = manager.getBranch();
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry.type !== 'message' || entry.message.role !== 'assistant') continue;
    const call = entry.message.content.find((block) => block.type === 'toolCall' && block.id === toolCallId && block.name === 'image_generate');
    if (call?.type === 'toolCall') {
      count = call.arguments.num_last_images_to_include;
      break;
    }
  }
  if (count === undefined) return undefined;
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > 5) {
    throw new Error('recent 数量必须为一至五的整数；本次未发送请求。');
  }
  return count;
}

export async function readRecentImages(manager: ExtensionContext['sessionManager'], count: number): Promise<{
  images: ImageReference[];
  references: RecentReference[];
  warning?: string;
}> {
  if (!Number.isInteger(count) || count < 1 || count > 5) {
    throw new Error('recent 数量必须为一至五的整数；本次未发送请求。');
  }
  const branch = manager.getBranch();
  const selected: { image: { data: string; mimeType: string }; entryId: string; original?: unknown; useOriginal: boolean }[] = [];
  const ownCalls = new Set<string>();
  // 先确认活动分支上的调用归属，避免把其它工具的 details.original 当成本包原图。
  for (const entry of branch) {
    if (entry.type === 'message' && entry.message.role === 'assistant') {
      for (const block of entry.message.content) {
        if (block.type === 'toolCall' && block.name === 'image_generate') ownCalls.add(block.id);
      }
    }
  }
  for (let i = branch.length - 1; i >= 0 && selected.length < count; i--) {
    const entry = branch[i];
    if (entry.type !== 'message' && entry.type !== 'custom_message') continue;
    const message = entry.type === 'message' ? entry.message : entry;
    if ('role' in message && message.role === 'toolResult' && message.isError) continue;
    if (!('content' in message) || !Array.isArray(message.content)) continue;
    const blocks = message.content.filter((block) => block.type === 'image');
    const isOwnResult = 'role' in message && message.role === 'toolResult' &&
      message.toolName === 'image_generate' && ownCalls.has(message.toolCallId);
    const original = isOwnResult ? (message.details as Partial<ImageDetails> | undefined)?.original : undefined;
    for (let j = blocks.length - 1; j >= 0 && selected.length < count; j--) {
      selected.push({ image: blocks[j], entryId: entry.id, useOriginal: isOwnResult && j === 0 && original !== undefined, original });
    }
  }
  if (selected.length < count) {
    throw new Error(`活动会话分支图片不足：需要 ${count} 张，仅有 ${selected.length} 张；本次未发送请求。`);
  }
  selected.reverse();
  const images: ImageReference[] = [];
  const references: RecentReference[] = [];
  for (const item of selected) {
    images.push(item.useOriginal ? await originalReference(item.original) : {
      image_url: `data:${item.image.mimeType};base64,${item.image.data}`,
    });
    references.push({ entryId: item.entryId, source: item.useOriginal ? 'pi-image-kit-original' : 'session-preview' });
  }
  return {
    images,
    references,
    ...(references.some((reference) => reference.source === 'session-preview') ? {
      warning: '部分参考图仅为活动会话中现存的图片/预览，可能已被 pi 缩放；没有可验证的原图来源，不宣称使用原图。',
    } : {}),
  };
}
