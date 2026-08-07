import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createFocusContext, validateFocusCompletion, type CommandEvidence, type FocusContext } from "../src/journey/focus-mode.js";
import { renderPlanningReview } from "../src/journey/planning-journey.js";

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const plan = "---\ntype: plan-spec\nstatus: complete\n---\n\n## Acceptance criteria\n\n- **AC-1** — Import bounded data.\n";
const design = "---\ntype: design\nstatus: complete\n---\n\n## Design\n\n- **DES-1** — Keep the import bounded.\n";
const seit = "---\ntype: seit\nstatus: complete\n---\n\n## Required Commands\n\n- **CMD-UNIT** — `pnpm test`\n\n## Traceability Matrix\n\n| SEIT row ID | Acceptance/risk ID | Design/contract ID | Boundary/test layer | Positive case | Negative/failure case | Command/procedure ID | Evidence |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n| SEIT-1 | AC-1 | DES-1 | unit | works | rejects | CMD-UNIT | report |\n";
// Two selected slices in the same wave with disjoint write sets: the supported shape for
// parallel lanes in one worktree (same-wave write sets must be disjoint per the validator).
const implementation = `---
type: implementation
status: complete
---

## Dependency graph

Wave 1: **1.1**
Wave 1: **1.2**

### Slice 1.1 — Import

**Goal.** Import bounded data.

**Requirement IDs.** AC-1

### 1.1 execution manifest

**Write set.** \`src/import.ts\` only.

**Command IDs.** CMD-UNIT

**Stop condition.** Stop on failure.

**Human decision.** None.

### Slice 1.2 — Guest harness

**Goal.** Install guest harness.

**Requirement IDs.** AC-1

### 1.2 execution manifest

**Write set.** \`guest/odi-harness\` only.

**Command IDs.** CMD-UNIT

**Stop condition.** Stop on failure.

**Human decision.** None.
`;
const pending = '<section id="bearing-final-qa" data-status="pending"><h2>Actual implementation and QA</h2><p>Pending implementation and validation.</p></section>';
const completedReview = renderPlanningReview([["plan-spec.md", plan], ["design.md", design], ["seit.md", seit], ["implementation.md", implementation]]).replace(pending, '<section id="bearing-final-qa" data-status="complete"><h2>Actual implementation and QA</h2><p>Planned versus actual: bounded change applied.</p><p>Validation evidence: CMD-UNIT passed.</p></section>');

const reviewArtifact = "docs/plans/import/review.html";
const passed: CommandEvidence[] = [{ commandId: "CMD-UNIT", status: "passed", summary: "1 test passed" }];

async function parallelLaneRepository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "bearing-focus-parallel-lanes-"));
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

async function sliceContext(root: string, sliceId: "1.1" | "1.2"): Promise<FocusContext> {
  const result = await createFocusContext({
    root,
    planDirectory: "docs/plans/import",
    role: "explorer",
    objective: sliceId === "1.1" ? "Import bounded data" : "Install guest harness",
    currentSlice: sliceId,
  });
  if (!result.ok) throw new Error(`missing focus context for slice ${sliceId}: ${result.reason}`);
  return result.value;
}

// Sibling lane 1.2 writes guest/odi-harness; lane 1.1 writes src/import.ts plus its review.
async function concurrentLaneChanges(root: string): Promise<void> {
  await mkdir(join(root, "guest/odi-harness"), { recursive: true });
  await Promise.all([
    writeFile(join(root, "src/import.ts"), "export const imported = true;\n"),
    writeFile(join(root, "guest/odi-harness/file.ts"), "export const sibling = true;\n"),
    writeFile(join(root, "docs/plans/import/review.html"), completedReview),
  ]);
}

describe("parallel disjoint selected-slice lanes in one worktree", () => {
  it("issue 115: without the sibling envelope, the concurrent lane's change fails path_outside_write_set", async () => {
    const root = await parallelLaneRepository();
    const lane = await sliceContext(root, "1.1");
    await concurrentLaneChanges(root);
    expect(await validateFocusCompletion(lane, root, [reviewArtifact, "src/import.ts"], passed)).toEqual({ ok: false, reason: "path_outside_write_set" });
  });

  it("issue 115: supplying the sibling selected-slice envelope validates the concurrent disjoint lane", async () => {
    const root = await parallelLaneRepository();
    const [lane, sibling] = await Promise.all([sliceContext(root, "1.1"), sliceContext(root, "1.2")]);
    await concurrentLaneChanges(root);
    const artifacts = [reviewArtifact, "src/import.ts"];
    expect(await validateFocusCompletion(lane, root, artifacts, passed, sibling.envelope.allowedPaths)).toEqual({
      ok: true,
      changedPaths: artifacts,
    });
  });

  it("issue 115: attributes a sibling lane's committed changes the same as its uncommitted edits", async () => {
    const root = await parallelLaneRepository();
    const [lane, sibling] = await Promise.all([sliceContext(root, "1.1"), sliceContext(root, "1.2")]);
    await mkdir(join(root, "guest/odi-harness"), { recursive: true });
    await writeFile(join(root, "guest/odi-harness/file.ts"), "export const sibling = true;\n");
    await exec("git", ["add", "guest/odi-harness/file.ts"], { cwd: root });
    await exec("git", ["commit", "-qm", "sibling lane"], { cwd: root });
    await Promise.all([
      writeFile(join(root, "src/import.ts"), "export const imported = true;\n"),
      writeFile(join(root, "docs/plans/import/review.html"), completedReview),
    ]);
    const artifacts = [reviewArtifact, "src/import.ts"];
    expect(await validateFocusCompletion(lane, root, artifacts, passed, sibling.envelope.allowedPaths)).toEqual({
      ok: true,
      changedPaths: artifacts,
    });
  });

  it("issue 115: a path both lanes may write stays with the lane even when the sibling envelope also matches", async () => {
    const root = await parallelLaneRepository();
    const lane = await sliceContext(root, "1.1");
    await concurrentLaneChanges(root);
    const artifacts = [reviewArtifact, "src/import.ts"];
    // A wave-level shared prelude path can appear in both envelopes; the lane's own
    // change must not be attributed away by the sibling match.
    const siblingEnvelope = [reviewArtifact, "guest/odi-harness", "src/import.ts"];
    expect(await validateFocusCompletion(lane, root, artifacts, passed, siblingEnvelope)).toEqual({
      ok: true,
      changedPaths: artifacts,
    });
  });

  it("issue 115: fails closed when a change matches neither the lane write set nor a declared sibling envelope", async () => {
    const root = await parallelLaneRepository();
    const [lane, sibling] = await Promise.all([sliceContext(root, "1.1"), sliceContext(root, "1.2")]);
    await Promise.all([
      writeFile(join(root, "src/import.ts"), "export const imported = true;\n"),
      writeFile(join(root, "notes.txt"), "undeclared\n"),
      writeFile(join(root, "docs/plans/import/review.html"), completedReview),
    ]);
    expect(await validateFocusCompletion(lane, root, [reviewArtifact, "src/import.ts"], passed, sibling.envelope.allowedPaths)).toEqual({ ok: false, reason: "path_outside_write_set" });
  });

  it("issue 115: refuses a receipt that claims a sibling lane's path as its own artifact", async () => {
    const root = await parallelLaneRepository();
    const [lane, sibling] = await Promise.all([sliceContext(root, "1.1"), sliceContext(root, "1.2")]);
    await concurrentLaneChanges(root);
    const artifacts = [reviewArtifact, "src/import.ts", "guest/odi-harness/file.ts"];
    expect(await validateFocusCompletion(lane, root, artifacts, passed, sibling.envelope.allowedPaths)).toEqual({ ok: false, reason: "path_outside_write_set" });
  });

  it("issue 115: malformed sibling envelope entries are inert and grant nothing", async () => {
    const root = await parallelLaneRepository();
    const lane = await sliceContext(root, "1.1");
    await concurrentLaneChanges(root);
    expect(await validateFocusCompletion(lane, root, [reviewArtifact, "src/import.ts"], passed, ["../escape.ts"])).toEqual({ ok: false, reason: "path_outside_write_set" });
  });

  it("issue 115: a lane whose only change is its review artifact still fails no_product_change beside a sibling lane", async () => {
    const root = await parallelLaneRepository();
    const [lane, sibling] = await Promise.all([sliceContext(root, "1.1"), sliceContext(root, "1.2")]);
    await mkdir(join(root, "guest/odi-harness"), { recursive: true });
    await Promise.all([
      writeFile(join(root, "guest/odi-harness/file.ts"), "export const sibling = true;\n"),
      writeFile(join(root, "docs/plans/import/review.html"), completedReview),
    ]);
    expect(await validateFocusCompletion(lane, root, [reviewArtifact], passed, sibling.envelope.allowedPaths)).toEqual({ ok: false, reason: "no_product_change" });
  });
});
