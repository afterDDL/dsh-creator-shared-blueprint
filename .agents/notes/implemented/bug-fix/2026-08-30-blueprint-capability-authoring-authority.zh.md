# Agent Note: Capability authoring continuation 由 source 授权

Status: implemented

[English](2026-08-30-blueprint-capability-authoring-authority.md) | 中文

## Problem

已接受的 capability route 与 browser request 原本携带相同字段，但 Host 启动 Creator 时只把 browser copy 当作输入。loopback caller 因而可以伪造 source、修改 target 或 request，或把同一条 source route 发送到多个随机 Creator Session。first bad transition 会在检查任何持久 source evidence 之前清除拟议 child 的当前 conversation binding，随后从不可信内容追加 lifecycle start。另一个竞态允许 client 在 prompt response 丢失后上报 `failed`，而已接受的 Creator run 此时仍可能继续写入。

[Routing provenance 决策](2026-08-28-blueprint-routing-provenance.md)负责 source interaction arbitration，[精确 capability baseline](2026-08-30-blueprint-capability-exact-baseline.md)负责 terminal delta verification。本决策负责两者之间的 admission 与显式 terminal quiescence。

## Decision

source Session 中唯一成功的 `route_blueprint_capability_authoring` Tool result 是 continuation content 的唯一 authority。Admission 要求存在更早且匹配的 Tool call 与 source-owned `blueprint/route-decision`，随后从 result metadata 重建 route id、source Session、target preset、revision、原始 request 与 authoring kind。browser DTO 只能逐字段精确复现这些值。

source Session id 与 route id 的 domain-separated SHA-256 会派生唯一可以 adopt 该 route 的 Creator Session。Host 还会独立要求该 live Agent 挂载 `cordis` composition。首次 adopt 只允许 fresh Session 初始化时写入且各至多出现一次的 `permission/preset`、`sandbox/mode` 与 `approval/policy` 事实，并拒绝任何已有任务或 authoring 历史；随后产生的 `blueprint/capability-authoring` start 是持久 adoption receipt。完全匹配的 active retry 会复用该记录。foreign id、错误 composition、已有 child history、失败或不完整的 source result、被修改的 DTO、不同 lifecycle，以及 settled replay，都会在清除 binding、注册 model context 或追加 lifecycle event 之前被拒绝。恢复流程可以信任已校验的 child start，无需重新打开 source。

Client 不能发布 capability 的 `failed` terminal；validation failure 属于 Host recovery lifecycle。用户取消时，Host 先写入并 flush `blueprint/capability-cancel-requested`，再停止 active Creator、等待 `whenIdle()`、清除待处理 capability input，并丢弃未发布 candidate。Settlement 与进程恢复都会在任何 wake 或 verification 之前识别该 checkpoint，因此取消不会与修复后的 turn 竞争 publication，也不会在 restart 后重新创建 interaction。

## Alternatives considered

**因为 loopback browser 收到了 Tool result，就信任它。** Loopback 限制 network reach，但不会让第二份 DTO 成为持久 authority，也无法协调 retry 与多个窗口。

**分配随机 child，再扫描已有 Session 去重。** Load order 不是持久 ownership。确定性 destination 让该关系不依赖当前打开了哪些 Session。

**增加另一条 source-side adoption event。** 已接受的 source Tool result 已持有确切内容，确定性 child start 已记录 adoption。第三项事实会重复这两项职责，却不会关闭新的 transition。

**在一次 Creator observation 失败时允许 client 发布 failure。** 被拒绝或丢失的 response 不能证明没有 run 被接受，而一次 validation miss 属于可恢复的配置 lifecycle。只有 Host 在 repair budget 耗尽后才能发布 failure。

## Consequences

新的 admission 要求 source Session 已加载；已 adopt child 的刷新恢复不需要 source。预发布阶段使用随机 child id 创建的 capability history 会被拒绝，而不是静默升级。可预测 id 发生碰撞时，只有既有 Agent 是空的 `cordis` Session 且确切 source route 有效才安全；wrong-preset 或已污染 Session 会被拒绝。Session-create response 中可选的 preset echo 不是 authority，因为 Host 会验证实际挂载的 composition。取消 checkpoint 增加一个已知 Session event，但不改变 Session envelope format。无需修改 Agent Loop 或 Creator runtime。
