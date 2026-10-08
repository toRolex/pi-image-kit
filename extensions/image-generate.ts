import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { loadExposure } from '../src/config.ts';
import { createImageTool } from '../src/tool.ts';

export default async function imageKit(pi: ExtensionAPI): Promise<void> {
  // Register exactly once. pi owns package path de-duplication and tool conflicts;
  // do not pretend a process-wide flag can dedupe another legacy implementation.
  pi.registerTool(createImageTool(await loadExposure(process.cwd())));
}
