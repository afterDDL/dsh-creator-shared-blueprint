# Agent Note: Native npm launch for Windows packed-install verification

Status: implemented

English | [中文](2026-09-01-packed-install-windows-npm-launch.zh.md)

## Problem

The packed-install verifier launches npm through `spawnSync` without a shell so package paths and arguments are never interpolated. Windows exposes npm through command-script and PowerShell wrappers, which are not native executables accepted by this direct child-process boundary. The verifier therefore failed before installation even though npm was available to the invoking shell.

## Decision

Release process helpers now resolve the bundled `node_modules/npm/bin/npm-cli.js` beside the active Node executable or a Node installation on `PATH` when running on Windows. They execute that JavaScript entry with `process.execPath` and preserve the original argument vector and environment. Other platforms continue to invoke the native `npm` command.

The resolver fails before installation if no npm CLI can be located. It does not enable a shell, parse wrapper scripts, or change the consumer environment. A cross-platform release-script test drives `npm --version` through the resolved invocation, and the packed-install verifier uses the same helper.

## Consequences

Windows can run the same repository-external tarball installation proof as other platforms without weakening command isolation. The npm CLI still comes from the active Node installation rather than the repository, and all existing install flags, cleanup, and installed-version checks remain unchanged.
