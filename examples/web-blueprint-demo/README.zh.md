# Web Blueprint 预览

[English](README.md) | 中文

独立的 [Subagent 一致性验证组合](subagent-completion.cordis.yml) 为本示例的无密钥快照启动真实 Host 插件。驱动程序管理临时 preset 并提供 authoring 完成事件；生产解析器验证 delegation 增量、新验证 Session 的 P1 结果、投影与唯一终态记录，不需要浏览器时间线、模型提供方或业务 child。该路径不使用预览的模拟完成状态。

这个可选 overlay 用于在 DSH 实际交付的 Web 界面中预览 Blueprint。它只在 production browser plugin graph 启动前注入 fixture 数据；Web shell、theme、navigation、conversation UI、Blueprint component、slot 和 CSS 都继续使用构建后的 production 实现。

先构建一次仓库，再启动预览：

```sh
pnpm run build
pnpm run demo:blueprint
```

打开 <http://127.0.0.1:3082/?fixture&blueprintDemo>。`fixture` query 会选择不需要密钥的浏览器内存 transport，`blueprintDemo` 则允许使用已注入的 fixture binding，并以已确认当前版本首次启动声明的状态进入，避免无关弹窗阻塞这一专项预览；production onboarding 行为不变。这个专项预览中的真实 preset picker 只显示「创造模式」和 Demo 自带的「上市公司研究 Agent」。新建预览会话使用真实的 `danger-full-access` 权限 preset，因此 production 权限选择器显示 `Full access`。

固定演示路径会复用 production conversation 与 Blueprint component，依次呈现创建 Agent、包含三项修改的 Purpose proposal、创建 Skill、添加协作 Agent、授权确认与最终 NVIDIA 试用。Fixture Session event 会提供 12–20 秒 Creator 进度、2–4 秒 Apply 状态、能力发布与 8–15 秒试用报告。整个流程不会调用模型、执行 Tool 实现、写入 Host 文件或访问网络。末尾验证文案仅表示确定性 Demo 已到达预期本地 flag，不代表 Harness runtime conformance。点击「重置 Demo」可回到已预填但尚未发送的 Creator 请求。
