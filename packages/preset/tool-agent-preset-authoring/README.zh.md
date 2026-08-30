# @deepseek-ai/dsh-tool-agent-preset-authoring

[English](README.md) | 中文

面向 Creator 的模型工具，直接使用现有 `ctx.agentPresets` 服务。本包不提供新服务、authoring 格式、sandbox 绕过或 isolate realm；由 composition 决定哪些 Agent scope 获得这五个工具注册。

## 工具

- `preset_list` 返回权威 preset 清单。
- `preset_read` 按 id 返回一份已存储的 composition。
- `preset_resolve` 返回一份 preset 的清单 metadata 与 composition 路径。
- `preset_copy` 从现有 preset 目录创建新的用户 preset，并拒绝已存在的 id。
- `preset_validate` 调用 `standingKeyFor(id)`，仅在 preset 通过正常 standing composition 路径挂载后报告成功。

每项操作都直接委托给 `ctx.agentPresets`。因此，用户根目录选择、shipped preset 保护、id 验证、copy 回滚、拒绝覆盖和挂载验证仍由 preset 服务负责。

## Composition scope

随附的 `cordis` preset 以 `tool-agent-preset-authoring` 挂载本包，因此 Creator 模型从首个请求起就能获得全部五个 schema。普通 preset 不挂载本包，无法看到或调用这些工具。

## 模型体验

### 工具 schema

#### 模型看到的内容

仅当模型的 preset 挂载本 Consumer 时，模型才会看到生成的 [`preset_list`、`preset_read`、`preset_resolve`、`preset_copy` 和 `preset_validate` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-agent-preset-authoring)。

#### Token 影响

五个固定 schema 会为每个 Creator 请求增加固定 token 开销。工具调用的参数和渲染结果会保留到 compaction。

#### KV Cache 影响

只要包版本和 preset composition 不变，这五个 schema 就构成稳定的请求前缀。从首个请求直接可用，避免了临时注册工具造成的跨请求 schema 插入。

## 已知限制与暂缓事项

- **copy 是唯一写操作**：本包不能编辑、删除或覆盖 preset；后续 composition 编辑继续使用现有 File／Shell sandbox 和 approval 路径。
- **验证只证明 composition 能挂载**：`preset_validate` 不运行模型轮次，也不判断新 Agent 的任务质量。
- **暴露范围由 composition 决定**：若其他 preset 挂载本包，会有意向其暴露相同的清单读取和用户 preset copy 操作；随附 composition 只向 Creator 挂载。
