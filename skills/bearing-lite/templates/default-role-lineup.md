# Bearing Lite global defaults

Store the user-owned copy at
`~/.agents/bearing-lite/default-role-lineup.md`. The Router displays it before
implementation and asks whether it is good for the current Journey. Never fill
agent, model, or reasoning values on the user's behalf.

```markdown
review_cadence: <per-slice | per-round | at-end>

| Role | Primary agent/harness | Primary model | Primary reasoning | Fallback agent/harness | Fallback model | Fallback reasoning |
| --- | --- | --- | --- | --- | --- | --- |
| Router | OWNER_TO_SET | OWNER_TO_SET | OWNER_TO_SET | OWNER_TO_SET | OWNER_TO_SET | OWNER_TO_SET |
| Navigator | OWNER_TO_SET | OWNER_TO_SET | OWNER_TO_SET | OWNER_TO_SET | OWNER_TO_SET | OWNER_TO_SET |
| Explorer | OWNER_TO_SET | OWNER_TO_SET | OWNER_TO_SET | OWNER_TO_SET | OWNER_TO_SET | OWNER_TO_SET |
| Crewmate | OWNER_TO_SET | OWNER_TO_SET | OWNER_TO_SET | OWNER_TO_SET | OWNER_TO_SET | OWNER_TO_SET |
| Validator | OWNER_TO_SET | OWNER_TO_SET | OWNER_TO_SET | OWNER_TO_SET | OWNER_TO_SET | OWNER_TO_SET |
| Park Ranger | OWNER_TO_SET | OWNER_TO_SET | OWNER_TO_SET | OWNER_TO_SET | OWNER_TO_SET | OWNER_TO_SET |
| Surveyor | OWNER_TO_SET | OWNER_TO_SET | OWNER_TO_SET | OWNER_TO_SET | OWNER_TO_SET | OWNER_TO_SET |
```

Journey artifacts copy the confirmed values and mark named instances active,
standby, or unused. Only verified primary unavailability activates its approved
fallback. If both are unavailable, return `OWNER_DECISION_REQUIRED`.
