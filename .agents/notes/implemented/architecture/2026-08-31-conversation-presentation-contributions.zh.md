# Agent Note：Conversation 展示贡献

状态：已实现

[英文](2026-08-31-conversation-presentation-contributions.md) | 中文

## 问题

外部 workflow 插件可以在用户可见 Session 内执行施工，同时保留施工前后的普通对话。它必须隐藏内部 context 和 Tool 调用，保留 assistant 问题与回答，并用 workflow 自己的状态取代通用 reasoning 活动提示。Interactive Blueprint 把这些选择编码在临时 Chat Node 字段中，字段名直接描述其 Creator 和配置行为。其他插件只能通过复制这些私有字段值复现该行为。

## 决定

`@deepseek-ai/dsh-client-ui-conversation` 拥有通用 `ConversationTurnPresentationData` 贡献。插件通过声明合并增加强类型 Chat Node，经 `ctx.conversationEvents` 注册其 node definition，并从持久证据投影三种作用于整个轮次的可见性指令之一：`hidden`、`human-input-only` 或 `hide-context-and-tools`。Snapshot builder 用固定的最强优先顺序组合一个 Turn 内的所有指令。因此，增量 append、分页 prepend 和完整重建会得到相同的可见 node，且不依赖插件注册顺序。

`activity: 'consumer-owned'` 指令只转交开放 Turn 的用户可见运行指示。ChatView 会抑制通用 `Deep diving...` 指示，生产方则经 `ctx.conversation.blocks` 提供带有 `activityPresentation: 'consumer-owned'` 的本地化状态。Session 日志和 reasoning 数据始终完整。如果生产方隐藏 transcript 却未声明活动归属，它仍然获得通用运行指示。

带有 `presentation: 'internal'` 的持久 context source 仍是一条与生产方无关的完整 Turn 隐藏指令。该标记在 refresh 和移除插件后仍然有效，因为基础 Conversation 投影会直接理解它。自定义 Turn 指令从生产方的持久事件派生；被移除的插件不再贡献可选投影，但不能删除或损坏底层日志。

注册遵循现有 Conversation Node 生命周期。Node definition 是 effect，在贡献 client 插件启动时可用，并在其 context 释放时消失。没有独立的启动注册表，也没有持久 UI schema。restart 或 refresh 后，生产方的持久 Session 事件会重建其 Chat Node 与指令。Cancel 归生产方生命周期所有：它记录或观察终态事件，清除 composer block 或外部 interaction，再让投影重算。UI 代码永远不强制 `turn/end`。

## Blueprint 迁移

Interactive Blueprint 把持久 Creator 证据映射为 `hide-context-and-tools`，因此普通 Think 和 assistant 对话仍然可见，内部 context 和 Tool 调用继续隐藏。Capability routing 与 repair 映射为 `human-input-only` 加 consumer-owned activity，同时使用它们现有的 composer block 展示本地化配置状态。现有外部 `PendingInteraction` 注册表继续把 assistant 问题带回 source Session，不改变响应归属。

不改变 capability transaction、Source Creator topology、事件 vocabulary 或用户可见文案。迁移只重命名 `ui-conversation` 消费的通用展示数据。

## 考虑过的替代方案

**保留 Blueprint 专用 marker 字段。** 拒绝，因为其他 workflow 需要依赖 Blueprint vocabulary 或复制未记录的结构检查。

**在渲染后过滤 DOM 元素。** 拒绝，因为增量投影和 refresh 投影可能不一致，被隐藏 node 仍会影响分组与 location，而且 accessibility 输出仍会保留施工内容。

**隐藏施工 Turn 的所有 assistant 输出。** 拒绝，因为这会把面向用户的问题和普通 assistant 对话与内部施工一起移除。

**在 workflow 提问或改变状态时结束 Turn。** 拒绝，因为展示不拥有 runtime 结算，强制终态会破坏同 Session 继续执行。

## 后果

任意 client 插件都能在不导入 Blueprint 的情况下控制 transcript 投影和运行状态归属。Core 测试注册一个 `external-workflow-presentation` dummy Chat Node，证明增量与 refresh snapshot 下可见性收敛，并证明通用运行指示会让位于外部 workflow 状态，同时 pending question 仍然可见。

该贡献只负责展示。插件必须继续以自己的持久生命周期为权威，从该生命周期恢复任何内存 interaction 或 composer block，并在结算或取消时清除它们。`ui-conversation` 不会从该指令推断 workflow 成功、重试或归属。
