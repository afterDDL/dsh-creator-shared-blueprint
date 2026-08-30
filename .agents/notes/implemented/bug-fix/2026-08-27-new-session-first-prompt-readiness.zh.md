# Agent Note：新 Session 只有在所选 composition 就绪后才接收 prompt

Status: implemented

[English](2026-08-27-new-session-first-prompt-readiness.md) | 中文

## 问题

Web client 有两条新 Session 路径会在 client 自己负责的初始化全部落定前暴露会话。新会话 preset seat 异步调用 `agentPresets.select` 时，composer 仍可调用 `Session.prompt`；快速按 Enter 可能先让 Session 变成非空，导致 preset recompose 无法提交。Try Agent 则会在安装 Blueprint conversation context 前打开已完成 Host composition 的新 Session，因此首条 prompt 可能看不到绑定 target 的上下文。Interactive Blueprint 还会跨 Session 保留一份全局 projected target，而 Session runtime identity、Creator mode 与 composer 文案分别独立推导。选择 Creator 后，live Session 因而可能仍运行普通 preset，但 details panel 或 composer 已声称处于 Creator 状态；异步排队的 context 更新也可能把新 target 写入先前的 current Session。

刷新会掩盖两种症状。已提交的 preset 选择会从持久 `agent-preset/selected` 事件恢复，Blueprint controller 也会在恢复的 Session 成为当前会话后重新安装 conversation context。这种最终收敛并不能保证首条 prompt 安全。

## 决策

Runtime readiness 直接使用既有 API 的提交点。`sessions.create` 只会在 preset mount、Agent setup、发布与 loop 启动完成后返回；其回传的 `agentPreset` 必须等于 Try Agent target。`agentPresets.select` 只会在空 Session 完成 recompose 并追加 `agent-preset/selected` 后返回。不新增 Host lifecycle 状态，也不引入计时器。

preset seat 在等待 `agentPresets.select` 前设置限定于 Session 的 `ctx.conversation.blocks` 条目，收到已提交 identity 后解除；选择失败则改为可重试的失败 block。除了渲染禁用 composer，`ConversationController` 还会在附件序列化与 `Session.prompt` 前执行每个 composer block，从而关闭状态变化到 React 重绘之间的浏览器事件空隙。InputHub 既有的拒绝恢复路径会还原未继续编辑的草稿文本与附件。

Try Agent 会等待 Host 创建的 Session 可被 client runtime 寻址，记录回传的 preset，并在打开会话前安装 Blueprint conversation context。Runtime conformance 仍是 Session Ready 后执行的更强 P1 验证，不承担 prompt-admission 信号。只有当前 Session 正是 P1 result 指明的 Session 时，验证结果才能在这次主动导航后发布。P1 请求被拒绝时，Client 会在同一 destination identity 下将其归一化为未完成验证。若当前 Session 不同，说明用户再次导航，两种 late outcome 都会被丢弃。

本次不新增 pending-message queue。输入会留在既有的逐 Session 草稿状态机中直至 Ready，因此没有需要去重或持久化的自动 dispatch；真正发送前刷新不会重放消息。已运行的旧 Session 没有初始化 block，也不会增加 readiness 请求。

当前 Session 与 Host 回显的 `agentPreset` 是 runtime 和默认 Blueprint target 的事实源。Creator selection 是由 seat 持有的 next-Session intent；只有 current Session 回显 `cordis` 后 UI 才进入 Creator mode。Blueprint preference 与显式 selection 按 Session 区分，只有属于同一 Session 的 Creator 或 capability-authoring record 才能覆盖 runtime target。每次 Session 或 runtime preset 切换都会先清除上一份 projection，再按新的 precedence chain 加载，包括同一个空白 Session id 被复用于另一份 composition。Conversation-context publication 会在串行队列内部重新读取 current Session，并丢弃 intended Session 已不匹配的工作。创建请求尚未出现时，基础 `cordis` Blueprint 可以保持可见，但它会清除普通 existing-Agent 模型上下文，而不会安装 Proposal 或新 Agent 路由指令。Creator 文案从同一个 runtime preset 推导。Creator 完成后会为该 Creator Session 保留已验证 target；打开其他 Session 时则恢复该 Session 自己的 runtime target。恢复时读取最近一个具有持久 end 的 turn，而不是假设 hydration 后的最后一个 turn 槽必然已经终止。

持久 typed create-agent route 在 client 重新挂载后保持幂等。启动 continuation 前，client 会恢复现有 `cordis` authoring context，并同时匹配 source Session id 与 route id；匹配成功后只消费该 route，不会再创建、打开或 prompt 另一个 Creator Session。

## 考虑过的替代方案

**隐藏基础 `cordis` 投影。** 该投影是有用的 UI，并不是路由缺陷的原因；不安全的是把它发布成普通 existing-Agent 模型上下文。

**保留普通 Blueprint 上下文，并依赖模型不发起路由。** 该上下文会明确提供 Proposal 与新 Agent 路由行为，而直接 Creator runtime 并不提供对应 route Tool，因此不能依靠模型自行选择来保证首条 prompt 可靠。

## 后果

- 快速或连续 Enter 无法穿过待完成的 preset recompose；发送路径会在任何 Host prompt admission 前拒绝，并恢复草稿。
- preset 切换失败不会产生 model turn，并保持该 Session 被阻塞，直到用户重新选择。
- 切换其他 Session 不会重定向草稿或完成回调，因为 block 与草稿都按 Session id 区分，Try Agent 导航也只有在发起时的 selection 仍为当前项时才执行。
- Creator 入口不会给旧 Session 换标签或 target。只有新 Session 回显 `cordis`、标准 Creator tools 与 Skill catalog 完成组装、preset-seat block 解除后，首条 Creator prompt 才会被接收。该 prompt 建立 Draft 前，基础投影只用于 UI，因此 existing-Agent route 不会抢先运行。
- 同 Session 仍可显式选择其他 Agent，但该 preference 不能跨 Session。若 Creator state 属于其他 Session，或 target/runtime 分裂且没有同 Session selection 或 authoring record，controller 会发出开发诊断。
- 既有五秒 client-addressability timeout 只是一条失败上限；它从不用于判定 Ready，成功的事件驱动路径也不会因此增加延迟。

## 测试

聚焦 client 测试证明 composer block 会阻止两条公开发送路径抵达 `Session.prompt`；重复的 preset-seat apply 只产生一次 Host 调用；readiness 在提交前发布 `pending`、提交后发布 `ready`；失败保持阻塞；Try Agent 的顺序为 create、addressability、preset identity、context installation、open、P1。Session lifecycle 测试还证明 Creator staging 不修改旧 Session、等待中的新 Session 会隐藏旧 Blueprint、逐 Session target preference 只恢复给其 owner、基础 Creator 投影会清除普通模型上下文、runtime preset 决定空白 composer 文案，且 contradiction diagnostic 会拒绝无法解释的 target/runtime split。负向用例覆盖 preset identity 不匹配、context 失败、初始化期间导航变化、被拒绝 P1 请求在确切 Trial 中发布、第三 Session 对该失败的抑制，以及 legacy global target preference 泄漏。
