import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createFocusContext, validateFocusCompletion, type CommandEvidence } from "../src/journey/focus-mode.js";
import { beginStandaloneFocus, validateStandaloneFocus } from "../src/journey/standalone-focus.js";
import { renderPlanningReview } from "../src/journey/planning-journey.js";

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const plan = "---\ntype: plan-spec\nstatus: complete\n---\n\n## Acceptance criteria\n\n- **AC-1** — Import bounded data.\n";
const design = "---\ntype: design\nstatus: complete\n---\n\n## Design\n\n- **DES-1** — Keep the import bounded.\n";
const seit = "---\ntype: seit\nstatus: complete\n---\n\n## Required Commands\n\n- **CMD-UNIT** — `pnpm test`\n\n## Traceability Matrix\n\n| SEIT row ID | Acceptance/risk ID | Design/contract ID | Boundary/test layer | Positive case | Negative/failure case | Command/procedure ID | Evidence |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n| SEIT-1 | AC-1 | DES-1 | unit | works | rejects | CMD-UNIT | report |\n";
const implementation = "---\ntype: implementation\nstatus: complete\n---\n\n## Phase 1\n\n### Slice 1.1 — Import\n\n**Goal.** Import bounded data.\n\n**Requirement IDs.** AC-1\n\n### 1.1 execution manifest\n\n**Write set.** `src/import.ts` only.\n\n**Command IDs.** CMD-UNIT\n\n**Stop condition.** Stop on failure.\n\n**Human decision.** None.\n";
const pending = '<section id="bearing-final-qa" data-status="pending"><h2>Actual implementation and QA</h2><p>Pending implementation and validation.</p></section>';
const completedReview = renderPlanningReview([["plan-spec.md", plan], ["design.md", design], ["seit.md", seit], ["implementation.md", implementation]]).replace(pending, '<section id="bearing-final-qa" data-status="complete"><h2>Actual implementation and QA</h2><p>Planned versus actual: src/import.ts changed exactly as planned.</p><p>Validation evidence: CMD-UNIT passed.</p></section>');

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "bearing-focus-"));
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
    writeFile(join(root, "notes.txt"), "owner draft\n"),
  ]);
  await exec("git", ["init", "-q"], { cwd: root });
  await exec("git", ["config", "user.email", "bearing@example.invalid"], { cwd: root });
  await exec("git", ["config", "user.name", "Bearing Test"], { cwd: root });
  await exec("git", ["add", "."], { cwd: root });
  await exec("git", ["commit", "-qm", "baseline"], { cwd: root });
  return root;
}

async function context(root: string) {
  return createFocusContext({ root, planDirectory: "docs/plans/import", role: "explorer", objective: "Import bounded data" });
}

const passed: CommandEvidence[] = [{ commandId: "CMD-UNIT", status: "passed", summary: "1 test passed" }];

describe("Focus mode", () => {
  it("derives one compact bounded envelope from approved planning sources", async () => {
    const root = await repository();
    const focus = await context(root);
    expect(focus?.envelope).toMatchObject({
      role: "explorer",
      immutableObjective: "Import bounded data",
      currentAcceptanceCriterion: "AC-1 — Import bounded data.",
      allowedPaths: ["docs/plans/import/review.html", "src/import.ts"],
      seitCommandIds: ["CMD-UNIT"],
      remainingSlices: ["1.1"],
      currentBlocker: "none",
      gateFailureFingerprint: "none",
    });
  });

  it("rejects malformed, wildcard, traversal, duplicate, and non-Git contracts", async () => {
    for (const writeSet of ["`src/*.ts` only.", "`../outside.ts` only.", "`src/import.ts`, `src/import.ts` only."]) {
      const root = await repository();
      await writeFile(join(root, "docs/plans/import/implementation.md"), implementation.replace("`src/import.ts` only.", writeSet));
      expect(await context(root)).toBeUndefined();
    }
    const root = await mkdtemp(join(tmpdir(), "bearing-focus-no-git-"));
    roots.push(root);
    await mkdir(join(root, "docs/plans/import"), { recursive: true });
    await Promise.all([
      writeFile(join(root, "docs/plans/import/plan-spec.md"), plan),
      writeFile(join(root, "docs/plans/import/seit.md"), seit),
      writeFile(join(root, "docs/plans/import/implementation.md"), implementation),
    ]);
    expect(await context(root)).toBeUndefined();
  });

  it("accepts only declared net changes, complete artifacts, and passing command evidence", async () => {
    const root = await repository();
    const focus = await context(root);
    if (!focus) throw new Error("missing focus context");
    await mkdir(join(root, ".bearing"), { recursive: true });
    await Promise.all([
      writeFile(join(root, "src/import.ts"), "export const imported = true;\n"),
      writeFile(join(root, "docs/plans/import/review.html"), completedReview),
      writeFile(join(root, ".bearing/runtime-state.json"), "{\"status\":\"running\"}\n"),
    ]);
    expect(await validateFocusCompletion(focus, root, ["src/import.ts", "docs/plans/import/review.html"], passed)).toEqual({
      ok: true,
      changedPaths: ["docs/plans/import/review.html", "src/import.ts"],
    });
  });

  it("tracks declared and undeclared changes after the agent commits them", async () => {
    const acceptedRoot = await repository();
    const accepted = await context(acceptedRoot);
    if (!accepted) throw new Error("missing focus context");
    await Promise.all([
      writeFile(join(acceptedRoot, "src/import.ts"), "export const imported = true;\n"),
      writeFile(join(acceptedRoot, "docs/plans/import/review.html"), completedReview),
    ]);
    await exec("git", ["add", "src/import.ts", "docs/plans/import/review.html"], { cwd: acceptedRoot });
    await exec("git", ["commit", "-qm", "implement import"], { cwd: acceptedRoot });
    expect(await validateFocusCompletion(accepted, acceptedRoot, ["src/import.ts", "docs/plans/import/review.html"], passed)).toEqual({ ok: true, changedPaths: ["docs/plans/import/review.html", "src/import.ts"] });

    const rejectedRoot = await repository();
    const rejected = await context(rejectedRoot);
    if (!rejected) throw new Error("missing focus context");
    await Promise.all([
      writeFile(join(rejectedRoot, "notes.txt"), "committed outside the write set\n"),
      writeFile(join(rejectedRoot, "src/import.ts"), "export const imported = true;\n"),
      writeFile(join(rejectedRoot, "docs/plans/import/review.html"), completedReview),
    ]);
    await exec("git", ["add", "."], { cwd: rejectedRoot });
    await exec("git", ["commit", "-qm", "mixed implementation"], { cwd: rejectedRoot });
    expect(await validateFocusCompletion(rejected, rejectedRoot, ["notes.txt", "src/import.ts", "docs/plans/import/review.html"], passed)).toEqual({ ok: false, reason: "path_outside_write_set" });
  });

  it("detects an unauthorized edit to a file that was already dirty", async () => {
    const root = await repository();
    await writeFile(join(root, "notes.txt"), "owner draft before execution\n");
    const focus = await context(root);
    if (!focus) throw new Error("missing focus context");
    await Promise.all([
      writeFile(join(root, "notes.txt"), "agent changed owner draft\n"),
      writeFile(join(root, "src/import.ts"), "export const imported = true;\n"),
      writeFile(join(root, "docs/plans/import/review.html"), completedReview),
    ]);
    expect(await validateFocusCompletion(focus, root, ["notes.txt", "src/import.ts", "docs/plans/import/review.html"], passed)).toEqual({ ok: false, reason: "path_outside_write_set" });
  });

  it("rejects missing artifacts and missing, unknown, duplicate, or failed evidence", async () => {
    const invalidEvidence: CommandEvidence[][] = [
      [],
      [{ commandId: "CMD-OTHER", status: "passed", summary: "passed" }],
      [...passed, ...passed],
      [{ commandId: "CMD-UNIT", status: "failed", summary: "failed" }],
    ];
    for (const evidence of invalidEvidence) {
      const root = await repository();
      const focus = await context(root);
      if (!focus) throw new Error("missing focus context");
      await Promise.all([
        writeFile(join(root, "src/import.ts"), "export const imported = true;\n"),
        writeFile(join(root, "docs/plans/import/review.html"), "complete\n"),
      ]);
      expect(await validateFocusCompletion(focus, root, ["src/import.ts", "docs/plans/import/review.html"], evidence)).toEqual({ ok: false, reason: "evidence_invalid" });
    }
    const root = await repository();
    const focus = await context(root);
    if (!focus) throw new Error("missing focus context");
    await writeFile(join(root, "src/import.ts"), "export const imported = true;\n");
    expect(await validateFocusCompletion(focus, root, ["docs/plans/import/review.html"], passed)).toEqual({ ok: false, reason: "artifact_missing" });
  });

  it("rejects completion with only the runtime-owned review change", async () => {
    const root = await repository();
    const focus = await context(root);
    if (!focus) throw new Error("missing focus context");
    await writeFile(join(root, "docs/plans/import/review.html"), "complete\n");
    expect(await validateFocusCompletion(focus, root, ["docs/plans/import/review.html"], passed)).toEqual({ ok: false, reason: "no_product_change" });
    expect(await readFile(join(root, "src/import.ts"), "utf8")).toContain("false");
  });

  it("guards direct role use and GitHub issue mutation with the same validator", async () => {
    const root = await repository();
    await mkdir(join(root, ".bearing/focus"), { recursive: true });
    await writeFile(join(root, ".bearing/focus/request.json"), JSON.stringify({ role: "crewmate", objective: "Import bounded data", planDirectory: "docs/plans/import", slice: "1.1" }));
    const begun = await beginStandaloneFocus(root, ".bearing/focus/request.json");
    expect(begun.ok).toBe(true);
    if (!begun.ok) throw new Error(begun.reason);
    await expect(readFile(join(root, ".bearing/focus", `${begun.runId}.json`), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await Promise.all([
      writeFile(join(root, "src/import.ts"), "export const imported = true;\n"),
      writeFile(join(root, "docs/plans/import/review.html"), completedReview),
      writeFile(join(root, ".bearing/focus/receipt.json"), JSON.stringify({ artifacts: ["src/import.ts", "docs/plans/import/review.html"], evidence: passed })),
    ]);
    expect(await validateStandaloneFocus(root, begun.runId, ".bearing/focus/receipt.json")).toEqual({ ok: true, changedPaths: ["docs/plans/import/review.html", "src/import.ts"] });

    const secondRoot = await repository();
    await mkdir(join(secondRoot, ".bearing/focus"), { recursive: true });
    await writeFile(join(secondRoot, ".bearing/focus/request.json"), JSON.stringify({ role: "crewmate", objective: "Close GitHub issue #12", planDirectory: "docs/plans/import", slice: "1.1" }));
    const unauthorized = await beginStandaloneFocus(secondRoot, ".bearing/focus/request.json");
    if (!unauthorized.ok) throw new Error(unauthorized.reason);
    await writeFile(join(secondRoot, ".bearing/focus", `${unauthorized.runId}.json`), JSON.stringify({ githubIssueMutationAuthorized: true }));
    await writeFile(join(secondRoot, ".bearing/focus/receipt.json"), JSON.stringify({ artifacts: ["src/import.ts", "docs/plans/import/review.html"], evidence: passed, githubIssueMutation: true }));
    expect(await validateStandaloneFocus(secondRoot, unauthorized.runId, ".bearing/focus/receipt.json")).toEqual({ ok: false, reason: "authority_invalid" });
  });

  it("rejects direct Crewmate use without a bounded request and approved plan", async () => {
    const root = await repository();
    await mkdir(join(root, ".bearing/focus"), { recursive: true });
    await writeFile(join(root, ".bearing/focus/request.json"), JSON.stringify({ role: "crewmate", objective: "Do whatever is needed" }));
    expect(await beginStandaloneFocus(root, ".bearing/focus/request.json")).toEqual({ ok: false, reason: "request_invalid" });
  });
});
