# Agent Note：preset 就绪的 Session 创建

状态：已实现

[English](2026-08-31-session-preset-readiness.md) | 中文

## 问题

Host 的 `session.create` 协议已经接受 `agentPreset`，并且只在该组装完成挂载、对应 Agent loop 启动后返回。Client Runtime 的 public Session 表层遗漏了这个选项。需要为指定组装创建 Session 的第三方界面因此只能直接调用 connection transport、自行等待列表可寻址，并协调另一套 client-local next-Session intent。这条重复路径可能在请求的 runtime identity 得到确认前暴露 Session。

## 决定

`SessionRuntime.create(options)` 接受协议已有的可选 `agentPreset`。请求指定 preset 时，成功响应必须精确回显同一个 preset，方法才会完成。与普通创建相同，完成时 Session 行与 Agent scope 已可在本地寻址。回显缺失或不同会抛出 `SessionPresetReadinessError`；调用方不得打开该 Session 或接纳 prompt。Host RPC 失败继续使用 `SessionCreateError`，并保留调用方预分配的 identity。

`WorkspaceRuntime.connectWorkspace(workspaceId, options)` 与 `startSession(workspaceId, options)` 为 New Session 流程接受同一个 preset 要求。只有已经运行请求 preset 的既有空白 Workspace 成员才可复用。并发连接按 Workspace 与 preset 共同合并，因此不兼容的 preset 请求不会共享创建结果。

Client Runtime 拥有这项 API，并在普通 client boot 中先于注入 `sessions` 或 `workspaces` 的 feature plugin 安装。它不引入注册生命周期或第二套 readiness 状态。Host 响应仍是组装挂载与 Agent 启动的提交点。create RPC 不接受 client cancellation，因为发布可能已经发生；响应丢失由既有的预分配 id 与 Session 列表路径对账。重启后，持久化 Session header 与从日志解析的 preset 会通过 `session.list` 返回，因此同一条精确 preset 复用规则无需恢复 client-local intent 即可成立。

## 迁移

Interactive Blueprint 现在通过 `ctx.sessions.create` 创建绑定 preset 的 Creator、verification 与 trial Session，而 Creator roster 入口使用通用的 preset-aware New Session 操作。它不再调用 connection 的 Session transport、不再用私有列表计时器等待，也不再消费 `agentPresetSessionIntent`。agent-preset UI 保留自身普通 chip staging 与空白 Session 重组行为；没有把 Blueprint 行为移入该 package。

## 考虑过的替代方案

**保留 client-local navigation intent。** 拒绝，因为 intent 不是 runtime 提交点，必须与后续 Session identity 再做 join，而且无法在不增加另一条协调路径的情况下支持程序化 Session 创建。

**先用默认 preset 创建，再在第一条 prompt 前切换。** 拒绝，因为 preset 选择是第二次 RPC，并且只适用于空白 Session；prompt admission 因此需要额外 blocking state，仍可能与重组竞争。

**成功创建后不检查 preset 回显。** 拒绝，因为这种成功只能证明 Session 已发布，不能证明调用方要求的 runtime identity 已就绪。

## 结果

任何 client plugin 都可以为命名的 agent preset 启动 Session，而无需导入 Blueprint 或 transport 内部实现。Runtime 测试使用 `external-specialist` 作为非 Blueprint 消费者，证明请求转发、Host 精确确认、导航前拒绝不匹配、按 preset 复用空白 Session 与 fresh 创建。Blueprint 只是相同 public Session 与 Workspace service 的消费者。
