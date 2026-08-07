import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { beginStandaloneFocus, validateStandaloneFocus } from "../src/journey/standalone-focus.js";
import { renderPlanningReview } from "../src/journey/planning-journey.js";

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const sleep = (ms: number): Promise<void> => new Promise((settle) => setTimeout(settle, ms));

const plan = "---\ntype: plan-spec\nstatus: complete\n---\n\n## Acceptance criteria\n\n- **AC-1** — Import bounded data.\n";
const design = "---\ntype: design\nstatus: complete\n---\n\n## Design\n\n- **DES-1** — Keep the import bounded.\n";
const seit = "---\ntype: seit\nstatus: complete\n---\n\n## Required Commands\n\n- **CMD-UNIT** — `pnpm test`\n\n## Traceability Matrix\n\n| SEIT row ID | Acceptance/risk ID | Design/contract ID | Boundary/test layer | Positive case | Negative/failure case | Command/procedure ID | Evidence |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n| SEIT-1 | AC-1 | DES-1 | unit | works | rejects | CMD-UNIT | report |\n";
const implementation = "---\ntype: implementation\nstatus: complete\n---\n\n## Phase 1\n\n### Slice 1.1 — Import\n\n**Goal.** Import bounded data.\n\n**Requirement IDs.** AC-1\n\n### 1.1 execution manifest\n\n**Write set.** `src/import.ts` only.\n\n**Command IDs.** CMD-UNIT\n\n**Stop condition.** Stop on failure.\n\n**Human decision.** None.\n";
const pending = '<section id="bearing-final-qa" data-status="pending"><h2>Actual implementation and QA</h2><p>Pending implementation and validation.</p></section>';
const completedReview = renderPlanningReview([["plan-spec.md", plan], ["design.md", design], ["seit.md", seit], ["implementation.md", implementation]]).replace(pending, '<section id="bearing-final-qa" data-status="complete"><h2>Actual implementation and QA</h2><p>Planned versus actual: src/import.ts changed exactly as planned.</p><p>Validation evidence: CMD-UNIT passed.</p></section>');
const passed = [{ commandId: "CMD-UNIT", status: "passed", summary: "1 test passed" }];

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "bearing-focus-lifetime-"));
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

async function beginNavigatorGuard(root: string) {
  await mkdir(join(root, ".bearing/focus"), { recursive: true });
  await writeFile(join(root, ".bearing/focus/request.json"), JSON.stringify({
    role: "navigator",
    objective: "Import bounded data",
    planDirectory: "docs/plans/import",
    slice: "1.1",
  }));
  const begun = await beginStandaloneFocus(root, ".bearing/focus/request.json");
  if (!begun.ok) throw new Error(begun.reason);
  return begun;
}

describe("Focus guard lifetime", () => {
  it("issue 123: a non-terminal validation resets the lifetime, so a Navigator phase past the fixed timer keeps its guard", async () => {
    const lifetimeMs = 500;
    vi.stubEnv("BEARING_FOCUS_GUARD_LIFETIME_MS", String(lifetimeMs));

    // Control: without any validation activity the guard still expires at the
    // lifetime, proving the override is in effect and the test would catch the
    // original fixed-timer bug (the closed guard answers state_invalid).
    const idleRoot = await repository();
    const idle = await beginNavigatorGuard(idleRoot);
    await sleep(lifetimeMs * 2);
    expect(await validateStandaloneFocus(idleRoot, idle.runId, ".bearing/focus/missing-receipt.json"))
      .toEqual({ ok: false, reason: "state_invalid" });

    // Active: a correctable failure (receipt_invalid) keeps the guard open and
    // restarts the lifetime, so the eventual completion is certified even though
    // more than one full lifetime has elapsed since begin. The terminal validate
    // must land after the original deadline (the fixed timer would have closed
    // the guard) and before the reset deadline (the reset must have kept it open).
    const root = await repository();
    const begun = await beginNavigatorGuard(root);
    await sleep(lifetimeMs * 0.4);
    expect(await validateStandaloneFocus(root, begun.runId, ".bearing/focus/missing-receipt.json"))
      .toEqual({ ok: false, reason: "receipt_invalid" });
    await sleep(lifetimeMs * 0.8);
    await Promise.all([
      writeFile(join(root, "src/import.ts"), "export const imported = true;\n"),
      writeFile(join(root, "docs/plans/import/review.html"), completedReview),
      writeFile(join(root, ".bearing/focus/receipt.json"), JSON.stringify({
        runtimeIdentity: begun.runtimeIdentity,
        artifacts: ["src/import.ts", "docs/plans/import/review.html"],
        evidence: passed,
      })),
    ]);
    expect(await validateStandaloneFocus(root, begun.runId, ".bearing/focus/receipt.json"))
      .toEqual({ ok: true, changedPaths: ["docs/plans/import/review.html", "src/import.ts"] });
  });
});
