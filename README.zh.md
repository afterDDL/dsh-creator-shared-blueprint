# Shared Blueprint

[English](README.md) | 中文

针对creator模式设计的插件。

一个让用户与 AI 共同理解、讨论和塑造 DeepSeek Harness agent（智能体）的共享界面。

**Interactive Preview · v0.1.0-beta.1**

Shared Blueprint 将难以理解的agent创建过程，转化为用户和 AI 都能看到、指向、讨论和修改的结构。Interactive Preview 支持在结构化页面中，从自然语言请求到可用 agent 的完整创作路径，并可添加经过验证的 Skill 和 Subagent。

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

用自然语言创建 Agent：描述你想完成的任务，AI 会逐步将需求整理成可见的结构化 Agent Blueprint。
和 AI 看着同一张 Blueprint 讨论：直接选中「角色、目标、能力、规则、输出」中的任一部分，围绕具体节点继续提问、澄清或调整。
在真正修改 Agent 前确认变化：AI 会先生成 Proposal，明确展示准备修改的内容，由你确认后再 Apply。
持续给 Agent 扩展能力：在结构化页面中，用自然语言创建 Skill 或添加协作 Agent；新增能力会直接回到 Blueprint 中，即使 Agent 逐渐变得复杂，结构和能力变化仍然清晰可见。
直接试运行刚刚搭好的 Agent：点击 Try Agent，用当前 Blueprint 启动真实会话，验证刚刚看到、修改和新增的能力是否真正进入运行状态。

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
