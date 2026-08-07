# Focus mode and workflow skills

How a bounded execution run is contained, and how the packaged skills that drive it work.

## Workflow skills

Bearing ships its complete internal workflow vocabulary in `skills/`: **Repository Fit**,
**Set Bearings**, **Gather Supplies**, **Map the Route**, **Navigator**, **Explorer**,
**Crewmate**, **Validator**, **Grader**, **Park Ranger**, and **Surveyor**. At runtime
Bearing reads the relevant packaged `SKILL.md` files and embeds them in the
selected harness request. Customers do not need AlphaZede's private skill
installation. The internal skills disable user and model invocation, so a harness cannot use
one as an unguarded command. `plugin-skills/` exposes the launcher plus guarded
Explorer, Navigator, and Crewmate wrappers. Each wrapper requires an approved
plan, starts a Focus snapshot, loads its corresponding internal skill, and
validates the final receipt. The internal role files are never exposed as
commands.

To customize a source build, edit the corresponding `skills/<name>/SKILL.md`
file, keep its `name` and `description` frontmatter valid, then rebuild and run
the tests. TypeScript remains responsible for security boundaries, artifact
validation, approval checks, and deterministic `review.html` generation; skill
text cannot weaken those guarantees. Reinstalling or upgrading the npm package
replaces edits made directly inside an installed package, so durable changes
belong in a fork or source checkout.

### Focus mode and direct roles

During Explorer or Expedition execution, Bearing derives one compact Focus
envelope from `plan-spec.md`, `seit.md`, and each `implementation.md` execution
manifest. The envelope fixes the objective, current acceptance criterion,
allowed paths, SEIT command IDs, blocker, remaining slices, and gate-failure
fingerprint. Bearing snapshots Git before execution and rejects completion when
the agent changes an undeclared path, omits a changed artifact, omits or
duplicates command evidence, reports a failed command as completion, makes no
product change, or leaves `review.html` stale.

Beginning a Focus run also returns a `runtimeIdentity`: a digest of the loaded
validation modules, fixed for the life of that guard. **The receipt must carry
that value verbatim**, or validation refuses it. A guard cannot acquire new
semantics once it has started, so a receipt bound to a different runtime would
otherwise be certified under validation rules that guard never executed. The
mismatch is refused as `runtime_mismatch`, which is correctable rather than
terminal. A slice declared as a Focus-runtime repair is the one exception: it
binds its receipt to the identity recomputed from the source it just repaired,
so a fix to Focus itself can be proven without a replacement run.

The same validator backs the guarded `$explorer`, `$navigator`, and `$crewmate`
plugin skills. Their temporary request and receipt stay under the selected
repository's ignored `.bearing/focus/` state, while the immutable snapshot stays
inside a one-use loopback guard process and cannot be rewritten as a workspace
file. Direct GitHub issue comments or closure require explicit GitHub-mutation
authority on the Focus request; Bearing checks that authorization flag but does
not itself bind it to a specific repository or issue number, so scoping to an
exact issue is the host wrapper's responsibility. Finding a bug does not
authorize publishing repository data.

Codex and Claude plugins also ship a short Focus reminder hook. Bearing enables
it only for the provider process it starts, including resumes and subagents.
The hook is optional: disabling or removing it does not remove TypeScript Focus
validation, which remains the completion boundary.

[Back to the README](../README.md)
