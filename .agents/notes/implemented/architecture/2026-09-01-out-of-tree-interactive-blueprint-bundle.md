# Agent Note: Out-of-tree Interactive Blueprint bundle

Status: implemented

English | [中文](2026-09-01-out-of-tree-interactive-blueprint-bundle.zh.md)

## Problem

Interactive Blueprint was split between a Host package and a browser package that were both dependencies and fixed rows of the standard Web bundle. Its browser package also consumed Blueprint Remote descriptors from the global first-party Remote aggregate. Copying those packages into a tarball would not make an extension: a clean DSH installation still had to contain Blueprint-specific source, dependency edges, and composition rows before the tarball was installed.

## Decision

`dsh-shared-blueprint` is one installable bundle with Host, Client, wire contract, generated Remote artifacts, and an additive `cordis.patch.yml`. The package's `dsh.client` declaration loads its browser artifact. That artifact mounts the package-owned generated Remote contribution through the generic Client Remote service before it registers Interactive Blueprint's additive Layout, Sidebar, Conversation, and Tool surfaces.

The Client entry cannot inject its own Remote namespace before it creates that namespace. Its outer fiber injects only the platform services needed by `$mount`; after mounting, an explicitly injected child fiber owns every UI consumer of the new namespace. Startup joins that child, and teardown disposes it before withdrawing the Remote contribution. A non-Blueprint external-client regression exercises the same mount-then-consume ordering.

The standard `dsh-web-app` package has no Shared Blueprint dependency and no Blueprint Host or Client row. The CLI has no runtime dependency on the bundle. Tests that exercise Interactive Blueprint compose the same standalone patch explicitly, so their assembly represents Web with an installed add-on rather than a hidden product default.

The package build is self-contained at its package root. It does not import the repository's shared Client tsdown helper, use repository-relative runtime imports, or retain `workspace:` ranges in its manifest. Host and Client TypeScript projects remain separate, while the published tarball carries prebuilt JavaScript, declarations, Typert Host descriptors, Client Remote codecs, CSS, license, and composition patch. Inspect Mode remains outside this bundle.

## Alternatives considered

**Keep Blueprint in the Web bundle and publish a second convenience package.** Rejected because installation would not own activation: clean DSH would still ship the Blueprint Host, Client, and Remote vocabulary, and removing the add-on would leave product behavior behind.

**Publish separate Host and Client packages.** Rejected because users install one product feature and its Host/Client versions must move together. A single bundle keeps patch ownership, generated Remote compatibility, and removal atomic without introducing a Blueprint-specific package coordinator.

**Reuse the monorepo Client build helper from the package.** Rejected because a source checkout outside this repository would lack that file. The package-local build repeats only the loader closure and CSS-module mechanics required to produce its own artifact.

## Consequences

Installing or removing one bundle now controls every Interactive Blueprint runtime face. The browser artifact is larger because it carries its generated Remote codec and wire dependencies instead of relying on the first-party aggregate, but it requires only generic platform module identities at runtime. The standard Web product no longer promises Interactive Blueprint unless the add-on is installed. Repository tests must name the add-on patch when they expect the feature, which makes accidental re-embedding visible. Inspect Mode requires a later independently accepted package change.
