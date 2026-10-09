# PR #6 凭据安全与 CI 实现记录

## 目标
- 用户要求快速修复项目 endpoint 隐式继承全局 API key，并建立 CI；沿用前次「安全则合并」授权。
- 工作目录 `/tmp/pi-image-kit-integration`，父提交 `84f3a6fb7a7bfe04030115e12a7adfaf8dfc0ffe`；主工作副本的用户本地修改保持原样。

## 决策与原因
- endpoint 与凭据作为同一信任边界；项目变更 endpoint 且未明确提供项目 key 时，必须请求前拒绝，不能转发全局 key。
- CI 只运行公共合成 mock，检查类型、固定资源与回归测试；不配置真实服务凭据，不发真实 Images 请求。
- 复用现有开发依赖进行本地回归不等于 fresh install；CI 使用锁文件干净安装，实际运行结果才可证明干净安装成功。
- Context7 官方文档 resolve 两次 fetch failed，后续查固定官方 action 文档；不把失败描述为已查到文档。

## 进展
- jj 身份一致、集成工作区初始干净、无敏感配置文件；既有 ignored node_modules 指向已安装开发依赖。
- 凭据修复：跨 origin、同 origin 不同 base path、全局仅 key 均不允许项目 endpoint 携带全局凭据；等价尾斜杠保留继承。loadExposure 仍不需要凭据。
- 实现代理验证：配置回归修前 9 pass / 11 fail，修后 20/20；非下载四个测试文件 102 pass / 0 fail / 1 skip，公开 session 跨 endpoint 合成攻击为 0 HTTP 请求；类型检查与资源审计通过。
- CI 使用 pull_request/main push，contents:read、checkout 不持久化 token、actions 固定完整 commit SHA；Node 22.23.2、pnpm 12.10.1、uv 0.12.23。只读复核发现额外 workflow_dispatch 不符合执行简报，已移除，保持最小触发范围；未发现其它确定阻断。
- 主执行器独立复跑无下载四个测试文件：102 pass / 0 fail / 1 skip，类型检查与资源审计成功。
- 保留 pnpm 1440 分钟 release-age 严格检查、不加 age 例外；仅精确批准 esbuild@0.28.2 安装脚本，明确禁止 @google/genai 与 protobufjs 的非必要脚本，不关闭 strictDepBuilds。
- 官方 pnpm 文档确认 v12 allowBuilds 格式；setup-node、pnpm/action-setup、setup-uv 读取固定官方 README。Context7 本次不可用如实记录。
- 初次本机独立干净安装被权限工具拒绝，没有以远端 CI 或子代理绕过；向用户明确列出 npm registry 锁文件依赖与 uv PyPI 固定 CLI 依赖后暂停。用户再次要求更新同一 PR 并在完工后可合并，后续安装与全量测试工具获得许可。
- 首次冻结安装发现 pnpm 12 新增 packageManagerDependencies 元数据未同步。运行 lockfile-only/ignore-scripts 仅添加第一 YAML 文档包管理器及其平台二进制锁；原应用依赖锁第二文档逐字不变。独立空 node_modules 冻结安装随后成功，125 包复用已有内容缓存并克隆，不伪称空 store 下载。
- 全量含 uv CLI mock：本地 105 pass / 0 fail / 1 skip；干净依赖目录按 CI 同样命令复测亦 105 pass / 0 fail / 1 skip，类型检查与资源审计通过。旧搜索专项无公共源码配置时 skip，非默认工具失败。真实 CLI 和其它模型验收范围未扩大。

## Deviations
- 无。
