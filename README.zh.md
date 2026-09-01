# Shared Blueprint

[English](README.md) | 中文

一个让用户与 AI 共同理解、讨论和塑造 DeepSeek Harness agent（智能体）的共享界面。

**Interactive Preview · v0.1.0-beta.1**

Shared Blueprint 将 agent 转化为用户和 AI 都能看到、指向、讨论和修改的结构。Interactive Preview 支持从自然语言请求到可用 agent 的完整创作路径，并可添加经过验证的 Skill 和 Subagent。

这是一个正在持续进行压力测试和兼容性加固的可运行 beta 版本，不代表稳定版、生产就绪或 DeepSeek 官方插件。

## 获取预览版

| 入口 | 适用对象 | 状态 |
|---|---|---|
| Try Demo | 希望在线快速体验的用户 | 尚未托管；不会用占位 URL 冒充 Demo。 |
| [Complete Build](release/interactive-preview/INSTALL.md#complete-build) | 希望用最短路径运行产品的用户 | 推荐入口，包含兼容的 DSH build 与 standalone bundle。 |
| [Standalone Bundle](release/interactive-preview/INSTALL.md#standalone-bundle) | DSH 插件与生态开发者 | 需要使用文档指定的 DSH compatibility checkout。 |

## 运行

最短的受支持启动路径请使用经过验证的 [Complete Build 命令](release/interactive-preview/INSTALL.md#complete-build)。

### 从源码运行

如需使用 packaged add-on 运行确切的兼容源码 checkout，请遵循 [Standalone Bundle 命令](release/interactive-preview/INSTALL.md#standalone-bundle)。

## 可以做什么

- 通过自然语言创建 agent。
- 查看语义 Blueprint，并选择其中节点与 AI 讨论。
- 在 Apply 修改正式 agent 前审阅 Proposal。
- 通过隔离 authoring 与验证后发布添加 Skill 或 Subagent。
- 启动 Try Agent 并使用生成的运行时。

## 兼容性

Shared Blueprint 产品以仓库外 `dsh-shared-blueprint` 包形式发布。上游 DSH `0.1.0-rc.7` 尚未提供这类高级 authoring 插件需要的全部通用扩展点，因此 Complete Build 内含已冻结的兼容性修改。未经修改的官方 `0.1.0-rc.7` 加 bundle 不是受支持的组合。详见[兼容性](release/interactive-preview/COMPATIBILITY.md)与[架构](release/interactive-preview/ARCHITECTURE.md)。

Inspect Mode 不属于本次发布范围。

## 发布信息

- [安装与运行](release/interactive-preview/INSTALL.md)
- [兼容矩阵](release/interactive-preview/COMPATIBILITY.md)
- [发布说明](release/interactive-preview/RELEASE_NOTES.md)
- [发布 backlog](release/interactive-preview/RELEASE_BACKLOG.md)
- [包约定](packages/bundle/shared-blueprint/README.md)

## 开发

本仓库同时包含构建 Complete Build 所用的兼容 DSH 源码。进行仓库开发前请阅读 [DeepSeek Harness 架构](docs/architecture.md)，并遵守 [AGENTS.md](AGENTS.md)。

## 许可证

[MIT](LICENSE)。第三方依赖及其许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
