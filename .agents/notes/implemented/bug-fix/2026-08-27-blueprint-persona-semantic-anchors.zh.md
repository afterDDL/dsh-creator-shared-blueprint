# Agent Note：Blueprint 从显式文本锚点投影 persona 语义

Status: implemented

[English](2026-08-27-blueprint-persona-semantic-anchors.md) | 中文

## Problem

Interactive Blueprint 会把 Identity 之后的第一个 persona 段落当成 Purpose，并且只在编号条目包含少数交付标签时识别 Output。因此复制来的 runtime introduction 可能连同 `{{model}}` 与 `{{cwd}}` 一起出现在用户级任务中，而详细报告模板完全不可见。能力摘要还会隐藏没有恰好被领域规则消费的 active Web Search 与 File Read，所以真实具备搜索、文件和 delegation 的 Agent 可能看起来只有一项协作者能力。

## Decision

本决策收紧了 [Interactive Blueprint adapter](../feature/2026-08-24-interactive-blueprint-preset-adapter.md) 所拥有的 persona projection 规则。Creator 编写的 persona 继续以普通 prompt 文本作为唯一 preset source。现在它会提供一条 `角色：…` 或 `Role: …`、一条 `目标：…` 或 `Purpose: …`、若干编号 Behavior，以及恰好一条独立 `输出：…` 或 `Output: …`。复制 preset 后会在校验前审查这些 semantic line 与多余翻译括注。这只是 authoring convention，不是第二套配置模型。

Purpose 投影会保留精确 source paragraph，提取 semantic 与 display value，记录 source 是显式还是推断，并且只为唯一物理行替换跨度开放写回。唯一显式 marker 的优先级高于 legacy 职责短语；多个显式 marker 仍视为有歧义。显式 marker 与受支持的职责短语会在 typed write 时保留 prefix 与 suffix。Legacy fallback 会跳过 heading、Identity introduction 和包含 runtime-template variable 的段落。恰好一条独立 Output 行会从显式 marker 投影但保持只读；明确标记的编号 Output 继续使用既有 ordinal 写 adapter。

Identity 与 Purpose、Behavior、Output 使用同一种持久文本更新事件。Session invariant 校验其语义值与已记录的 candidate evidence；Identity candidate 仍仅限 Purpose、Behavior 和 Output。安全角色替换跨度、revision 与 expected value 继续由权威写入路径校验。事件回放时重新读取当前 preset，会错误地用后续配置判断历史编辑，因此 invariant 校验已记录证据，而不重新构造该次写入。

Client 只从 semantic node 派生 Agent 特有工作，同时为 active Web Search 与 File Read 创建由真实 capability node id 支撑的独立用户级摘要。Search 可以保留 Web Fetch 作为额外 evidence。只有 File Read 与声明分析类工作的 semantic text 同时存在时，才使用文件分析文案。限定于 preset 的 Skill 与 provider-backed delegation 继续遵循已有 evidence 规则，inherited Skill catalog 仍然隐藏。

Behavior discovery 不能依赖 YAML 保留物理换行：Creator 可以把规则标题和连续编号行放入 folded scalar。已解析 persona 仍是权威来源。即使缺少既有 ordinal 写回地址，`行为规则`、`行为约束`、`工作方式` 等显式规则区块也会产生有来源的规则；此类投影只读并附 mapping diagnostic。可识别的 Identity 段落结束规则区块，防止尾随的运行时介绍污染规则证据。编号 Output 和显式 Output 区块仍被排除。[真实折叠规则 fixture](../../../../examples/web-blueprint-demo/tests/fixtures/preset/blueprint-adapter/rc1-folded-rules.cordis.yml) 与 [Creator 工作方式 fixture](../../../../examples/web-blueprint-demo/tests/fixtures/preset/blueprint-adapter/creator-working-method.cordis.yml) 固化这一边界，不修改 Creator authoring 或其他 semantic parser。

## Alternatives considered

单独增加 semantic metadata 文件会在 preset persona 之外形成第二事实源。render 时调用模型总结会让展示不稳定，也可能生成没有写回地址的语义声明。因此两者都被否决，改为在现有 persona 文本中使用显式行，并进行确定性投影。

把所有行内编号视为规则会误收报告结构和任意正文。新恢复的格式必须有受支持的规则标题，才能在不引入通用自然语言分类器的情况下保留语义证据。以 typed write-back 作为可见性前提会丢弃真实约束，因此安全展示与写入授权分离。

## Consequences

- Purpose display 与 write-back 不会再消费 runtime persona introduction。
- Creator-created Agent 无需新增 preset 字段，也无需修改 P0、P1 或 P2，即可投影五个用户级区块。
- Purpose edit 只改 anchor span，因此保留角色和 runtime-template 文本。
- Output 仍然只有在编号 source line 唯一时才可直接编辑；独立 semantic Output 保持可选、可读。
- 主要 runtime capability 不再从 semantic summary 中消失，但 persona 单独声称拥有能力仍不能生成节点。
- Capability label 遵循 Blueprint language choice；Tool、Skill 与 provider 等技术 id 保留在内部。

## Testing

聚焦 projection 测试覆盖 runtime-template 与 legacy 职责段落旁的显式中文 Purpose、唯一独立与编号 Output 识别、有歧义的重复 anchor，以及保留 Identity 与 template variable 的窄 Purpose 替换。Client 测试覆盖六种不同领域 Agent 的差异化摘要、具有真实搜索/文件/delegation evidence 的供应商尽调工作，以及英文 capability label。包级 TypeScript 检查覆盖 Host adapter 与 Blueprint client。
