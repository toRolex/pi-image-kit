import { Type } from 'typebox';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { loadConfig } from './config.ts';
import { requestImage } from './images.ts';
import { imageOutput } from './output.ts';

const candidates = new Set(['gpt-image-2', 'gpt-image-2.5', 'gpt-image-2.5-flare', 'gpt-image-2.5-sunburst']);
const parameters = Type.Object({
  prompt: Type.String({ minLength: 1, description: '完整图像提示；保留用户指定文本与约束。' }),
  transparent_background: Type.Optional(Type.Boolean({ description: '请求透明背景；效果须另行检查。' })),
  model: Type.Optional(Type.String({ minLength: 1, description: '已授权扩展：用户显式模型 ID 原样优先；未指定默认 gpt-image-2.5。候选之外策略待确认。' })),
  model_source: Type.Optional(Type.Union([Type.Literal('user'), Type.Literal('agent')], { description: '模型选择来源。显式用户选择为 user；agent 选择必须附任务依据。' })),
  model_selection_basis: Type.Optional(Type.String({ description: '仅 agent 选档时的任务与已验证依据；没有依据回到默认，不虚构能力、价格或速度。' })),
}, { additionalProperties: false });

// A temporary decision gate, not a permanent model allowlist. Keep it isolated
// so the future user decision changes one policy seam, not the input schema.
function selectModel(args: { model?: string; model_source?: 'user' | 'agent'; model_selection_basis?: string }): string {
  let model: string;
  if (args.model_source === 'agent' && !args.model_selection_basis?.trim()) {
    model = 'gpt-image-2.5';
  } else {
    model = args.model ?? 'gpt-image-2.5';
  }
  if (!candidates.has(model)) throw new Error('候选外模型策略待用户确认；本次未发送请求。这不是永久拒绝策略。');
  return model;
}

export function createImageTool(exposure: 'direct' | 'deferred' = 'direct'): ToolDefinition<typeof parameters> {
  return {
    name: 'image_generate', label: 'Image generation', exposure,
    description: '生成图片并直接返回 image content。用户显式模型优先；无任务依据默认 gpt-image-2.5，模型 ID 原样发送。支持请求透明背景，实际效果未知需检查。当前 #2 仅新图；#3 路径编辑、#4 recent 将接同一 tool。失败不会改模型、认证或启动 CLI。',
    promptSnippet: 'Generate raster images, optionally request a transparent background.',
    promptGuidelines: ['Read the imagegen skill for prompting, inspection and iteration. Use this tool by default, not CLI.', 'Preserve the user’s explicit model exactly. For agent selection set model_source=agent and supply verified task basis; otherwise omit model for gpt-image-2.5. No known capability, price or speed ranking.'],
    parameters,
    async execute(_id, args, signal, _onUpdate, ctx) {
      const model = selectModel(args);
      const config = await loadConfig(ctx.cwd);
      const transparent = args.transparent_background ?? false;
      const response = await requestImage(
        config,
        'generations',
        {
          prompt: args.prompt,
          model,
          background: transparent ? 'transparent' : 'opaque',
          quality: 'auto',
          size: 'auto',
        },
        signal,
      );
      return imageOutput(response, model, transparent, config.saveDirectory);
    },
  };
}
