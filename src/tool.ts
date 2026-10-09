import { Type } from 'typebox';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { loadConfig } from './config.ts';
import { readImageReferences, requestImage } from './images.ts';
import { imageOutput } from './output.ts';
import { readRecentImages, recentImageCount } from './recent.ts';

const candidates = new Set(['gpt-image-2', 'gpt-image-2.5', 'gpt-image-2.5-flare', 'gpt-image-2.5-sunburst']);
const parameters = Type.Object({
  prompt: Type.String({ minLength: 1, description: '完整图像提示；保留用户指定文本与约束。' }),
  transparent_background: Type.Optional(Type.Boolean({ description: '请求透明背景；效果须另行检查。' })),
  referenced_image_paths: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 5, description: '最多五张绝对路径参考图；非空时走 JSON 编辑，与 recent 互斥。空数组沿用无路径语义。' })),
  num_last_images_to_include: Type.Optional(Type.Integer({ minimum: 1, maximum: 5, description: '活动会话分支最近一至五张图，按时间顺序编辑；本包原图校验来源/hash，外部图可能仅有预览。不足即报错，与非空路径互斥。' })),
  model: Type.Optional(Type.String({ minLength: 1, description: '已授权扩展：用户显式模型 ID 原样优先；未指定默认 gpt-image-2.5。候选之外策略待确认。' })),
  model_source: Type.Optional(Type.Union([Type.Literal('user'), Type.Literal('agent')], { description: '模型选择来源。显式用户选择为 user；agent 选择必须附任务依据。' })),
  model_selection_basis: Type.Optional(Type.String({ description: '仅 agent 选档时的任务与已验证依据；没有依据回到默认，不虚构能力、价格或速度。' })),
}, { additionalProperties: false });

// 临时决策门，不是永久模型白名单；未来确认只改此策略，不改输入契约。
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
    description: '生成图片并直接返回 image content。用户显式模型优先；无任务依据默认 gpt-image-2.5，模型 ID 原样发送。支持请求透明背景，实际效果未知需检查。支持最多五张绝对路径原图的 JSON 编辑；支持活动会话分支最近一至五张图续改；本包原图校验 hash，外部图按现存预览使用并说明限制。失败不会改模型、认证或启动 CLI。',
    promptSnippet: 'Generate raster images, optionally request a transparent background.',
    promptGuidelines: ['Read the imagegen skill for prompting, inspection and iteration. Use this tool by default, not CLI.', 'Preserve the user’s explicit model exactly. For agent selection set model_source=agent and supply verified task basis; otherwise omit model for gpt-image-2.5. No known capability, price or speed ranking.'],
    parameters,
    async execute(_id, args, signal, _onUpdate, ctx) {
      const count = recentImageCount(ctx.sessionManager, _id, args.num_last_images_to_include);
      const paths = args.referenced_image_paths ?? [];
      const hasReferences = paths.length > 0;
      if (hasReferences && count !== undefined) {
        throw new Error('绝对路径参考图与 recent 引用互斥；本次未发送请求。');
      }
      const model = selectModel(args);
      const recent = count !== undefined
        ? await readRecentImages(ctx.sessionManager, count)
        : undefined;
      const images = recent?.images ?? (hasReferences ? await readImageReferences(paths) : undefined);
      const config = await loadConfig(ctx.cwd);
      const transparent = args.transparent_background ?? false;
      const response = await requestImage(
        config,
        images ? 'edits' : 'generations',
        {
          prompt: args.prompt,
          model,
          background: transparent ? 'transparent' : 'opaque',
          quality: 'auto',
          size: 'auto',
          ...(images ? { images } : {}),
        },
        signal,
      );
      const output = await imageOutput(response, model, transparent, config.saveDirectory);
      if (!recent) return output;
      return {
        ...output,
        content: [...output.content, ...(recent.warning ? [{ type: 'text' as const, text: `Warning: ${recent.warning}` }] : [])],
        details: { ...output.details, references: recent.references, ...(recent.warning ? { referenceWarning: recent.warning } : {}) },
      };
    },
  };
}
