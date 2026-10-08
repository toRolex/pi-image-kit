# pi-image-kit

> **状态：尚未实现。** 等待用户发布 spec 后开工。

pi 的**非官方移植**（unofficial port）。基线为 [Codex CLI 0.160.0](https://github.com/openai/codex/commit/a956835d020762cb2b570053af06f643a11c0ecc)（官方 commit `a956835`）。

## 计划范围

- 提供 tool
- 打包完整 skill 资源及脚本

## 配置与模型

- endpoint、Bearer key 均可配置
- 默认模型 `gpt-image-2.5`
- 候选模型（四个）：`gpt-image-2`、`gpt-image-2.5`、`gpt-image-2.5-flare`、`gpt-image-2.5-sunburst`
- 选择优先级：用户显式指定优先；否则由 agent 选择（各档位能力待验证）

## 未决

以下尚未定案，不在本阶段承诺：

- CLI 默认模型
- 编辑（edit）的 multipart 适配
