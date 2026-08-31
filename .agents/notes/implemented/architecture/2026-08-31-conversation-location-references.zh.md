# Agent Note: Definition 拥有的 Conversation Location 引用

Status: implemented

[English](2026-08-31-conversation-location-references.md) | 中文

## 问题

Conversation projection 插件可能在 source Turn 已关闭后发出持久 replacement 或 marker。其 payload 可以有意省略 Turn 与 Step 坐标，因为这些坐标已经由 source 持久事件拥有。Client Runtime 此前直接识别一种 `user/message` replacement 和一个 presentation metadata 值，因此仓库外 projection 若不修改 Runtime 内部实现，就无法在实时 append、refresh、registry rebuild 或逐步扩展的截断窗口中保留 source Location。

## 决定

`ConversationNodeDefinition.locationReference(event)` 可以为 Definition 拥有的 projection 事件返回一条更早持久事件的 `seq`。Location index 继续是 Turn 与 Step 坐标的唯一 owner。引用事件已加载时，index 会沿用其解析后坐标，把 projection 事件登记到相同 Location，并在完整窗口 rebuild 时使用同一组引用。prepend 补齐此前缺失的 source 事件后，会修正 projection Location，并且只重放 Match Location 确实变化的 Context。

该 hook 只读取当前事件，并沿用现有 Definition 注册生命周期。引用必须是非负 safe integer，且小于 projection 事件的 `seq`。同一事件只能由一个 Definition 声明；多个声明会直接拒绝，而不会让注册顺序成为权威。Runtime 不解释 surface replacement range、presentation metadata、Blueprint state 或 renderer visibility；这些含义保留在拥有持久事件的 Definition 中。

普通坐标规则仍是默认行为。具有明确 Session、Turn 或 Step 坐标的事件不需要引用。如果 source 位于当前历史窗口之外，它在 prepend 被加载前无法提供坐标；引擎随后会 rebuild 并修正受影响的 Match，而不是向插件暴露可变 Location map。

## 曾考虑的替代方案

**暴露 Runtime Location map。**该方案允许插件修改引擎拥有的层级状态，并可能使 append 与 refresh 产生不同结果，因此拒绝。

**让 Runtime 理解 replacement surface operation 或 internal presentation。**这些属于 producer 与 presentation 语义，不是通用 Location 机制，因此拒绝。

**只在 rendered Node 上保存引用。**渲染发生在 Context matching 之后，无法修正 Match Location、Turn data 或 refresh replay，因此拒绝。

## 影响

任何 Client 插件都可以把持久 projection 事件投影到更早事件的稳定 Location，无须增加产品专属 Core 分支。Runtime 测试使用一个非 Blueprint 的 review projection，证明 append、registry rebuild、prepend repair、validation 与 collision 行为。UI Conversation 使用该 hook 处理 internal replacement message，在移除 Client Runtime 中 presentation 知识的同时保留既有 hidden-Turn 结果。
