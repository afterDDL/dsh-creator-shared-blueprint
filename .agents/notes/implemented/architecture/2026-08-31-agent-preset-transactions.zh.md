# Agent Note: 隔离的 AgentPresets 事务

Status: implemented

[English](2026-08-31-agent-preset-transactions.md) | 中文

## Problem

外部插件编辑 preset 时，必须让未验证文件对已提交读取方不可见，校验一份确切 candidate，仅在已提交 baseline 未变化时发布，并在进程中断于目录重命名之间时恢复。Interactive Blueprint 在 adapter 内部实现了这些文件系统保证，只要求 AgentPresets 在任意发布 callback 外排除读取方。这样一来，正确性依赖 Blueprint 自有的隐藏目录词汇，其他插件若不复制整套实现便无法取得相同保证。

## Decision

`AgentPresets` 负责可写 preset 目录的通用隔离事务 lifecycle。`prepareTransaction(id, { key, expectedRevision })` 在 roster gate 内解析已提交 preset，验证精确组装 revision，记录完整目录树 baseline digest，并把目录克隆到 `.agent-preset-transaction-<sha256>`。返回的 `AgentPresetTransaction` 是持久 handle；调用方的稳定 `key` 使重试和重启能够接管同一事务，而无需在 journal 中暴露调用方专属身份。

`resolveTransaction()` 返回仅指向隔离 candidate 的 `AgentPreset`。`registerScopedOverlay()` 可以让该 preset 只通过一个 agent scope 的上下文创作工具可见，`mountIsolated()` 可以为 fresh 校验 agent 组装它。普通 `list()`、`resolve()`、`read()`、常驻挂载与 projection snapshot 仍然只寻址已提交目录。

消费插件负责语义校验。它在校验前后调用 `fenceTransaction()`，并让完整目录树 digest 跨越所有外部 conformance 检查保持不变。`publishTransaction()` 只接受该 digest，将正式目录与准备时 baseline 比较，在 roster 与目标 preset gate 内完成可崩溃恢复的重命名序列，并在恢复读取方之前清除常驻指针。已有 agent 保留其已挂载代际，未来 agent 使用已发布代际。AgentPresets 不知道 candidate 添加的是 Skill、delegation、workflow 还是其他功能。

事务存储是带 journal 的文件系统资源，而不是服务本地 promise。`recoverTransaction()` 在重启后幂等重建准备、发布与放弃阶段。取消由消费方负责：fence candidate，调用 `discardTransaction()`，持久化返回的 disposition，再调用 `cleanupTransaction()`。清理刻意晚于 settlement，使持久 terminal 能在隐藏证据消失之前证明实际结果。

该服务在普通 Host 组装期间、所有注入 `agentPresets` 的消费方之前注册；事务不新增启动 registry。消费插件被移除或缺失时，未验证 candidate 不会因此进入已提交状态，因为只有 `publishTransaction()` 能跨越正式路径。隐藏目录可以保留，直到操作者或恢复后的插件处理它。`runLegacyPublication()` 仅作为已持久化其他 rename journal 的插件所用的内部迁移 hook；新事务创建无法使用它。

## Blueprint migration

Interactive Blueprint 的每个新 capability lifecycle 都通过 `prepareTransaction()` 创建，使用通用 resolve、fence、recover、publish、discard、cleanup、scoped overlay 与 isolated mount 方法，只把 Skill/Subagent 目录树 delta 策略保留在 adapter。Blueprint 持久 candidate 与 disposition 字段在结构上兼容通用 handle 与 evidence，因此产品事件 schema 不变。

已经持久化的 `.blueprint-capability-*` 记录仍可恢复，且无需让 AgentPresets 理解该目录格式。Adapter 先使用通用服务，只有 `AgentPresetTransactionNotFoundError` 明确证明通用 journal 不存在时才进入 legacy reader。新 lifecycle 从不调用 legacy preparer。两套 cleanup reader 都是幂等的，因此来自任一词汇的已结算记录只会删除自己的隐藏目录。

## Alternatives considered

**公开 Blueprint 的整套 candidate 模块。** 拒绝，因为它的 journal 包含 source、route 与 Creator 身份，其 admitted-delta 逻辑还指名 Skill 与 Subagent 行为。这些属于消费方策略，不是 AgentPresets 文件系统语义。

**只公开发布 mutex。** 拒绝，因为 callback 没有定义 candidate 隔离、完整目录树比较、崩溃阶段、重启接管或清理顺序。每个消费方仍需自行发明这套影响正确性的事务。

**把 candidate 校验放进 AgentPresets。** 拒绝，因为 preset 内容是开放的插件组装。AgentPresets 能证明字节与可挂载性，但只有消费功能能判断允许哪种语义 delta，以及何种 runtime evidence 足够。

**立即删除 legacy reader。** 拒绝，因为持久化 Blueprint lifecycle 可能在正式目录已停放到旧 journal 时重启。删除 reader 可能搁浅唯一 authoritative tree。兼容路径只读已有数据，不提供创建入口。

## Consequences

任何第三方 Host 插件都能准备、检查、校验、发布、取消并在重启后恢复 preset candidate，而无需导入 Blueprint。Core 测试安装一个 `ExternalPresetPublisher` dummy plugin，证明 committed isolation、expected-baseline 拒绝、常驻代际刷新、安全放弃、清理与重启发布。Blueprint 测试证明新事务使用通用目录词汇，已经持久化的 background Creator 记录仍通过 legacy reader 恢复。

通用包现在负责完整目录树 hashing 与文件系统 journal，因而增加了安全敏感 surface。它拒绝外部符号链接、硬链接文件、特殊 entry、配置可写根目录之外的路径、digest 不匹配，以及已提交内容被并发编辑后的发布。消费方仍须持久化 handle 与 terminal disposition、限制 repair 次数，并决定语义校验何时通过。
