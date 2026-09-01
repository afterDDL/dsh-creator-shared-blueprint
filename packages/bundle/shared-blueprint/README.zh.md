# dsh-shared-blueprint

[English](README.md) | 中文

DSH 的 standalone Shared Blueprint Interactive Preview 包。一个 package 同时拥有 Host adapter、持久事件类型、generated Remote、browser client 与 additive composition patch。标准 Web bundle 不挂载 Blueprint，必须显式安装。本 package 不包含 Inspect Mode。

版本 `0.1.0-beta.1` 是正在持续进行压力测试和兼容性加固的可运行 Preview/Beta。这是第三方 package，不是 DeepSeek 官方插件。它当前需要使用[兼容的 DSH checkout](../../../release/interactive-preview/COMPATIBILITY.md)；未经修改的 DSH `0.1.0-rc.7` 加本 package 不受支持。

## 安装

把预构建 tarball 安装到 Web profile，然后启动普通 Web app：

```sh
dsh plugin --profile web add ./dsh-shared-blueprint-0.1.0-beta.1.tgz
dsh web
```

该 bundle 会添加一个 `shared-blueprint` Host row。其 `dsh.client` 声明加载同一 package 的 browser plugin；browser plugin 先挂载 package 自带的 generated Remote contribution，再注册 additive Layout、Sidebar 与 Conversation surface。移除 bundle 会同时移除 Host 与 Client 两个 face；`dsh-web-app` 内不保留 Blueprint row。

`ctx.blueprintAdapter.read(presetId, { agent? })` 会把真实 agent preset、带 scope 的 `systemPrompt.assemble()` 结果，以及未来会话或现有会话的权限 preset 投影到一起。没有 live agent 时，它通过一次 AgentPresets projection snapshot 同时取得已提交 metadata、组装文本与一个常驻 scope key，并为 assembly 与 Skill 读取复用该 key。它支持 Purpose、Identity、Capabilities、Behavior、Output 与 Access；原始状态中不存在的段落不会被补造出来。

服务启动期间，adapter 会以该 package 的 npm 身份注册自己所需的持久 Session event type。同一条注册路径既适用于被打入 DSH build 的 package，也适用于仓库外安装；冲突 owner 或重复的 live adapter 会在任何 Blueprint Session 被解码前使 composition 失败。

每个节点都包含 `id`、`type`、`value`、`source`、`status`、`editable` 与 `adapterRef`。`source` 区分 preset 文本、runtime 组装状态、继承自 Host/会话的策略，以及从 persona 文本语义分类得出的值。可选 `sourceLanguage` 是开放 metadata，只根据已编写 semantic text 中可识别的 Unicode script 证据推导；无法确定的拉丁文字不会被标成英文。client 会独立选择固定 Blueprint label 的译文，绝不会翻译 Tool、provider、Skill、配置 id 或 semantic value。根级 `revision` 是 composition 文本的 SHA-256；`runtime` 保留用于验证投影的确切工具名、提示词段落名与权限组合。

Capability 投影还会读取 target preset 带 scope 的 `ctx.skills` snapshot 与 active literal `tool-subagent` composition row。Skill 节点展示 identity、简短 description、invocation policy 与 scoped ownership，同时由 Host 内部保留 definition digest。Delegation 节点描述已配置的 Tool name、provider、one-shot 或 continuable 模式、persona 摘要与 provider availability；其 runtime summary 还会保留完整 parsed row config 的 SHA-256，包括嵌套的 `agentOptions`、`toolFilter`、`maxDepth` 与未求值的 `!!js` expression node。`maxDepth: 0` 的 active row 无法发起第一次 child 调用，因此会报告为 mapping gap，而不是可用 delegation。两类节点目前都只读：现有 Skill registry 没有 per-preset mutation API，而 delegation row 的变更无法在保留任意 Loader expression 与 provider lifecycle 状态的同时保证安全。

## 写操作

Behavior discovery 只读取真实 `persona.config.text`。显式 `行为规则`、`行为约束`、`工作方式`、`规则`、`约束`、`Behavior`、`Rules`、`Behavioral rules` 或 `Constraints` 标题支持编号列表、bullet 和约束正文，包括被 YAML `>-` 折叠的列表。可识别的 Identity 段落结束规则区块，因此尾随的运行时介绍不能成为最后一条规则的一部分。已有编号工作流程保留 ordinal 地址；Output 区块和明确标记的编号 Output 不作为 Behavior 来源。恢复的规则保留精确的已解析 source evidence 与 semantic/display value。缺少安全 ordinal 写回 anchor 时只读显示，不静默隐藏；空规则区块和有歧义的编号产生 mapping diagnostic。Identity、Purpose 和 Output discovery 保持独立。

事务内部拥有五种类型化操作：`updateIdentity`、`updatePurpose`、`updateBehavior`、`updateOutput` 与 `setCapability`；它们不再是单节点 Remote。Identity 与 Purpose 投影都会保留 persona 段落作为 source evidence，提取用户级 semantic/display value，记录确定性的 projection kind，并且只为一个唯一替换跨度开放写回。Creator 编写的 persona 使用 `角色：…` 或 `Role: …` 表达 Identity，使用 `目标：…` 或 `Purpose: …` 表达 Purpose，并使用独立 `输出：…` 或 `Output: …` 行表达 Output；受支持的 legacy 短语会保留外围文本，而有歧义的 prose 保持只读或不投影。独立 Output 只读投影，因为当前 typed write address 使用 ordinal；明确标记的编号条目继续使用既有 Output 写路径。capability 操作只接受 `web-search` 与 `web-fetch`。Apply 通过 `ctx.agentPresets` 解析目标，拒绝非 user trust，校验 Blueprint revision 与预期字段值，在内存中为每项确认操作修改一个 YAML 物理行或一个 `tool-web` 布尔值，再通过 `writeFileAtomic` 发布完整文件。它不会解析并重新序列化整份 composition，因此注释、行顺序、`!!js` 与无关格式都保持不变。

写入通过现有按文件 stamp 分代的 standing generation 影响后续会话。正在运行的会话继续使用其已加入的 generation；不带 agent 的重新读取解析下一个 generation，带 agent 的读取则报告该 agent 的确切组装。

生成的 `blueprint` Remote 命名空间暴露 `get`、`applyChangeSet`、`cancelChangeSet`、`setConversationContext` 与 `validateSession`。验证会通过持久 Session header 与 live scope 已加入的 composition 双重确认新 Session 使用了请求的 preset，要求 UI 携带的 Blueprint expected revision 仍是当前版本，并把 Identity、Purpose、Behavior 与 Output 的值同实际 assembled section text 比较。替换后的值可以保留旧值作为子串；conformance 会证明当前 projected value 出现在预期 assembled section 中，而不会把旧文本消失误当成 runtime 证据。它会把 enabled/disabled capability 同 live scoped Tool 集合比较，并为每个 enabled model-visible Tool schema 计算摘要，比较 scoped Skill identity、definition digest 与 invocation policy，验证 delegation Tool、prompt 证据和 provider availability，最后比较 live resolved permissions。结果只返回 section name、node id、schema/section digest 与 pass/fail，不返回 prompt、schema 或 Skill definition 内容。请求只有通过完整的 `sourceSessionId`、`routeId` 与 `changeSetId` identity 才能指向已提交的 Change Set。验证会从已恢复的 source Session log 中解析该精确 Apply receipt，并要求其 preset 与 committed revision 匹配，之后才会把 P0 的 preflight、preset write、reprojection 与 drift 证据同 runtime 检查连接起来；因此这项关联能跨越 adapter 进程重启。Web transport 会把全部 Blueprint endpoint 固定在 loopback，因为读取会暴露 composition 细节，写入会改变后续 Session 挂载的内容。

## 对话提案

如果 Client 在 source Session 已接纳的 Add-capability routing turn 尚未结束时离开该 Session，仅包含清理请求的 context update 会保留该 Session 的确切类型化 routing binding，直到匹配的 `turn/end`；其他 Session 继续使用各自独立的 Agent scoped binding。

添加能力通过 `setConversationContext` 提交 `capabilityInput.routeId` 与 `capabilityInput.userRequest`。Host 记录 `blueprint/routing-input`，将 interaction 绑定到确切接纳的消息、source Session 与 target，并在 request context 中单独提供路由说明。`create-agent` 必须引用当前原始请求，且该能力入口禁止新建 Agent；后续独立用户消息可以改变目标。`blueprint/route-decision` 在异步检查前为每个 `routeId` 保留一个操作。其他操作不能接管同一 interaction，包括先前尝试被拒绝之后；只有同类操作的失败尝试可以重试。不同 interaction 即使使用同一 target preset 或 source turn，也可以选择其他操作。添加能力会在 Identity、Purpose 或 Behavior 近似提案取得 existing-edit 所有权前拒绝它们，使可复用流程与协作者仍能进入 Skill 或 Subagent authoring。已接受的 Proposal 与 authoring route 都会结束 source turn。Active authoring context 仍会阻止提案，但提到创建的文本不会触发该限制。[路由来源与仲裁](../../../.agents/notes/implemented/bug-fix/2026-08-28-blueprint-routing-provenance.md) 记录证据与限制。

Apply 必须提供 `sourceSessionId`、`routeId` 与 `changeSetId`。Host 从该 Session 找到匹配的成功 `propose_blueprint_change` Tool result、route decision 与 `meta.blueprintChangeSet`，推导唯一获准的操作 batch，并在任何 preset 写入前拒绝缺失、外来或被篡改的内容。它会比较数组顺序、operation discriminant、target 与带类型的 scalar field，因此 transport 对象的 key 顺序既不构成授权，也不会产生误判。Proposal result 会先写入检查点。Apply 与 `cancelChangeSet` 共用 preset 串行队列，并发布一个引用 Proposal result sequence 的不可变终态；重复同一决定具有幂等性，而 Apply 与 Cancel 相互拒绝。`setConversationContext` 为每个 `applyReceipt` 返回其持久 Apply terminal 的确切 sequence，并同时返回 `proposalCancellations` 用于刷新恢复，因此 Client 会按 Apply 完成顺序而不是 Proposal 创建顺序排列 committed receipt。后续 revision 不会抹去这些终态。

`setConversationContext` 会把当前 Blueprint revision、可选 selected node、一个 runtime context contribution、`propose_blueprint_change`、`route_blueprint_capability_authoring` 与 `route_blueprint_creator_authoring` 限定到一个 live existing-Agent Session。选择节点只提供上下文，不会授权写入。结构化编辑提交 source Session、route、node id、node type、expected scalar 与 proposed scalar。Host 会针对已提交投影校验 Identity、Purpose、Behavior、Output 或可独立写入的 Web capability，只 enqueue 持久 routing input 与 user message，不执行写入。Proposal Tool 必须把该 source edit 作为第一项精确复现，并且只能补充 Host 发现的 dependent candidate；Apply 仍是单独的终态 UI 操作。直接对话 Proposal 使用相同的持久权威路径。Creator route 只接受模型给出的类型化 `create-agent` 分类，保留用户直接请求原文，只在文字脚本可以识别时附带开放 `sourceLanguage` metadata，并且不执行 preset 写入。Capability 与 Creator route 保持为两个独立 Tool，因此修改 existing Agent 或添加 Skill/Subagent 不会被 client 改判为新 Agent 创建。

Client 通过正常 `cordis` executor 继续执行已接受的 Creator route。来源先将请求原文、显示名称、可选 `sourceLanguage`、来源轮次、route id 与预留 Creator 身份写入 `blueprint/creator-authoring` 并持久化；成功结果发布时仅取消其当前轮次。独立目标采用该上下文。Host 只有在来源确切轮次已结束且 `whenIdle()` 证明完全停稳后才启动 continuation，并通过目标的持久收件箱凭据去重投递。创建或终止失败不能启动 Creator，并保留来源历史；启动校验要求重新打开未加载的来源。[独占交接](../../../.agents/notes/implemented/bug-fix/2026-08-28-blueprint-exclusive-creator-handoff.md) 记录顺序与失败语义。Creator guidance 保留请求语言，将缺失 metadata 视为无法确定，并能恢复 legacy `language` 事件。直接发送到 `cordis` 的 legacy 请求继续使用协调器的消息解析 fallback。

Capability-authoring route 不执行写入。它只接受 `skill` 或 `subagent`，把结果绑定到当前 preset 与 revision，并拒绝过期或不匹配的上下文；未实现的 `composition` kind 不再接纳。继续执行前，Host 会从唯一成功的 `route_blueprint_capability_authoring` Tool result 及其匹配的 call 和 source-owned route decision 重建确切 route、source、target、revision、request 与 kind；browser request 只能逐字段复现这些值。`cordis` source 会在其确切 routing turn 结束后直接持有 lifecycle。非 `cordis` source 与 legacy record 仍保留 domain-separated deterministic `cordis` worker；首次 adopt 只允许各出现至多一次的 `permission/preset`、`sandbox/mode` 与 `approval/policy` 初始化事实，并拒绝任何已有任务或 authoring 历史。已有 `blueprint/capability-authoring` start 是持久 retry receipt。foreign owner、非 `cordis` composition、已污染的 legacy worker、失败或不完整的 source route、被修改的 DTO，以及 lifecycle 结束后的 replay，都会在任何 lifecycle 或 conversation binding 变化前被拒绝。持有 lifecycle 的 Session 会写入 source Session 与 route、base revision、每个 roster entry 的 trust、display metadata、health 与 composition digest、projected node baseline、全部 scoped Skill summary，以及带完整 config digest 的全部 delegation summary。完成时先证明每个 non-target preset record 未变、target metadata 未变，并且每个既有 Skill 与 delegation 都同 baseline 具有相同的 typed field 与 digest；之后才要求恰好新增一个获准的 target capability，保留每个 baseline node，并拒绝跨 kind 或第二项 capability addition。Skill 完成还要求该项是新的 target-owned 可调用定义；Subagent 完成还要求该项是新的 provider-backed delegation，并通过 fresh target-bound P1 verification Session。Host-owned terminal settlement 与 lifecycle-scoped 用户取消保持持久，刷新不会复活已结束 lifecycle。[能力 continuation authority](../../../.agents/notes/implemented/bug-fix/2026-08-30-blueprint-capability-authoring-authority.md)记录 admission；[精确 capability baseline](../../../.agents/notes/implemented/bug-fix/2026-08-30-blueprint-capability-exact-baseline.md)记录 delta authority。

Host 会在独占 target lease 期间把完整 target directory clone 到隐藏 sibling candidate。Creator 通过 scoped roster overlay 只能看到该 candidate，并且只能在其中写入；formal preset 与 committed Blueprint 保持不变。每个完全停稳的 Creator turn 会先通过精确 composition allowlist，再由 fresh isolated Session 证明真实 mount、lane-specific runtime conformance 与 active capability projection。Attempt 失败时，Host 写入私有 typed diagnostic，并在同一个 source Session 与 route 下唤醒同一个 Creator；有界 repair 期间 source 始终保持 configuring。成功时会在可从 crash 恢复的整目录 publication 前 flush `blueprint/capability-verified`。耗尽时则证明并保留 formal baseline、丢弃 candidate，并生成不含实现 diagnostic 的可重试 user terminal。Durable cancellation checkpoint 会阻止 restart replay 待处理 repair input。[已验证 capability publication](../../../.agents/notes/implemented/bug-fix/2026-08-30-blueprint-capability-verified-publication.md)记录 isolation、recovery、publication 与 projection generation 一致性。

结构化编辑不会先写。浏览器提交 committed node type 与 scalar、proposed scalar、source Session 和 route。Host 从 node type 推导 operation，发现有界 P2 candidate，持久化 routing input 与 human message，然后等待 source-owned Proposal。关闭 capability 时，只接纳在文本中明确引用其 canonical Tool name 的 editable semantic text；Purpose 与 Identity 使用已定义的 same-persona relation。Proposal 会拒绝被改写的 source item、重复 target，以及 candidate set 之外的每个 dependent target。Apply 随后校验 durable Proposal 的 revision、target、editable、expected value、operation type、semantic target 与 physical anchor，再进行 staging。它只发布一次完整文件，并校验所有 target 与 non-target semantic stability。写后投影失败时，只有 committed revision 仍为当前版本才恢复；并发外部更改会阻止恢复覆盖更新工作。

Session invariant 会根据确切的更早成功 Proposal Tool result、匹配 Tool call、source-owned route decision、owner、target、revision 与 operation content 校验每个 Apply 或 Cancel 终态。一个 Change Set 只有一个不可变终态。Capability lifecycle invariant 会拒绝不支持的 kind、畸形 roster、Skill、delegation 或 config-digest baseline、不一致的 terminal copy，以及没有排在 start 之后的 completion evidence。

同一个方法还接受与正常可写 preset context 互斥的 Creator Draft context，用于 Creating、Waiting、Paused 与 Ambiguity。启用 Draft 时会移除 existing-Agent Proposal Tool；即使已可靠关联 authoring target，只要其 Blueprint 仍与 `preset_copy` source 相同，也可以继续不展示该投影。结构化 `ask_user_question` 回答仍是正常 Creator 输入。即使旧工具调用已经进入执行路径，也会以 `creator-authoring-in-progress` 拒绝。只有 coordinator 进入 Ready 后，才能重新安装正常的可写 preset/revision context。

Skill verification 由 Host 负责：durable start 在 authoring 前写入每个可见 Skill 的 name、description、invocation policy、scope、provider、source 与 definition digest。Composition authority 只允许一条关闭 default root 的新 local `skill-filesystem` row、一条 `tool-skill` row，以及一个新的 target-owned model-callable Skill。Host 会在创建 fresh verification Session 前拒绝第二个 Skill 或任何 delegation，随后要求 scoped catalog evidence、匹配的 active Blueprint node，并通过 `skill` Tool 实际加载 authored definition。Failure 会进入共用 repair loop；只有 verified publication 才能完成。

Creator 完成通过一次 `blueprint/creator-authoring-ended` 写入检查点，引用 route、开始事件、成功的 `preset_validate` 结果、目标 preset 和已完成的 authoring 轮次。恢复先尊重该任务级事实，再考虑后续 Session 活动，并忽略陈旧的 Draft 激活。错误轮次记录失败；用户停止的未完成轮次仍可继续。只有开始事件的历史可以从首个满足条件的 authoring 区间补充终态证据，而不改写既有事件。存在多个验证目标时不能推断完成。参见[任务归属](../../../.agents/notes/implemented/bug-fix/2026-08-28-blueprint-creator-task-terminal.md)。

Subagent verification 由 Host 负责，并使用相同 recovery lifecycle。其 durable baseline 记录每个 delegation row 的 identity、Tool、provider、mode、availability、enabled state，以及完整 parsed config 的 canonical digest，包括嵌套 child option、Tool filter、depth policy 与 `!!js` node。Composition authority 只接纳一个新的 active `tool-subagent` row 且不接纳 Skill，并把该 row id 与 config digest 绑定到 fresh-Session provider、Tool、prompt、permission 与 active Blueprint evidence。Verification 不提交业务 turn 或 child task，并在 flush 后释放 live Agent。重复 observation 会复用 durable repair 或 verification checkpoint；取消仍为 cancelled。

## 模型体验

间接影响来自拥有相应提示词段落和工具 schema 的 preset 行；直接影响来自启用对话上下文时提供的当前 Blueprint、selection、提案与 authoring-route 规则、只生成预览的工具，以及不执行 preset 写入的结果。结构化编辑提交会加入一条 source-owned routing event 与普通 user message，使模型能提出与请求精确一致的编辑，而不会把 UI 意图当作已经提交的 preset 变更。

#### KV Cache effect

读取没有影响。启用正常对话上下文会在清除上下文或 Session 结束前，加入一个带 scope 的 runtime-context snapshot 与两个 Builder Tool schema。Creator Draft 与绑定 target 的 capability-authoring context 只加入各自 snapshot，并移除两个工具。结构化编辑会追加一条 source-owned routing event 与一条 user message，但不会更改 preset；只有之后确认的 Apply 才能改变随后创建的 Session 的系统提示词前缀。运行中的 Session 保留既有 preset generation。

## 已知限制与暂缓事项

- **Persona 语义使用窄文本锚点** —— Creator 编写的角色、目标与独立 Output 行提供稳定 Identity、Purpose 与 Output source，不新增第二套 preset 模型。Legacy 角色和任务短语只有在可以确定性提取时才展示。Identity 与 Purpose 需要唯一单物理行跨度才能写入；Output 还需要既有编号地址。任意、竞争或多行 prose 保持只读或不投影。
- **只有两个 capability 具备写 adapter** —— Web Search 与 Web Fetch 映射到显式的 `tool-web` 布尔值。File Read 可以展示，但不能独立关闭，因为 `tool-fs` 在同一行下拥有多个工具。
- **工具可见不等于 provider 可用** —— 即使没有可用 provider，工具注册表也会有意保留已启用的 Web 工具；Web 服务并未提供 provider 枚举 API。
- **Access 只读** —— 权限 preset 属于 Host settings 与 session log，不属于 agent preset。
- **Generation 不暴露 revision identity** —— preset service 可以确认持久 Session preset 与 live scope 已加入的 preset generation，但不会暴露创建该 generation 的精确 source-text hash。因此 runtime validation 证明的是 expected revision 仍新鲜且 runtime content/schema 等价，并明确返回 `strictRevisionBound: false`；它不会宣称具备 revision 到 generation 的密码学绑定。
- **提案意图校验是保守规则，不是语义证明** —— Host 会拒绝假设性或不明确的用户直接消息，但 proposed value 与影响说明仍由模型起草。「全部应用」会在一次原子发布前校验初始 revision 与每项操作；语义依赖质量仍由模型判断。
- **Candidate discovery 只使用 literal 与结构关系，不使用领域知识** —— Host 通过 canonical Tool reference、Purpose 中被移除的 literal 与同 persona 关系限定模型可以判断的节点，但不会编码 APS 或 DAAD 属于德国申请等事实。模型仍负责判断已接纳 candidate 是否冲突以及应该如何改写；没有关联影响的编辑可能只得到确认。
- **Remote API 仅供 Web 使用且仅限 loopback** —— 当前没有 SDK 方法；非 loopback Web 部署在形成认证方案前不能读取或编辑 Blueprint。
