# pi-image-kit

**非官方、独立实现的 pi 移植，不是 fork。生成、绝对路径与 recent 编辑：mock 实现完成；真实验收未执行，issue 不应关闭。**

固定基线：OpenAI Codex CLI **0.160.0**，commit [`a956835d020762cb2b570053af06f643a11c0ecc`](https://github.com/openai/codex/tree/a956835d020762cb2b570053af06f643a11c0ecc)。公开 pi API 验收版本：`@earendil-works/pi-coding-agent` **1.1.0**，commit `abe508e1b89912adde45528136c3221eb69acdd7`。初期 Context7 检索网络失败，采用该安装包官方 `docs/packages.md`、`docs/sdk.md`、公开声明及固定源码；#4 已成功 resolve/query `/earendil-works/pi`，交叉确认 `getBranch()` 与 details 持久化用法，精确 1.1.0 normalize 行为仍以固定源码为准。

## 安装与配置

这是标准 pi package，manifest 仅发现一个 `image_generate` 与一个完整 `imagegen` skill。`package.json` 的 `pi-image-kit` 只是本地标识，`private: true`；npm 包名及发布策略未决定，未发布。

```sh
pi install /absolute/path/to/pi-image-kit
```

在 pi agent 目录（通常 `~/.pi/agent`）建立 **私有** `image-kit.json`，或在项目 `.pi/image-kit.json` 配置；项目字段覆盖全局字段。配置一次即可，无需每次操作 CLI 或环境变量。不要把密钥粘贴进聊天、提交配置，或移植 ChatGPT 登录。

```json
{
  "endpoint": "https://images.example.invalid/v1",
  "apiKey": "YOUR_LOCAL_BEARER_KEY",
  "timeoutMs": 120000,
  "exposure": "direct"
}
```

`endpoint` 是 API 基址，tool 追加 `/images/generations`；Bearer key 仅放 Authorization。默认保存 `<当前工作目录>/.pi/images/`；可配置 `saveDirectory` 为绝对目录或 `false`。项目忽略规则覆盖配置与默认生成产物，自定义目录需自行忽略。HTTP 错误只显示状态、timeout/网络/JSON 错误为固定消息，不回显服务响应、私有 endpoint、key 或原始异常。此范围不是对任意外部扩展/格式的全面安全承诺。

## 会话使用与模型

自然语言示例：“生成一个透明背景的蓝色圆点，使用 gpt-image-2.5-sunburst。”skill 默认引导同一 `image_generate`，保留完整提示、检查和迭代指导，不自动启动 Python/CLI。

输入：官方 `prompt`、可选 `transparent_background`；授权扩展 `model`。模型选择记录字段 `model_source`（`user`/`agent`）和 `model_selection_basis` 是 pi 适配，不伪称官方字段。

- 用户显式 `model` 原样优先；默认来源 `user`。
- agent 选档必须标 `model_source: "agent"` 并给出真实任务依据；无依据默认 `gpt-image-2.5`。
- 初始候选：`gpt-image-2`、`gpt-image-2.5`、`gpt-image-2.5-flare`、`gpt-image-2.5-sunburst`；无已验证的能力、价格或速度排名。
- 候选之外策略待用户确认；集中临时 gate 明确“本次未发送请求”，不是永久拒绝/接受决策，也未在 schema 固化四值 enum。

无编辑引用时发送官方 JSON generation 契约：`prompt`、原样 `model`、`background: transparent|opaque`、`quality: auto`、`size: auto`，不发送 `n`。对扩展模型不编造参数差异。

仅消费第一项 `b64_json`，第一项不可用即错误，不跳过取后项。返回真正的 pi image content，不是 Markdown 链接；PNG/JPEG/WebP 可展示。成功保存才给路径，落盘失败仍返回图片与 warning。透明参数已发送、服务报告、像素效果验证分别记录；`verified` 当前始终 false，不将服务报告当透明效果保证。任何失败均不换模型、认证、请求路线或 CLI，也不重试。

## 普通与 deferred 部署

普通安装默认 `direct`，不依赖任何本机旧扩展或 TOML。标准 loader 对重复 package 路径按身份去重，发现/激活不再次注册。

- 当前 pi 内置 `tool_search`：显式配置 `exposure: "deferred"`，启用内置搜索，即可搜索并激活已注册 tool；重启会话以重读 exposure。SDK 不默认加载内置搜索，测试使用公开 `createToolSearchExtension()`。
- 已有 `pi-tool-search` 的 TOML 模式：保留 `direct`，由其 `[tools] deferred = ["image_generate"]` 隐藏/发现。已通过其**真实公开实现**在隔离配置下完成关键词搜索、重复 `select:image_generate`、生成闭环；不是自写替代搜索器。两套搜索模式不能混为一谈。
- 已有另一个 `image_generate`：先通过 pi 配置禁用/替换旧 extension，再启用本包。两个不同实现同名不是 package 路径去重；本包不会偷偷抑制旧 tool、猴补注册表或修改用户部署。旧 multipart/Markdown 结果不符合本包契约，不沿用。

## 完整资源与审计

`vendor/codex-0.160.0/`：29 个公开源材料，包含完整 12 文件 imagegen skill、两份 Python 脚本、五份 references、agents、两份 assets、skill LICENSE，以及请求/tool 源码、根 LICENSE/NOTICE。不可变原样快照；原始上游图片是公开资源，不是实际生成图。

`skills/imagegen/`：完整运行资源。适配 `SKILL.md` 与 `references/cli.md`，有 prominent modified 标识；两份脚本与其它资源逐字保留。完整原 Markdown 仍在 vendor。`resources.json` 列固定来源 URL、Git blob SHA1、SHA256、大小、运行副本映射及修改说明；`NOTICE` 保留完整上游告知并记录适配。许可 Apache-2.0。升级须 review，不追 latest。

```sh
pnpm audit:resources
pnpm check
pnpm test
# 可选：提供已安装公开 pi-tool-search 的 src/extension.ts；只用临时 TOML，绝不读取/迁移个人配置
PI_IMAGE_KIT_LEGACY_SEARCH_SOURCE=/absolute/path/to/public/pi-tool-search/src/extension.ts pnpm test
```

公共资源审计 command 检查完整清单、hash、Git blob 与 modified 标识；测试实际破坏临时副本，验证缺件、快照改动、未标记修改和意外文件会失败。开发依赖按锁文件安装。本机 fresh install 当前被 pi 1.1.0 的 minimum-release-age 策略与未批准 dependency build scripts 阻塞；机器生成的 age-exclude 配置不入库，不擅自批准/绕过。#4 合入 #5 时，已有依赖下曾完整测试 78/78（含旧部署专项）通过；不代表 fresh install 策略通过。review 修复后，直接 `node --import tsx --test tests/*.test.ts` 默认并行全套 **81 通过、0 失败、1 skip**（未设置旧搜索源码），旧搜索专项另跑 **1/1**；typecheck、29 snapshot / 12 runtime 资源审计通过。既有 30ms timeout flake 已修复：review 六 worker 曾复现 30 项中 7 失败；现在请求头挂起用 500ms，并区分连接前 abort（0 请求）与已到达（最多 1 请求），响应体挂起用 1000ms、显式 flush headers 并核对场景已到达。相同六 worker 复核 **30/30** 通过，保持 timeout、不重试和不 fallback；不是生产超时实现损坏或无限调大 deadline 的结论。

## 已验收与未验收

默认 tool 防 CLI 回退测试同时隔离 `process.cwd()` 与 `PI_CODING_AGENT_DIR`，检查 loader errors；只用测试自建无效全局/项目配置验证污染不会进入隔离会话，不读取真实个人配置。新增 skill 一致性回归确认任意模型选择均不是 CLI 授权、交付只 copy 并保留受追踪原图；公开 session 验证“生成→copy 项目交付→recent”仍发送原图而非缩放预览。

最高层公开 seam：隔离 `createAgentSession` + 标准 package/resource loader + `session.prompt()` + 内存 session/credentials/settings + 公开 scripted provider + localhost fake Images HTTP。真实走发现、schema、HTTP、会话输出与图片 normalize；只替代外部 LLM 和 Images 服务，不 mock 内部实现。

mock 覆盖四模型显式选择、默认与 agent 依据、透明参数、首图显示/保存、保存失败、禁用保存、401、请求头/响应体 timeout、首项不可用、无效/future edit 参数不发请求、dummy secret 可见边界、普通/新版 deferred/已部署旧搜索。recent mock 先真实生成再续改，覆盖最近1/5、3001×1原图与不同内容/尺寸的 pi normalize 预览、最新五张 chronological 顺序、活动分支切换、保存失败 base64、文件替换 hash 拒绝与外部预览来源限制；实际 capture JSON edit 的 data URL，不以数组截取测试代替会话闭环。普通可移植测试不设置旧源码路径时，旧部署专项明确 skip，不伪称其运行。

**真实 Images、真实 LLM 自主自然语言发现、真实 gateway 兼容、透明效果均未执行/未验证。** 真实验收须先单独确认费用、网络、提示/图片数据发送范围，再在新的 pi 会话执行；mock 不能代替真实证据。不提交私人 session、URL、key 或生成图；不关闭 issue。

## 后续公共 seam 与范围

- `src/tool.ts` 的 `createImageTool()`：唯一入口，支持新图及 #3 绝对路径编辑。例如“修改 `/绝对路径/图片.png`，背景透明”：传 `prompt`、`referenced_image_paths: ["/绝对路径/图片.png"]`、`transparent_background: true`；最多五张，按输入顺序发送官方 JSON `images/edits`。按文件内容解码且不缩放，PNG/JPEG/WebP 保留原字节，其余可解码格式转 PNG；相对路径、不可读取/解码、超量及与 recent 冲突均不发请求。无路径也无 recent 才保持 generation；空路径数组按无路径处理。“修改最近一张/五张图片”传 `num_last_images_to_include: 1` / `5`，从 `ctx.sessionManager.getBranch()` 活动分支取最新图片，按选中图片时间顺序发 JSON edits；非当前分支不混入。数量仅一至五整数，历史不足报错，互斥/无效引用不发请求（包括 pi 会转换的原始小数/字符串参数），不降级生成。#3 mock 经公开 session/fake HTTP 验证；真实 JSON edits 兼容与透明效果未验证。
- `src/config.ts` 的 `loadConfig()`：共同配置与认证；`requestImage()`：JSON `generations`/`edits` 共享传输，没有 multipart 或 CLI fallback。
- `src/output.ts` 的 `imageOutput()`：统一第一项 image content、保存与 warning。`details.original` 标记本包 source/version、MIME、SHA256，成功保存时是原图路径，失败/禁用保存时留原始 base64；`src/recent.ts` 仅对本包对应工具调用结果信任该记录，验证 source/version/hash 后取原字节；路径替换/失效拒绝，不自动用预览。外部图或丢失原图记录的图可用现存 image content，并在结果中标记 `references[].source: session-preview` 与 warning，不宣称取得原图；外部工具的 original/path 不被读取。自动 normalize 保留 details；任意其它扩展仍可能替换 details，来源字段不是防恶意扩展的签名，不承诺通用宿主保证。
- #5 已实现明确选择 CLI 门与 localhost 完整脚本闭环，详见下节。原脚本默认 `gpt-image-2` 未修改，不表示 pi CLI 默认决策已定。
- 真网关 JSON edits、透明支持、multipart 策略、候选外模型与 CLI 默认仍待确认；只 gate 受影响分支。

## #5：明确选择完整官方 CLI

默认仍使用 tool。失败、批量需求、model 选择都不授权 CLI；skill 主动说明可选路线并等待明确选择，再单独确认费用、网络、提示/图片/mask/批量材料发送范围。两个确认标志记录这些确认，不是自动推断用户同意。参考 `skills/imagegen/references/cli.md` 的 pi 执行段。

配置本地 `OPENAI_BASE_URL` 与 `OPENAI_API_KEY`，然后在授权后执行：

```sh
node /absolute/package/scripts/run-image-cli.mjs --choose-cli --allow-network-data-cost -- \
  generate --prompt "公开测试蓝点" --model gpt-image-2.5 \
  --quality high --out output/imagegen/dot.png
```

入口用 uv 管理 `openai==2.30.0`、`pillow==12.1.0`，直接执行固定 Codex **0.160.0 / a956835d020762cb2b570053af06f643a11c0ecc** 的完整官方 `image_gen.py`，未修改脚本；支持原有 generate/edit/generate-batch、model/mask/quality/n/size 等参数。endpoint 与 Bearer 由受控子进程环境注入，无 ChatGPT 登录。命令入口不继承个人 OpenAI/代理配置；程序调用的 `environment` 由调用方显式提供，不能视为任意调用方都自动隔离。失败不会启动其它 CLI、换模型或认证。完整上游 chroma helper 仍保留，未自动使用。

`tests/cli.test.ts` 实际运行脚本，通过 localhost fake Images 服务验收生成、独立显式 `gpt-image-2.5-sunburst`、`gpt-image-2.5` mask 编辑、`gpt-image-2.5-flare` 双任务异步 batch，检查质量、Bearer、模型 ID、真实 PNG 输出字节。测试隔离 HOME、dummy key 与环境，只发送公共合成样本；通过 uv 公共 PyPI 下载依赖，缓存为临时目录。此为 mock 服务验收，不是只检查 help/解析；不证明真网关 multipart/透明或默认 tool JSON edits 兼容。测试不省略 Python 闭环，依赖下载失败明确失败。

本票还验证直接/符号链接入口、两项独立授权、缺失配置、污染父环境、size/n 透传及 CLI 401 不换模型/认证/路线；`tests/cli-no-fallback.test.ts` 用真实公开 session 与 PATH uv 哨兵验证默认 tool 失败、批量、显式 model 都不启动 CLI。scripted provider 不等于真实 LLM 自主理解。

2026-10-08 合入 #3 integration `361fecc37519044f4ddf02cc6bacb3e52bb94f7e` 后验收：串行全套 **56 通过、0 失败、1 skip**（未配置旧部署源码专项）；typecheck、29 snapshot / 12 runtime 资源审计通过。合入前一次并行全测因既有 30ms timeout 未捕获请求失败，串行复测通过，未修改共享测试或 timeout。pnpm scripts 前置安装仍报 release-age 策略阻塞；实际脚本可在已有依赖运行，不算 fresh 安装通过。

**真实 CLI API 验收未执行，不算通过。** CLI 默认是否改为 2.5 仍未决，保留官方 `gpt-image-2`/`medium` 不等于策略定案；真实费用/网络/数据授权未取得。Context7 本次 resolve 失败（fetch failed），依据固定官方源码记录，不声称 online query 成功。fresh Node 安装仍未验收，使用已有 ignored 依赖链接，不绕过 pnpm age/build 策略。
