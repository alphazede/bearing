---
name: bearing-lite
description: >
  Bearing Lite router for entry, resume, or unclear next action on repository
  work. Locates the project plan, next ready task, dependency state, risk, and
  smallest valid route among planning stages and roles. Activate for bearing
  lite, start/resume bearing, route the next task, or choose the minimum role
  path. Do not use for model or provider selection, package publication, deep
  harness control-room work, or a single already-assigned role packet.
---

# Bearing Lite Router

Plugin entry skill. Not a work role. Owner Authority remains human-only.

## Inputs

Plan path, next ready task, dependencies, risk, and available native capabilities.

## Select the smallest route

1. Identify the project plan and next ready task. Missing plan fields stay `PROPOSED`.
2. Invoke only missing planning stages: `repository-fit`, `set-bearings`, `gather-supplies`, `map-the-route`. Reuse valid evidence; do not replay completed stages.
3. Choose the least costly role route that preserves dependencies and assurance:
   - **Direct:** Crewmate → author self-check plus coordinator confirmation when `required_assurance` is `none`; otherwise the declared assurance roles. Add Park Ranger only when required or owner-selected. Validator and Park Ranger appear only when declared, owner-selected, or at a mandatory integrated phase gate.
   - **Single wave:** Explorer → Crewmate packets with the same assurance rule → Surveyor when multi-packet or owner acceptance requires it. Never automatic Validator per packet.
   - **Expedition:** Navigator → Trail Boss only for concurrent/conflicting waves → Explorer lanes → optional Sub-explorer → Crewmates, with assurance only where `required_assurance`, owner selection, or a mandatory phase gate requires it.
   - **Long multi-phase:** Delegate Authority only when the owner explicitly delegates across sessions or Navigator replacement.
4. Leave dormant roles unselected. No placeholder, receipt, or hidden state.
5. Report honest hook coverage: full, partial, or skills-only procedural checks.

## Never

- Select models, providers, credentials, launchers, or tool routes.
- Create, import, or interpret `.bearing` state, MCP, CLI, or a scheduler.
- Expand owner authority, publish, or self-certify as Validator, Park Ranger, or Surveyor.

## State and task record

Task status lives only in the project plan. See `references/task-state.md` and `templates/task.md`. Orientation diagrams may load later under `references/` and `assets/`; text remains authoritative.
