# Agent Note: 可继续 subagent id 不是后台 Job id

[English](2026-08-30-continuable-subagent-id-is-not-job-id.md) | 中文

Status: implemented

## Problem

可继续委派返回持久子会话 id，而一次性后台工作返回通用 Job id。当委派工具与 Job 控制工具同时对模型可见时，简短的 `started subagent <id>` 结果没有说明由哪套控制协议持有该值。模型可能把子会话 id 传给 `job_list` 或 `job_output`；Job 注册表会正确拒绝，但失败的收集可能触发重复委派，即使原始子级仍在运行并最终正常回报。

## Decision

可继续启动结果使用 `started continuable subagent <id>` 标识生命周期，并立即说明该 id 不是后台 Job id、不能传给 `job_*`，且结果通过运行时结算通知完成投递。规范工具值仍为 `{ kind: 'continuable', subagentId }`；一次性后台渲染与 Job 登记保持不变。

这项渲染区分对模型可见并写入日志。可继续子级仍拥有自己的持久 Session 与独立轮次，`ctx.jobs` 则仍只对明确返回 Job id 的工作具有权威性。

## Alternatives considered

**把每个可继续子级登记为通用 Job。** 这会在继续执行管理器之外增加第二个生命周期所有者和收集记录，拆分取消与结算权威，并抹去 `subagentId` 所代表的持久对话区别。

**从使用可继续子级的生成 preset 中移除 Job 控制工具。** 同一个 Agent 仍可能合理地通过后台 shell 命令或一次性提供方使用 Job，因此隐藏通用控制工具会删除无关能力，而不是消除返回标识符的歧义。

**只依赖工具 schema 的 `kind` 字段。** 模型消费的是渲染后的工具结果，含糊文本正是造成重复工作的转移点。保留结构化值却不修正其展示，真实用户链路仍不可靠。

## Consequences

启动确认会变长，但它在 id 进入模型上下文的时刻明确控制权归属。包级覆盖固定渲染文本与 Job 记录缺失；无密钥组装 `subagent-settlement` 快照固定同一结果及随后由管理器负责的通知。真实浏览器 Blueprint 发布候选覆盖验证一次委派会得到一个子级结果，并由父级消费，而不会发生 `job_*` 重试。
