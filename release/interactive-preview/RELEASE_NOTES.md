# Shared Blueprint Interactive Preview

Version `0.1.0-beta.1` is the first public release candidate for the Interactive product.

## What you can do

- Create an agent from a natural-language request.
- Understand the agent through a semantic Blueprint.
- Select a Blueprint node and discuss it with AI.
- Review a Proposal and explicitly Apply a committed modification.
- Extend an agent with a Skill or Subagent after isolated authoring and runtime verification.
- Start Try Agent and exercise the resulting runtime.

## Release status

This is a working Preview/Beta under active stress testing, compatibility hardening, and iteration. It is not a stable or production-ready release and is not an official DeepSeek plugin.

## Distribution

The recommended Complete Build includes a compatible DSH build and the standalone package. The Standalone Bundle is provided for DSH ecosystem developers together with an exact compatibility branch and commit.

## Compatibility

The Shared Blueprint product is out of tree. Upstream DSH `0.1.0-rc.7` does not yet expose every generic extension API this package needs, so untouched rc.7 plus the bundle is unsupported. The Complete Build includes the frozen generic compatibility changes.

## Known limitations

- Provider credentials are supplied by the user; without a provider, real agent creation and Try Agent cannot complete.
- The release still requires the compatibility checkout rather than untouched upstream rc.7.
- Capability-authoring reasoning is represented by the user-level configuring state rather than exposing the model's internal reasoning transcript.
- Inspect Mode is not included.

## Verification

The frozen product passed manual Interactive Golden Path acceptance before packaging. Final package build, clean installation, Web boot, browser smoke, payload inspection, checksum generation, and secret/path scans are release-candidate gates; their result belongs to the generated release manifest and final RC report rather than this static note.
