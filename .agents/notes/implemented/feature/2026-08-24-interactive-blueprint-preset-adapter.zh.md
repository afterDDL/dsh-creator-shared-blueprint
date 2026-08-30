# Agent Note: Interactive Blueprint 投影并受限编辑 agent preset

Status: implemented

[English](2026-08-24-interactive-blueprint-preset-adapter.md) | 中文

## Problem

Interactive Blueprint 不能通过一份并行 JSON 模型得到验证。有意义的目标必须在 Harness 实际挂载的 composition 上完成闭环：读取 preset 与继承策略，观察带 scope 的 runtime 组装，编辑受支持的语义字段，写回 preset，再证明新 Session 收到修改后的提示词段落、工具与权限。通用 YAML 编辑器虽然容易伪造这个闭环，却会恢复 [copy-only preset authoring](../simplification/2026-08-08-copy-only-preset-authoring.md) 已移除的任意 `!!js` 写入能力。

## Decision

`@deepseek-ai/dsh-blueprint-adapter` 是位于 `ctx.agentPresets` 旁的可选 Host 服务。它把 preset composition 文本、preset standing scope 或 live agent 下的 `ctx.systemPrompt.assemble()`、scoped `ctx.skills` snapshot、active literal `tool-subagent` row，以及 `ctx.permissionPresets` 投影为 Purpose、Identity、Capabilities、Behavior、Output 与 Access JSON 节点。每个节点都声明来源、runtime 状态、可编辑性与 adapter 自有引用；不存在的语义段落保持不存在。Skill 节点保留仅供 Host 使用的 definition digest 与 invocation policy；delegation 节点保留已配置的 row identity、provider、模式、persona 摘要与当前 provider availability，不会把 child Session 当作配置。

Purpose 与 Output 来自 persona 插件的同一个 prose scalar，而不是独立配置字段。[显式 persona semantic anchor](../bug-fix/2026-08-27-blueprint-persona-semantic-anchors.md)会保留精确 source paragraph 并投影用户级 value；安全的 legacy Purpose paragraph 仍标记为 inferred。带编号的 Behavior 仍归因于 preset。Capability 节点来自组装后的工具 schema；Access 来自 Host 默认值或 live session 中已固定的权限事件。根级 composition hash 是写入使用的 revision。

写操作是闭集：Identity 中确定且唯一的角色跨度、Purpose、一个带编号的 Behavior、一个具有唯一锚点的带编号 Output，以及显式的 `tool-web.config.search` 与 `tool-web.config.fetch` 布尔值。Identity 解析会保留 persona 段落作为 source evidence，推导不含 runtime template prose 的 semantic/display role，记录提取方式，并且独立记录是否存在窄替换。Creator 编写的 persona 使用请求语言下的首行 `角色：…` 或 `Role: …` 作为 semantic source。受支持的 legacy introduction 在 `updateIdentity` 时保留前缀、后缀、模型变量与工作目录变量；能够确定提取但没有安全跨度的 legacy role clause 仍可选择，但保持只读。每次写入都通过 roster 解析 preset，只接受 `user` trust，校验 revision 与预期值，替换一个物理行或布尔字段，再原子发布完整 composition。它不会重新序列化文档。[standing generation 机制](../architecture/2026-08-08-per-preset-standing-mounts.md)把编辑带给后续会话，既有会话继续使用已加入的 generation。

`tool-pwsh.config.enableRunInBackground` 会改变 live `pwsh` schema，但 Blueprint 不投影参数级 capability，因此它不是端到端映射。`tool-fs` 通过一个 row 注册 Read、Write、Edit 与可选的图片读取，并且没有单工具 enable 字段，因此 File Read 不能独立写入。只有 preset 提供唯一的带编号 Output 物理行时，adapter 才接受替换。恰好一条独立 `输出：…` 或 `Output: …` persona 行会以只读方式投影；adapter 绝不会创建通用 Output 字段。

Web bundle 会挂载 adapter 及其生成的 `blueprint` Remote 命名空间。`get`、`applyChangeSet`、`cancelChangeSet`、`setConversationContext` 与 `validateSession` 同其他 privileged configuration 调用一起固定在 loopback；五种 semantic operation 只在原子 Change Set transaction 内部使用。`@deepseek-ai/dsh-client-ui-blueprint` 把 `competitive-research` 投影到现有 sidebar、conversation input、details 与 overlay slot。控件遵循每个节点的 `editable` 标志，committed transaction 之后只执行一次新的 `get`；「试用 Agent」会先记录该投影 revision，再使用所选 preset 新建 Session。Client runtime 的浏览器持久化只保留最近一次成功投影的 preset id；启动时只有最新名单与 `blueprint.get` 均成功，才会接纳该 id。active capability authoring 与 active Creator association 的优先级高于已恢复 preference。terminal lifecycle 会保留其有效 target，但不会恢复任务状态，也不能替换指向其他 target 的更新持久或进程内用户选择；用户在本次启动后做出的显式选择也会阻止后续 active 自动恢复替换它。Session 创建与名单 hydration 不拥有、也不会替换已选择的 Blueprint target，因此对话上下文与 structured interaction 会继续限定在该 target。验证会检查持久与 live joined preset identity，在实际 assembled section text 中查找每个已投影 Identity、Purpose、Behavior 与 Output 的值，比较完整 Tool presence 与 model-visible schema digest，比较 scoped Skill identity、definition digest 与 invocation policy，验证 delegation Tool、prompt 证据和 provider availability，并比较 resolved permissions。结果只返回 digest 证据；可选 P0 identity 只接受从 source Session 恢复的 exact durable Apply receipt，raw prompt、schema 与 Skill definition 内容均保留在 Host。

UI controller 接收与 provider 无关的 roster 和封闭 Blueprint operation interface，而不是完整 Client API。DSH binding 会把真实 preset roster 映射到该输入，并保留当前 preferred target 策略。`InMemoryBlueprintDemoAdapter` 接受调用方提供的 seed，在浏览器内存中实现相互隔离的 roster 读取、projection 读取、窄写入、capability Tool list 更新、原子 Change Set preflight 与 commit，以及 reset。它不内置任何示例 Agent，也不暴露 runtime-validation 方法。静态 Demo shell 可以模拟对话和试用呈现，但不能把模拟结果呈现为 live DSH Session，也不能复用 runtime-conformance 成功状态。

Demo Mode 不提供第二套 layout 或 component tree。`mountBlueprintDemoUi` 会把同一组 production roster、details、selected-context、proposal 与 overlay component 注册进正常 Web Client slot，而普通 layout、theme、sidebar、conversation、workspace 与 Session plugin 会保持挂载。可选 Host 配置会接收一份 JSON bootstrap 文档，并在 production shell 启动前将其注入为 `window.__DSH_BLUEPRINT_DEMO__`；browser 仍要求 `fixture` 与 `blueprintDemo` 两个 query flag 同时存在才会使用它。可运行的 `examples/web-blueprint-demo` overlay 持有临时预览 seed、延后发布的 Creator scenario 与非默认端口，其专项 fixture roster 只显示交付的 `cordis` 入口和 Demo 自带的上市公司研究 Agent。新会话从已记录的 `danger-full-access` 权限事件开始，因此 production picker 会显示 Full access，而普通 fixture 的默认值不变。明确的新建 Agent 请求会先记录 Draft baseline，再发布调用方提供的 scenario。Fixture Session event 随后驱动 Creator 进度、原生授权与试用 transcript；Demo-local coordination 则发布 Purpose 修改、Skill node、协作 Agent node 与本地验证状态。所有步骤都不会调用模型、Tool 实现、Agent loop、Host 写入或网络 endpoint。验证状态只证明确定性 Demo flag 已到达，不代表 runtime conformance。Agent identity 与 scripted content 仍由调用方 seed 持有，不成为 package default。

`DemoScenarioController` 是 fixture walkthrough lifecycle、Creator projection、Blueprint selection、proposal、capability authoring 与 trial state 的唯一持有者，并把兼容视图投影给现有 production component。connection fixture 通过单一 timeline player，使用 production `SessionEvent` 与 pending-interaction frame 字段构造 scripted transcript，因此最终产品 capture 可以替换 fixture input，而不必替换 UI tree。controller transition 与 fixture timing 均不定义最终产品 interaction behavior。

「能力」区只拥有一个 `＋ 添加能力` 入口，不会形成独立插件管理界面。client 主要从已投影 Purpose、Behavior 与 Output 语义派生最多六条可重复执行的具体工作。已启用 Tool、scoped Skill 与已配置 delegation row 会支持这些陈述。Active Web Search 与 File Read 还会得到由真实 capability node id 支撑的独立用户级摘要，而 inherited Skill catalog 仍不会凭自身产生通用能力。每条陈述保留其语义与 runtime supporting node id；raw name、ownership、provider 与 mode 只保留在 Blueprint 和 P1 证据中。选择一条陈述会把一个真实 supporting node 安装为对话 context。

「添加能力」会询问用户希望得到的结果，并启动一条绑定 target 的配置记录。普通 existing-Agent 对话是默认路径；当 editable Blueprint 可以实现需求时，`propose_blueprint_change` 会继续可用。第二个只生成预览的工具 `route_blueprint_capability_authoring` 只能分类明确要求新 Skill 定义或 Subagent 配置的请求。其类型化结果绑定当前 preset id 与 revision，且不执行写入。[source authority 决定](../bug-fix/2026-08-30-blueprint-capability-authoring-authority.md)要求 Host 从成功的 source Tool result 重建全部 continuation field，并且只接纳由 source Session 与 route 确定的空日志 `cordis` child。该 Creator Session 会通过 `blueprint/capability-authoring` 事件记录 target preset、原始请求、类型化 authoring mechanism、exact baseline、显式终止结果与 terminal sequence。client 刷新后，Host 会从这些事件重建未结束的 context，原生 pending interaction 则恢复 question 与 approval wait。在 recovery request 完成分类前，重复的 Session snapshot 不得启动普通新 Agent observer；只有 recovery 明确把 Session 识别为普通 Creator 工作后才能运行该 observer。terminal record 会阻止 coordinator 重新解释 sequence 不晚于它的消息；更晚的用户直接消息可以启动独立工作。过期的普通 Blueprint context request 无法替换 active authoring binding。配置记录区分判断、提案确认与 Creator authoring，根据真实重新投影刷新，并为其 source Session 保留成功、失败或取消状态，直到下一次 capability request 替换它。系统不会创建推测性的 Blueprint node 或安装结果。

Subagent authoring 采用专用的安全顺序，因为 P0 无法在一次类型化 transaction 中同时增加任意 composition row 与修改 persona prose。持久 start event 会记录完整 preset roster 与 target revision、每个 projected target node、每项 scoped Skill definition summary，以及包含完整 parsed config digest 的每项 delegation summary。[exact baseline 决定](../bug-fix/2026-08-30-blueprint-capability-exact-baseline.md)只允许新增一个 routed kind 的 capability，同时要求每项 baseline capability、non-target preset、target metadata 与 non-target semantic node 保持完全一致。Creator 收到一项 existing-target operation：禁止 `preset_copy` 与新建顶层 preset，只允许真实 `tool-subagent` 配置字段，要求稳定的 row 与 Tool identity，并要求 `persona` 中包含明确协作者名称。[仅供 Creator 使用的固定 preset authoring Consumer](../bug-fix/2026-08-30-creator-only-preset-authoring-consumer.md)提供 `preset_validate`；该操作只证明可挂载，并不是允许语义编辑的 P1 证据。后台 Creator Session 不会替换用户当前对话。Creator 回合 completed 本身不代表成功：Host authoring 解析器会重新投影 target，要求恰好出现一项 Tool 已启用且 provider 可用的新 delegation，创建专用验证 Session，并要求匹配的 P1 delegation evidence 通过后才持久化 completed。Client 会发布已验证投影并保留 source-owned terminal，不要求加载 Creator 时间线。验证不提交模型轮次，也不 spawn 业务 child；临时 live Agent 在 Session 检查点完成后释放。缺少 row、provider 不可用、baseline 变化、conformance 失败、拒绝、取消或停止都会结束 lifecycle，且不会产生正式 capability。`maxDepth: 0` 的 active row 无法发起第一次 child 调用，因此会成为 projection gap，而不是可用 delegation。

对话上下文限定在 Session，而不是只存在于 UI。`setConversationContext` 会注册一个包含当前投影与可选 selected node 的动态 runtime context contribution，以及 `propose_blueprint_change` 和 `route_blueprint_capability_authoring`。Selection 只提供上下文，不会强制编辑。两个工具都只创建持久化的类型化预览，不执行写入。Proposal validation 会拒绝不明确或假设性的用户直接消息、过期 revision、不兼容操作、变化后的当前值、只读节点、File Read、Shell Background 与未知节点；authoring-route validation 会拒绝过期 target/revision context 与不受支持的 authoring kind。对话卡片只在 Apply 后调用既有语义写方法，再重新读取 Blueprint。Creator Draft 与绑定 target 的 capability-authoring context 会移除两个工具。上下文移动或 Session 结束时，带 scope 的注册会被移除；runtime validation 会排除它们，因为它们描述 Builder 对话，而不是目标 preset。

每个可编辑的 Identity、Purpose、Behavior、Output、Web Search 与 Web Fetch 控件都遵循[structured edit 决定](../bug-fix/2026-08-30-blueprint-structured-purpose-edit.md)。提交前，其 browser-local draft 不产生业务效果。提交会记录 source-owned route 与用户可见 interaction，但不会写入 preset；第一项 Proposal operation 必须精确复现该 source edit，后续 operation 只能指向由 Host 推导的 P2 candidate，并说明明确 dependency。Tool row 会把展示绑定到确切 call、source node、type、operation、scalar type 与 changed value。Apply 与 Cancel 会从持久 source evidence 重建 authority，并对每个 preset 共用一项串行 terminal decision。Apply 会针对同一 composition preflight 并 stage 封闭 operation list，只发布一次文件，刷新 exact receipt，再重新投影。Cancel 会刷新 durable terminal 而不写入。因此 refresh 可以恢复 terminal decision，主 Blueprint 则始终只投影 committed state。

客户端 Creator 协调器只会在 Session 运行 `cordis` preset 时，从持久 user message 识别明确提出创建、搭建或想要一个有名称 Agent 的请求。它会立即用 Draft 替换无关 Blueprint，并根据现有 running 状态、终止 turn 原因以及原生 question 或 approval interaction 推导 Creating、Waiting 和 Paused。协调器可以在页面重新挂载后，从持久 user message、已结束 Tool result、待处理 interaction 与最近 turn end 重建该 Session scoped record。它通过从当前名单排除随后 authoring 证据归属的 preset 来恢复创建前名单。Creating、Waiting、Paused 与 Ambiguity 会移除 `propose_blueprint_change`；原生 `ask_user_question` 回答保持普通 Creator authoring 输入。Host 还会以 `creator-authoring-in-progress` 拒绝已经进入执行路径的旧调用，形成第二层防护。成功的 `preset_copy` 会直接贡献其类型化 source 与 target id，不依赖 prose 或路径推断。明确影响 preset 策略的问卷回答会区分使用已有 preset、基于已有 preset 完善与新建独立 preset：使用已有 preset 可以接纳指定 baseline preset；新建独立 preset 会排除 baseline preset；基于已有 preset 完善会等待后续 authoring 证据。策略尚未决定时，如果当前 Session 已对 metadata 名称与 Draft 完全匹配的某个 baseline id 成功调用 `preset_validate`，也可以接纳该唯一 target；这份类型化证据只标识复用 target，不证明已经完成语义定制。名单轮询只接受没有 broken 标记且能通过正常 `blueprint.get` 投影的候选。其他关联仍保持 Session scoped：候选必须出现在该 Session 已记录 mutation Tool 参数中的 `agent.cordis.yml` 路径里，或其规范化 metadata 名称必须与 Draft 名称完全相同。关联前，客户端只显示 Draft。一个可归属候选会确定 target，但复制得到的 target 在其用户级 Blueprint 节点仍与类型化 source preset 相同时继续显示 Draft 空态，即使它已经通过挂载验证；比较不包含 preset metadata 与 revision。Purpose、Identity、Capability、Behavior、Output 或 Access 的首个值差异会让真实投影开始显示，且本次生命周期内展示状态保持 sticky，后续投影持续更新。通过验证接纳的既有同名 baseline 没有 copy source，关联后会显示其当前真实投影。此后 Identity、Purpose、Capability、Behavior 与 Output 均可选择；selection 会安装包含重新投影 target 与真实 selected-node 语义的 Creator authoring context，而不是 existing-Agent proposal context。直接 Host 写入、Apply 与「试用 Agent」保持禁用。轮询会在整个 authoring 期间重新投影已关联 target，保留仍存在的 selection，并在 revision 变化后刷新其上下文。多个或无法归属的候选保持 ambiguity。Ready 要求没有运行中工作或待处理 interaction，并且出现晚于创建流程最近一次用户输入或原生等待点的结构化 `completed` turn；协调器随后会再次读取最终 Blueprint，再开放编辑与「试用 Agent」并恢复提案上下文。reconcile 会按 Session 合并执行，并在较新 observation 改变 lifecycle record 后丢弃旧结果，因此较早的名单或投影读取不能覆盖终止完成状态。绑定不会在 Creator Session 上选择 preset，「试用 Agent」仍会创建独立 Session。

Existing-Agent 对话会在 Proposal 与 capability authoring 之外，单独暴露一个 `route_blueprint_creator_authoring` 分类 Tool。该 Tool 保留用户直接请求原文并产生类型化 `create-agent` route；client 会清除旧 Blueprint，通过正常 `cordis` executor 继续该 route，并在唤醒目标 Creator Session 前记录 `blueprint/creator-authoring`。该事件持有 source Session、route id、请求、显示名称与可选的开放 `sourceLanguage` metadata。轻量 Unicode script detection 会在识别出相关证据时记录 `zh`、`ja` 或 `ko`；其他文字会让该字段保持缺失，Creator guidance 则保留原始请求的主要自然语言，不会 fallback 到英文。恢复流程也能读取把等价 metadata 保存在 `language` 下的 legacy 事件。页面重新挂载后会从这条事件恢复 Creator guidance，因此任意语言的创建请求都会共用一条不依赖关键词的类型化 executor 路径。现有 parser 只为直接发送到 `cordis` Session 的 legacy 请求保留。Existing-Agent 修改和绑定 target 的 Skill、composition 或 Subagent authoring 不使用新 Agent route。

Proposal Tool 同样会在封闭操作列表之外携带类型化的 `modify-existing-agent` 或 `reconcile-direct-edit` intent。Host 仍会绑定最近一条用户直接消息或 direct-edit notice、当前 preset、revision、可编辑 target 与 expected value，但模型选择类型化 existing-Agent route 后，不再需要按语言匹配修改动词。任意语言的请求都会使用同一个 Proposal executor，同时不会削弱它同 Creator 或 capability authoring 的隔离。

[Creator 前台 ownership](../bug-fix/2026-08-28-blueprint-creator-foreground-ownership.md)会在 Session transition 期间排除迟到或 foreign publication。[Creator task terminal](../bug-fix/2026-08-28-blueprint-creator-task-terminal.md)会阻止无关的后续 turn 重新激活已完成 authoring。

新 Agent 的执行交接遵循 [Creator 独占交接决策](../bug-fix/2026-08-28-blueprint-exclusive-creator-handoff.md)；来源终止与目标投递不会改变编写或投影语义。

[路由来源与仲裁](../bug-fix/2026-08-28-blueprint-routing-provenance.md) 将添加能力的原始输入与 guidance 分离，约束其 target，并为每轮保留一个顶层操作。包含创建指令的文本不代表 active Creator 状态。

## Alternatives considered

**依赖未打开的后台对话判定 Skill 完成。** 不采用，因为 cold Session 按设计不维护客户端观察器读取的聊天时间线。改由 Host Session 事件和恢复路径，通过串行上下文操作结算 Skill 终态。持久化开始事件保留 authoring 前的作用域 Skill 标识；成功要求 Creator 轮次已完成，且新的目标专属可调用定义具有最新挂载 Blueprint 证据。结束记录先完成持久化检查点，再清理前台状态；重复观察复用该结果。缺少旧基线时拒绝宣称成功，不从 authoring 后的目录反推基线。Subagent 成功仍保留独立的委派/P1 检查。

**根据当前值或 revision 推断 Applied。** 否决，因为后续有效编辑可能替换同一个值，而无关写入也可能在从未应用该提案的情况下得到相同文本。对话中的 Apply 将 P0 终态记录到 `blueprint/apply-result`，并等待 Session 持久化检查点。恢复时匹配 Session、preset、Change Set id、base revision 和完整类型化操作。匹配的 committed receipt 优先于当前可应用性；未应用提案只有在当前 revision 或 expected value 不再匹配时才变为 stale。失败尝试不会成为 Applied，缺少 receipt 的既有历史也不会根据文本回填。Preset 提交与 receipt 持久化仍是独立操作；两者之间发生崩溃时，不能声称该 Apply 已获 receipt 证明。

**把独立 `blueprint.json` 作为权威来源。** 否决，因为提示词段落、工具注册与权限继承会和第二份可编辑模型发生漂移；生成的 JSON 只能是 artifact，不能成为 session composition 的来源。

**解析并 dump 完整 YAML 文档。** 否决，因为一次语义编辑会改写与操作无关的注释、顺序、block scalar 风格与 Loader 专用 `!!js` 表达式。

**通过猜测 row 让所有 runtime 工具可编辑。** 否决，因为工具可见性不能识别唯一所有者 row，也不能证明 provider 可用。adapter 只接受 Web Search 与 Web Fetch；它们的工具配置已经具有明确的启停语义。

**把 Tool、Skill、provider 与 delegation row 直接作为能力 UI。** 否决，因为这些对象解释的是实现方式，而不是 Agent 会做什么。它们继续作为权威证据保留；client 只派生一份带 supporting node id 的可丢弃语义视图，绝不会通过该视图写入。

**让静态 Demo 模拟完整 DSH Client API。** 否决，因为 Session、transport、model、Creator 与 conformance 行为会组成第二套虚假 runtime。Demo 只实现共享 Blueprint controller 实际使用的 provider-neutral 状态操作；后续 Demo shell 负责提供明确标注的脚本化对话。

**把每个「添加能力」请求都当作 Creator authoring。** 否决，因为许多目标能力可以由当前 editable persona 与已挂载 runtime 表达。入口来源不能证明必须新增 Skill 或 Subagent；只有明确的类型化路由才能进入 existing-target Creator authoring。

**在 preset authoring API 上恢复任意 composition 写入。** 依据 copy-only 决策保留的安全与编辑器质量理由否决。类型化语义 Host 操作的权限与失败模式都窄于接受 composition 文本。

**允许模型直接调用 preset 写方法。** 否决，因为普通讨论、假设性问题与过期对话上下文会因此获得修改权限。模型只能起草闭集内的类型化提案；用户 Apply 与现有 revision 和 expected-value 校验仍是强制步骤。

**把一次直接编辑自动级联到关联节点。** 否决，因为语义一致性需要模型判断，而直接控件只授权其自身的类型化写入。具有明确因果关系的关联修改可以组成一个可见 Change Set，但用户查看并应用之前不会开始任何额外类型化写入。

**解析 Creator 最终 Assistant message 作为完成信号。** 否决，因为 prose 不能证明 preset 真实存在、可挂载、属于当前 Session，或已经停止变化。target 关联使用名单变化、正常 Blueprint 投影与 Session 已记录的 authoring 证据；完成判定使用 Session 的结构化 running、pending interaction 与 terminal turn 状态。

## Consequences

- Blueprint JSON 是基于真实 composition 与 runtime 服务的可复现证据，不是可编辑的影子格式。
- 同一 controller 可以运行在真实 DSH binding 或调用方提供的内存 Demo 状态之上。后者只证明 UI 状态变更，不提供 model execution、Session assembly、Skill authoring 或 runtime conformance 证据。
- Demo Mode 只替换 Blueprint data binding。它复用 built production Web shell 与 slot component，可选 Host overlay 会提供预览数据而不改变 production default，因此不会让另一张手工设计页面逐渐漂移为公开 Demo。
- Purpose 与 Behavior 写入目前要求唯一的单物理行。其他 persona 风格在可分类时保持可读，否则不生成虚构节点。
- Web Search 与 Web Fetch 是 `setCapability` 接受的仅有两种 capability。Shell Background 必须先拥有参数级 Blueprint 节点，File Read 则需要插件自身提供独立 enable 字段，不能依赖 row 改写。
- 已挂载的 scoped Skill 与 active literal delegation row 继续作为只读证据，但不再逐项列出。语义视图最多展示六条从 Purpose、Behavior 与 Output 派生的具体可重复工作，在内部保留语义与 runtime supporting node id，并且可以省略共享或无法分类的 catalog entry，而不会改变 Blueprint 或 P1 catalog。Existing-structure 请求继续经过 Proposal、P2、P0 与 P1；只有绑定 target 的类型化路由才会为新 Skill 或 Subagent 进入 Creator authoring。client 不提供 marketplace、安装结果、待处理 capability 权威状态、Skill mutation 或 subagent authoring API；后续真实投影仍是唯一成功信号。
- MVP 的 Output 写入可以指向现有且唯一的带编号 Output 条目，并校验 revision 与预期值；它不能创建 Output 条目，也不能宣称适用于任意 persona prose。
- 已启用的 Web Fetch 仍可能没有可执行 provider，因为 Web 服务有意不暴露 provider inventory，且工具在 provider 故障期间仍保持 schema 可见；Blueprint 会把这一点记录为 mapping gap。
- 权限是稳定的只读 Access 节点。通过 preset 修改权限会违反其 Host/settings/session 归属。
- Selected node 会改变当前 Session 中模型可见的提示词上下文，但不会授权修改。提案生成采取保守规则：含糊讨论不产生提案，Apply 仍负责权威的新鲜度校验。
- 每个可编辑的结构化控件都会在提交前保留 browser-local draft，随后创建一项 route-owned Change Set；其 exact source edit 排在第一项，P2 addition 受确定性限制。Apply 前不会写入 preset；Apply 或 Cancel 持久且归 source 所有，Blueprint 始终只显示 committed state。
- copy-only authoring Note 保持活跃：浏览器 preset authoring 仍不接受 YAML、路径或 composition 文本。语义 Remote API 不削弱该 wire 规则。
- Creator 协调会把 target 关联、语义可见性、selection、直接写入与 authoring 完成分开。复制得到的 target 在某个用户级节点发生变化前不会暴露 source 模板内容；开始展示后，已关联 target 会在所有非 Ready 状态中保持可见且可选，明确调整会路由为 Creator steering，且不存在 Proposal Tool 或并发 Host 写入。Ready 只会在最终新鲜投影之后开放直接编辑与「试用 Agent」，并恢复 existing-Agent proposal context。协调器不翻译 reasoning、不复制原生 question、不切换当前 Session，也不根据 semantic similarity 强制匹配；版本管理、参数级 capability 编辑、权限编辑与 diff 页面仍不属于本决策。
- standing-mount Note 保持活跃：其 generation 与 live-session 保证使写回可以被观察，而无需修改 Preset 或 Session 核心逻辑。
- Runtime conformance 会证明当前 expected Blueprint revision 仍是最新版本，且新 Session 的 live prompt 内容、Tool schema 与权限等价。preset service 不暴露 generation 的 source revision hash，因此结果会明确报告 strict revision binding 不可用。该检查属于配置证据，不是回答质量 Eval、A/B test、score 或持久 history。
