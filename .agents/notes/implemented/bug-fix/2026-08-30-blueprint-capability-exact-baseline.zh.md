# Agent Note: Capability authoring 终态要求精确基线

Status: implemented

[English](2026-08-30-blueprint-capability-exact-baseline.md) | 中文

## 问题

Capability authoring 为目标新增一个 Skill 或 delegation 时可以合法改变 target，因此仅凭 target revision 变化无法证明请求的 delta。只记录 preset id、Skill name，以及 delegation row id、Tool 与 provider，也会遗漏权威内容。Creator 可以修改既有 Skill body、改变隐藏的 delegation option 或改写另一个 preset，再新增一个其他方面有效的 target capability，并且仍通过原有 completion 检查。

## 决策

持久 `blueprint/capability-authoring` 开始事件会记录 authoring 前完整的 committed preset roster。每个 entry 保留 id、trust、已解析 display metadata、discovery health，以及可读 composition text 的 SHA-256。Target entry 必须健康，其 composition digest 必须等于 route 的 base revision。Authoring 在隔离 clone 中进行：candidate verification 允许其中的 target composition digest 改变，而 formal target、其 metadata 与每个 non-target roster entry 在 verified publication 前都必须保持精确。

同一开始事件记录每个 scoped Skill 的 name、description、invocation policy、scope、provider、source 与 definition digest。它还记录每个已投影 delegation 的 row id、Tool、provider、mode、availability、enabled state，以及完整 parsed config 的 SHA-256。Config serialization 会递归排序 object key、保留 array 顺序，并把 Loader `!!js` expression 当作未求值的 `{ __jsExpr }` 数据。因此嵌套的 `agentOptions`、`toolFilter`、`maxDepth` 与未来兼容 JSON 的 config field 都会参与比较，同时不会执行 expression 或暴露 raw config。

Candidate 结算先按 name 连接当前 Skill，按 row id 连接当前 delegation，并要求每项 baseline summary 保持精确。Skill authoring 随后只接纳一个新的 target-owned、model-callable Skill，且不允许新 delegation。Subagent authoring 在 fresh-Session P1 检查前只接纳一个新的 enabled、provider-backed delegation，且不允许新 Skill。Projected node 检查继续作为额外防护，但不再充当隐藏 definition 或 config field 的权威。

Session invariant 要求 roster、Skill 与 delegation baseline 完整且 identity 不重复，校验 definition 与 config digest，要求 target roster revision 同 route base revision 相等，并要求终态事件精确复制持久开始基线。本决策替代最初 [Interactive Blueprint 决策](../feature/2026-08-24-interactive-blueprint-preset-adapter.md)中较窄的 name 与 row-id baseline；其中的 projection、routing 与 confirmation 决策仍然有效。

[Capability continuation authority](2026-08-30-blueprint-capability-authoring-authority.md)负责 admission、deterministic Creator identity 与 explicit-terminal quiescence。本决策只在该 authority 已生成一项有效 durable start 之后开始生效。

## 考虑过的替代方案

**只比较已投影 Blueprint node。** Skill body、child `agentOptions`、Tool filter、depth limit、Loader expression 与 non-target preset content 不一定改变 projected node。

**要求 target composition revision 完全不变。** 新增 delegation 必然改变该 revision，而新增 filesystem Skill 可能不会改变它。精确 baseline member 加上获准 addition 可以识别允许的 delta，而不会禁止这两种机制。

**在 Session event 中保存 raw Skill body 与 delegation config。** 持久 identity 需要 equality evidence，不需要 model-visible 或 client-visible source text。Digest summary 可以限制事件体积，并避免执行 Loader expression。

## 影响

Creator turn 如果在新增所请求 capability 的同时修订既有 capability，会使 candidate validation 失败；有界 recovery 可以修复同一个 candidate，耗尽后则丢弃它且不改变 formal preset。另一个 preset 或 target metadata 的并发修改也会保守地阻止 publication。Runtime Session 回归覆盖修改既有 Skill body 并新增一个 Skill、修改包含 `!!js` 的既有 delegation config 并新增一个 delegation、修改 non-target preset 并为 target 新增一个有效 Skill，以及修改 target metadata。
