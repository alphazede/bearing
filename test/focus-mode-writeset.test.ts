import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
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

// The write set mixes a directory entry (guest/odi-harness, whose descendants the agent may
// touch) with a file entry (src/import.ts, which must still match exactly).
const directoryWriteSet = "`guest/odi-harness`, `src/import.ts` only.";
const reviewArtifact = "docs/plans/import/review.html";
const passed: CommandEvidence[] = [{ commandId: "CMD-UNIT", status: "passed", summary: "1 test passed" }];

async function repositoryWithWriteSet(writeSet: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "bearing-focus-writeset-"));
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

describe("Focus write-set directory entries", () => {
  it("issue 116: a directory write-set entry authorizes descendants at any depth, and file entries still match exactly", async () => {
    const root = await repositoryWithWriteSet(directoryWriteSet);
    const focus = await acceptedContext(root);
    if (!focus) throw new Error("missing focus context");
    expect(focus.envelope.allowedPaths).toEqual([reviewArtifact, "guest/odi-harness", "src/import.ts"]);
    await mkdir(join(root, "guest/odi-harness/sub/dir"), { recursive: true });
    await Promise.all([
      writeFile(join(root, "guest/odi-harness/file.ts"), "export const fixture = true;\n"),
      writeFile(join(root, "guest/odi-harness/sub/dir/deep.ts"), "export const deep = true;\n"),
      writeFile(join(root, "src/import.ts"), "export const imported = true;\n"),
      writeFile(join(root, "docs/plans/import/review.html"), completedReview),
    ]);
    const artifacts = [reviewArtifact, "guest/odi-harness/file.ts", "guest/odi-harness/sub/dir/deep.ts", "src/import.ts"];
    expect(await validateFocusCompletion(focus, root, artifacts, passed)).toEqual({
      ok: true,
      changedPaths: artifacts,
    });
  });

  it("issue 116: a directory write-set entry with a trailing slash authorizes the same descendants", async () => {
    const root = await repositoryWithWriteSet("`guest/odi-harness/`, `src/import.ts` only.");
    const focus = await acceptedContext(root);
    if (!focus) throw new Error("missing focus context");
    expect(focus.envelope.allowedPaths).toEqual([reviewArtifact, "guest/odi-harness/", "src/import.ts"]);
    await mkdir(join(root, "guest/odi-harness/sub"), { recursive: true });
    await Promise.all([
      writeFile(join(root, "guest/odi-harness/file.ts"), "export const fixture = true;\n"),
      writeFile(join(root, "guest/odi-harness/sub/deep.ts"), "export const deep = true;\n"),
      writeFile(join(root, "src/import.ts"), "export const imported = true;\n"),
      writeFile(join(root, "docs/plans/import/review.html"), completedReview),
    ]);
    const artifacts = [reviewArtifact, "guest/odi-harness/file.ts", "guest/odi-harness/sub/deep.ts", "src/import.ts"];
    expect(await validateFocusCompletion(focus, root, artifacts, passed)).toEqual({
      ok: true,
      changedPaths: artifacts,
    });
  });

  it.each([
    ["an undeclared sibling change", [reviewArtifact, "src/import.ts"]],
    ["a declared sibling artifact", [reviewArtifact, "guest/odi-harness-evil/file.ts", "src/import.ts"]],
  ])("issue 116: rejects %s beside a directory write-set entry", async (_label, artifacts) => {
    const root = await repositoryWithWriteSet(directoryWriteSet);
    const focus = await acceptedContext(root);
    if (!focus) throw new Error("missing focus context");
    await mkdir(join(root, "guest/odi-harness-evil"), { recursive: true });
    await Promise.all([
      writeFile(join(root, "guest/odi-harness-evil/file.ts"), "export const evil = true;\n"),
      writeFile(join(root, "src/import.ts"), "export const imported = true;\n"),
      writeFile(join(root, "docs/plans/import/review.html"), completedReview),
    ]);
    expect(await validateFocusCompletion(focus, root, artifacts, passed)).toEqual({ ok: false, reason: "path_outside_write_set" });
  });

  it("issue 116: rejects a traversal artifact even when a directory prefix would otherwise match", async () => {
    const root = await repositoryWithWriteSet(directoryWriteSet);
    const focus = await acceptedContext(root);
    if (!focus) throw new Error("missing focus context");
    await Promise.all([
      writeFile(join(root, "src/import.ts"), "export const imported = true;\n"),
      writeFile(join(root, "docs/plans/import/review.html"), completedReview),
    ]);
    expect(await validateFocusCompletion(focus, root, [reviewArtifact, "guest/odi-harness/../escape.ts", "src/import.ts"], passed)).toEqual({ ok: false, reason: "path_outside_write_set" });
  });
});
