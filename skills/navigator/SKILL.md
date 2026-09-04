---
name: navigator
description: >
  Compatibility diagnostic for plans that still name Navigator. Use when an
  existing plan assigns Navigator or asks to sequence expedition waves as
  navigator. Do not use for new Journeys, packet work, planning, assurance,
  or publication.
---

# Navigator

Compatibility only. Router now owns cross-wave sequencing and conflict
resolution.

## Inputs and match

- **Inputs:** a plan that still assigns `Navigator`, plus the recorded Journey
  snapshot.
- **Match:** an existing plan names Navigator as an assigned role.
- **Non-match:** new Journeys, Explorer waves, Crewmate packets, or assurance.

## Algorithm

1. Do not sequence waves, reread the artifact set, dispatch Explorers, or
   run assurance. Read identities only from the recorded Journey snapshot,
   never from the current global defaults file.
2. Return `REROUTED` to the Router with a diagnostic that Navigator is not a
   normal role; treat the assignment as unused and continue under Router.
3. Preserve the checkout lease. Do not write planning state.

## Return and recovery

Return `REROUTED` with verdict, candidate_ref, changed_paths, tests, findings,
and blocker. Findings name the compatibility path.

Never implement, self-assure, select models, or mutate remotes.
