# Agent Note：默认 Conversation 详情表层

状态：已实现

[英文](2026-08-31-default-conversation-details-surface.md) | 中文

## 问题

面向 Session 的 client 插件可能需要在未选中临时 Tool 调用时，在右栏持续显示 inspector。Interactive Blueprint 给 conversation 详情壳层增加了私有默认分支，并依赖提前到达的布局打开请求。如果没有已记录的公共席位，其他 inspector 只能替换完整 `details` 栏，或 patch Blueprint 的面板注册。

## 决定

`@deepseek-ai/dsh-client-ui-conversation` 拥有 Session 作用域的单实例 slot `conversation.details.default`，并导出 `ConversationDefaultDetailsProps` 作为其标准 runtime props。Conversation 详情壳层只在共享 selection store 中没有 Tool target 时渲染该 slot。Tool selection 会临时渲染现有 `conversation.details.tool` 路径；清除 selection 会恢复同一个默认 slot entry 及其作用域组件状态。

该 slot 在 ui-conversation 正常启动期间由 `details` entry 声明。消费方使用 `ctx.slots.inject`，因此可以在该声明之前或之后启动，其注册 disposer 只移除自己的表层。消费方缺席或被卸载时，ui-conversation 会提供可用的 fallback，包含普通详情标题、空状态与关闭动作。单实例 slot 的冲突规则会拒绝两个同时存在的默认 owner，而不是按加载顺序选择。

`@deepseek-ai/dsh-client-ui-layout` 通过 `ctx.layout` 拥有布局几何。`openDetails()` 与 `closeDetails()` 在 AppFrame 连接 store actions 前只保留最后一条提前请求。这让展示插件能够在不依赖 React 挂载顺序的情况下打开已注册表层。连接完成后，调用会立即生效，重复 open 保留用户当前的宽度。

两个包都不持久功能数据。默认 entry 经标准 Session 钩子或自有 service 读取持久状态，并在 refresh 或 restart 后重建该状态。布局几何特意保持为瞬时状态；被恢复的消费方可在注册时申请打开。Cancel 和 unload 会释放 slot 贡献，但不修改 Session 数据。显式 close 只影响布局几何，不取消消费方生命周期。

## Blueprint 迁移

Interactive Blueprint 使用 `ConversationDefaultDetailsProps` 标注其右栏面板，通过 `conversation.details.default` 注册它，并在 slot 注册变为活跃后请求 `ctx.layout.openDetails()`。Tool 详情仍然会取代 Blueprint 面板，清除 Tool selection 后恢复它。不改变 Blueprint 状态、selection、RPC 或用户可见文案。

## 考虑过的替代方案

**暴露完整 `details` 栏。** 拒绝，因为替换 owner 会删除已有 Tool 详情席位、共享 selection store、关闭接线与 locale 组装。

**给 layout 增加 Blueprint panel API。** 拒绝，因为 layout 拥有布局几何，不拥有业务表层或其数据。

**按插件加载顺序选择默认表层。** 拒绝，因为两个 inspector 会产生不确定的归属。现有单实例 slot 冲突是明确的部署错误。

**在功能插件中持久面板几何。** 拒绝，因为宽度与开关状态归 shell 所有，功能持久会创造竞争的权威。

## 后果

任意 Session inspector 都可以在不导入 Blueprint 的情况下占用默认详情表层。非 Blueprint 的 `external-session-inspector` 测试会在 ui-conversation 之前启动，在 slot 声明后落位，接收作用域 Session id，申请打开，然后卸载，并证明内建的可关闭 fallback 已恢复。

该 seam 只负责展示。它不增加 navigation、数据加载、cancel 或 Session ownership。需要持久状态的消费方必须已经拥有该状态，并且独立于 slot 注册恢复它。
