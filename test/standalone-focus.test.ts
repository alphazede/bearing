import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderPlanningReview } from "../src/journey/planning-journey.js";
import { beginStandaloneFocus } from "../src/journey/standalone-focus.js";

const exec = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const plan = "---\ntype: plan-spec\nstatus: complete\n---\n\n## Acceptance criteria\n\n- **AC-1** — Import bounded data.\n";
const design = "---\ntype: design\nstatus: complete\n---\n\n## Design\n\n- **DES-1** — Keep the import bounded.\n";
const seit = "---\ntype: seit\nstatus: complete\n---\n\n## Required Commands\n\n- **CMD-UNIT** — `pnpm test`\n\n## Traceability Matrix\n\n| SEIT row ID | Acceptance/risk ID | Design/contract ID | Boundary/test layer | Positive case | Negative/failure case | Command/procedure ID | Evidence |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n| SEIT-1 | AC-1 | DES-1 | unit | works | rejects | CMD-UNIT | report |\n";
const implementation = "---\ntype: implementation\nstatus: complete\n---\n\n## Phase 1\n\n### Slice 1.1 — Import\n\n**Goal.** Import bounded data.\n\n**Requirement IDs.** AC-1\n\n### 1.1 execution manifest\n\n**Write set.** `src/import.ts` only.\n\n**Command IDs.** CMD-UNIT\n\n**Stop condition.** Stop on failure.\n\n**Human decision.** None.\n";

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "bearing-focus-bind-"));
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

async function beginRequest(root: string): Promise<void> {
  await mkdir(join(root, ".bearing/focus"), { recursive: true });
  await writeFile(join(root, ".bearing/focus/request.json"), JSON.stringify({ role: "explorer", objective: "Import bounded data", planDirectory: "docs/plans/import" }));
}

/** Fail the guard's loopback bind with the given socket error code. */
function failBind(code: string): void {
  vi.spyOn(Server.prototype, "listen").mockImplementation(function (this: Server, _options: unknown, _listener?: unknown): Server {
    const error = new Error(`${code}: simulated bind failure`) as NodeJS.ErrnoException;
    error.code = code;
    process.nextTick(() => this.emit("error", error));
    return this;
  });
}

describe("standalone focus guard bind failures", () => {
  it.each(["EADDRINUSE", "EACCES", "EADDRNOTAVAIL"])("reports %s as guard_bind_failed, not state_invalid", async (code) => {
    const root = await repository();
    await beginRequest(root);
    failBind(code);
    const begun = await beginStandaloneFocus(root, ".bearing/focus/request.json");
    expect(begun).toEqual({ ok: false, reason: "guard_bind_failed" });
  });

  it("fails closed to state_invalid for an unrecognized listen error", async () => {
    const root = await repository();
    await beginRequest(root);
    failBind("EUNKNOWN");
    const begun = await beginStandaloneFocus(root, ".bearing/focus/request.json");
    expect(begun).toEqual({ ok: false, reason: "state_invalid" });
  });

  it("still begins a guard when the listener binds", async () => {
    const root = await repository();
    await beginRequest(root);
    const begun = await beginStandaloneFocus(root, ".bearing/focus/request.json");
    expect(begun.ok).toBe(true);
    if (!begun.ok) return;
    expect(begun.runId).toMatch(/^v1\.([1-9][0-9]{0,4})\.[0-9a-f]{64}$/);
  });
});
