# pi-image-kit

在 pi 中生成图片、编辑本地图片，或继续修改会话里的最近图片。非官方、独立实现的 Codex imagegen 移植。

## 安装

```sh
pi install git:github.com/toRolex/pi-image-kit@v1.0.0
```

如果已有同名 `image_generate` 生图扩展，先用 `pi config` 禁用旧扩展，只保留本包。

## 配置

创建 `~/.pi/agent/image-kit.json`，填入你的服务地址和 Bearer key：

```json
{
  "endpoint": "https://images.example.invalid/v1",
  "apiKey": "YOUR_LOCAL_BEARER_KEY"
}
```

`endpoint` 填 API 基址，不要带 `/images/generations` 或 `/images/edits`。不要把配置或密钥提交到仓库、粘贴进聊天。

配置完成后，重启 pi 会话。

## 使用

直接对 pi 说：

```text
生成一张透明背景的蓝色小猫。
把 /绝对路径/图片.png 里的蓝色改成绿色。
把最近一张图片的背景改成白色。
```

图片会显示在会话中，默认保存到当前项目的 `.pi/images/`。路径编辑和最近图片续改最多引用五张图；路径必须是绝对路径。

## 注意事项

- 默认模型是 `gpt-image-2.5`。也可明确指定 `gpt-image-2`、`gpt-image-2.5-flare` 或 `gpt-image-2.5-sunburst`；其它模型的使用策略尚未确定。
- 已在单一服务与 `gpt-image-2.5` 组合上验证生成、单图编辑、recent 单图续改和透明像素。其它组合未做真实验收，透明效果取决于服务支持。
- 默认走 `image_generate` 工具，失败不会自动重试、换模型或回退 CLI。完整 CLI 须明确选择，并另行确认联网、数据和费用；真实 CLI 尚未验收。
- 项目可用 `.pi/image-kit.json` 覆盖配置。项目更改服务地址时，必须同时提供该项目的 `apiKey`，不会继承全局密钥。

更多配置、deferred 搜索、CLI 和开发检查见 [技术说明](docs/technical-details.md)；真实测试范围见 [验收记录](docs/verification-2026-10-09.md)。

基于固定的 Codex CLI 0.160.0 公开资源，许可 [Apache-2.0](LICENSE)，上游声明见 [NOTICE](NOTICE)。从 GitHub 安装，未发布 npm 包。
