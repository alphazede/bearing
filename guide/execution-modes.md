# Execution modes and reasoning policy

The mode-recommendation contract behind Explorer and Expedition, and how abstract reasoning tiers map onto a provider.

## The mode-recommendation policy

The scoring rules below are a policy and command contract, not current browser
behavior. The browser presents both cards and you choose directly; it does not
derive signals from your plan or call the scoring command for you. A caller that
does supply the signals gets the following, and a recommendation never starts
anything.

Any of five conditions selects the larger shape on its own: work spanning
multiple repositories, a security-critical integration, a data migration,
irreversible operations, or a plan that already declares three or more Explorers.

Otherwise eight signals are scored for a total between 0 and 25: phases,
slices, dependency edges, overlapping write sets, services, risk rating,
expected concurrency, and integration checkpoints. Reaching the threshold
selects the larger shape. The default threshold is 8.

Risk adds 3 points at high and 4 at critical, so a critical-risk plan with
nothing else notable scores 4 and stays below the default threshold. Risk raises
the score; it does not by itself force Expedition.

**Trail Boss** is the role that coordinates Explorer lanes inside Expedition. It
schedules phases and manages dependencies, budgets, conflicts, and integration;
it does not implement, and it cannot certify anyone's work, because only Surveyor
certifies. It may only parent Explorers, and when one exists every Explorer
reports to it, so the graph rules never permit a half-coordinated topology. Trail
Boss is a role inside Expedition, never a mode of its own.

This graph, and the scheduler that would enact it, are implemented and tested but
not yet wired into the browser journey. A live run makes one adapter call;
choosing Expedition permits subagents where the selected adapter supports that
option, and delegates the actual fan-out to that harness rather than scheduling
lanes itself.

Each decision records the threshold it used rather than reading configuration at
replay time, so replaying an old decision reproduces it even if the default later
changes. Two plans with identical inputs but different recorded thresholds
therefore replay to different recommendations.

## Reasoning policy

Reasoning policy uses provider-independent abstract tiers: `minimal`, `low`,
`medium`, `high`, `very-high`, and `max`. Bearing maps each role's tier onto
the selected provider's real reasoning ladder and clamps it down to that
provider's ceiling. The resolved provider level and whether clamping occurred
are recorded. The policy accepts an escalation input that raises a tier, but
never above the provider ceiling; no browser journey supplies it today, so
escalation is an available policy input rather than current browser behavior. An
unmapped provider or unrecognized tier blocks with `reasoning_unmappable`
instead of silently choosing a default.

The tier you select is a ceiling, not an assignment. Each role runs at the
lower of its own default and your selection, so choosing `medium` holds every
role at `medium` or below, while choosing `max` leaves Explorer, Crewmate, and
Surveyor at their `medium` default and lets the roles that default to `high`,
which are Navigator, Validator, Grader, and Park Ranger, reach it.
If the selected model's ladder omits a role's level, that role clamps to the
nearest lower level the model does support; a model with nothing available at
or below a role's tier is blocked rather than quietly raised.

For example, abstract `max` resolves to `xhigh` on Grok and Pi and to
`thinking` on Agy; abstract `very-high` also resolves to `thinking` on Agy.
`--reasoning very-high` is accepted directly by the CLI.
`--reasoning ultra --provider codex` is accepted as a legacy alias and normalizes to abstract `max`;
Codex `ultra` remains a provider level rather than a policy default.
Agent profiles use schema version 2. Valid version 1 profiles migrate to
version 2, while malformed or future-schema profiles block rather than reset.

[Back to the README](../README.md)
