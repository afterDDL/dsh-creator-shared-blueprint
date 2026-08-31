# Agent Note: 仓库外 Interactive Blueprint bundle

Status: implemented

[English](2026-09-01-out-of-tree-interactive-blueprint-bundle.md) | 中文

## Problem

Interactive Blueprint 原本拆分为 Host package 与 browser package，并且两者都是标准 Web bundle 的 dependency 和固定 row。其 browser package 还从全局 first-party Remote aggregate 获取 Blueprint Remote descriptor。把这些 package 复制进 tarball 并不会形成真正 extension：clean DSH installation 在安装 tarball 前仍必须包含 Blueprint-specific source、dependency edge 与 composition row。

## Decision

`@deepseek-ai/dsh-shared-blueprint` 是一个同时包含 Host、Client、wire contract、generated Remote artifact 与 additive `cordis.patch.yml` 的可安装 bundle。package 的 `dsh.client` 声明会加载其 browser artifact；该 artifact 先通过通用 Client Remote service 挂载 package 自己的 generated Remote contribution，再注册 Interactive Blueprint 的 additive Layout、Sidebar、Conversation 与 Tool surface。

标准 `dsh-web-app` package 不再依赖 Shared Blueprint，也不包含 Blueprint Host 或 Client row。CLI 没有该 bundle 的 runtime dependency。验证 Interactive Blueprint 的测试会显式组合同一份 standalone patch，因此其 assembly 表示安装了 add-on 的 Web，而不是隐藏的产品默认值。

package build 在自身 package root 内自包含。它不导入仓库共用 Client tsdown helper，不使用仓库相对 runtime import，也不在 manifest 中保留 `workspace:` range。Host 与 Client TypeScript project 仍然分离；发布的 tarball 包含预构建 JavaScript、declaration、Typert Host descriptor、Client Remote codec、CSS、license 与 composition patch。Inspect Mode 不属于本 bundle。

## Alternatives considered

**继续把 Blueprint 放在 Web bundle，并额外发布 convenience package。** 拒绝，因为 installation 无法拥有 activation：clean DSH 仍会自带 Blueprint Host、Client 与 Remote vocabulary，移除 add-on 后也会残留产品行为。

**分别发布 Host 与 Client package。** 拒绝，因为用户安装的是一个产品功能，其 Host/Client version 必须同步演进。单一 bundle 让 patch ownership、generated Remote compatibility 与移除保持原子，不需要新增 Blueprint-specific package coordinator。

**从 package 复用 monorepo Client build helper。** 拒绝，因为仓库外 source checkout 不存在该文件。package-local build 只重复生成自身 artifact 必需的 loader closure 与 CSS-module 机制。

## Consequences

安装或移除一个 bundle 现在会控制 Interactive Blueprint 的全部 runtime face。browser artifact 因为自带 generated Remote codec 与 wire dependency，比依赖 first-party aggregate 时更大，但 runtime 只要求通用 platform module identity。标准 Web 产品只有在安装 add-on 后才承诺 Interactive Blueprint。仓库测试在需要该功能时必须明确写出 add-on patch，因此意外重新嵌入会变得可见。Inspect Mode 需要后续独立验收与 package 变更。
