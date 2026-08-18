# Verified host mapping

This adapter is the verified native mapping for hosts that share a
session-start / stop command hook. Coverage is **partial**: activation and
closeout are executable; transition-order and protected-action stay
procedural.

## Hosts

| Host | Plugin install | Hooks | Coverage |
|---|---|---|---|
| Claude Code | `.claude-plugin/` marketplace | `hooks/hooks.json` | partial |
| Codex | `.codex-plugin/` + `.agents/plugins/` | `hooks/hooks.json` | partial |
| Grok Build | `.grok-plugin/` marketplace | `hooks/hooks.json` | partial |
| Cursor | `.cursor-plugin/` | `hooks/com.cursor/hooks.json` (`sessionStart`, `stop`) | partial |
| Kimi Code | `.kimi-plugin/plugin.json` | manifest `hooks` array | partial |
| AGY | `.agy/` (strict `plugin.json`) | none | skills-only |
| Pi | `package.json` `"pi"` + `pi-package` | none (TypeScript extensions, not command hooks) | skills-only |

Do **not** set `hooks` on Claude, Codex, or Grok host manifests. Those hosts
auto-load `hooks/hooks.json`; declaring both is a duplicate-file error.

Skill-copy into a host skills directory does **not** register hooks. Plugin
install or disable uses the host's native controls. Bearing Lite never copies
adapters into global hook configuration.

## Event map

| Host event names | Bearing class | Executable? |
|---|---|---|
| `SessionStart`, `sessionStart`, `session_start` | activation | yes, advisory |
| `Stop`, `stop` | closeout | yes, advisory only |
| any other host event | none | unmapped; fail open as `UNAVAILABLE` |

The adapter accepts snake_case and camelCase (`hook_event_name` /
`hookEventName`, `cwd` / `workspaceRoot`).

## Derived fields

The host event supplies session metadata. The adapter reads visible Markdown
under `cwd` (bounded; skips `skills/`, `hooks/`, `test/`, and dependency
trees) and sets only:

| Bearing field | Source |
|---|---|
| `plan_present` | a Markdown file contains a `task_id`, `assigned_role`, non-placeholder journey marker, or `checkout_lease` block |
| `router_invoked` | a `- journey:` setting is present and not a placeholder |
| `assigned_role` | active task `assigned_role` when not `unassigned` or `<…>` |
| `next_action` / `next_action_known` | active task `next_action` when not a placeholder |
| closeout handoff fields | matching task-record keys when present |

`assigned_role` and `router_invoked` are **not** inferred from the tool-call
payload. Missing values stay missing, so activation advises the router instead
of inventing context.

## Outcome translation

| Outcome | Host JSON | Process exit |
|---|---|---|
| `ADVISE`, `REROUTE`, `UNAVAILABLE` on activation or a discoverable-Journey first-pass Stop | `hookSpecificOutput.additionalContext` | always `0` |
| Stop/SubagentStop re-entry (`stop_hook_active`) | quiet success (empty JSON; no `additionalContext`) | always `0` |
| Stop/SubagentStop with no discoverable Journey | quiet success (empty JSON; no `additionalContext`) | always `0` |
| first-pass Stop/SubagentStop with a discoverable Journey | `hookSpecificOutput.additionalContext` | always `0` |
| `BLOCK` | JSON `decision: "block"` only; this mapping never requests protected completion | always `0` |

A discoverable Journey is a visible plan with a `task_id`, `assigned_role`,
non-placeholder journey marker, or `checkout_lease` block. Empty cwd and
`stop_hook_active` re-entry stay quiet. Never map policy or infrastructure to
a non-zero exit.
