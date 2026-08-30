# Agent Note: Creator 独占交接终止来源轮次

Status: implemented

[English](2026-08-28-blueprint-exclusive-creator-handoff.md) | 中文

## Problem

路由工具成功返回并不会转移执行所有权。独立 Creator 编写同一请求时，来源 agent（智能体）仍可能继续调用工具。[Blueprint 适配器决策](../feature/2026-08-24-interactive-blueprint-preset-adapter.md) 保留其编写与投影语义；本决策只负责执行器交接。

## Decision

独占路由在成功返回前，将 `blueprint/creator-authoring` 写入来源 Session 并完成持久化检查点。记录保留请求原文、语言元数据、来源轮次、route id，以及确定性的独立 Creator Session id。成功结果将轮次标记为终态，并在结果发布时同步取消驱动器。取消保留收件箱，因为发布期间不能重入 Session 追加。已计划的同批后续调用可能收到合成的取消结果，但不会执行其工具体。

Client 使用预留 id，通过正常路径创建 Session。Host 安装并持久化 Creator 上下文，要求来源结果已被接受，等待 `whenIdle()`，验证该确切轮次的持久结束事件与空闲状态，然后投递一条插件 continuation。目标 Session 的持久收件箱插入是投递凭据；串行上下文更新避免不同客户端和刷新后的重复投递。创建或终止失败时，请求仍可重试，Creator 不会启动。来源历史与后续轮次保持可用。

## Alternatives considered

**只靠提示词停止，或仅调用 `concludeTurn()`。** 两者都不能阻止所有同批后续工具或竞态中的 steering（中途引导）路径。同步取消关闭该执行窗口。

**取消完成前启动 Creator。** 取消确认不等于完全停稳，仍允许两个执行器重叠。

**只在 Client 去重路由。** 内存集合不能跨刷新保留，也不能协调两个窗口。目标身份与投递凭据保存在 Session 历史中。

## Consequences

来源终止先于目标创建，因此创建失败会结束这个轮次，但不会销毁或锁住其 Session。恢复流程可以重试已记录的请求。Host 启动校验要求来源 Session 已加载；未加载的来源需要重新打开。普通 Proposal 与能力编写保留既有执行语义。不需要修改 Agent Loop、Session、Preset 或 Creator 实现。
