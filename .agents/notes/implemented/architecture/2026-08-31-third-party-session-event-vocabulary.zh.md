# Agent Note: 第三方插件提供的必需 Session 事件词汇

Status: implemented

[English](2026-08-31-third-party-session-event-vocabulary.md) | 中文

## 问题

`SessionEventMap` 可以通过声明合并扩展，但持久化此前只通过仓库生成的 `KNOWN_SESSION_EVENT_TYPES` 识别必需事件类型。仓库外插件可以为事件添加类型并追加事件，但即使重启后仍安装了同一插件，完整日志也会被拒绝。若接受任意字符串或静默跳过未知必需事件，系统又会在缺少 producer 声明为必需的语义时错误重建 Session。

## 决定

`SessionStore` 持有运行时注册表 `eventTypes`，用于登记第一方 build 之外的必需持久事件类型。插件通过声明合并定义事件 payload，并在应用期间注册 `{ type, owner }`。注册经 disposer 跟随插件 fiber；只有事件类型属于生成的第一方集合或当前有效的注册时，持久化才接受该必需事件。

持久化继续保持快速失败。插件必须在任何含该事件的 Session 被 inspect、load 或 resume 前完成注册。解码检查会直接执行这项顺序约束：注册缺失或过晚时，在构造 Session 前返回 `SessionFormatUnsupportedError`。重启后必须重新注册，移除插件会使后续读取拒绝，并发 ownership 冲突会拒绝，而不是任选一种解释。

注册不携带插件版本。插件版本注册既有类型，就表示它承诺兼容该类型的持久 payload 与语义。不兼容的修订须使用新的事件类型；在事件信封不变的情况下附加一个无法验证的版本字符串，并不能让旧 payload 变得可解释。

本决定部分取代 [Session log 版本机制](2026-08-10-session-log-version-mechanism.md)中暂缓运行时注册的替代方案：生成集合继续作为第一方 build 的统一词汇；运行时注册只用于仓库外必需事件，这类事件缺失时有意依赖插件组合，并明确失败。

## 曾考虑的替代方案

**接受任意事件类型字符串。**这会移除读取侧对必需事件语义已经存在的唯一证明，并可能静默重建出无效 Session。

**在每个事件或 Session header 中持久保存插件包版本。**版本标签不能定义 payload 兼容性，会让核心存储依赖包管理器，并在真实迁移关系出现前扩大协议格式。

**每次启动前从已安装包生成词汇。**这会增加包扫描和第二套 manifest 协议，同时仍需为 HMR 与移除提供生命周期 ownership。运行时注册表是当前更小的需求。

## 影响

仓库外插件现在可以拥有必需持久事件，无需修改 Core。它们必须在启动期间注册，并在兼容版本之间保持旧类型语义可读。插件缺失、插件有意停止注册不兼容旧类型，或事件类型冲突时，系统会阻止 resume，而不会削弱持久性安全。Core contract tests 固定了注册 dispose 与冲突行为；一个非 Blueprint dummy 插件持久化自定义事件，证明缺少插件时会拒绝，也证明 fresh runtime 注册后可以成功重新加载。
