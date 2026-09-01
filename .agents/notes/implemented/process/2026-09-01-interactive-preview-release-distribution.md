# Agent Note: Interactive Preview release distribution

Status: implemented

English | [中文](2026-09-01-interactive-preview-release-distribution.zh.md)

## Problem

The public Shared Blueprint repository contains a compatible DSH checkout and one third-party product package. Presenting its root as the upstream DSH project obscures the product, while publishing the package under DeepSeek's npm-style scope implies ownership the third-party release does not have. A source checkout alone also does not prove that a stranger can install the exact bytes offered for download.

## Decision

The release branch presents Shared Blueprint Interactive Preview at the repository root and publishes no official-namespace package. `dsh-shared-blueprint` uses an independent `0.1.0-beta.1` version and stays outside the DSH npm release family. Registry availability is checked during release preparation but does not authorize publication.

One deterministic release command produces two candidates from a clean commit. The Complete Build contains prebuilt DSH and vendored Cordis tarballs, the standalone package, a relative-path lockfile, and a Node launcher; it contains no installed dependency tree or user state. The Standalone Bundle is the independently installable npm-format package. Both candidates carry the same package bytes.

Compatibility is identified by the official rc.7 baseline and one exact release branch commit. The historical generic API commits also changed their then-current in-tree Blueprint consumers, so the release does not claim that a squashed subset applies cleanly to untouched rc.7. The machine-readable compatibility manifest lists the required generic commits and the verified checkout instead.

## Alternatives considered

**Keep the upstream DSH root README.** This preserves upstream branding but makes a first-time visitor reconstruct the released product from internal package paths.

**Publish as `@deepseek-ai/dsh-shared-blueprint`.** The scope resembles an official DeepSeek package and is not owned by this release, so using it would misrepresent provenance.

**Ship the working directory or `node_modules`.** This shortens local setup but captures machine paths, caches, optional native artifacts, and user state while making the archive irreproducible.

**Advertise a manually rebased one-file compatibility patch.** The seam history is verified as commits on the release branch; reconstructing it onto rc.7 would require new Core work during product freeze and could reintroduce the former private consumer.

## Consequences

Users get a product-first entry and two explicit installation paths. The Complete Build is larger because it carries every required DSH tarball, but installation does not depend on unpublished DSH registry versions. Ecosystem developers must use the exact compatibility checkout until the generic APIs are available upstream. npm publication, a tag, and a GitHub Release remain separate approval points.
