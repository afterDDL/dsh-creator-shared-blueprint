# Agent Note: Creator 使用固定的 preset authoring Consumer

Status: implemented

[English](2026-08-30-creator-only-preset-authoring-consumer.md) | 中文

## 问题

Creator 原先通过挂载临时插件来注册 `preset_check`，从而访问 preset validation。该 Tool 只能在后续模型请求重建 schema 目录后出现，因此当前模型可能在看不到它的情况下继续执行。重复 probe 还会使不同 Session 的名称与输入 schema 漂移。Preset 的发现、读取、复制、路径解析与 validation 需要从 Creator 首个请求起使用同一套稳定 authoring 接口，同时不能把这些操作暴露给普通 Agent Session。

## 决策

`@deepseek-ai/dsh-tool-agent-preset-authoring` 是 `agentPresets` 与 `tools` 的固定 Consumer。只有 `cordis` preset 挂载它。因此 Creator 的首个模型请求就包含 `preset_list`、`preset_read`、`preset_resolve`、`preset_copy` 与 `preset_validate`；普通 Agent preset 不包含其中任何一项。

每个 Tool 都委托给对应的 roster 操作，不增加 service、realm、authoring 格式或 policy。`preset_validate` 调用 `standingKeyFor(id)`，并原样返回挂载结果而不转换失败。[mount-validation 决定](2026-08-11-preset-authoring-agent-validates-its-own-composition.md)继续说明为何 discovery health 不足，以及为何 validation 使用真实 Session 采用的同一 standing mount。本决定仅取代该 Note 的临时自挂载 probe。

`preset_copy` 是唯一的 composition 创建操作。Host 校验两个 id，拒绝任何 root 已提供的目标，回滚失败的 copy，重写副本的 `preset.yml`，并且绝不从模型接收 YAML 文本或 filesystem path。`preset_resolve` 返回由 roster 持有、供后续文件操作使用的路径。[copy-only authoring 决定](../simplification/2026-08-08-copy-only-preset-authoring.md)继续持有 browser 与 Host 的写入限制。

## 验证

Creator 的首个 assembled request 包含全部五个固定 schema，且没有 `preset_check`。真实 composition 路径执行 `preset_list` → `preset_read` 或 `preset_resolve` → `preset_copy` → `preset_validate`；copy 创建一个用户 preset，重复的目标 id 会被拒绝，validation 只有在 standing mount 成功后才报告成功。`standard` Session 不暴露这五个 Tool。生成的 Tool catalog 记录稳定的名称与 schema。

## 考虑过的替代方案

**保留临时 `cordis_mount` probe。** 动态注册无法把 Tool 放入已经在执行的模型请求。重新读取 registry 不会更新继续沿用早先 schema 集合的模型，重复片段也可能漂移。

**为每个 Agent preset 挂载固定 Consumer。** Preset discovery、path resolution、copy 与 validation 属于 authoring authority。普通 Agent Session 不需要这些操作，也不应承担其 schema 成本或获得这项 authority。

**恢复 browser YAML editor，或让 Tool 接收 composition 文本。** 这会重新引入 copy-only authoring 已移除的任意 composition 写入能力。固定 Consumer 暴露 roster 操作，而不是 composition 文本。

## 后果

Creator request 从首个模型 header 起承担五个 schema 的固定 token 成本。作为交换，authoring Tool 前缀在整个 Session 内保持稳定，每个 Creator 使用相同的名称与 validation 语义。该包不增加新的 composition 格式或 validation 规则；roster 操作的变化仍由 `agentPresets` 持有，其面向模型的 schema 与 Creator-only 挂载则共同接受验证。
