# Agent Note: 后台 Creator 交互始终归 child 所有

Status: implemented

[English](2026-08-30-blueprint-background-interaction-ownership.md) | 中文

## Problem

Interactive Blueprint 会让 source Session 保持 foreground，同时由预留的 `cordis` child 在后台执行 Creator authoring。该 child 可能因原生 question 或 approval 而阻塞。first bad transition 把 child 的 pending observation 缩减为 wait kind 与 source-visible status，丢弃了确切的 `PendingWait`；source 虽能显示需要输入，却没有可回答的 composer interaction。

被破坏的不变量是：只有确切的 child carrier 才能授权回答。`PendingWait` 保留私有 RPC 关联、child Session id 与进程内响应行为。source 只负责展示，不持有响应归属；复制的 payload 字段与 Host DTO 都无法重建该权限。[前台归属决策](2026-08-28-blueprint-creator-foreground-ownership.md)规定哪个 source 可以发布 Creator 状态，本决策规定投影到该 source 的 pending interaction。

## Decision

conversation plugin 持有按 source 寻址的内存 `ComposerInteractionRegistry`，并以 `ctx.conversation.interactions` 对外提供。生产方会替换一个 source Session 的确切外部 carrier。`ConversationRoot` 先组合 foreground Session 的原生 wait，再追加外部 wait；只有原生 wait 具有相同 owning Session 与 carrier key 时，才抑制该外部 wait。因此，普通 composer chain 始终是唯一的原生渲染方与回答路径。

ui-blueprint 会保留后台 child observation 中的确切 carrier，并且只有当前 Session 拥有 Creator 或 capability route、且 carrier 属于另一 Session 时才选中它。同步 effect 会把该对象发布到当前 source 注册表。切换 source、wait 解除、route 丢失或 effect 释放都会向先前 source 发布空列表。source 绝不会复制 interaction，也不会代替 child 回答；原生 question 或 approval domain 会通过原 carrier 响应。

Host conversation-context result 继续携带持久 source、route、lifecycle 与 terminal 事实，不包含 `PendingWait`。刷新流程先使用这些事实标识 child，再从 child Session 的正常 pending projection 取得新的 exact carrier，然后重新发布到 source composer。持久 context 本身绝不会伪造 response path。

## Alternatives considered

**在 Blueprint 内直接渲染原生 control。** 跨 plugin component value import 会违反 Client bundle-purity 规则，还会让 details plugin 持有 composer interaction behavior。注册表会保留 plugin direction 与既有原生 chain。

**把 wait 复制到 Host DTO，再通过 source 代理 answer。** 可序列化副本不含私有 RPC correlation 与 settlement state。增加第二套 response protocol 会重复 pending-interaction transport，并模糊 child Session 的 audit ownership。

**child 等待时导航到 Creator child。** 这样虽能展示 interaction，却会中断 source continuity，并让后台 executor 负责 foreground navigation。

## Consequences

用户会留在 source Session，而其原生 composer 会展示阻塞 child 的 question 或 approval。child 保留 response ownership、audit correlation 与 settlement；ui-blueprint 只保留 presentation ownership 与 lifecycle status。

注册表会有意保持在进程内。刷新同时需要持久 Creator context 与 child Session 回放得到的 pending interaction；本决策不增加 Host field、Session event 或 wire format。通用的按 source 注册表可以携带其他 plugin 的确切 interaction，同时无需让 ui-conversation import 该生产方。

## Verification

注册表 coverage 会固定稳定的 per-source store、确切对象 identity、replacement、clear 与 source-scoped forget。Conversation-root coverage 会固定 native-first ordering，以及相对原生 owner-plus-key 匹配的抑制行为。Blueprint controller coverage 会固定当前 Creator 或 capability source 的 exact-carrier selection，拒绝 foreign 与 same-Session carrier，并清除 settled observation。
