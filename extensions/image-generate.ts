import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { loadExposure } from '../src/config.ts';
import { createImageTool } from '../src/tool.ts';

export default async function imageKit(pi: ExtensionAPI): Promise<void> {
  // 只注册一次；包路径去重与工具冲突由 pi 处理，进程标志不能去重另一个旧实现。
  pi.registerTool(createImageTool(await loadExposure(process.cwd())));
}
