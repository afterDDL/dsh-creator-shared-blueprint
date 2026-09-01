# Shared Blueprint Interactive Preview architecture

## Product package

`dsh-shared-blueprint` is one installable Cordis bundle. It owns the Host adapter, browser client, wire contract, generated Remote codec, durable event registration, invariant companion, and additive `cordis.patch.yml`. Installing or removing the package controls both Host and Client faces; the standard DSH Web bundle does not contain a Blueprint row.

Interactive authoring projects committed agent presets into a semantic Blueprint. User edits enter a Proposal and Apply flow. Skill and Subagent authoring uses isolated candidates, Host validation, a fresh verification Session, and verified-only publication. Those product rules remain inside the standalone package.

## DSH extension APIs

The compatible DSH build supplies generic APIs for isolated preset publication, durable plugin event types, preset-ready Session creation, replacement-aware conversation locations, presentation contributions, default details, and additive Sidebar sections. The package consumes those APIs without patching internal maps or mounting a built-in Blueprint implementation.

## Release forms

The Complete Build is a deterministic package of prebuilt DSH and vendored Cordis tarballs, the standalone Blueprint tarball, a relative-path pnpm lockfile, and a small Node launcher. It excludes `node_modules` and creates its local DSH home only when the user starts it.

The Standalone Bundle is the independently versioned npm-format tarball. It contains prebuilt Host and Client JavaScript, declarations and runtime contract modules, the generated Remote artifacts, the Cordis patch, package metadata, and its license. It contains no source tree, source map, workspace dependency specifier, credential, or machine path.

## Scope boundary

This release includes only Interactive Mode. Shared schema, projection, selection identity, conversation context, and UI primitives remain available for future work, but Inspect Mode has no release entry point or compatibility promise here.
