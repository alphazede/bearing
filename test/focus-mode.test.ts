import { execFile } from "node:child_process";
import { createServer, request as httpRequest, type Server } from "node:http";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFocusContext, snapshotGitState, validateFocusCompletion, type CommandEvidence } from "../src/journey/focus-mode.js";
import { beginStandaloneFocus, defaultRuntimeIdentity, sourceRuntimeIdentity, validateStandaloneFocus } from "../src/journey/standalone-focus.js";
import { renderPlanningReview } from "../src/journey/planning-journey.js";
import { createDispatcher, type JsonRpcResponse } from "../src/mcp/server.js";

function structured(response: JsonRpcResponse | null): Record<string, unknown> {
  const value = (response?.result as { structuredContent?: unknown } | undefined)?.structuredContent;
  if (typeof value !== "object" || value === null) throw new Error(`no structuredContent: ${JSON.stringify(response)}`);
  return value as Record<string, unknown>;
}

function callTool(dispatch: ReturnType<typeof createDispatcher>, name: string, args: unknown): Promise<JsonRpcResponse | null> {
  return dispatch({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
}

const exec = promisify(execFile);
const roots: string[] = [];
const servers: Server[] = [];
const writeSetClauseReason = "ambiguous write authority fails closed rather than silently granting write access; restate the prohibition in prose without backticks per planning contract rule 5";
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen({ host: "127.0.0.1", port: 0 }, resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not listen");
  servers.push(server);
  return address.port;
}

async function settleWithin<T>(promise: Promise<T>, timeoutMs = 100): Promise<T | "unsettled"> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<"unsettled">((resolve) => {
        timeout = setTimeout(() => resolve("unsettled"), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function loopbackRequest(
  port: number,
  method: string,
  path: string,
  body = "",
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: "127.0.0.1",
      port,
      method,
      path,
      headers: { "content-length": Buffer.byteLength(body) },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode ?? 0,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    request.once("error", reject);
    request.end(body);
  });
}

const plan = "---\ntype: plan-spec\nstatus: complete\n---\n\n## Acceptance criteria\n\n- **AC-1** — Import bounded data.\n";
const design = "---\ntype: design\nstatus: complete\n---\n\n## Design\n\n- **DES-1** — Keep the import bounded.\n";
const seit = "---\ntype: seit\nstatus: complete\n---\n\n## Required Commands\n\n- **CMD-UNIT** — `pnpm test`\n\n## Traceability Matrix\n\n| SEIT row ID | Acceptance/risk ID | Design/contract ID | Boundary/test layer | Positive case | Negative/failure case | Command/procedure ID | Evidence |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n| SEIT-1 | AC-1 | DES-1 | unit | works | rejects | CMD-UNIT | report |\n";
const implementation = "---\ntype: implementation\nstatus: complete\n---\n\n## Phase 1\n\n### Slice 1.1 — Import\n\n**Goal.** Import bounded data.\n\n**Requirement IDs.** AC-1\n\n### 1.1 execution manifest\n\n**Write set.** `src/import.ts` only.\n\n**Command IDs.** CMD-UNIT\n\n**Stop condition.** Stop on failure.\n\n**Human decision.** None.\n";
const pending = '<section id="bearing-final-qa" data-status="pending"><h2>Actual implementation and QA</h2><p>Pending implementation and validation.</p></section>';
const completedReview = renderPlanningReview([["plan-spec.md", plan], ["design.md", design], ["seit.md", seit], ["implementation.md", implementation]]).replace(pending, '<section id="bearing-final-qa" data-status="complete"><h2>Actual implementation and QA</h2><p>Planned versus actual: src/import.ts changed exactly as planned.</p><p>Validation evidence: CMD-UNIT passed.</p></section>');

async function repository(ignoreDocs = false): Promise<string> {
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
    ...(ignoreDocs ? [writeFile(join(root, ".gitignore"), "docs/\n")] : []),
  ]);
  await exec("git", ["init", "-q"], { cwd: root });
  await exec("git", ["config", "user.email", "bearing@example.invalid"], { cwd: root });
  await exec("git", ["config", "user.name", "Bearing Test"], { cwd: root });
  await exec("git", ["add", "."], { cwd: root });
  await exec("git", ["commit", "-qm", "baseline"], { cwd: root });
  return root;
}

async function bearingPlanRepository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "bearing-focus-bearing-plan-"));
  roots.push(root);
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, ".bearing/focus/s10-plan"), { recursive: true });
  const planSources: readonly [string, string][] = [
    ["plan-spec.md", plan],
    ["design.md", design],
    ["seit.md", seit],
    ["implementation.md", implementation],
  ];
  const pendingReviewHtml = renderPlanningReview(planSources);
  await Promise.all([
    writeFile(join(root, ".gitignore"), ".bearing/\n"),
    writeFile(join(root, "src/import.ts"), "export const imported = false;\n"),
    writeFile(join(root, ".bearing/focus/s10-plan/plan-spec.md"), plan),
    writeFile(join(root, ".bearing/focus/s10-plan/design.md"), design),
    writeFile(join(root, ".bearing/focus/s10-plan/seit.md"), seit),
    writeFile(join(root, ".bearing/focus/s10-plan/implementation.md"), implementation),
    writeFile(join(root, ".bearing/focus/s10-plan/review.html"), pendingReviewHtml),
  ]);
  await exec("git", ["init", "-q"], { cwd: root });
  await exec("git", ["config", "user.email", "bearing@example.invalid"], { cwd: root });
  await exec("git", ["config", "user.name", "Bearing Test"], { cwd: root });
  await exec("git", ["add", ".gitignore", "src/import.ts"], { cwd: root });
  await exec("git", ["commit", "-qm", "baseline"], { cwd: root });
  return root;
}

async function context(root: string) {
  return createFocusContext({ root, planDirectory: "docs/plans/import", role: "explorer", objective: "Import bounded data" });
}

async function acceptedContext(root: string) {
  const result = await context(root);
  return result.ok ? result.value : undefined;
}

const passed: CommandEvidence[] = [{ commandId: "CMD-UNIT", status: "passed", summary: "1 test passed" }];

describe("Focus mode", () => {
  it("derives one compact bounded envelope from approved planning sources", async () => {
    const root = await repository();
    const result = await context(root);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.value.envelope).toMatchObject({
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

  it("issue 107: Navigator Focus fails closed without one explicit selected slice", async () => {
    const root = await repository();
    const secondSlice = `${implementation}\n### Slice 1.2 — Export\n\n**Goal.** Export bounded data.\n\n**Requirement IDs.** AC-1\n\n### 1.2 execution manifest\n\n**Write set.** \`src/export.ts\` only.\n\n**Command IDs.** CMD-UNIT\n\n**Stop condition.** Stop on failure.\n\n**Human decision.** None.\n`;
    await Promise.all([
      writeFile(join(root, "docs/plans/import/implementation.md"), secondSlice),
      writeFile(join(root, "docs/plans/import/review.html"), renderPlanningReview([["plan-spec.md", plan], ["design.md", design], ["seit.md", seit], ["implementation.md", secondSlice]])),
      writeFile(join(root, "src/export.ts"), "export const exported = false;\n"),
    ]);
    await exec("git", ["add", "."], { cwd: root });
    await exec("git", ["commit", "-qm", "multi-slice baseline"], { cwd: root });
    expect(await createFocusContext({
      root,
      role: "navigator",
      objective: "Coordinate only export",
      planDirectory: "docs/plans/import",
    })).toEqual({ ok: false, reason: "input_invalid", field: "currentSlice" });

    const selected = await createFocusContext({
      root,
      role: "navigator",
      objective: "Coordinate only export",
      planDirectory: "docs/plans/import",
      currentSlice: "1.2",
    });
    expect(selected).toMatchObject({
      ok: true,
      value: {
        envelope: {
          role: "navigator",
          allowedPaths: ["docs/plans/import/review.html", "src/export.ts"],
          seitCommandIds: ["CMD-UNIT"],
          remainingSlices: ["1.2"],
        },
      },
    });
  });

  it("rejects malformed, wildcard, traversal, duplicate, and non-Git contracts", async () => {
    for (const [writeSet, rejection] of [
      ["`src/*.ts` only.", { ok: false, reason: "write_set_path_invalid", sliceId: "1.1", field: "Write set", detail: "src/*.ts" }],
      ["`../outside.ts` only.", { ok: false, reason: "write_set_path_invalid", sliceId: "1.1", field: "Write set", detail: "../outside.ts" }],
      ["`src/import.ts`, `src/import.ts` only.", { ok: false, reason: "write_set_path_duplicate", sliceId: "1.1", field: "Write set", detail: "src/import.ts" }],
    ] as const) {
      const root = await repository();
      await writeFile(join(root, "docs/plans/import/implementation.md"), implementation.replace("`src/import.ts` only.", writeSet));
      expect(await context(root)).toEqual(rejection);
    }
    const root = await mkdtemp(join(tmpdir(), "bearing-focus-no-git-"));
    roots.push(root);
    await mkdir(join(root, "docs/plans/import"), { recursive: true });
    await Promise.all([
      writeFile(join(root, "docs/plans/import/plan-spec.md"), plan),
      writeFile(join(root, "docs/plans/import/seit.md"), seit),
      writeFile(join(root, "docs/plans/import/implementation.md"), implementation),
    ]);
    expect(await context(root)).toEqual({ ok: false, reason: "git_state" });
  });

  it("returns a distinct typed rejection for every authoring failure", async () => {
    const cases = [
      [implementation.replace("**Goal.** Import bounded data.\n\n", ""), { ok: false, reason: "field_missing", sliceId: "1.1", field: "Goal" }],
      [implementation.replace("**Requirement IDs.** AC-1\n\n", ""), { ok: false, reason: "field_missing", sliceId: "1.1", field: "Requirement IDs" }],
      [implementation.replace("**Write set.** `src/import.ts` only.\n\n", ""), { ok: false, reason: "field_missing", sliceId: "1.1", field: "Write set" }],
      [implementation.replace("**Command IDs.** CMD-UNIT\n\n", ""), { ok: false, reason: "field_missing", sliceId: "1.1", field: "Command IDs" }],
      [implementation.replace("Import bounded data.", "x".repeat(513)), { ok: false, reason: "goal_too_long", sliceId: "1.1", field: "Goal", detail: "length=513 limit=512" }],
      [implementation.replace("`src/import.ts` only.", "`src/import.ts`."), { ok: false, reason: "write_set_only_missing", sliceId: "1.1", field: "Write set" }],
      [implementation.replace("`src/import.ts` only.", "Write only."), { ok: false, reason: "write_set_empty", sliceId: "1.1", field: "Write set" }],
      [implementation.replace("CMD-UNIT", "UNKNOWN"), { ok: false, reason: "command_id_invalid", sliceId: "1.1", field: "Command IDs" }],
      [implementation.replace("CMD-UNIT", "CMD-MISSING"), { ok: false, reason: "command_id_unmapped", sliceId: "1.1", field: "Command IDs", detail: "CMD-MISSING" }],
      [implementation.replace("### Slice 1.1 — Import", "### Slice 1.1 — Import\n\n### Slice 1.1 — Duplicate"), { ok: false, reason: "duplicate_slice_id", sliceId: "1.1" }],
      [implementation.replace("### 1.1 execution manifest", "### 1.1 execution manifest\n\n### 1.1 execution manifest"), { ok: false, reason: "duplicate_manifest_id", sliceId: "1.1" }],
    ] as const;
    for (const [candidate, rejection] of cases) {
      const root = await repository();
      await writeFile(join(root, "docs/plans/import/implementation.md"), candidate);
      expect(await context(root)).toEqual(rejection);
    }
  });

  it("rejects a prohibited backticked path instead of granting it", async () => {
    const root = await repository();
    await writeFile(
      join(root, "docs/plans/import/implementation.md"),
      implementation.replace("`src/import.ts` only.", "Write only `src/a.ts`. Do not modify `src/secret.ts`."),
    );
    expect(await context(root)).toEqual({
      ok: false,
      reason: "write_set_negation",
      sliceId: "1.1",
      field: "Write set",
      detail: writeSetClauseReason,
    });

    const acceptedRoot = await repository();
    const accepted = await context(acceptedRoot);
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) throw new Error(accepted.reason);
    expect(accepted.value.envelope.allowedPaths).toEqual(["docs/plans/import/review.html", "src/import.ts"]);
  });

  it.each([
    "Write only `src/a.ts`; `src/secret.ts` must not be modified.",
    "Write only `src/a.ts`; `src/secret.ts` is read-only.",
    "Write only `src/a.ts`; leave `src/secret.ts` untouched.",
    "Write only `src/a.ts`; must not modify `src/secret.ts`.",
  ])("rejects a prohibited path instead of granting it: %s", async (writeSet) => {
    const root = await repository();
    await writeFile(
      join(root, "docs/plans/import/implementation.md"),
      implementation.replace("`src/import.ts` only.", writeSet),
    );
    expect(await context(root)).toEqual({
      ok: false,
      reason: "write_set_negation",
      sliceId: "1.1",
      field: "Write set",
      detail: writeSetClauseReason,
    });
  });

  it("accepts only declared net changes, complete artifacts, and passing command evidence", async () => {
    const root = await repository();
    const focus = await acceptedContext(root);
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
    const accepted = await acceptedContext(acceptedRoot);
    if (!accepted) throw new Error("missing focus context");
    await Promise.all([
      writeFile(join(acceptedRoot, "src/import.ts"), "export const imported = true;\n"),
      writeFile(join(acceptedRoot, "docs/plans/import/review.html"), completedReview),
    ]);
    await exec("git", ["add", "src/import.ts", "docs/plans/import/review.html"], { cwd: acceptedRoot });
    await exec("git", ["commit", "-qm", "implement import"], { cwd: acceptedRoot });
    expect(await validateFocusCompletion(accepted, acceptedRoot, ["src/import.ts", "docs/plans/import/review.html"], passed)).toEqual({ ok: true, changedPaths: ["docs/plans/import/review.html", "src/import.ts"] });

    const rejectedRoot = await repository();
    const rejected = await acceptedContext(rejectedRoot);
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
    const focus = await acceptedContext(root);
    if (!focus) throw new Error("missing focus context");
    await Promise.all([
      writeFile(join(root, "notes.txt"), "agent changed owner draft\n"),
      writeFile(join(root, "src/import.ts"), "export const imported = true;\n"),
      writeFile(join(root, "docs/plans/import/review.html"), completedReview),
    ]);
    expect(await validateFocusCompletion(focus, root, ["notes.txt", "src/import.ts", "docs/plans/import/review.html"], passed)).toEqual({ ok: false, reason: "path_outside_write_set" });
  });

  it("rejects missing artifacts and missing, unknown, or duplicate evidence", async () => {
    // A failed command is no longer folded in here: it reports command_regressed, because a broken
    // build is a regression rather than a gap in the evidence. Its own test covers that outcome.
    const invalidEvidence: CommandEvidence[][] = [
      [],
      [{ commandId: "CMD-OTHER", status: "passed", summary: "passed" }],
      [...passed, ...passed],
    ];
    for (const evidence of invalidEvidence) {
      const root = await repository();
      const focus = await acceptedContext(root);
      if (!focus) throw new Error("missing focus context");
      await Promise.all([
        writeFile(join(root, "src/import.ts"), "export const imported = true;\n"),
        writeFile(join(root, "docs/plans/import/review.html"), "complete\n"),
      ]);
      expect(await validateFocusCompletion(focus, root, ["src/import.ts", "docs/plans/import/review.html"], evidence)).toEqual({ ok: false, reason: "evidence_invalid" });
    }
    const root = await repository();
    const focus = await acceptedContext(root);
    if (!focus) throw new Error("missing focus context");
    await writeFile(join(root, "src/import.ts"), "export const imported = true;\n");
    expect(await validateFocusCompletion(focus, root, ["docs/plans/import/review.html"], passed)).toEqual({ ok: false, reason: "artifact_missing" });
  });

  it("rejects a declared production artifact that was never changed", async () => {
    // The fabricated-fix shape: declare the production file and its test, change only the test.
    // Every other completion check passes — there is a product change, nothing escaped the write
    // set, and every changed path is declared — so this is the one rule that catches it.
    const root = await repository();
    const focus = await acceptedContext(root);
    if (!focus) throw new Error("missing focus context");
    await writeFile(join(root, "docs/plans/import/review.html"), "complete\n");

    expect(await validateFocusCompletion(
      focus,
      root,
      ["src/import.ts", "docs/plans/import/review.html"],
      passed,
    )).toEqual({ ok: false, reason: "artifact_unchanged" });
    expect(await readFile(join(root, "src/import.ts"), "utf8")).toContain("false");
  });

  it("reports a failed declared command as a regression, not as missing evidence", async () => {
    // A command that ran and failed means previously-working behaviour broke. Folding it into
    // evidence_invalid gave a broken build the same soft verdict as a missing summary.
    const root = await repository();
    const focus = await acceptedContext(root);
    if (!focus) throw new Error("missing focus context");
    await Promise.all([
      writeFile(join(root, "src/import.ts"), "export const imported = true;\n"),
      writeFile(join(root, "docs/plans/import/review.html"), "complete\n"),
    ]);

    expect(await validateFocusCompletion(
      focus,
      root,
      ["src/import.ts", "docs/plans/import/review.html"],
      [{ commandId: "CMD-UNIT", status: "failed", summary: "unit suite failed" }],
    )).toEqual({ ok: false, reason: "command_regressed" });
  });

  it("rejects completion with only the runtime-owned review change", async () => {
    const root = await repository();
    const focus = await acceptedContext(root);
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
      writeFile(join(root, ".bearing/focus/receipt.json"), JSON.stringify({ runtimeIdentity: begun.runtimeIdentity, artifacts: ["src/import.ts", "docs/plans/import/review.html"], evidence: passed })),
    ]);
    expect(await validateStandaloneFocus(root, begun.runId, ".bearing/focus/receipt.json")).toEqual({ ok: true, changedPaths: ["docs/plans/import/review.html", "src/import.ts"] });

    const secondRoot = await repository();
    await mkdir(join(secondRoot, ".bearing/focus"), { recursive: true });
    await writeFile(join(secondRoot, ".bearing/focus/request.json"), JSON.stringify({ role: "crewmate", objective: "Close GitHub issue #12", planDirectory: "docs/plans/import", slice: "1.1" }));
    const unauthorized = await beginStandaloneFocus(secondRoot, ".bearing/focus/request.json");
    if (!unauthorized.ok) throw new Error(unauthorized.reason);
    await writeFile(join(secondRoot, ".bearing/focus", `${unauthorized.runId}.json`), JSON.stringify({ githubIssueMutationAuthorized: true }));
    await writeFile(join(secondRoot, ".bearing/focus/receipt.json"), JSON.stringify({ runtimeIdentity: unauthorized.runtimeIdentity, artifacts: ["src/import.ts", "docs/plans/import/review.html"], evidence: passed, githubIssueMutation: true }));
    expect(await validateStandaloneFocus(secondRoot, unauthorized.runId, ".bearing/focus/receipt.json")).toEqual({ ok: false, reason: "authority_invalid" });
    expect(await validateStandaloneFocus(secondRoot, unauthorized.runId, ".bearing/focus/receipt.json")).toEqual({ ok: false, reason: "state_invalid" });
  });

  it("drives one bounded Focus run end to end through the generic MCP tools", async () => {
    const root = await repository();
    await mkdir(join(root, ".bearing/focus"), { recursive: true });
    await writeFile(join(root, ".bearing/focus/request.json"), JSON.stringify({ role: "crewmate", objective: "Import bounded data", planDirectory: "docs/plans/import", slice: "1.1" }));
    const dispatch = createDispatcher({
      headlessJourney: () => { throw new Error("a Focus tool must never reach the transition engine"); },
    });

    const begun = structured(await callTool(dispatch, "bearing_focus_begin", { repository: root, requestPath: ".bearing/focus/request.json" }));
    expect(begun.code).toBeUndefined();
    expect(begun.focusRunId).toMatch(/^v1\.\d{1,5}\.[0-9a-f]{64}$/);
    expect(begun.repository).toMatch(/^[0-9a-f]{16}$/);
    // The envelope is the same immutable contract the in-process Focus path derives.
    const direct = await createFocusContext({ root, planDirectory: "docs/plans/import", role: "crewmate", objective: "Import bounded data", currentSlice: "1.1" });
    expect(begun.envelope).toEqual(direct.ok ? direct.value.envelope : undefined);
    expect(JSON.stringify(begun.envelope)).not.toContain(root);

    await Promise.all([
      writeFile(join(root, "src/import.ts"), "export const imported = true;\n"),
      writeFile(join(root, "docs/plans/import/review.html"), completedReview),
      writeFile(join(root, ".bearing/focus/receipt.json"), JSON.stringify({ runtimeIdentity: begun.runtimeIdentity, artifacts: ["src/import.ts", "docs/plans/import/review.html"], evidence: passed })),
    ]);
    const validated = structured(await callTool(dispatch, "bearing_focus_validate", {
      repository: root,
      focusRunId: begun.focusRunId,
      receiptPath: ".bearing/focus/receipt.json",
    }));
    expect(validated).toMatchObject({ changedPaths: ["docs/plans/import/review.html", "src/import.ts"] });
    expect(validated.code).toBeUndefined();
    expect(JSON.stringify(validated)).not.toContain(root);
    // The guard is consumed: the same receipt cannot be validated twice.
    expect(structured(await callTool(dispatch, "bearing_focus_validate", {
      repository: root,
      focusRunId: begun.focusRunId,
      receiptPath: ".bearing/focus/receipt.json",
    }))).toMatchObject({ code: "state_invalid" });
  });

  it("refuses an uncontained repository, an escaping path, and a malformed request from the MCP boundary", async () => {
    const root = await repository();
    await mkdir(join(root, ".bearing/focus"), { recursive: true });
    await writeFile(join(root, ".bearing/focus/request.json"), JSON.stringify({ role: "crewmate", objective: "Import bounded data", planDirectory: "docs/plans/import", slice: "1.1" }));
    const outside = await mkdtemp(join(tmpdir(), "bearing-focus-outside-"));
    roots.push(outside);
    await writeFile(join(outside, "request.json"), JSON.stringify({ role: "crewmate", objective: "Escape", planDirectory: "docs/plans/import", slice: "1.1" }));
    await exec("ln", ["-s", join(outside, "request.json"), join(root, ".bearing/focus/linked.json")]);

    const refusals = [
      [{ repository: join(root, "src"), requestPath: ".bearing/focus/request.json" }, "repository_rejected"],
      [{ repository: `${root}/docs/..`, requestPath: ".bearing/focus/request.json" }, "repository_rejected"],
      [{ repository: "relative/path", requestPath: ".bearing/focus/request.json" }, "repository_rejected"],
      [{ repository: root, requestPath: "../request.json" }, "request_invalid"],
      [{ repository: root, requestPath: ".bearing/focus/linked.json" }, "request_invalid"],
      [{ repository: root, requestPath: ".bearing/focus/absent.json" }, "request_invalid"],
    ] as const;
    for (const [args, code] of refusals) {
      const body = structured(await callTool(createDispatcher(), "bearing_focus_begin", args));
      expect([args.requestPath, body]).toMatchObject([args.requestPath, { code }]);
      expect(JSON.stringify(body)).not.toContain(root);
    }
    // The refusals have to be able to pass, or none of them proves anything.
    expect(structured(await callTool(createDispatcher(), "bearing_focus_begin", { repository: root, requestPath: ".bearing/focus/request.json" })).code)
      .toBeUndefined();
  });

  it("accepts a corrected ignored canonical review against the same immutable Focus context", async () => {
    const root = await repository(true);
    await mkdir(join(root, ".bearing/focus"), { recursive: true });
    await writeFile(join(root, ".bearing/focus/request.json"), JSON.stringify({ role: "crewmate", objective: "Import bounded data", planDirectory: "docs/plans/import", slice: "1.1" }));
    const begun = await beginStandaloneFocus(root, ".bearing/focus/request.json");
    if (!begun.ok) throw new Error(begun.reason);
    await Promise.all([
      writeFile(join(root, "src/import.ts"), "export const imported = true;\n"),
      writeFile(join(root, "docs/plans/import/review.html"), "invalid review\n"),
      writeFile(join(root, ".bearing/focus/receipt.json"), JSON.stringify({ runtimeIdentity: begun.runtimeIdentity, artifacts: ["src/import.ts", "docs/plans/import/review.html"], evidence: passed })),
    ]);

    expect(await validateStandaloneFocus(root, begun.runId, ".bearing/focus/receipt.json")).toEqual({ ok: false, reason: "review_invalid" });
    await writeFile(join(root, "docs/plans/import/review.html"), completedReview);
    expect(await validateStandaloneFocus(root, begun.runId, ".bearing/focus/receipt.json")).toEqual({
      ok: true,
      changedPaths: ["docs/plans/import/review.html", "src/import.ts"],
    });
    expect(await validateStandaloneFocus(root, begun.runId, ".bearing/focus/receipt.json")).toEqual({ ok: false, reason: "state_invalid" });
  });

  it("fingerprints only the canonical ignored review when an omitted ignored sibling also changes", async () => {
    const root = await repository(true);
    await mkdir(join(root, ".bearing/focus"), { recursive: true });
    await writeFile(join(root, ".bearing/focus/request.json"), JSON.stringify({ role: "crewmate", objective: "Import bounded data", planDirectory: "docs/plans/import", slice: "1.1" }));
    const begun = await beginStandaloneFocus(root, ".bearing/focus/request.json");
    if (!begun.ok) throw new Error(begun.reason);
    await Promise.all([
      writeFile(join(root, "src/import.ts"), "export const imported = true;\n"),
      writeFile(join(root, "docs/plans/import/review.html"), completedReview),
      writeFile(join(root, "docs/plans/import/other.html"), "omitted ignored artifact\n"),
      writeFile(join(root, ".bearing/focus/receipt.json"), JSON.stringify({ runtimeIdentity: begun.runtimeIdentity, artifacts: ["src/import.ts", "docs/plans/import/review.html"], evidence: passed })),
    ]);

    expect(await validateStandaloneFocus(root, begun.runId, ".bearing/focus/receipt.json")).toEqual({
      ok: true,
      changedPaths: ["docs/plans/import/review.html", "src/import.ts"],
    });
  });

  it("rejects a declared ignored sibling outside the exact review allowance", async () => {
    const root = await repository(true);
    await mkdir(join(root, ".bearing/focus"), { recursive: true });
    await writeFile(join(root, ".bearing/focus/request.json"), JSON.stringify({ role: "crewmate", objective: "Import bounded data", planDirectory: "docs/plans/import", slice: "1.1" }));
    const begun = await beginStandaloneFocus(root, ".bearing/focus/request.json");
    if (!begun.ok) throw new Error(begun.reason);
    await Promise.all([
      writeFile(join(root, "src/import.ts"), "export const imported = true;\n"),
      writeFile(join(root, "docs/plans/import/review.html"), completedReview),
      writeFile(join(root, "docs/plans/import/other.html"), "undeclared ignored artifact\n"),
      writeFile(join(root, ".bearing/focus/receipt.json"), JSON.stringify({ runtimeIdentity: begun.runtimeIdentity, artifacts: ["src/import.ts", "docs/plans/import/review.html", "docs/plans/import/other.html"], evidence: passed })),
    ]);

    expect(await validateStandaloneFocus(root, begun.runId, ".bearing/focus/receipt.json")).toEqual({ ok: false, reason: "path_outside_write_set" });
  });

  it("issue 73: deterministic standalone Focus with valid plan under .bearing/focus/<plan>/ requires final-QA review declaration for execution; changed review admissible, omission fails", async () => {
    // Clause 1: declaring a genuinely changed review (fp delta) under .bearing plan dir is admissible.
    const changedRoot = await bearingPlanRepository();
    await mkdir(join(changedRoot, ".bearing/focus"), { recursive: true });
    await writeFile(join(changedRoot, ".bearing/focus/request.json"), JSON.stringify({
      role: "crewmate",
      objective: "Import bounded data",
      planDirectory: ".bearing/focus/s10-plan",
      slice: "1.1",
    }));
    const begunChanged = await beginStandaloneFocus(changedRoot, ".bearing/focus/request.json");
    expect(begunChanged.ok).toBe(true);
    if (!begunChanged.ok) throw new Error(begunChanged.reason);
    await Promise.all([
      writeFile(join(changedRoot, "src/import.ts"), "export const imported = true;\n"),
      writeFile(join(changedRoot, ".bearing/focus/s10-plan/review.html"), completedReview),
      writeFile(join(changedRoot, ".bearing/focus/receipt.json"), JSON.stringify({
        runtimeIdentity: begunChanged.runtimeIdentity,
        artifacts: ["src/import.ts", ".bearing/focus/s10-plan/review.html"],
        evidence: passed,
      })),
    ]);
    expect(await validateStandaloneFocus(changedRoot, begunChanged.runId, ".bearing/focus/receipt.json")).toEqual({
      ok: true,
      changedPaths: [".bearing/focus/s10-plan/review.html", "src/import.ts"],
    });

    // Clause 2: omitting the required final-QA review from receipt cannot PASS (pre-populated complete review under gitignored .bearing plan dir yields no fp delta, validateFocusCompletion would admit, but must reject).
    const omitRoot = await bearingPlanRepository();
    // Pre-write complete review so reviewBefore matches reviewAfter (unchanged during run).
    await writeFile(join(omitRoot, ".bearing/focus/s10-plan/review.html"), completedReview);
    await mkdir(join(omitRoot, ".bearing/focus"), { recursive: true });
    await writeFile(join(omitRoot, ".bearing/focus/request.json"), JSON.stringify({
      role: "crewmate",
      objective: "Import bounded data",
      planDirectory: ".bearing/focus/s10-plan",
      slice: "1.1",
    }));
    const begunOmit = await beginStandaloneFocus(omitRoot, ".bearing/focus/request.json");
    expect(begunOmit.ok).toBe(true);
    if (!begunOmit.ok) throw new Error(begunOmit.reason);
    await Promise.all([
      writeFile(join(omitRoot, "src/import.ts"), "export const imported = true;\n"),
      writeFile(join(omitRoot, ".bearing/focus/receipt.json"), JSON.stringify({
        runtimeIdentity: begunOmit.runtimeIdentity,
        artifacts: ["src/import.ts"],
        evidence: passed,
      })),
    ]);
    expect(await validateStandaloneFocus(omitRoot, begunOmit.runId, ".bearing/focus/receipt.json")).toEqual({ ok: false, reason: "artifact_missing" });
  });

  it("rejects direct Crewmate use without a bounded request and approved plan", async () => {
    const root = await repository();
    await mkdir(join(root, ".bearing/focus"), { recursive: true });
    await writeFile(join(root, ".bearing/focus/request.json"), JSON.stringify({ role: "crewmate", objective: "Do whatever is needed" }));
    expect(await beginStandaloneFocus(root, ".bearing/focus/request.json")).toEqual({ ok: false, reason: "request_invalid" });
  });

  it("carries a bounded typed parser rejection out of the standalone Focus guard", async () => {
    const root = await repository();
    await writeFile(join(root, "docs/plans/import/implementation.md"), implementation.replace("Import bounded data.", "x".repeat(513)));
    await mkdir(join(root, ".bearing/focus"), { recursive: true });
    await writeFile(join(root, ".bearing/focus/request.json"), JSON.stringify({
      role: "crewmate",
      objective: "Import bounded data",
      planDirectory: "docs/plans/import",
      slice: "1.1",
    }));
    const result = await beginStandaloneFocus(root, ".bearing/focus/request.json");
    expect(result).toEqual({
      ok: false,
      reason: "goal_too_long",
      sliceId: "1.1",
      field: "Goal",
      detail: "length=513 limit=512",
    });
    expect(Object.values(result).every((value) => typeof value !== "string" || value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value))).toBe(true);
  });

  it("expires an abandoned standalone focus guard", async () => {
    const root = await repository();
    await mkdir(join(root, ".bearing/focus"), { recursive: true });
    await writeFile(join(root, ".bearing/focus/request.json"), JSON.stringify({
      role: "crewmate",
      objective: "Import bounded data",
      planDirectory: "docs/plans/import",
      slice: "1.1",
    }));

    vi.useFakeTimers();
    let begun;
    try {
      begun = await beginStandaloneFocus(root, ".bearing/focus/request.json");
      expect(begun.ok).toBe(true);
      await vi.runAllTimersAsync();
    } finally {
      vi.useRealTimers();
    }
    if (!begun?.ok) throw new Error(begun?.reason ?? "focus guard did not begin");

    expect(await validateStandaloneFocus(root, begun.runId, ".bearing/focus/missing-receipt.json"))
      .toEqual({ ok: false, reason: "state_invalid" });
  });

  it("settles with a typed reason when the validation request times out", async () => {
    const root = await repository();
    let received!: () => void;
    const requestReceived = new Promise<void>((resolve) => { received = resolve; });
    const port = await listen(createServer(() => received()));

    const pending = validateStandaloneFocus(
      root,
      `v1.${port}.${"a".repeat(64)}`,
      "receipt.json",
      25,
    );
    await requestReceived;

    expect(await settleWithin(pending, 200)).toEqual({ ok: false, reason: "request_timeout" });
  });

  it("settles with a typed reason when the guard response is oversized", async () => {
    const root = await repository();
    const port = await listen(createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.write(Buffer.alloc(16 * 1024 + 1, "x"));
    }));

    expect(await settleWithin(
      validateStandaloneFocus(root, `v1.${port}.${"b".repeat(64)}`, "receipt.json"),
    )).toEqual({ ok: false, reason: "response_too_large" });
  });

  it("keeps the consume-on-success-or-terminal guard available after an unrelated loopback probe", async () => {
    const root = await repository();
    await mkdir(join(root, ".bearing/focus"), { recursive: true });
    await writeFile(join(root, ".bearing/focus/request.json"), JSON.stringify({
      role: "crewmate",
      objective: "Import bounded data",
      planDirectory: "docs/plans/import",
      slice: "1.1",
    }));
    const begun = await beginStandaloneFocus(root, ".bearing/focus/request.json");
    if (!begun.ok) throw new Error(begun.reason);
    const [, portText] = begun.runId.split(".");

    const probe = await loopbackRequest(Number(portText), "GET", "/probe");
    expect(probe.status).toBe(404);
    expect(JSON.parse(probe.body)).toEqual({ ok: false, reason: "state_invalid" });
    expect(await validateStandaloneFocus(root, begun.runId, ".bearing/focus/missing-receipt.json"))
      .toEqual({ ok: false, reason: "receipt_invalid" });
  });

  it("responds to an oversized matching request instead of dropping the connection", async () => {
    const root = await repository();
    await mkdir(join(root, ".bearing/focus"), { recursive: true });
    await writeFile(join(root, ".bearing/focus/request.json"), JSON.stringify({
      role: "crewmate",
      objective: "Import bounded data",
      planDirectory: "docs/plans/import",
      slice: "1.1",
    }));
    const begun = await beginStandaloneFocus(root, ".bearing/focus/request.json");
    if (!begun.ok) throw new Error(begun.reason);
    const [, portText, capability] = begun.runId.split(".");

    const response = await settleWithin(loopbackRequest(
      Number(portText),
      "POST",
      `/validate/${capability}`,
      "x".repeat(16 * 1024 + 1),
    ));
    expect(response).not.toBe("unsettled");
    expect(response).toEqual({
      status: 413,
      body: JSON.stringify({ ok: false, reason: "request_too_large" }),
    });

    // Invariant, not a regression guard: answering an oversized request must never
    // consume the guard before successful completion or terminal rejection. Today
    // the guard survives either way, because
    // `response.end`'s callback does not fire while the oversized body stays
    // unconsumed, so the scheduled `server.close()` never runs. Passing
    // `consume: false` states the intent explicitly instead of depending on that
    // stream timing, and this assertion locks the behaviour in if it ever changes.
    await new Promise((settle) => setTimeout(settle, 250));
    expect(await validateStandaloneFocus(root, begun.runId, ".bearing/focus/missing-receipt.json"))
      .toEqual({ ok: false, reason: "receipt_invalid" });
  });

  // A 400 is rejected before validateStored runs, so it spends no validation
  // attempt and must leave the consume-on-success-or-terminal guard intact,
  // exactly as 404 and 413 do.
  it.each([
    ["a body that does not parse", "{not json"],
    ["a body naming a different root", JSON.stringify({ root: "/elsewhere", receiptPath: "receipt.json" })],
    ["a body with no receiptPath", JSON.stringify({ root: "PLACEHOLDER_ROOT" })],
  ])("keeps the consume-on-success-or-terminal guard available after %s", async (_label, rawBody) => {
    const root = await repository();
    await mkdir(join(root, ".bearing/focus"), { recursive: true });
    await writeFile(join(root, ".bearing/focus/request.json"), JSON.stringify({
      role: "crewmate",
      objective: "Import bounded data",
      planDirectory: "docs/plans/import",
      slice: "1.1",
    }));
    const begun = await beginStandaloneFocus(root, ".bearing/focus/request.json");
    if (!begun.ok) throw new Error(begun.reason);
    const [, portText, capability] = begun.runId.split(".");

    const response = await settleWithin(loopbackRequest(
      Number(portText),
      "POST",
      `/validate/${capability}`,
      rawBody.replace("PLACEHOLDER_ROOT", await realpath(root)),
    ));
    expect(response).not.toBe("unsettled");
    expect(response).toEqual({
      status: 400,
      body: JSON.stringify({ ok: false, reason: "state_invalid" }),
    });

    // The guard survives, so a subsequent well-formed request still reaches
    // validation and fails on the receipt rather than on a closed server.
    await new Promise((settle) => setTimeout(settle, 250));
    expect(await validateStandaloneFocus(root, begun.runId, ".bearing/focus/missing-receipt.json"))
      .toEqual({ ok: false, reason: "receipt_invalid" });
  });
});

describe("Focus runtime provenance", () => {
  it("issue 74: a receipt bound to another runtime identity is refused with runtime_mismatch", async () => {
    const root = await repository();
    await mkdir(join(root, ".bearing/focus"), { recursive: true });
    await writeFile(join(root, ".bearing/focus/request.json"), JSON.stringify({
      role: "crewmate",
      objective: "Import bounded data",
      planDirectory: "docs/plans/import",
      slice: "1.1",
    }));
    const begun = await beginStandaloneFocus(root, ".bearing/focus/request.json");
    expect(begun.ok).toBe(true);
    if (!begun.ok) throw new Error(begun.reason);
    await Promise.all([
      writeFile(join(root, "src/import.ts"), "export const imported = true;\n"),
      writeFile(join(root, "docs/plans/import/review.html"), completedReview),
      writeFile(join(root, ".bearing/focus/receipt.json"), JSON.stringify({
        runtimeIdentity: "f".repeat(64),
        artifacts: ["src/import.ts", "docs/plans/import/review.html"],
        evidence: passed,
      })),
    ]);
    expect(await validateStandaloneFocus(root, begun.runId, ".bearing/focus/receipt.json"))
      .toEqual({ ok: false, reason: "runtime_mismatch" });
  });

  // Reviewer P3: prove the fail-closed comment on StandaloneFocusBegin rather
  // than assert it — a receipt omitting runtimeIdentity entirely never
  // validates, so an unbound guard cannot certify anything.
  it("issue 74: a receipt omitting runtimeIdentity is refused as receipt_invalid", async () => {
    const root = await repository();
    await mkdir(join(root, ".bearing/focus"), { recursive: true });
    await writeFile(join(root, ".bearing/focus/request.json"), JSON.stringify({
      role: "crewmate",
      objective: "Import bounded data",
      planDirectory: "docs/plans/import",
      slice: "1.1",
    }));
    const begun = await beginStandaloneFocus(root, ".bearing/focus/request.json");
    expect(begun.ok).toBe(true);
    if (!begun.ok) throw new Error(begun.reason);
    await Promise.all([
      writeFile(join(root, "src/import.ts"), "export const imported = true;\n"),
      writeFile(join(root, "docs/plans/import/review.html"), completedReview),
      writeFile(join(root, ".bearing/focus/receipt.json"), JSON.stringify({
        artifacts: ["src/import.ts", "docs/plans/import/review.html"],
        evidence: passed,
      })),
    ]);
    expect(await validateStandaloneFocus(root, begun.runId, ".bearing/focus/receipt.json"))
      .toEqual({ ok: false, reason: "receipt_invalid" });
  });

  it("issue 74: a matching runtime identity validates exactly as before (negative control)", async () => {
    const root = await repository();
    await mkdir(join(root, ".bearing/focus"), { recursive: true });
    await writeFile(join(root, ".bearing/focus/request.json"), JSON.stringify({
      role: "crewmate",
      objective: "Import bounded data",
      planDirectory: "docs/plans/import",
      slice: "1.1",
    }));
    const begun = await beginStandaloneFocus(root, ".bearing/focus/request.json");
    expect(begun.ok).toBe(true);
    if (!begun.ok) throw new Error(begun.reason);
    expect(begun.runtimeIdentity).toMatch(/^[0-9a-f]{64}$/);
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

  it("issue 64: a receipt with a well-formed taskOutcome validates; a malformed one is refused; omission still validates", async () => {
    const root = await repository();
    await mkdir(join(root, ".bearing/focus"), { recursive: true });
    await writeFile(join(root, ".bearing/focus/request.json"), JSON.stringify({
      role: "crewmate",
      objective: "Import bounded data",
      planDirectory: "docs/plans/import",
      slice: "1.1",
    }));
    const begun = await beginStandaloneFocus(root, ".bearing/focus/request.json");
    expect(begun.ok).toBe(true);
    if (!begun.ok) throw new Error(begun.reason);
    const base = {
      runtimeIdentity: begun.runtimeIdentity,
      artifacts: ["src/import.ts", "docs/plans/import/review.html"],
      evidence: passed,
    };
    // 1. A malformed taskOutcome is refused as receipt_invalid and stays correctable.
    await Promise.all([
      writeFile(join(root, "src/import.ts"), "export const imported = true;\n"),
      writeFile(join(root, "docs/plans/import/review.html"), completedReview),
      writeFile(join(root, ".bearing/focus/receipt.json"), JSON.stringify({ ...base, taskOutcome: { status: "sideways" } })),
    ]);
    expect(await validateStandaloneFocus(root, begun.runId, ".bearing/focus/receipt.json"))
      .toEqual({ ok: false, reason: "receipt_invalid" });
    // 2. The same run corrects to a well-formed taskOutcome and validates.
    await writeFile(join(root, ".bearing/focus/receipt.json"), JSON.stringify({
      ...base,
      taskOutcome: { status: "complete", changedPaths: ["src/import.ts"], attemptsUsed: 1 },
    }));
    expect(await validateStandaloneFocus(root, begun.runId, ".bearing/focus/receipt.json"))
      .toEqual({ ok: true, changedPaths: ["docs/plans/import/review.html", "src/import.ts"] });
    // 3. A receipt without taskOutcome still validates exactly as before.
    // Fresh repository: the earlier phases already changed src/import.ts in the
    // first working tree, and an unchanged artifact is itself a refusal.
    const freshRoot = await repository();
    await mkdir(join(freshRoot, ".bearing/focus"), { recursive: true });
    await writeFile(join(freshRoot, ".bearing/focus/request.json"), JSON.stringify({
      role: "crewmate",
      objective: "Import bounded data",
      planDirectory: "docs/plans/import",
      slice: "1.1",
    }));
    const second = await beginStandaloneFocus(freshRoot, ".bearing/focus/request.json");
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error(second.reason);
    await Promise.all([
      writeFile(join(freshRoot, "src/import.ts"), "export const imported = true;\n"),
      writeFile(join(freshRoot, "docs/plans/import/review.html"), completedReview),
      writeFile(join(freshRoot, ".bearing/focus/receipt.json"), JSON.stringify({
        runtimeIdentity: second.runtimeIdentity,
        artifacts: ["src/import.ts", "docs/plans/import/review.html"],
        evidence: passed,
      })),
    ]);
    expect(await validateStandaloneFocus(freshRoot, second.runId, ".bearing/focus/receipt.json"))
      .toEqual({ ok: true, changedPaths: ["docs/plans/import/review.html", "src/import.ts"] });
  });

  it("issue 74: a run begun under a stale guard is refused by the current runtime (stale guard)", async () => {
    const root = await repository();
    await mkdir(join(root, ".bearing/focus"), { recursive: true });
    await writeFile(join(root, ".bearing/focus/request.json"), JSON.stringify({
      role: "crewmate",
      objective: "Import bounded data",
      planDirectory: "docs/plans/import",
      slice: "1.1",
    }));
    const stale = "a".repeat(64);
    const fresh = "b".repeat(64);
    // The guard began under the stale runtime and reported its stale identity;
    // the agent bound the receipt to it, exactly as the begin response said.
    const begun = await beginStandaloneFocus(root, ".bearing/focus/request.json", () => stale);
    expect(begun.ok).toBe(true);
    if (!begun.ok) throw new Error(begun.reason);
    expect(begun.runtimeIdentity).toBe(stale);
    await Promise.all([
      writeFile(join(root, "src/import.ts"), "export const imported = true;\n"),
      writeFile(join(root, "docs/plans/import/review.html"), completedReview),
      writeFile(join(root, ".bearing/focus/receipt.json"), JSON.stringify({
        runtimeIdentity: stale,
        artifacts: ["src/import.ts", "docs/plans/import/review.html"],
        evidence: passed,
      })),
    ]);
    // The validating client runs the current runtime: refuse rather than certify under stale semantics.
    expect(await validateStandaloneFocus(root, begun.runId, ".bearing/focus/receipt.json", 10_000, () => fresh))
      .toEqual({ ok: false, reason: "runtime_mismatch" });
  });

  it("issue 74: the guard refuses a receipt claiming a different runtime even when the client matches it (client/guard mismatch)", async () => {
    const root = await repository();
    await mkdir(join(root, ".bearing/focus"), { recursive: true });
    await writeFile(join(root, ".bearing/focus/request.json"), JSON.stringify({
      role: "crewmate",
      objective: "Import bounded data",
      planDirectory: "docs/plans/import",
      slice: "1.1",
    }));
    const guardIdentity = "c".repeat(64);
    const clientIdentity = "d".repeat(64);
    const begun = await beginStandaloneFocus(root, ".bearing/focus/request.json", () => guardIdentity);
    expect(begun.ok).toBe(true);
    if (!begun.ok) throw new Error(begun.reason);
    await Promise.all([
      writeFile(join(root, "src/import.ts"), "export const imported = true;\n"),
      writeFile(join(root, "docs/plans/import/review.html"), completedReview),
      // The receipt claims the CLIENT's runtime, so the client-side gate passes;
      // only the guard's own gate can refuse it.
      writeFile(join(root, ".bearing/focus/receipt.json"), JSON.stringify({
        runtimeIdentity: clientIdentity,
        artifacts: ["src/import.ts", "docs/plans/import/review.html"],
        evidence: passed,
      })),
    ]);
    expect(await validateStandaloneFocus(root, begun.runId, ".bearing/focus/receipt.json", 10_000, () => clientIdentity))
      .toEqual({ ok: false, reason: "runtime_mismatch" });
    // The mismatch is a correctable receipt failure, not a terminal one: the guard
    // survives, and a corrected receipt bound to the guard's own identity validates.
    await writeFile(join(root, ".bearing/focus/receipt.json"), JSON.stringify({
      runtimeIdentity: guardIdentity,
      artifacts: ["src/import.ts", "docs/plans/import/review.html"],
      evidence: passed,
    }));
    expect(await validateStandaloneFocus(root, begun.runId, ".bearing/focus/receipt.json", 10_000, () => guardIdentity))
      .toEqual({ ok: true, changedPaths: ["docs/plans/import/review.html", "src/import.ts"] });
  });

  it("issue 74: the runtime identity is deterministic per build and differs across builds (source/dist)", async () => {
    // The same loaded modules always derive the same identity; no hand-maintained
    // version constant that can be forgotten when validation semantics change.
    expect(await defaultRuntimeIdentity()).toBe(await defaultRuntimeIdentity());
    // A receipt bound to one build's identity is refused by another build's runtime.
    const root = await repository();
    await mkdir(join(root, ".bearing/focus"), { recursive: true });
    await writeFile(join(root, ".bearing/focus/request.json"), JSON.stringify({
      role: "crewmate",
      objective: "Import bounded data",
      planDirectory: "docs/plans/import",
      slice: "1.1",
    }));
    const sourceBuild = "e".repeat(64);
    const distBuild = "f".repeat(64);
    const begun = await beginStandaloneFocus(root, ".bearing/focus/request.json", () => sourceBuild);
    expect(begun.ok).toBe(true);
    if (!begun.ok) throw new Error(begun.reason);
    await Promise.all([
      writeFile(join(root, "src/import.ts"), "export const imported = true;\n"),
      writeFile(join(root, "docs/plans/import/review.html"), completedReview),
      writeFile(join(root, ".bearing/focus/receipt.json"), JSON.stringify({
        runtimeIdentity: sourceBuild,
        artifacts: ["src/import.ts", "docs/plans/import/review.html"],
        evidence: passed,
      })),
    ]);
    expect(await validateStandaloneFocus(root, begun.runId, ".bearing/focus/receipt.json", 10_000, () => distBuild))
      .toEqual({ ok: false, reason: "runtime_mismatch" });
  });

  it("issue 74: the begin response exposes no capability or token material", async () => {
    const root = await repository();
    await mkdir(join(root, ".bearing/focus"), { recursive: true });
    await writeFile(join(root, ".bearing/focus/request.json"), JSON.stringify({
      role: "crewmate",
      objective: "Import bounded data",
      planDirectory: "docs/plans/import",
      slice: "1.1",
    }));
    const begun = await beginStandaloneFocus(root, ".bearing/focus/request.json");
    expect(begun.ok).toBe(true);
    if (!begun.ok) throw new Error(begun.reason);
    const capability = begun.runId.slice(begun.runId.lastIndexOf(".") + 1);
    expect(begun.runtimeIdentity).not.toBe(capability);
    expect(JSON.stringify({ runtimeIdentity: begun.runtimeIdentity, envelope: begun.envelope })).not.toContain(capability);
    // The receipt boundary rejects any extra secret-bearing key outright.
    await writeFile(join(root, ".bearing/focus/receipt.json"), JSON.stringify({
      runtimeIdentity: begun.runtimeIdentity,
      capability,
      artifacts: ["src/import.ts", "docs/plans/import/review.html"],
      evidence: passed,
    }));
    expect(await validateStandaloneFocus(root, begun.runId, ".bearing/focus/receipt.json"))
      .toEqual({ ok: false, reason: "receipt_invalid" });
  });

  it("issue 74: begin fails closed when the runtime identity cannot be derived", async () => {
    const root = await repository();
    await mkdir(join(root, ".bearing/focus"), { recursive: true });
    await writeFile(join(root, ".bearing/focus/request.json"), JSON.stringify({
      role: "crewmate",
      objective: "Import bounded data",
      planDirectory: "docs/plans/import",
      slice: "1.1",
    }));
    expect(await beginStandaloneFocus(root, ".bearing/focus/request.json", () => {
      throw new Error("validation modules unreadable");
    })).toEqual({ ok: false, reason: "state_invalid" });
  });
});

describe("Focus runtime repair lane", () => {
  // The approved repair-slice shape (issues 58/61): the write set is limited to
  // the Focus runtime modules and their tests. The repos below carry fake
  // runtime sources so the guard can recompute the produced runtime identity
  // from the repository working tree.
  const repairWriteSet = "`src/journey/focus-mode.ts` `test/focus-mode.test.ts` only.";
  const baselineRuntime = {
    "src/journey/standalone-focus.ts": "export const standaloneFocus = \"baseline\";\n",
    "src/journey/focus-mode.ts": "export const focusMode = \"baseline\";\n",
    "src/journey/planning-journey.ts": "export const planningJourney = \"baseline\";\n",
    "test/focus-mode.test.ts": "export const focusTests = \"baseline\";\n",
    "src/import.ts": "export const imported = false;\n",
  } as const;

  async function runtimeRepository(writeSet = repairWriteSet): Promise<{ root: string; completedReview: string }> {
    const root = await mkdtemp(join(tmpdir(), "bearing-focus-runtime-"));
    roots.push(root);
    await mkdir(join(root, "docs/plans/import"), { recursive: true });
    await mkdir(join(root, "src/journey"), { recursive: true });
    await mkdir(join(root, "test"), { recursive: true });
    const repairImplementation = implementation.replace("`src/import.ts` only.", writeSet);
    const repairSources: readonly [string, string][] = [["plan-spec.md", plan], ["design.md", design], ["seit.md", seit], ["implementation.md", repairImplementation]];
    await Promise.all([
      writeFile(join(root, "docs/plans/import/plan-spec.md"), plan),
      writeFile(join(root, "docs/plans/import/design.md"), design),
      writeFile(join(root, "docs/plans/import/seit.md"), seit),
      writeFile(join(root, "docs/plans/import/implementation.md"), repairImplementation),
      writeFile(join(root, "docs/plans/import/review.html"), renderPlanningReview(repairSources)),
      ...Object.entries(baselineRuntime).map(([path, content]) => writeFile(join(root, path), content)),
    ]);
    await exec("git", ["init", "-q"], { cwd: root });
    await exec("git", ["config", "user.email", "bearing@example.invalid"], { cwd: root });
    await exec("git", ["config", "user.name", "Bearing Test"], { cwd: root });
    await exec("git", ["add", "."], { cwd: root });
    await exec("git", ["commit", "-qm", "baseline"], { cwd: root });
    // The completed final-QA section must be rendered from the repair sources:
    // the review validator requires the review to start with the exact render
    // of the current plan sources, so a review built from the default
    // implementation.md would be review_invalid.
    return {
      root,
      completedReview: renderPlanningReview(repairSources).replace(pending, '<section id="bearing-final-qa" data-status="complete"><h2>Actual implementation and QA</h2><p>Planned versus actual: src/journey/focus-mode.ts changed exactly as planned.</p><p>Validation evidence: CMD-UNIT passed.</p></section>'),
    };
  }

  async function repairRequest(root: string): Promise<void> {
    await mkdir(join(root, ".bearing/focus"), { recursive: true });
    await writeFile(join(root, ".bearing/focus/request.json"), JSON.stringify({
      role: "crewmate",
      objective: "Repair the Focus validator",
      planDirectory: "docs/plans/import",
      slice: "1.1",
    }));
  }

  it("issue 61: a declared Focus-runtime repair slice validates in the same run bound to the runtime it produced", async () => {
    const { root, completedReview } = await runtimeRepository();
    await repairRequest(root);
    const begun = await beginStandaloneFocus(root, ".bearing/focus/request.json", () => "a".repeat(64));
    expect(begun.ok).toBe(true);
    if (!begun.ok) throw new Error(begun.reason);
    await Promise.all([
      writeFile(join(root, "src/journey/focus-mode.ts"), "export const focusMode = \"repaired\";\n"),
      writeFile(join(root, "test/focus-mode.test.ts"), "export const focusTests = \"repaired\";\n"),
      writeFile(join(root, "docs/plans/import/review.html"), completedReview),
    ]);
    const produced = await sourceRuntimeIdentity(root);
    if (!produced) throw new Error("produced runtime identity unreadable");
    // The receipt is bound to the repaired runtime — the exact bytes the slice
    // produced — not to the immutable identity the guard began with.
    expect(produced).toMatch(/^[0-9a-f]{64}$/);
    expect(produced).not.toBe(begun.runtimeIdentity);
    await writeFile(join(root, ".bearing/focus/receipt.json"), JSON.stringify({
      runtimeIdentity: produced,
      artifacts: ["src/journey/focus-mode.ts", "test/focus-mode.test.ts", "docs/plans/import/review.html"],
      evidence: passed,
    }));
    expect(await validateStandaloneFocus(root, begun.runId, ".bearing/focus/receipt.json")).toEqual({
      ok: true,
      changedPaths: ["docs/plans/import/review.html", "src/journey/focus-mode.ts", "test/focus-mode.test.ts"],
    });
  });

  it("issue 61: an undeclared slice bound to the on-disk runtime is still refused with runtime_mismatch", async () => {
    // The write set adds a product path, so the run is an ordinary slice even
    // though its receipt is bound to the exact runtime hash on disk.
    const { root, completedReview } = await runtimeRepository("`src/journey/focus-mode.ts` `src/import.ts` only.");
    await repairRequest(root);
    const begun = await beginStandaloneFocus(root, ".bearing/focus/request.json", () => "a".repeat(64));
    expect(begun.ok).toBe(true);
    if (!begun.ok) throw new Error(begun.reason);
    await Promise.all([
      writeFile(join(root, "src/journey/focus-mode.ts"), "export const focusMode = \"repaired\";\n"),
      writeFile(join(root, "src/import.ts"), "export const imported = true;\n"),
      writeFile(join(root, "docs/plans/import/review.html"), completedReview),
    ]);
    const produced = await sourceRuntimeIdentity(root);
    if (!produced) throw new Error("produced runtime identity unreadable");
    await writeFile(join(root, ".bearing/focus/receipt.json"), JSON.stringify({
      runtimeIdentity: produced,
      artifacts: ["src/journey/focus-mode.ts", "src/import.ts", "docs/plans/import/review.html"],
      evidence: passed,
    }));
    expect(await validateStandaloneFocus(root, begun.runId, ".bearing/focus/receipt.json"))
      .toEqual({ ok: false, reason: "runtime_mismatch" });
  });

  it("issue 61: a declared write set of only test paths does not get the repair lane", async () => {
    // The write set reaches no Focus runtime module, so the identity exception
    // must not apply even though every path sits inside the repair paths list.
    const { root, completedReview } = await runtimeRepository("`test/focus-mode.test.ts` only.");
    await repairRequest(root);
    const begun = await beginStandaloneFocus(root, ".bearing/focus/request.json", () => "a".repeat(64));
    expect(begun.ok).toBe(true);
    if (!begun.ok) throw new Error(begun.reason);
    await Promise.all([
      writeFile(join(root, "test/focus-mode.test.ts"), "export const focusTests = \"repaired\";\n"),
      writeFile(join(root, "docs/plans/import/review.html"), completedReview),
    ]);
    const produced = await sourceRuntimeIdentity(root);
    if (!produced) throw new Error("produced runtime identity unreadable");
    await writeFile(join(root, ".bearing/focus/receipt.json"), JSON.stringify({
      runtimeIdentity: produced,
      artifacts: ["test/focus-mode.test.ts", "docs/plans/import/review.html"],
      evidence: passed,
    }));
    expect(await validateStandaloneFocus(root, begun.runId, ".bearing/focus/receipt.json"))
      .toEqual({ ok: false, reason: "runtime_mismatch" });
  });

  it("issue 61: a declared repair slice whose receipt identity is not the produced runtime fails typed and stays correctable", async () => {
    const { root, completedReview } = await runtimeRepository();
    await repairRequest(root);
    const begun = await beginStandaloneFocus(root, ".bearing/focus/request.json", () => "a".repeat(64));
    expect(begun.ok).toBe(true);
    if (!begun.ok) throw new Error(begun.reason);
    await Promise.all([
      writeFile(join(root, "src/journey/focus-mode.ts"), "export const focusMode = \"repaired\";\n"),
      writeFile(join(root, "test/focus-mode.test.ts"), "export const focusTests = \"repaired\";\n"),
      writeFile(join(root, "docs/plans/import/review.html"), completedReview),
    ]);
    const produced = await sourceRuntimeIdentity(root);
    if (!produced) throw new Error("produced runtime identity unreadable");
    const artifacts = ["src/journey/focus-mode.ts", "test/focus-mode.test.ts", "docs/plans/import/review.html"];
    // The receipt claims a runtime the run never produced — the bytes on disk
    // do not hash to this identity.
    await writeFile(join(root, ".bearing/focus/receipt.json"), JSON.stringify({
      runtimeIdentity: "b".repeat(64),
      artifacts,
      evidence: passed,
    }));
    expect(await validateStandaloneFocus(root, begun.runId, ".bearing/focus/receipt.json"))
      .toEqual({ ok: false, reason: "runtime_mismatch" });
    // The guard itself refuses too, even when the client-side gate is bypassed
    // with a direct loopback request, and the refusal consumes nothing.
    const [, portText, capability] = begun.runId.split(".");
    const direct = await settleWithin(loopbackRequest(
      Number(portText),
      "POST",
      `/validate/${capability}`,
      JSON.stringify({ root: await realpath(root), receiptPath: ".bearing/focus/receipt.json" }),
    ));
    expect(direct).toEqual({ status: 409, body: JSON.stringify({ ok: false, reason: "runtime_mismatch" }) });
    // The refusal is a correctable receipt failure: a corrected receipt bound
    // to the produced runtime validates in the same run — no replacement journey.
    await writeFile(join(root, ".bearing/focus/receipt.json"), JSON.stringify({
      runtimeIdentity: produced,
      artifacts,
      evidence: passed,
    }));
    expect(await validateStandaloneFocus(root, begun.runId, ".bearing/focus/receipt.json")).toEqual({
      ok: true,
      changedPaths: ["docs/plans/import/review.html", "src/journey/focus-mode.ts", "test/focus-mode.test.ts"],
    });
  });
});

describe("snapshotGitState", () => {
  it("succeeds when the working tree contains an empty untracked directory", async () => {
    const root = await repository();
    // Git reports an empty untracked directory as `dir/`; it must not fail the snapshot closed.
    await mkdir(join(root, "scratch-empty"), { recursive: true });
    const snapshot = await snapshotGitState(root);
    expect(snapshot).toBeDefined();
    expect([...(snapshot?.paths.keys() ?? [])].some((path) => path.endsWith("/"))).toBe(false);
  });

  it("excludes untracked Bearing state in visible bearing-<plan>/ workspaces, but not look-alike dirs", async () => {
    const root = await repository();
    const ledger = join(root, "bearing-alpha", "runs", "run-1");
    // A bare-prefix directory fails the workspace name grammar; it is not Bearing state.
    const lookAlike = join(root, "bearing-", "runs", "run-9");
    await mkdir(ledger, { recursive: true });
    await mkdir(lookAlike, { recursive: true });
    await Promise.all([
      writeFile(join(ledger, "events.jsonl"), "not-json\n"),
      // Untracked files inside the workspace root are still Bearing-owned.
      writeFile(join(root, "bearing-alpha", "manifest.json"), "{}\n"),
      writeFile(join(lookAlike, "events.jsonl"), "not-json\n"),
    ]);
    const before = await snapshotGitState(root);
    if (!before) throw new Error("before snapshot failed");
    // Bearing's own ledger churn plus an unplanned write in the look-alike dir.
    await Promise.all([
      writeFile(join(ledger, "events.jsonl"), "changed\n"),
      writeFile(join(lookAlike, "events.jsonl"), "changed\n"),
    ]);
    const after = await snapshotGitState(root, before.head);
    if (!after) throw new Error("after snapshot failed");
    const changed = [...new Set([...before.paths.keys(), ...after.paths.keys(), ...after.committedPaths])]
      .filter((path) => after.committedPaths.has(path) || before.paths.get(path) !== after.paths.get(path));
    // Bearing's own ledger churn must be invisible; the look-alike dir must still fail closed.
    expect(changed).toEqual(["bearing-/runs/run-9/events.jsonl"]);
  });
});
