# Agent Note: Interactive Preview 发布分发

Status: implemented

[English](2026-09-01-interactive-preview-release-distribution.md) | 中文

## 问题

公开的 Shared Blueprint 仓库包含一个兼容的 DSH checkout 和一个第三方产品包。继续把根入口呈现为上游 DSH 项目会遮蔽实际产品，而在包名中使用 DeepSeek 的 npm 风格 scope 会暗示该第三方发行方并不具备的所有权。仅有源码 checkout 也不能证明陌生用户可以安装下载入口提供的确切字节。

## 决策

发布分支在仓库根入口呈现 Shared Blueprint Interactive Preview，并且不发行任何官方 namespace 包。`dsh-shared-blueprint` 使用独立的 `0.1.0-beta.1` 版本，不属于 DSH npm release family。发布准备会检查 registry 可用性，但该检查不授权实际发布。

一条确定性的发布命令会从干净 commit 生成两种候选产物。Complete Build 包含预构建 DSH 和 vendored Cordis tarball、standalone package、使用相对路径的 lockfile 与 Node launcher，不包含已安装依赖树或用户状态。Standalone Bundle 是可独立安装的 npm 格式包。两种候选产物使用完全相同的 package 字节。

兼容性由官方 rc.7 基线和一个确切的 release branch commit 标识。通用 API 的历史 commit 同时修改了当时位于树内的 Blueprint 消费方，因此本次发布不声称从其中截取的 squashed patch 可以干净应用到未经修改的 rc.7。机器可读 compatibility manifest 会列出所需通用 commit 与经过验证的 checkout。

## 考虑过的替代方案

**保留上游 DSH 根 README。** 这会保留上游品牌，但首次访问的用户必须从内部 package 路径反推出实际发布的产品。

**使用 `@deepseek-ai/dsh-shared-blueprint` 发布。** 该 scope 类似 DeepSeek 官方 package，且不归本次发布方所有，因此使用它会错误表达来源。

**打包 working directory 或 `node_modules`。** 这样可缩短本机设置步骤，却会纳入本机路径、缓存、可选 native 产物与用户状态，并使 archive 无法复现。

**宣传手工 rebase 的单文件 compatibility patch。** seam 历史以 release branch 上的 commit 形式经过验证；在产品冻结期间把它重构到 rc.7 需要新增 Core 施工，并可能重新带回之前的私有消费方。

## 结果

用户得到产品优先的入口和两条明确安装路径。Complete Build 因为携带全部所需 DSH tarball 而更大，但安装不依赖尚未发布的 DSH registry 版本。在通用 API upstream 之前，生态开发者必须使用确切的 compatibility checkout。npm 发布、tag 与 GitHub Release 仍然是彼此独立的审批点。
