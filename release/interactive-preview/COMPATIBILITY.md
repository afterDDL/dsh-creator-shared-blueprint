# Shared Blueprint Interactive Preview compatibility

## Supported baseline

The product package is `dsh-shared-blueprint@0.1.0-beta.1`. The current compatibility baseline is DSH `0.1.0-rc.7` at `99f6f02fecdb7dff40c3fbc9470f5907c29f74ca`, plus the frozen generic extension changes identified by the release branch and companion compatibility JSON.

Untouched official DSH `0.1.0-rc.7` plus the standalone bundle is not a supported combination. The package is out of tree; the remaining requirement is availability of generic DSH plugin APIs, not a private Blueprint Core dependency.

## Distribution choices

The Complete Build carries the compatible DSH packages and the standalone bundle together. It is the recommended route for product evaluation.

The Standalone Bundle is paired with an exact compatibility checkout. Use the repository, branch, and full commit recorded in `shared-blueprint-interactive-preview-compatibility-0.1.0-beta.1.json`. The seam history contains migration commits from the former in-tree consumer, so this release does not advertise a synthetic squashed patch as cleanly applicable to untouched rc.7.

## Generic extension requirements

The compatible DSH checkout exposes seven generic capabilities used by advanced third-party plugins:

1. isolated AgentPreset publication transactions;
2. durable custom Session event-type registration and owner identity;
3. preset-ready Session creation;
4. replacement-aware conversation location references;
5. conversation presentation contributions;
6. a default conversation details contribution;
7. additive Sidebar navigation contributions.

These APIs belong to AgentPresets, Session, Conversation, Client Runtime, Layout, and Sidebar. Their names and lifecycle do not depend on Shared Blueprint.

```text
Official DSH 0.1.0-rc.7 baseline
                +
frozen generic compatibility changes
                |
                v
public extension APIs
                |
                v
out-of-tree dsh-shared-blueprint bundle
```

## Scope

Interactive Mode is included. Inspect Mode is neither packaged nor supported by this release. Provider credentials are user-supplied. The release is a beta under active stress testing and compatibility hardening.
