# Agent Note: Blueprint 路由保留原始意图并限制每个 interaction 的单一操作

Status: implemented

[English](2026-08-28-blueprint-routing-provenance.md) | 中文

## 问题

添加能力把路由指令附加到了用户消息。创建表达式 guard 将这些指令视为 active Creator 意图，拒绝 existing-Agent 提案，却仍允许新建 Agent 路由。真实 CSV 请求因此把当前 preset 复制成第二个顶层 Agent。此前的 Creator 已完成；这次拒绝来自文本分类，而非 active lifecycle。

## 决策

Client 为每次添加能力 interaction 生成独立 `routeId`。Host 在提交消息前，将该 identity 与原始文本、确切 message id、source Session 和 target 一起记录到 `blueprint/routing-input`。直接对话请求使用 message id 作为 interaction identity。路由说明作为独立模型上下文提供。路由从持久历史解析当前人类消息，不会在 Assistant 消息、description 或 prompt 指令中寻找用户意图。类型化模型仍负责选择操作；新 Agent 调用必须引用当前用户原文，而能力入口无论引用什么都会拒绝该操作。后续独立人类消息可以请求不同目标。

`blueprint/route-decision` 在异步校验前为一个 `routeId` 同步保留合法操作。同一 interaction 的其他操作不能竞争。执行中或已成功的尝试不能再次启动；失败尝试只能重试同类操作。不同 interaction 即使位于同一 source turn 或指向同一 target preset，也可以选择其他操作。被 UI action 排除的操作会被拒绝，但不会取得所有权。添加能力还会在 `modify-existing-agent` 取得 interaction 所有权前拒绝 Identity、Purpose 与 Behavior 近似提案；既有类型化 capability 开关和 Output 修改仍可使用 Proposal。因此无效 create-agent 或文本近似不会阻止合法 Skill 或 Subagent 路由，但已接纳的路由不能转向另一个业务操作。持久 tool result 确认尝试结果，不引入另一套 scheduler 或状态存储。验证成功的 Proposal 与 capability route 都使用 `concludeTurn()`。接受操作会结束 source turn，不再发起模型请求；后续用户 interaction 会取得新 identity，不需要删除旧 decision。已经生成的调用仍受 Host 重复与操作 guard 约束，其拒绝记录仍然可见。

如果前台在已接纳的类型化路由执行前发生切换，Host 会保留该 source Agent 的 Blueprint binding，直到匹配的 source `turn/end`。Tool 注册仍按 Agent 隔离，因此其他 Session 既不会继承也不会释放 source route。

Proposal Change Set 携带 `sourceSessionId` 与 `routeId`。Session scoped Tool row 仅在 owner 与该 row Session 一致时渲染 Change Set，Apply receipt 也写入 source Session，因此 foreground 变化不能重新归属 pending Proposal。Capability route 及其 Creator lifecycle event 携带同一来源 identity；恢复与观察要求匹配确切 route，而不再只匹配 preset 与 revision。Creator Session 仍是针对 existing target 的 `cordis` authoring executor，不会创建或复制第二个顶层 preset。

真实 Creator 或 capability-authoring binding 保留其提案 guard。用户消息中的创建词语不再代替 active authoring 状态。[Blueprint adapter](../feature/2026-08-24-interactive-blueprint-preset-adapter.md) 保持投影、提案和事务行为；[独占交接](2026-08-28-blueprint-exclusive-creator-handoff.md) 保持执行转移顺序。

## 考虑过的替代方案

**增加特定语言的创建排除词。** 关键词不能证明一句话由谁编写，同样问题会在其他语言或指令示例中再次出现。

**只依赖路由说明。** Guidance 无法阻止被拒绝后第二个 typed call 接管。Host 仲裁即使在模型忽略说明时仍执行操作限制。

**只存储 client selection 或内存锁。** 两者都不能在刷新后重建确切请求与操作。持久 interaction identity、message identity 与 tool result 提供确切所有权。

## 后果

模型仍负责语义分类；引用证明来源，而不证明任意文本在语义上要求创建。添加能力对新 Agent 创建和语义文本近似施加更强的确定性禁止。纠正已接纳的业务操作需要新的 interaction，不能在同一 identity 内 fallback route fishing。讨论不使用工具，也不占有操作。Direct-edit reconciliation 保持现有事件授权。

定向测试覆盖 guidance 污染、并发与已结束操作冲突、同一 source turn 内的独立 interaction、占锁前近似提案拒绝、Proposal Session 所有权、terminal 与 active Creator context，以及日语/韩语能力输入。构建后的 headless composition 证明 Skill route 被接受后不会发起第二次模型请求，并且只保留一个 target preset；同一响应的测试保留重复与新 Agent 调用的拒绝记录，不允许它们阻塞合法路由。
