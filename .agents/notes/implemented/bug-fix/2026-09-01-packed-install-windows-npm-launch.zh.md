# Agent Note: Windows packed-install 验证的原生 npm 启动

Status: implemented

[English](2026-09-01-packed-install-windows-npm-launch.md) | 中文

## Problem

packed-install verifier 通过不启用 shell 的 `spawnSync` 启动 npm，确保 package path 与参数不经过插值。Windows 通过 command script 和 PowerShell wrapper 暴露 npm，而这些 wrapper 不是该直接子进程边界可以接受的原生可执行文件。因此，即使调用方 shell 能使用 npm，verifier 仍会在安装开始前失败。

## Decision

release process helper 现在会在 Windows 上解析 active Node executable 旁边或 `PATH` 中 Node installation 所带的 `node_modules/npm/bin/npm-cli.js`。helper 使用 `process.execPath` 执行该 JavaScript entry，并保持原有参数向量和 environment。其他平台继续调用原生 `npm` command。

如果找不到 npm CLI，resolver 会在安装前失败。它不会启用 shell、解析 wrapper script 或修改 consumer environment。一项跨平台 release-script test 通过解析后的 invocation 执行 `npm --version`，packed-install verifier 使用同一个 helper。

## Consequences

Windows 现在可以在不削弱 command isolation 的前提下运行与其他平台相同的仓库外 tarball 安装证明。npm CLI 仍来自 active Node installation，而非仓库；现有 install flag、清理与 installed-version check 全部保持不变。
