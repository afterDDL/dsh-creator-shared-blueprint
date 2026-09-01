# Shared Blueprint

English | [中文](README.zh.md)

A shared interface for humans and AI to understand, discuss, and shape agents built on DeepSeek Harness.

**Interactive Preview · v0.1.0-beta.1**

Shared Blueprint turns an agent into a structure that people and AI can both see, point to, discuss, and modify. The Interactive Preview supports the full authoring path from a natural-language request to a usable agent with verified Skills and Subagents.

This is a working beta under active stress testing and compatibility hardening. It is not a stable release, production-readiness claim, or official DeepSeek plugin.

## Get the preview

| Entry | For | Status |
|---|---|---|
| Try Demo | A hosted first look | Not hosted yet; no placeholder URL is presented as a demo. |
| [Complete Build](release/interactive-preview/INSTALL.md#complete-build) | People who want the shortest path to the product |Recommended. Bundles Shared Blueprint with a compatible DSH build containing the 7 generic extension seams not yet available upstream. |
| [Standalone Bundle](release/interactive-preview/INSTALL.md#standalone-bundle) | DSH plugin and ecosystem developers | Fully out-of-tree with 0 private Core dependencies. Requires the compatibility seam layer until equivalent extension APIs are available in upstream DSH. |

## Run

Follow the verified [Complete Build commands](release/interactive-preview/INSTALL.md#complete-build) for the shortest supported start.

### Run from source

Follow the [Standalone Bundle commands](release/interactive-preview/INSTALL.md#standalone-bundle) to run the exact compatible source checkout with the packaged add-on.

## What you can do

- Create an agent from natural language.
- Inspect its semantic Blueprint and select a node for discussion.
- Review a Proposal before Apply changes the committed agent.
- Add a Skill or Subagent through isolated authoring and verified publication.
- Start Try Agent and use the resulting runtime.

## Compatibility

The Shared Blueprint product is distributed as the out-of-tree `dsh-shared-blueprint` package. Upstream DSH `0.1.0-rc.7` does not yet expose every generic extension point needed by this class of advanced authoring plugin, so the Complete Build includes the frozen compatibility changes. Untouched official `0.1.0-rc.7` plus the bundle is not a supported combination. See [Compatibility](release/interactive-preview/COMPATIBILITY.md) and [Architecture](release/interactive-preview/ARCHITECTURE.md).

Inspect Mode is not part of this release.

## Release information

- [Install and run](release/interactive-preview/INSTALL.md)
- [Compatibility matrix](release/interactive-preview/COMPATIBILITY.md)
- [Release notes](release/interactive-preview/RELEASE_NOTES.md)
- [Release backlog](release/interactive-preview/RELEASE_BACKLOG.md)
- [Package contract](packages/bundle/shared-blueprint/README.md)

## Development

This repository also contains the compatible DSH source used to build the Complete Build. Start with [DeepSeek Harness architecture](docs/architecture.md) and follow [AGENTS.md](AGENTS.md) for repository work.

## License

[MIT](LICENSE). Third-party dependencies and their licenses are disclosed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
