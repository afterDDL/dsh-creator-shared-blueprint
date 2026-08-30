# Agent Note：结构化 Blueprint 编辑会暂存 route-owned Change Set

Status: implemented

[English](2026-08-30-blueprint-structured-purpose-edit.md) | 中文

## 问题

第一版 Apply 前不写入修复只暂存了 Purpose，Identity、Behavior、Output、Web Search 与 Web Fetch 仍使用单 node 写入 Remote。因此，同一个视觉 Save 操作有两种事务语义：Purpose 会生成 Proposal，其他控件则会在确认前修改真实 preset。文本提交失败时，editor 还会关闭并丢失 draft。Proposal Apply 信任浏览器提供的 operation，Cancel 只保存在浏览器内存中，因此刷新后可能重新出现已取消卡片。

## 决策

所有可编辑的 Identity、Purpose、Behavior、Output、Web Search 与 Web Fetch 控件都通过一条结构化 interaction 提交。Client 会在 editor 或 switch 打开时捕获 committed scalar，创建新的 route id，并通过 conversation-context 同步发送 `sourceSessionId + routeId`、node id 与 type、expected value 和 proposed value。提交前 draft 有意只存在于 browser，因为此时尚未请求 durable business operation；「取消」只会丢弃这份 draft。提交成功后才会创建 source-owned durable routing input 与后续 Proposal，其 route、terminal decision 与 receipt 可以跨刷新恢复。提交失败后，editor 与 local draft 会继续显示。任何结构化控件都不会调用单 node 写入 Remote，也不会更新 committed Blueprint store。

Host 会读取 committed projection，校验 node identity、editability、scalar type、expected value 与受支持 operation，然后推导确定性的 P2 impact candidate。它会记录 source-owned `blueprint/routing-input`，通过用户可见的 interaction 唤醒同一 Session，并且只在这些持久输入刷新后返回 enqueue evidence。Client 会拒绝缺失或不匹配的 evidence。Proposal Tool 只接受 `modify-existing-agent`；第一项 change 必须与结构化 source edit 完全一致，后续 change 必须是互不重复且已获准的 candidate，并说明明确 dependency。生成的 `structured-edit` Change Set 必须包含 `sourceSessionId + routeId`，因此只有源 interaction 能渲染 Proposal 与 terminal 控件。该 row 还会把 Change Set id 绑定到确切 Tool call，并且只有 source node id、source type、operation、scalar type 与变化后的 value 全部一致时才接纳第一项 structured proposal。Proposal 展示会接受 Identity、Purpose、Behavior、Output 与 Web capability source type，根据 source type 与 label 生成标题，并拒绝 Access。

Apply 不会把浏览器中的副本当作授权。Host 会定位 source Session 中成功的 Proposal Tool result，校验其 Tool call 与 route decision，根据持久 metadata 重建确切的闭集操作列表，并在进入现有原子 P0 transaction 前比较请求。这项比较会保留 operation 数组顺序，并校验 discriminant、target 与带类型的 scalar field，不依赖 transport 对象的 key 插入顺序。Apply 与 Cancel 共用一个按 preset 串行执行的 terminal decision：重复同一 decision 是幂等操作，相反 decision 会被拒绝；Remote 返回前会追加并刷新生成的 receipt 或 cancellation。Runtime validation 会从该精确 source Session receipt 解析可选 P0 关联，而不是依赖进程内存，因此恢复后的 Session 在重启后仍保留 `sourceSessionId + routeId + changeSetId` join。Try 会等待当前 source Session 的 receipt hydration，并从 preset 与 committed revision 都精确匹配的项目中选择持久 Apply terminal 最新的一项；Proposal 顺序、进程内 last-Apply cache 与 Session 切换都不能授权 P0。Receipt hydration 可能在 Creator projection reconcile 执行期间结束，因此串行 reconcile tail 还会处理前一次 drain 收尾期间入队的 observation。Validation response 必须回显 created Trial Session、preset 与 expected revision。打开后的 P1 失败只会在该 created Trial Session 仍是当前 Session 时发布，引用第三个 Session 的响应也不能重定向错误。成功 Apply 后，Client 只会执行一次最终 `blueprint.get`；在此之前，真实 preset 与主 Blueprint 均不变化。

Capability authoring 继续拥有自己的 route id 与后台 Creator lifecycle，因此 pending 或 completed 结构化编辑不能持有之后的「添加能力」请求。Active capability execution 会排除 edit、Apply、再次 Add 与 Try。它的持久 baseline 会保留 preset roster 与 projected target，使 terminal verification 能够拒绝无关 semantic change 或额外顶层 preset。

## 考虑过的替代方案

**保留旧的单 node Save 调用。** 否决，因为这些调用会在 Proposal 确认前写入 preset，并保留一条没有持久 interaction owner 的第二 mutation 路径。

**只暂存 Purpose，把其他控件视为即时设置。** 否决，因为详情栏把这些控件呈现为同一 Blueprint 编辑界面，而且每项受支持的更改都会影响后续 Agent assembly。

**在主 Blueprint 中显示 proposed value。** 否决，因为 Blueprint 投影的是 committed Agent state。没有明确 pending 语义的 draft 会错误表达真实 preset。

**为结构化 route 放宽 Proposal ownership。** 否决，因为前台导航或之后针对同一 target 的 interaction 可能显示或应用另一个 Session 的 pending edit。

## 后果

所有受支持的结构化控件具有相同的 draft、source-owned Proposal、Apply 或 Cancel terminal、receipt 与 reprojection 语义。Editor 失败会保留用户输入，刷新会恢复 Apply 与 Cancel，stale 或 foreign 浏览器无法授权 preset 写入。因此，完整可编辑 Blueprint 界面的 Apply 前不写入要求只有这一处 current owner。
