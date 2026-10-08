import type { ImageKitConfig } from './config.ts';

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

// Shared transport seam for #3 JSON edits; no multipart or CLI fallback.
export async function requestImage(
  config: ImageKitConfig,
  operation: 'generations' | 'edits',
  request: ImageRequest & { images?: unknown[] },
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
  // A service may echo the Bearer key or private endpoint in its body. Neither
  // external error text nor fetch exception text crosses the session boundary.
  if (!response.ok) throw new Error(`图像服务返回 HTTP ${response.status}；未切换模型、认证或 CLI。`);
  try {
    return await response.json() as ImageResponse;
  } catch {
    throw requestError(timeout, signal, '图像服务响应不是有效 JSON。');
  }
}
