# Shared Blueprint Interactive Preview v0.1.0-beta.1

Shared Blueprint gives people and AI a shared structure for understanding, discussing, and modifying agents built on DeepSeek Harness.

This Preview includes natural-language agent creation, semantic Blueprint inspection, node-level discussion, Proposal and Apply, verified Skill and Subagent publication, and Try Agent.

## Assets

- `shared-blueprint-interactive-preview-complete-build-0.1.0-beta.1.tgz` — recommended product download.
- `dsh-shared-blueprint-0.1.0-beta.1.tgz` — standalone package for compatible DSH checkouts.
- `shared-blueprint-interactive-preview-compatibility-0.1.0-beta.1.json` — exact compatibility baseline, branch, commit, and generic seam inventory.
- `SHA256SUMS.txt` — artifact checksums.

## Status and compatibility

This is a working beta under active stress testing and compatibility hardening, not a stable or production-ready release. It is a third-party project and not an official DeepSeek plugin. Untouched official DSH `0.1.0-rc.7` plus the standalone bundle is unsupported; use the Complete Build or the exact compatibility checkout recorded in the attached manifest.

Inspect Mode is not included. Provider credentials are never bundled and must be supplied by the user.

## Publication checklist

- Confirm the generated release manifest reports passing clean-artifact smoke and scans.
- Confirm every asset matches `SHA256SUMS.txt`.
- Replace the Try Demo placeholder only after a real hosted demo exists.
- Obtain explicit approval before creating a tag, GitHub Release, or npm publication.
