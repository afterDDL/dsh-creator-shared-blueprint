# Agent Note：可叠加 Sidebar 导航 section

状态：已实现

[英文](2026-08-31-additive-sidebar-navigation-sections.md) | 中文

## 问题

外部 client 插件可能需要在 Workspace 和 Session 浏览器之上持续显示 navigation 或 roster 表层。Interactive Blueprint 增加了一个单实例 `sidebar.agents` 席位，其名称与归属都预设了 Agent roster。这阻止了不相关的高级插件共享该位置，并使 Core patch 描述某个消费方，而不是 Sidebar 能力。

## 决定

`@deepseek-ai/dsh-client-ui-sidebar` 拥有有序的 root 作用域列表 slot `sidebar.navigation.section`。每个注册都提供稳定 `id` 和可选 `order`；slot ledger 拒绝重复 id，并以确定顺序排列独立 section。Section 会收到 `SidebarNavigationSectionProps`，其中包含外壳稳定后的 `wide` 状态与 `expandSidebar()`。该回调只从轨道状态展开，因此宽态 section 不会意外收起栏。

外壳在 New Session 与 `sidebar.workspaces` 之间渲染该列表。Workspace 浏览器仍然是填满剩余空间的滚动区域，Settings 仍固定在底部。Section 组件在收起期间保持挂载，并在 `wide` 为 false 时自行选择渲染轨道控件还是不渲染。外壳不推断业务数据、selection、badge 或 navigation 行为。

该 slot 随 sidebar shell 声明。插件使用 `ctx.slots.inject` 以在该声明之前或之后启动；注册与移除都是普通 effect。释放一个插件只会移除它自己的 id，并保留 sibling section、Workspace 浏览器与 shell 控件。该 slot 不持久数据。refresh 或 restart 后，恢复的插件会重新注册，并通过自己的 service 取得持久状态。关闭或展开 sidebar 只影响布局，不取消 section 的业务生命周期。

## Blueprint 迁移

Interactive Blueprint 把 Agent roster 以 `id: 'blueprint-agents'` 注册到 `sidebar.navigation.section`，并使用 `SidebarNavigationSectionProps` 标注组件。它保留 `order: 0`，并继续在轨道状态返回空。Agent selection、roster 加载与用户可见文案不变。

## 考虑过的替代方案

**保留单实例 `sidebar.agents`。** 拒绝，因为 Agent 展示只是一个消费方，第二个 navigation 功能将被迫替换它或 patch 另一个位置。

**让插件替换完整 `sidebar` owner。** 拒绝，因为替换会移除 New Session、Workspace 浏览、Settings、折叠编排与所有子席位。

**把功能行放进 `sidebar.workspaces`。** 拒绝，因为 ui-workspace 拥有浏览、搜索、分组与 dialog；不相关的 navigation 状态会与该包耦合。

**收起时隐藏所有贡献。** 拒绝，因为通用插件可能拥有有意义的轨道控件。Entry 通过 `wide` 拥有该展示选择。

## 后果

任意 client 插件都可以在不导入 Blueprint 的情况下增加有序 sidebar navigation section。非 Blueprint 的 `external-navigation-sections` 测试会在 shell 声明之前启动，注册 project-index 和 runtime-monitor section，证明顺序，并释放两者，而不改变 Workspace 或 Settings 席位。Sidebar DOM 测试证明每个 section 都会收到 wide 状态与仅轨道有效的展开动作。

该列表不仲裁紧缺的垂直空间。消费方必须保持 section 紧凑，提供稳定 id，并避免复制 shell 或 Workspace 浏览器已经拥有的控件。
