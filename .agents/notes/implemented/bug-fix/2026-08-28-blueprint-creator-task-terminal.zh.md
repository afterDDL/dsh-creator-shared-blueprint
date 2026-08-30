# Agent Note: Creator 终态任务不能拥有后续交互

Status: implemented

[English](2026-08-28-blueprint-creator-task-terminal.md) | 中文

## 问题

Creator Session 可以比其 create-agent 任务存活更久。将每条更新的消息重新解释成新 Draft，会让偶然出现的创建用语替换 Ready 目标。根据整个 Session 的最新轮次恢复，也会把后续被停止的讨论误认为中断的 authoring。

## 决策

类型化 Creator 记录保留 route 身份。自由文本不能替换该身份，Ready 忽略同一任务的非终态 observation。文本解析器仅用于没有类型化身份的历史。它针对每个创建 Agent 表达判断否定，因此后续不相关的暂缓要求不会抹去前面的主要创建请求，而局部受到否定的表达仍不会启动 Draft。

Host 为每个任务记录一份 `blueprint/creator-authoring-ended` 事实。完成证据引用其开始事件、成功的挂载验证、目标 preset 和已完成的 authoring 轮次。恢复先使用该事实，再考虑后续轮次；只有开始记录的历史从首个满足条件的区间补充检查点。另一个 Creator 或 capability 任务限定该区间。多个验证目标仍保持未决。错误轮次产生失败，而没有任务终态的用户停止仍可继续。取消是独立的任务终态，不等同于停止轮次。

终态恢复安装普通 Blueprint context，并拒绝陈旧的 Draft 激活。[Session 前台决策](2026-08-28-blueprint-creator-foreground-ownership.md)仍负责其他 Session 和迟到响应的拒绝；本决策补充同一 Session 内的任务身份。Capability routing、语义投影和 exclusive handoff 保留既有行为。

## 考虑过的替代方案

**消息只要包含否定创建语言就整条拒绝。** 同一请求可以创建 Agent，同时暂缓其 Skill 或 Subagent 工作。否定只作用于局部表达；类型化身份与持久结果仍负责路由任务的授权与终止。

**使用 Session 最新轮次。** 后续交互共享 Session，但不属于已完成的创建任务。

**删除 paused 恢复或历史。** 两者都会丢弃合法的未完成 authoring。终态优先级保留可继续性和仅追加历史。

## 影响

既有日志保持完整；恢复可以追加一份缺失的终态事实。运行时 invariant 拒绝改写终态，也拒绝没有验证证据的完成。Controller 回归覆盖自由文本覆盖、局部否定、后接独立暂缓要求的主要创建请求、陈旧 observation、新身份、恢复和 Session 切换。可运行的 headless 快照执行真实 preset copy 与挂载验证，再执行普通对话和恢复。
