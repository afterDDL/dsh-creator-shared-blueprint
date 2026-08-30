# Agent Note: Creator 前台状态属于当前查看的 Session

Status: implemented

[English](2026-08-28-blueprint-creator-foreground-ownership.md) | 中文

## 问题

Creator 历史按 Session 隔离，但 Blueprint controller 只有一个前台 store。恢复与投影响应可能在导航后才完成，将上一 Session 的暂停 Draft、target 和 roster lock 发布到前台。Capability authoring 还使用同一个 Session 字段表达 source conversation 与后台 Creator executor，并只保存一个全局 handoff；导航因此可能显示另一 source 的 progress 或丢弃其 terminal result。归属 diagnostic 在发布后才运行。仅在导航时清空可见投影既不能排除这些发布，也不能保留可恢复的后台状态。

## 决策

Creator 前台归属要求当前查看的 Session 等于 observation 的 owner。来源可以在 handoff 前暂存自己的 Draft；后续 authoring 属于子 Creator。启动这项类型化 continuation 时，Client 会创建预留 child，但不会让它覆盖打开 source Session。Source 会保持 foreground，Client 在后台观察 child，并且只投影属于该 route 的 progress 或 terminal。Host 仍按 Session id 恢复持久 context。Client 在每次异步恢复请求后重新检查当前 Session，controller 拒绝 foreign observation 和发布。

每次 Session 或 runtime preset 切换都会递增前台代次。读取结果发布前必须仍匹配该代次及 Creator observation 版本。按代次共享 load 可防止新 Session 等待旧读取，也能排除 A → B → A 后返回的旧响应。默认投影不能替换读取期间恢复的 Draft。交互锁要求当前拥有该 Creator 状态且其尚未 Ready。

无类型的 legacy Creator 恢复只解释最新一条人类输入。因此后续 edit 或 capability 请求在刷新或 Session 导航后不会复活更早已完成的创建 interaction。

Capability presentation 将 UI ownership（`sourceSessionId` 与 `routeId`）和 execution ownership（`creatorSessionId` 与 lifecycle `startSeq`）分离。Controller 按 source Session 保留最近一次 capability interaction，并从 foreground Session 派生唯一可渲染 handoff。后台订阅观察每个 active Creator Session，把等待状态或持久 terminal outcome 投影回匹配的 source record。成功、失败和取消会跨导航与重新投影持续显示，直到同一 source 的另一项 capability request 替换它们。刷新会从 Creator lifecycle 重建这些 terminal，不增加本地 completion store，也不把 Creator timeline message 复制进 source conversation。

[Creator task terminal 决策](2026-08-28-blueprint-creator-task-terminal.md)负责判定哪一项持久 task outcome 可以穿过该前台 fence 完成投影。Foreground ownership 不会根据后续 Session activity 推断 task completion。

[Session readiness 决策](2026-08-27-new-session-first-prompt-readiness.md)仍负责 prompt 准入和 target 优先级；[exclusive handoff](2026-08-28-blueprint-exclusive-creator-handoff.md)仍负责执行权转移。本次不改变这两套执行协议。

## 考虑过的替代方案

**导航时清空全部 Creator 历史。** 这会破坏合法的刷新与返回恢复，也不能解决正在返回的异步发布。

**取消后台 authoring。** 前台归属不授予取消权限；后台任务必须保留原有执行行为。

**只比较 Session 是否相同。** 离开再返回同一 Session 后，旧读取仍能匹配。前台代次区分这些访问。

**按 target preset 关联 capability presentation。** 多个 source Session 可以操作同一 preset。Target 表示 mutation destination，不表示哪个 interaction 有权显示 progress 或 terminal state。

## 影响

按 Session 保存的记录与持久事件保持完整。非当前 Creator observation 只更新其 source-owned record；返回时会渲染该 Session 的当前状态。不需要改变 Host API、Creator Runtime、完成条件、语义投影或 authoring executor。Controller 测试覆盖 foreign lifecycle、迟到读取、返回代次、来源暂存、多个同时存在的 source record、持久 capability terminal 与刷新恢复。可运行的 Web example 验证新 Session 不继承上一 Creator 的交互锁。
