# Agent Note: tool-cordis 共享 Host inspect provider

Status: implemented

[English](2026-08-25-tool-cordis-shares-host-inspect-providers.md) | 中文

## 问题

Agent preset 在逐 agent 上下文中挂载 `tool-cordis`，而 `cordisInspect` 只拥有一个进程级 Host provider 注册表。如果每个工具集实例都注册 `Service`、`Event`、`Builtin` 和 `Tool`，第二个存活的 Creator Session 会因这些 provider id 已被第一个会话占用而无法激活 preset。

## 决策

`tool-cordis` 按 `ctx.root` 保留一组 Host provider。第一个存活实例注册这些 provider，后续实例递增根作用域引用计数，只有最后一个 disposer 才撤回这组注册。`Tool` provider 捕获进程所有的工具注册表，而非逐 agent 的 Context，因此创建共享 provider 的实例先于其他持有者卸载时，该 provider 仍然有效。

Host 注册表继续拒绝重复 id。共享是 `tool-cordis` 内部的所有权规则，并非允许无关 provider 相互遮蔽或替换的一般规则。

## 曾考虑的替代方案

**让 `CordisInspectRegistryService` 接受重复 id。** 否决，因为这会隐藏真正的组合冲突，并使查询所有权取决于注册顺序。

**把这些 provider 移入 `cordis-host-runner`。** 否决，因为 Service 与 Event provider 依赖面向模型的工具包所拥有的生成 API 目录；移动它们会颠倒该所有权，并让 runner 耦合到一个 Consumer 的参考数据。

## 后果

多个 Creator Session 可以在同一 DSH 进程中同时保持 Cordis preset 挂载，而不会阻止新会话创建。卸载一个会话不会移除其他会话仍在使用的 inspect provider；卸载最后一个工具集实例后则不会遗留全局注册。聚焦生命周期测试固定了共享、最终释放、幂等释放，以及存在真正冲突 provider 时的回滚行为。
