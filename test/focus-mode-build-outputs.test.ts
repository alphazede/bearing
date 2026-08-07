import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createFocusContext, validateFocusCompletion, type CommandEvidence } from "../src/journey/focus-mode.js";
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
const pending = '<section id="bearing-final-qa" data-status="pending"><h2>Actual implementation and QA</h2><p>Pending implementation and validation.</p></section>';
const completedReview = renderPlanningReview([["plan-spec.md", plan], ["design.md", design], ["seit.md", seit], ["implementation.md", implementation]]).replace(pending, '<section id="bearing-final-qa" data-status="complete"><h2>Actual implementation and QA</h2><p>Planned versus actual: bounded change applied.</p><p>Validation evidence: CMD-UNIT passed.</p></section>');

const reviewArtifact = "docs/plans/import/review.html";
const passed: CommandEvidence[] = [{ commandId: "CMD-UNIT", status: "passed", summary: "1 test passed" }];
// No .gitignore in the fixture: dist/** from the required build stays untracked, which is
// exactly the condition of issue 125's reproduction.
const buildOutput = ["dist/web/index.html", "dist/web/assets/app.js"];

async function repository(writeSet = "`src/import.ts` only."): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "bearing-focus-build-"));
  roots.push(root);
  await mkdir(join(root, "docs/plans/import"), { recursive: true });
  await mkdir(join(root, "src"), { recursive: true });
  const boundedImplementation = implementation.replace("`src/import.ts` only.", writeSet);
  await Promise.all([
    writeFile(join(root, "docs/plans/import/plan-spec.md"), plan),
    writeFile(join(root, "docs/plans/import/design.md"), design),
    writeFile(join(root, "docs/plans/import/seit.md"), seit),
    writeFile(join(root, "docs/plans/import/implementation.md"), boundedImplementation),
    writeFile(join(root, "docs/plans/import/review.html"), renderPlanningReview([["plan-spec.md", plan], ["design.md", design], ["seit.md", seit], ["implementation.md", boundedImplementation]])),
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

/** Simulate the packet's required build command emitting untracked output under dist/. */
async function emitBuildOutput(root: string): Promise<void> {
  await mkdir(join(root, "dist/web/assets"), { recursive: true });
  await Promise.all([
    writeFile(join(root, "dist/web/index.html"), "<!doctype html>\n"),
    writeFile(join(root, "dist/web/assets/app.js"), "export {};\n"),
  ]);
}

async function applyAuthoredChange(root: string): Promise<void> {
  await Promise.all([
    writeFile(join(root, "src/import.ts"), "export const imported = true;\n"),
    writeFile(join(root, "docs/plans/import/review.html"), completedReview),
  ]);
}

describe("Focus disposable build outputs", () => {
  it("issue 125: a source-only packet validates when its required build emits untracked dist/** output", async () => {
    const root = await repository();
    const focus = await acceptedContext(root);
    if (!focus) throw new Error("missing focus context");
    await emitBuildOutput(root);
    await applyAuthoredChange(root);
    const artifacts = [reviewArtifact, "src/import.ts"];
    expect(await validateFocusCompletion(focus, root, artifacts, passed)).toEqual({
      ok: true,
      changedPaths: artifacts,
    });
  });

  it("issue 125: build output present before the packet and rebuilt during it is still ignored", async () => {
    const root = await repository();
    await emitBuildOutput(root);
    const focus = await acceptedContext(root);
    if (!focus) throw new Error("missing focus context");
    await writeFile(join(root, "dist/web/assets/app.js"), "export const rebuilt = true;\n");
    await emitBuildOutput(root);
    await applyAuthoredChange(root);
    const artifacts = [reviewArtifact, "src/import.ts"];
    expect(await validateFocusCompletion(focus, root, artifacts, passed)).toEqual({
      ok: true,
      changedPaths: artifacts,
    });
  });

  it("issue 125: declared build output inside the write set is still enforced as an authored artifact", async () => {
    const root = await repository("`dist/web`, `src/import.ts` only.");
    const focus = await acceptedContext(root);
    if (!focus) throw new Error("missing focus context");
    await emitBuildOutput(root);
    await applyAuthoredChange(root);
    const artifacts = [reviewArtifact, "src/import.ts", "dist/web/index.html", "dist/web/assets/app.js"].sort();
    expect(await validateFocusCompletion(focus, root, artifacts, passed)).toEqual({
      ok: true,
      changedPaths: artifacts,
    });
  });

  it("issue 125: mutating tracked build output still fails path_outside_write_set", async () => {
    const root = await repository();
    await mkdir(join(root, "dist/web"), { recursive: true });
    await writeFile(join(root, "dist/web/app.js"), "export const built = 1;\n");
    await exec("git", ["add", "dist"], { cwd: root });
    await exec("git", ["commit", "-qm", "track dist output"], { cwd: root });
    const focus = await acceptedContext(root);
    if (!focus) throw new Error("missing focus context");
    await mkdir(join(root, "dist/web/assets"), { recursive: true });
    await Promise.all([
      writeFile(join(root, "dist/web/app.js"), "export const built = 2;\n"),
      writeFile(join(root, "dist/web/index.html"), "<!doctype html>\n"),
      writeFile(join(root, "dist/web/assets/app.js"), "export {};\n"),
    ]);
    await applyAuthoredChange(root);
    expect(await validateFocusCompletion(focus, root, [reviewArtifact, "src/import.ts"], passed)).toEqual({ ok: false, reason: "path_outside_write_set" });
  });

  it("issue 125: committing untracked build output still fails path_outside_write_set", async () => {
    const root = await repository();
    const focus = await acceptedContext(root);
    if (!focus) throw new Error("missing focus context");
    await emitBuildOutput(root);
    await applyAuthoredChange(root);
    await exec("git", ["add", "dist"], { cwd: root });
    await exec("git", ["commit", "-qm", "commit build output"], { cwd: root });
    expect(await validateFocusCompletion(focus, root, [reviewArtifact, "src/import.ts"], passed)).toEqual({ ok: false, reason: "path_outside_write_set" });
  });

  it("issue 125: an untracked symlink under dist/ still fails path_outside_write_set", async () => {
    const root = await repository();
    const focus = await acceptedContext(root);
    if (!focus) throw new Error("missing focus context");
    await mkdir(join(root, "dist"), { recursive: true });
    await symlink("../src/import.ts", join(root, "dist/link.ts"));
    await applyAuthoredChange(root);
    expect(await validateFocusCompletion(focus, root, [reviewArtifact, "src/import.ts"], passed)).toEqual({ ok: false, reason: "path_outside_write_set" });
  });

  it("issue 125: an untracked authored file outside the write set still fails path_outside_write_set", async () => {
    const root = await repository();
    const focus = await acceptedContext(root);
    if (!focus) throw new Error("missing focus context");
    await Promise.all([
      writeFile(join(root, "src/extra.ts"), "export const extra = true;\n"),
    ]);
    await applyAuthoredChange(root);
    expect(await validateFocusCompletion(focus, root, [reviewArtifact, "src/import.ts"], passed)).toEqual({ ok: false, reason: "path_outside_write_set" });
  });

  it("issue 125: untracked output under a lookalike root (dist-web/) still fails path_outside_write_set", async () => {
    const root = await repository();
    const focus = await acceptedContext(root);
    if (!focus) throw new Error("missing focus context");
    await mkdir(join(root, "dist-web"), { recursive: true });
    await writeFile(join(root, "dist-web/index.html"), "<!doctype html>\n");
    await applyAuthoredChange(root);
    expect(await validateFocusCompletion(focus, root, [reviewArtifact, "src/import.ts"], passed)).toEqual({ ok: false, reason: "path_outside_write_set" });
  });
});
