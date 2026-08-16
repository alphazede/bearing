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
| `plan_present` | a Markdown file contains a `task_id` or `assigned_role` block |
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
| `ADVISE`, `REROUTE`, `UNAVAILABLE` | `hookSpecificOutput.additionalContext` | always `0` |
| `BLOCK` | JSON `decision: "block"` only; this mapping never requests protected completion | always `0` |

Never map policy or infrastructure to a non-zero exit.
