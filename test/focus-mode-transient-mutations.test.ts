import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createFocusContext, recordFocusCheckpoint, validateFocusCompletion, type CommandEvidence } from "../src/journey/focus-mode.js";
import { renderPlanningReview } from "../src/journey/planning-journey.js";

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const plan = "---\ntype: plan-spec\nstatus: complete\n---\n\n## Acceptance criteria\n\n- **AC-1** — Import bounded data.\n";
const design = "---\ntype: design\nstatus: complete\n---\n\n## Design\n\n- **DES-1** — Keep the import bounded.\n";
const seit = "---\ntype: seit\nstatus: complete\n---\n\n## Required Commands\n\n- **CMD-UNIT** — `pnpm test`\n\n## Traceability Matrix\n\n| SEIT row ID | Acceptance/risk ID | Design/contract ID | Boundary/test layer | Positive case | Negative/failure case | Command/procedure ID | Evidence |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n| SEIT-1 | AC-1 | DES-1 | unit | works | rejects | CMD-UNIT | report |\n";
const implementation = "---\ntype: implementation\nstatus: complete\n---\n\n## Phase 1\n\n### Slice 1.1 — Import\n\n**Goal.** Import bounded data.\n\n**Requirement IDs.** AC-1\n\n### 1.1 execution manifest\n\n**Write set.** `src/import.ts` only.\n\n**Command IDs.** CMD-UNIT\n\n**Stop condition.** Stop on failure.\n\n**Human decision.** None.\n";

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "bearing-focus-transient-"));
  roots.push(root);
  await mkdir(join(root, "docs/plans/import"), { recursive: true });
  await mkdir(join(root, "src"), { recursive: true });
  await Promise.all([
    writeFile(join(root, "docs/plans/import/plan-spec.md"), plan),
    writeFile(join(root, "docs/plans/import/design.md"), design),
    writeFile(join(root, "docs/plans/import/seit.md"), seit),
    writeFile(join(root, "docs/plans/import/implementation.md"), implementation),
    writeFile(join(root, "docs/plans/import/review.html"), renderPlanningReview([["plan-spec.md", plan], ["design.md", design], ["seit.md", seit], ["implementation.md", implementation]])),
    writeFile(join(root, "src/import.ts"), "export const imported = false;\n"),
  ]);
  await exec("git", ["init", "-q"], { cwd: root });
  await exec("git", ["config", "user.email", "bearing@example.invalid"], { cwd: root });
  await exec("git", ["config", "user.name", "Bearing Test"], { cwd: root });
  await exec("git", ["add", "."], { cwd: root });
  await exec("git", ["commit", "-qm", "baseline"], { cwd: root });
  return root;
}

async function acceptedContext(root: string) {
  const result = await createFocusContext({ root, planDirectory: "docs/plans/import", role: "explorer", objective: "Import bounded data" });
  return result.ok ? result.value : undefined;
}

const passed: CommandEvidence[] = [{ commandId: "CMD-UNIT", status: "passed", summary: "1 test passed" }];
const artifacts = ["src/import.ts", "docs/plans/import/review.html"];

describe("Focus mode transient mutations (issue 119)", () => {
  it("fails a run whose checkpoint observed an out-of-write-set file that was deleted before the final snapshot", async () => {
    const root = await repository();
    const focus = await acceptedContext(root);
    if (!focus) throw new Error("missing focus context");
    await mkdir(join(root, "tools"), { recursive: true });
    await writeFile(join(root, "tools/.fix-nul.cjs"), "module.exports = {};\n");
    const checkpoint = await recordFocusCheckpoint(focus, root);
    expect(checkpoint).toEqual({ ok: true, observed: ["tools/.fix-nul.cjs"] });
    await rm(join(root, "tools/.fix-nul.cjs"));
    await Promise.all([
      writeFile(join(root, "src/import.ts"), "export const imported = true;\n"),
      writeFile(join(root, "docs/plans/import/review.html"), "complete\n"),
    ]);
    // The final diff is clean (the scratch file is gone), yet the checkpoint
    // proves the write set was breached during execution.
    expect(await validateFocusCompletion(focus, root, artifacts, passed)).toEqual({ ok: false, reason: "path_outside_write_set" });
  });

  it("without a checkpoint the transient out-of-write-set file is invisible to final validation", async () => {
    // Negative control: the same create-and-delete shape passes when no checkpoint
    // recorded it, documenting that the audit — not some other check — closes the hole.
    const root = await repository();
    const focus = await acceptedContext(root);
    if (!focus) throw new Error("missing focus context");
    await mkdir(join(root, "tools"), { recursive: true });
    await writeFile(join(root, "tools/.fix-nul.cjs"), "module.exports = {};\n");
    await rm(join(root, "tools/.fix-nul.cjs"));
    await Promise.all([
      writeFile(join(root, "src/import.ts"), "export const imported = true;\n"),
      writeFile(join(root, "docs/plans/import/review.html"), "complete\n"),
    ]);
    expect(await validateFocusCompletion(focus, root, artifacts, passed)).toEqual({
      ok: true,
      changedPaths: ["docs/plans/import/review.html", "src/import.ts"],
    });
  });

  it("transient churn inside the write set observed at a checkpoint stays valid", async () => {
    const root = await repository();
    const focus = await acceptedContext(root);
    if (!focus) throw new Error("missing focus context");
    await writeFile(join(root, "src/import.ts"), "export const imported = true;\n");
    expect(await recordFocusCheckpoint(focus, root)).toEqual({ ok: true, observed: ["src/import.ts"] });
    await writeFile(join(root, "src/import.ts"), "export const imported = false;\n");
    await Promise.all([
      writeFile(join(root, "src/import.ts"), "export const imported = true;\n"),
      writeFile(join(root, "docs/plans/import/review.html"), "complete\n"),
    ]);
    expect(await validateFocusCompletion(focus, root, artifacts, passed)).toEqual({
      ok: true,
      changedPaths: ["docs/plans/import/review.html", "src/import.ts"],
    });
  });

  it("transient build output observed at a checkpoint stays disposable, not a write-set breach", async () => {
    const root = await repository();
    const focus = await acceptedContext(root);
    if (!focus) throw new Error("missing focus context");
    await mkdir(join(root, "dist"), { recursive: true });
    await writeFile(join(root, "dist/bundle.js"), "console.log(1);\n");
    expect(await recordFocusCheckpoint(focus, root)).toEqual({ ok: true, observed: [] });
    await rm(join(root, "dist/bundle.js"));
    await Promise.all([
      writeFile(join(root, "src/import.ts"), "export const imported = true;\n"),
      writeFile(join(root, "docs/plans/import/review.html"), "complete\n"),
    ]);
    expect(await validateFocusCompletion(focus, root, artifacts, passed)).toEqual({
      ok: true,
      changedPaths: ["docs/plans/import/review.html", "src/import.ts"],
    });
  });

  it("fails the checkpoint closed when Git state cannot be read", async () => {
    const root = await repository();
    const focus = await acceptedContext(root);
    if (!focus) throw new Error("missing focus context");
    await rm(join(root, ".git"), { recursive: true, force: true });
    expect(await recordFocusCheckpoint(focus, root)).toEqual({ ok: false, reason: "git_state" });
  });
});
