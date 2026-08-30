---
name: editing-cordis-compositions
description: Use when creating, changing, or validating a Cordis composition for this harness — writing or editing an agent preset, adding or removing a plugin row, deciding whether something belongs to the host composition or to one session, checking whether a preset you authored actually mounts, or diagnosing a row that mounted but contributed nothing.
---

# Editing Cordis compositions

Every capability in this harness is a plugin row in a `cordis.yml`. There is no separate configuration language: changing what an agent can do means changing which rows are composed for it.

## Off-limits

**Never edit, delete, or overwrite a preset that ships with the deployment** — the `agent-presets` directory beside the deployment's own config, which supplies `standard`, `code`, `minimal`, and `cordis`. Never escalate the sandbox to reach it, even when a change there looks quicker. An upgrade overwrites that install, and corrupting `cordis` disables preset authoring itself. Reading a shipped composition is the intended way to start; writing to one is not, and neither is editing the host composition to work around a preset limitation.

To change what a shipped preset does, copy it and edit the copy. Locally authored presets under the user root are yours to create, edit, and delete.

## Decide the plane first

Two planes, and the choice is not about how "agent-related" something feels — it is about whether the thing must be shared.

**Host composition.** The registries themselves (`tools`, `systemPrompt`, `agents`, `agent-loop`, `sessions`), anything crossing sessions (persistence, session query, storage, settings, credentials, telemetry), the sandbox and approval stack, the model route, and the subagent registry with its spawn/fork backends. One instance for the process.

**Agent preset.** What one session contributes to those registries: its tool plugins, its persona and prompt sections, its compaction policy. One instance per session, mounted under that session's scope and unwound with it.

**A service with a consumer outside the agent plane cannot move into a preset.** `subagents` is the worked example: the registry answers cross-session queries for the host api-proxy, so a per-session copy both starves that host row — it waits forever for a service nothing provides — and collides on the second session, since a provider name registers once. The preset contributes the delegation *tools*; the registry and its backends stay host-side.

A preset is a directory holding one `agent.cordis.yml`, optionally beside a `preset.yml` carrying display metadata — `name` and `description` (and, for shipped presets, a roster `order`). Write the metadata too: a preset without it shows up in every picker as its bare directory name.

Locally authored presets live one directory per preset under `${DSH_HOME:-$HOME/.dsh}/.agent-presets/`, and the shipped set sits beside the deployment's own config. Use those when the user asks where to look. A deployment can configure other roots, so the path you read or edit comes from `preset_list` or `preset_resolve` — the same roster where `preset_copy` reports what it created.

## Built-in preset authoring tools

The Creator composition supplies five stable tools on its first request. Call them directly; do not inspect the tool registry or generate a temporary plugin that wraps the preset service.

- `preset_list` — list every preset with its `id`, `trust` (`system` for the shipped set, `user` for authored ones), and absolute composition `path`.
- `preset_read` — read one composition by preset id without guessing its filesystem location.
- `preset_resolve` — resolve one preset id to its authoritative roster metadata and path.
- `preset_copy` — copy a complete source preset to a new user preset id, with an optional display name; this is the only preset authoring write.
- `preset_validate` — mount-validate one preset through the same standing composition path used by a new Session.

The normal sequence is `preset_list` → `preset_read` or `preset_resolve` → `preset_copy` → edit the returned user path → `preset_validate`. These tools delegate to the existing preset service, so shipped-preset protection, copy-without-overwrite, user-root placement, and mount validation remain authoritative.

## Authoring a preset

1. **Start from a copy.** `preset_copy` copies a whole preset directory into the user root — composition, metadata, skill directories, assets. It validates the id against `[a-z0-9][a-z0-9-]*` (it becomes the directory name, so no leading hyphen), refuses an id any root already supplies, rolls a failed copy back, and rewrites the copy's `preset.yml` to keep the source's description while dropping its name and roster `order`. Prefer it over a shell copy: it needs no sandbox escalation, it lands the copy in whichever root this deployment made writable, and the copy is exactly as loadable as its source. `preset_resolve` then names the file it created — that path, not a guessed one, is what the following edits target. `standard` is the full coding agent and the usual source.
2. **Expect the file sandbox on every edit after the copy.** The user preset root lies outside the session workspace, so under the default `workspace-write` policy the first write there is denied. Only writes are: reading any composition by absolute path needs no escalation. Retry that exact command once with `sandbox_permissions` escalation and a short justification — the user sees and approves it. Batch your writes (one heredoc per file) rather than escalating many small commands. `copy()` itself runs host-side and needs none of this; the edits do.
3. **Write the copy's `description`** in `preset.yml`, and its `name` if you passed none to `copy()`.
4. **Give the persona stable semantic lines.** Make the first non-empty persona line exactly `角色：<用户级角色>` for a Chinese request or `Role: <user-level role>` for an English request. Give the task its own later line, exactly `目标：<用户级任务>` or `Purpose: <user-level task>`. Keep both on one physical line, in the user's primary language, without `{{model}}`, `{{cwd}}`, environment details, tool instructions, or behavior prose. Replace a copied source persona's old role and task introductions instead of adding competing lines. The lines remain ordinary persona prompt text and are the stable Identity and Purpose sources used by Blueprint write-back and runtime validation.
5. **Give delivery requirements one semantic Output line.** Add exactly one standalone line `输出：<用户级交付物>` for Chinese or `Output: <user-level deliverable>` for English. Put the concise deliverable on that single physical line; numbered workflow rules and detailed report headings may follow elsewhere. This is the stable Output source used by Blueprint projection and runtime validation. Keep every user-facing semantic line in the request's primary language unless the user asks otherwise; do not append translated role, task, Behavior, or Output glosses in parentheses.
6. **Audit copied semantic text before accepting it.** A copied preset is only a starting point. Before deciding that no composition edit is needed, inspect the Role, Purpose, numbered Behavior headings, and Output line against the current request language and remove redundant translated glosses inherited from the source. Technical identifiers and established product or standard names may remain unchanged.
7. **Edit the remaining `agent.cordis.yml` rows** while keeping the plane rule and the realm rule.
8. **Mount-validate the result**, then hand off to the user for a real session — both under *Verifying a change*.

A composition written from scratch usually forgets a group realm or a consumer row; a copy starts loadable.

## The rule that catches people

**A row that publishes a service may not sit loose in a preset.** Registering a service without an isolate realm puts it in the process-global realm, so the second session mounting that preset collides with the first. The mount rejects it rather than letting the collision surface later.

Whether a row publishes a service is not visible from its name, and package READMEs are absent from an installed deployment. Read it off the live runtime instead: `cordis_inspect what:"services"` lists every service with the fiber that owns it, so a service attributed to a fiber other than the row you are adding is one that row consumes rather than provides. For a row not in your current composition, mount-validate and read the rejection — it names the offending service.

When a preset genuinely owns a service, wrap the provider **and every consumer that reaches it** in one group carrying an `isolate` realm. The shipped `standard` composition does this for `workflows`, which nothing outside an agent reads — its `delegation` group, with the delegation tools omitted here:

```yaml
- id: delegation
  name: cordis:group
  group: true
  isolate:
    workflows: true
  config:
    - id: workflow-worker-thread
      name: '@deepseek-ai/dsh-workflow-worker-thread'
      config:
        provider: spawn
    - id: tool-workflow
      name: '@deepseek-ai/dsh-tool-workflow'
```

`true` means a realm private to each mounting session. A string label instead joins subtrees into one shared realm; `provide()` still throws on the second registration under that symbol, so a label does not pool instances and is not what a preset needs.

A consumer left outside the group resolves the host's registry, which the preset did not populate, and then contributes nothing. Mount-validation catches that as a row that never activated.

Realms are for services a preset owns, not for every group. A host capability the preset only consumes must stay outside a realm, or the row cannot resolve it: `tool-bash`, `tool-jobs`, and `tool-goal` publish nothing and sit loose in `standard`, which explains in comments which host instance each one resolves and why a realm would break it. Wrapping a consumer row in a realm of its own is the same error as leaving one outside its provider's realm.

## Verifying a change

**`preset_validate` is the check.** It calls the roster's mount validation and composes the preset's plugin subtree for real — the same mount a session start performs, minus the agent — and rejects the four ways a composition fails:

- a row whose package does not resolve (`Cannot find package …`);
- a row whose config is invalid (`invalid config: $.<field> missing required value`);
- a row that never activated (`N row(s) did not activate: <id>: waiting for <service>`);
- a service published into the root realm, which arrives as one of two messages. A name the host does not supply lands in the root realm and the mount audit rejects it: `row(s) published process-global service(s) [<name>]; a preset service must sit behind an isolate realm or move to the host composition` — this is the shape a preset's own forgotten realm takes. A name the host already supplies collides before the audit: `service "<name>" has been registered at <Owner>`. Both name the offending service.

It returns normally when the composition mounts. Run it as the final check on a finished edit rather than after every line: a successful mount installs a standing generation that lives until the process exits, while a failed one disposes its subtree and leaves nothing behind.

**Do not treat the roster's `broken` field as validation.** `preset_list` reports `broken` from a shape check — the file parses in the loader's YAML dialect and holds named rows — which every failure above passes. It catches a damaged file, not an unusable composition.

`cordis_inspect` reports THIS session's composition, so it confirms what a row does in the runtime you are already in, never what your new preset will do.

After a clean mount-validation, ask the user to start a session on the new preset and confirm the tool list; the preset decides tool schemas and prompt sections, and only a real session shows the agent that composition produces.

`cordis_mount` evaluates JavaScript against the live runtime and disappears on restart. It is for probing, not for shipping a capability: a capability belongs in a composition file.

## Native product subagents

Codex and Claude Code providers belong on the host plane but are not installed by production `dsh`. The active Profile must install and mount the selected provider before a preset can expose its ordinary delegation-tool row; never move a product provider into the preset and never add a product-specific settings field.

Copy these disabled templates from a shipped full preset and remove `disabled` only for the products the user requested:

```yaml
- id: tool-subagent-codex
  name: '@deepseek-ai/dsh-tool-subagent'
  disabled: true
  config:
    provider: codex
    toolName: subagent_codex
    backgroundMode: one-shot
    maxDepth: provider-managed

- id: tool-subagent-claude-code
  name: '@deepseek-ai/dsh-tool-subagent'
  disabled: true
  config:
    provider: claude-code
    toolName: subagent_claude_code
    backgroundMode: one-shot
    maxDepth: provider-managed
```

The two rows are independent. Leaving both disabled preserves the copied preset, enabling one exposes only that product tool, and enabling both exposes both. Production `dsh` does not install or mount either optional provider: before enabling a row, the Profile must install the matching `@deepseek-ai/dsh-subagent-codex` or `@deepseek-ai/dsh-subagent-claude-code` package and mount it once on the host plane. A preset cannot provide that host dependency. `backgroundMode: one-shot` keeps omitted or `false` calls in the foreground and lets explicit `run_in_background: true` return a generic Job id. Full presets already carry `tool-jobs`, while the base host carries the job registry; retain both so `job_output`, `job_list`, `job_kill`, cancellation, and completion notices stay available. The host must also provide `codex` or `claude` on `PATH`; the preset does not install, authenticate, select a model for, or probe either product.

## What not to move into a preset

`agent-loop` registers the one agent factory and throws on a second. The registries own the per-session layering and cannot themselves be per-session. Session persistence must stay host-side or the session list fragments. The sandbox, approval, and permission rows are a deliberate boundary: a preset is exactly as privileged as the plugins it names, so letting one relax its own confinement would defeat the confinement.
