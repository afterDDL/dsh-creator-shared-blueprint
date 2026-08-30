# Agent Note: Capability addition 仅在可恢复验证后发布

Status: implemented

[English](2026-08-30-blueprint-capability-verified-publication.md) | 中文

## 问题

Capability Creator 过去会在 Host validation 前编辑 formal preset。因此，即使 fresh mount verification 失败，一个已完成的 Creator 仍可能把新的 Skill row 与文件留在 committed state。`blueprint.get` 随后会投影该未验证状态，同时 source 发布 failure terminal。第一个错误 transition 是在 authority 与 runtime proof 之前写入 formal preset；被违反的 invariant 是 committed Blueprint capability 必须来自同一个成功验证的 preset generation。

一次 Creator turn 或 mount 失败也会立即结束用户请求。即使同一个 Creator 可以修复 candidate，系统仍会把内部 plugin name 与 verification stage 暴露为产品错误。

## 决策

一个已接纳的 capability route 会独占 target lease，并把完整 formal preset directory clone 到隐藏的 sibling candidate。Creator 获得 scoped roster overlay 与 write guard，只能看到该 candidate 和最少的 non-delegating authoring Tool。整个 authoring 与 repair 期间，formal preset file、committed Blueprint projection 与 running Session 都保持不变。

Host 会在创建 verification Session 之前验证 composition authority。Skill candidate 只能新增一组精确的 local Skill wiring 和一个新的 target-owned callable Skill；ambient default Skill root 必须关闭。Subagent candidate 只能新增一个 active `tool-subagent` row，其 identity 与完整 config digest 会绑定后续 evidence。两个 lane 都使用新的 isolated Session，证明 mounted runtime conformance、active Blueprint projection 与所请求 lane 的专属行为。Complete-tree digest 会在 composition parsing 前、authority validation 后、runtime verification 后和 publication 时分别约束 candidate。

检查失败时，Host 会写入私有 `blueprint/capability-repair` 记录，其中包含确切 prerequisite、diagnostic、turn、attempt 与 candidate digest。Host 会把该 diagnostic 发送给同一个 source Session 与 route 下的 deterministic Creator。Skill 与 Subagent 共用这一有界 repair lifecycle。Source 保持 configuring 状态，既不会收到中间 failure terminal，也不会收到实现层 diagnostic。进程 restart 会根据持久 message id 重建最新且尚未投递的 repair input，不会创建另一个 interaction。

检查成功时，Host 会在移动任何 formal directory 之前写入并 flush `blueprint/capability-verified`。Publication 使用 preset publication gate 与可从 crash 恢复的整目录 journal，随后使 standing pointer 失效，因此只有未来 Session 会加入新 generation。只有该 transaction 已 committed 后才发布 completed terminal。没有 live Agent 的 Host read 会在同一个 publication exclusion 内取得 metadata、composition text 与一个 standing key，因此 `blueprint.get` 不会混合一个 generation 的 formal text 与另一个 generation 的 Skill registration。

Publication retry 有明确上限。如果 validation 或 publication 无法在配置的 budget 内成功，Host 会证明 formal tree 仍与 baseline 相同、记录 discard evidence，并发布一个不包含私有 diagnostic 的 failed terminal。Client 显示临时、可重试的消息，并保留此前 committed Blueprint。重新尝试会启动新 route，绝不会把被拒绝 candidate 改标为 verified。用户取消会在 Creator cancellation 与 candidate discard 之前写入持久 checkpoint，恢复过程会完成该取消而不 replay authoring input。

## 考虑过的替代方案

**先写 formal preset，验证后再 rollback。** Formal projection、standing mount 与并发 reader 都可能观察到未验证区间。Rollback 也无法证明自己没有覆盖并发编辑。

**把文件存在或 Creator prose 当成成功。** 两者都不能证明 Loader resolution、scoped Skill discovery、Tool loading、provider availability 或 fresh-Session conformance。

**第一次 verification 失败后结束 route。** Validation diagnostic 是 reserved Creator 可以执行的修复输入，尚不能证明用户请求无法完成。

**分别维护 Skill 与 Subagent recovery flow。** 两者的 lane evidence 不同，但 isolation、retry ownership、publication、cancellation 与 user-visible state 的义务相同。独立 lifecycle state machine 会再次产生分叉。

## 影响

Capability authoring 会使用隐藏磁盘空间，并在每次 verification attempt 创建一个 fresh Session。两项成本都受配置的 repair count 限制；candidate disposition 持久化后，terminal cleanup 会移除 transaction。Running Session 保持其已加入 generation；committed publication 只影响后续 Session。

`blueprint/capability-repair`、`blueprint/capability-verified` 与 `blueprint/capability-cancel-requested` 是已知 Session event，不改变 Session envelope format。缺少 candidate authority 的 pre-release history 不能被当作 verified publication。无需修改 Agent Loop。

## 验证

Runtime coverage 包括两个 lane 的首次失败、第二次成功修复；失败期间 formal baseline 保持；在创建 verification Session 前拒绝 authority；实际 Skill loading；fresh delegation conformance；repair 耗尽；publication 有界重试；durable cancellation；以及 clean restart 后恢复且不重复创建 interaction。Projection coverage 会强制在 assembly 与 Skill read 之间发生 publication，并证明同一个结果始终完整使用其捕获的 generation。
