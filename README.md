# Shared Blueprint

English | [中文](README.zh.md)

A plugin designed for Creator mode.

A shared interface for humans and AI to understand, discuss, and shape agents built on DeepSeek Harness.

**Interactive Preview · v0.1.0-beta.1**

Shared Blueprint turns the hard-to-follow agent creation process into a structure that people and AI can both see, point to, discuss, and modify. In a structured interface, the Interactive Preview supports the full authoring path from a natural-language request to a usable agent with verified Skills and Subagents.

This is a working beta under active stress testing and compatibility hardening. It is not a stable release, production-readiness claim, or official DeepSeek plugin.

## Get the preview

| Entry | For | Status |
|---|---|---|
| [Try Demo](https://afterddl.github.io/dsh-creator-shared-blueprint/) | A hosted first look | Live scripted interactive Demo; no DSH backend or provider credentials required. |
| [Complete Build](release/interactive-preview/INSTALL.md#complete-build) | People who want the shortest path to the product | Recommended. Bundles Shared Blueprint with a compatible DSH build containing the 7 generic extension seams not yet available upstream. |
| [Standalone Bundle](release/interactive-preview/INSTALL.md#standalone-bundle) | DSH plugin and ecosystem developers | Fully out-of-tree with 0 private Core dependencies. Requires the compatibility seam layer until equivalent extension APIs are available in upstream DSH. |

## Run

Follow the verified [Complete Build commands](release/interactive-preview/INSTALL.md#complete-build) for the shortest supported start.

### Run from source

Follow the [Standalone Bundle commands](release/interactive-preview/INSTALL.md#standalone-bundle) to run the exact compatible source checkout with the packaged add-on.

## What you can do

Create an Agent with natural language: Describe the task you want to accomplish, and AI will progressively organize your requirements into a visible, structured Agent Blueprint.

Discuss the same Blueprint with AI: Select any part—Role, Purpose, Capabilities, Rules, or Output—and continue asking questions, clarifying, or making adjustments around that specific node.

Confirm changes before they modify the Agent: AI first generates a Proposal that clearly shows what it plans to change. You confirm it before selecting Apply.

Keep extending the Agent's capabilities: From the structured interface, use natural language to create a Skill or add a collaborating Agent. New capabilities appear directly in the Blueprint, so its structure and capability changes remain clear even as the Agent grows more complex.

Try the Agent you just built: Select Try Agent to start a real session from the current Blueprint and confirm that the capabilities you viewed, changed, and added are active at runtime.

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
