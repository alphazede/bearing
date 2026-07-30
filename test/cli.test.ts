import { afterEach, describe, expect, it } from "vitest";
import { get } from "node:http";
import type { Server } from "node:http";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ImprovementCliReport, LauncherDeps } from "../src/cli.js";
import { defaultOpenBrowser, isDirectInvocation, parseFocusArgs, parseImproveArgs, parseJourneyArgs, parseStartArgs, run } from "../src/cli.js";
import { executeHeadlessJourney } from "../src/server/local-session.js";
import type { ProcessRunner } from "../src/adapters/adapters.js";
import { BearingStore } from "../src/store/bearing-store.js";
import { currentPlanningVerdict } from "../src/journey/planning-journey.js";

function newCtx() {
  const out: string[] = [];
  const err: string[] = [];
  const opened: string[] = [];
  const state: { exitCode?: number } = {};
  const d: LauncherDeps = {
    openBrowser: (url: string) => {
      opened.push(url);
    },
    stdout: { write: (s: string) => { out.push(s); return true; } },
    stderr: { write: (s: string) => { err.push(s); return true; } },
    exit: (code: number) => {
      state.exitCode = code;
    },
    improvement: {
      report: async () => ({ ok: false, reason: "stage_failed" }),
      export: async () => ({ ok: false, reason: "export_failed" }),
    },
    workspace: {},
  };
  return { d, out, err, opened, getExitCode: () => state.exitCode };
}

const servers: Server[] = [];
const roots: string[] = [];
const validPlan = "---\ntype: plan-spec\nstatus: complete\n---\n\n## Acceptance criteria\n\n- **AC-1** — Bounded account data is imported.\n\n## Risks and open questions\n\n- **RISK-1** — Invalid input must fail closed.\n\n## Entry criteria\n\nApproved scope.\n\n## Exit criteria\n\nAll evidence passes.\n\n## Rollback or repair\n\nRepair the bounded slice.\n\n## Accountable controller\n\nNavigator.\n";
const validDesign = "---\ntype: design\nstatus: complete\n---\n\n## Use Cases and Communication Flows\n\nComplete flow.\n\n## Interface Option Check\n\ninterface_options: not needed - fixture\n\n## OOPDSA Implementation Design\n\n- **DES-1** — Use the existing import boundary.\n- **CONTRACT-1** — Reject invalid input without writes.\n";
const validSeit = "---\ntype: seit\nstatus: complete\n---\n\n## Required Commands\n\n- **CMD-UNIT** — `pnpm test`\n\n## Traceability Matrix\n\n| SEIT row ID | Acceptance/risk ID | Design/contract ID | Boundary/test layer | Positive case | Negative/failure case | Command/procedure ID | Evidence |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n| SEIT-1 | AC-1 | DES-1, CONTRACT-1 | unit | valid input imports | invalid input fails closed | CMD-UNIT | test report |\n| SEIT-2 | RISK-1 | CONTRACT-1 | unit | bounded input remains valid | invalid input is rejected | CMD-UNIT | test report |\n\n## Cross-cutting Checks\n\nComplete checks.\n";
const validImplementation = "---\ntype: implementation\nstatus: complete\n---\n\n# Implementation\n\n## Phase 1 — Build\n\n### Slice 1.1 — Import\n\n**Goal.** Import bounded account data.\n\n**Requirement IDs.** AC-1\n\n**Design IDs.** DES-1, CONTRACT-1\n\n**SEIT proof rows.** SEIT-1\n\n**Type.** /tdd\n\n**Design lenses.** CDD\n\n**Implementation role.** Backend Engineer\n\n**Agent model route.** Codex agent default\n\n**Agent reasoning level.** medium.\n\n**Ponytail mode.** full\n\n**Review path.** native review\n\n### 1.1 execution manifest\n\n**Write set.** `src/import.ts` only.\n\n**Command IDs.** CMD-UNIT\n\n**Stop condition.** Stop if focused validation fails.\n\n**Human decision.** None.\n";

async function writePlan(root: string, implementation = validImplementation, plan = validPlan, directory = "docs/plans/import"): Promise<string> {
  const target = join(root, directory);
  await mkdir(target, { recursive: true });
  await Promise.all([
    writeFile(join(target, "plan-spec.md"), plan),
    writeFile(join(target, "design.md"), validDesign),
    writeFile(join(target, "seit.md"), validSeit),
    writeFile(join(target, "implementation.md"), implementation),
  ]);
  return target;
}

async function seedPlanReviewBoundary(root: string, runId: string, directory = "docs/plans/headless-review"): Promise<BearingStore> {
  await writePlan(root, validImplementation, validPlan, directory);
  const verdict = await currentPlanningVerdict(root, directory);
  if (!verdict || verdict.verdict !== "PASS") throw new Error("valid plan-review fixture did not pass");
  const store = new BearingStore(root);
  const fit = { outcome: "confirmed" as const, planDirectory: directory, repository: root, decidedAt: "2026-07-29T00:00:00.000Z" };
  let current = await store.load(runId);
  const gathered = await store.apply({
    schemaVersion: 1, commandId: `${runId}-gathered`, correlationId: `${runId}-gathered`, runId, expectedRevision: current.revision,
    session: { sessionId: "bearing", actor: "bearing" }, type: "recordJourneyCheckpoint",
    payload: {
      stage: "gather-supplies", status: "waiting", artifacts: [], qaJson: "[]", planDirectory: directory, resolvedPlanDirectory: directory,
      repositoryFitDecision: fit, planningState: "REQUIREMENTS_READY",
      selectionProvider: "codex", selectionModel: "gpt-5.6-terra", selectionReasoning: "medium",
    },
  });
  if (!gathered.ok) throw new Error(gathered.reason);
  current = await store.load(runId);
  const mapped = await store.apply({
    schemaVersion: 1, commandId: `${runId}-mapped`, correlationId: `${runId}-mapped`, runId, expectedRevision: current.revision,
    session: { sessionId: "bearing", actor: "bearing" }, type: "recordJourneyCheckpoint",
    payload: {
      stage: "map-route", status: "waiting", artifacts: [], qaJson: "[]", planDirectory: directory, resolvedPlanDirectory: directory,
      repositoryFitDecision: fit, planningState: "ARCHITECTURE_READY",
      selectionProvider: "codex", selectionModel: "gpt-5.6-terra", selectionReasoning: "medium",
    },
  });
  if (!mapped.ok) throw new Error(mapped.reason);
  current = await store.load(runId);
  const validation = { ...verdict, currentContentHash: verdict.checkedContentHash };
  const lastResult = {
    status: "action", summary: "Implementation route is ready for owner review.", artifacts: [
      `${directory}/plan-spec.md`, `${directory}/design.md`, `${directory}/seit.md`, `${directory}/implementation.md`,
    ], tokens: 1, planningReview: { phases: 1, slices: 1, assignments: [] }, planningValidation: validation,
  };
  const drafted = await store.apply({
    schemaVersion: 1, commandId: `${runId}-drafted`, correlationId: `${runId}-drafted`, runId, expectedRevision: current.revision,
    session: { sessionId: "bearing", actor: "bearing" }, type: "recordJourneyCheckpoint",
    payload: {
      stage: "draft-implementation", status: "waiting", artifacts: lastResult.artifacts, qaJson: "[]", planDirectory: directory, resolvedPlanDirectory: directory,
      repositoryFitDecision: fit, reviewBaselineRevision: current.revision, lastResultJson: JSON.stringify(lastResult), planningState: "PLANNING_VALIDATED",
      selectionProvider: "codex", selectionModel: "gpt-5.6-terra", selectionReasoning: "medium",
    },
  });
  if (!drafted.ok) throw new Error(drafted.reason);
  return store;
}

async function planTree(directory: string): Promise<readonly string[]> {
  return Promise.all((await readdir(directory)).sort().map(async (name) =>
    `${name}:${(await readFile(join(directory, name))).toString("base64")}`));
}

async function seedSettledImprovementRun(root: string, runId = "improvement-run"): Promise<void> {
  const store = new BearingStore(root);
  const created = await store.apply({
    schemaVersion: 1,
    commandId: `${runId}-create`,
    runId,
    expectedRevision: 0,
    type: "createWorkRequest",
    payload: { title: "Improvement evidence", goal: "Measure a settled run" },
    session: { sessionId: "test-owner", actor: "owner" },
    correlationId: `${runId}-create`,
  });
  if (!created.ok) throw new Error(created.reason);
  const completed = await store.apply({
    schemaVersion: 1,
    commandId: `${runId}-complete`,
    runId,
    expectedRevision: created.state.revision,
    type: "recordJourneyCheckpoint",
    payload: { stage: "review", status: "complete", artifacts: [] },
    session: { sessionId: "test-bearing", actor: "bearing" },
    correlationId: `${runId}-complete`,
  });
  if (!completed.ok) throw new Error(completed.reason);
}

afterEach(async () => {
  while (servers.length) {
    const s = servers.pop()!;
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("direct invocation", () => {
  it("recognizes a symlinked executable target but not an unrelated path", async () => {
    const root = await mkdtemp(join(tmpdir(), "bearing-cli-"));
    roots.push(root);
    const executable = join(root, "bearing");
    await symlink(fileURLToPath(new URL("../src/cli.ts", import.meta.url)), executable);

    expect(isDirectInvocation(executable)).toBe(true);
    expect(isDirectInvocation(fileURLToPath(import.meta.url))).toBe(false);
  });
});

describe("parseStartArgs", () => {
  it("accepts `start`", () => {
    expect(parseStartArgs(["start"])).toEqual({ ok: true, detach: false, noOpen: false, overrides: {} });
  });

  it("accepts `start --no-open`", () => {
    expect(parseStartArgs(["start", "--no-open"])).toEqual({ ok: true, detach: false, noOpen: true, overrides: {} });
  });

  it("accepts `start --detach`", () => {
    expect(parseStartArgs(["start", "--detach"])).toEqual({ ok: true, detach: true, noOpen: false, overrides: {} });
  });

  it("parses every approved shared override in spaced and equals forms", () => {
    expect(parseStartArgs(["start", "--agent", "bear", "--provider=codex", "--model", "gpt-5.6-sol", "--reasoning=medium", "--tools", "read,search", "--exclude-tools=write", "--no-session", "--offline", "--timeout=600000", "--max-turns", "7", "--budget=900"])).toEqual({
      ok: true,
      detach: false,
      noOpen: false,
      overrides: { agentRef: "bear", provider: "codex", model: "gpt-5.6-sol", reasoning: "medium", tools: ["read", "search"], excludedTools: ["write"], noSession: true, offline: true, timeoutMs: 600000, maxTurns: 7, budget: { tokens: 900 } },
    });
  });

  it("accepts only approved decision depths", () => {
    expect(parseStartArgs(["start", "--decision-depth", "deep"])).toMatchObject({ ok: true, overrides: { decisionDepth: "deep" } });
    expect(parseStartArgs(["start", "--decision-depth", "medium"]).ok).toBe(false);
  });

  it.each([
    ["minimal", "minimal"], ["low", "low"], ["medium", "medium"], ["high", "high"], ["very-high", "very-high"], ["max", "max"],
    ["off", "minimal"], ["none", "minimal"], ["default", "medium"], ["xhigh", "very-high"], ["ultra", "max"], ["thinking", "very-high"],
  ])("normalizes reasoning override %s to the abstract %s tier", (input, tier) => {
    expect(parseStartArgs(["start", "--reasoning", input])).toMatchObject({ ok: true, overrides: { reasoning: tier } });
  });

  it("accepts an optional safe-integer budget and rejects unsafe values", () => {
    expect(parseStartArgs(["start", "--budget", "9007199254740991"])).toMatchObject({ ok: true, overrides: { budget: { tokens: Number.MAX_SAFE_INTEGER } } });
    expect(parseStartArgs(["start", "--budget", "9007199254740992"]).ok).toBe(false);
  });

  it("rejects duplicate, credential, per-role, malformed, and unsafe overrides", () => {
    for (const args of [
      ["start", "--model", "a", "--model=b"],
      ["start", "--api-key", "secret"],
      ["start", "--model", "navigator=one"],
      ["start", "--tools", "read,,write"],
      ["start", "--exclude-tools", "read,read"],
      ["start", "--tools", "read,write", "--exclude-tools", "write"],
      ["start", "--reasoning", "maximum"],
      ["start", "--timeout", "0"],
      ["start", "--timeout", "2100001"],
      ["start", "--max-turns=-1"],
      ["start", "--budget", "9007199254740992"],
      ["start", "--provider"],
      ["start", "--offline=true"],
      ["start", "--agent", "x".repeat(257)],
    ]) expect(parseStartArgs(args).ok).toBe(false);
  });

  it("rejects an unknown command", () => {
    expect(parseStartArgs(["bogus"]).ok).toBe(false);
  });

  it("rejects an unknown flag", () => {
    expect(parseStartArgs(["start", "--evil"]).ok).toBe(false);
  });

  it("rejects empty input", () => {
    expect(parseStartArgs([]).ok).toBe(false);
  });
});

describe("parseFocusArgs", () => {
  it("accepts only bounded begin and validate forms", () => {
    expect(parseFocusArgs(["focus", "begin", "--request", ".bearing/focus/request.json"])).toEqual({ ok: true, action: "begin", requestPath: ".bearing/focus/request.json" });
    expect(parseFocusArgs(["focus", "validate", "--run", "019f8d4e-a637-7e71-8c76-af9d7ec91adf", "--receipt", ".bearing/focus/receipt.json"])).toEqual({ ok: true, action: "validate", runId: "019f8d4e-a637-7e71-8c76-af9d7ec91adf", receiptPath: ".bearing/focus/receipt.json" });
    for (const args of [
      ["focus", "begin"],
      ["focus", "begin", "--request", "a", "--request", "b"],
      ["focus", "validate", "--receipt", "a"],
      ["focus", "delete", "--run", "x"],
    ]) expect(parseFocusArgs(args)).toEqual({ ok: false });
  });
});

describe("headless journey commands", () => {
  const route = ["--repo", "/tmp/bearing-cli-repository", "--provider", "codex", "--model", "gpt-5.6-terra", "--reasoning", "medium"];

  it("accepts the documented authenticated transition subcommands only", () => {
    expect(parseJourneyArgs(["journey", "create", ...route, "--run", "journey_1", "--goal", "Ship the bounded repair"])).toMatchObject({ ok: true, action: "create", runId: "journey_1" });
    expect(parseJourneyArgs(["journey", "resume", ...route, "--run", "journey_1"])).toMatchObject({ ok: true, action: "resume", runId: "journey_1" });
    expect(parseJourneyArgs(["journey", "status", ...route, "--run", "journey_1"])).toMatchObject({ ok: true, action: "status", runId: "journey_1" });
    expect(parseJourneyArgs(["journey", "decide", ...route, "--run", "journey_1", "--answer", "Use the existing contract"])).toMatchObject({ ok: true, action: "decide" });
    expect(parseJourneyArgs(["journey", "approve-route", ...route, "--run", "journey_1"])).toMatchObject({ ok: true, action: "approve-route" });
    expect(parseJourneyArgs(["journey", "select-explorer", ...route, "--run", "journey_1", "--review-cadence", "slice"])).toMatchObject({ ok: true, action: "select-explorer" });
    expect(parseJourneyArgs(["journey", "progress", ...route, "--run", "journey_1", "--stage", "gather-supplies"])).toMatchObject({ ok: true, action: "progress", stage: "gather-supplies" });
    for (const args of [
      ["journey", "create", ...route, "--run", "journey_1"],
      ["journey", "progress", ...route, "--run", "journey_1", "--stage", "not-a-stage"],
      ["journey", "status", ...route, "--run", "journey_1", "--answer", "nope"],
      ["journey", "decide", ...route, "--run", "journey_1", "--answer", "  "],
      ["journey", "unknown", ...route, "--run", "journey_1"],
    ]) expect(parseJourneyArgs(args).ok).toBe(false);
  });

  it.each([
    ["create", ["journey", "create", ...route, "--run", "journey_1", "--goal", "Ship the bounded repair"]],
    ["resume", ["journey", "resume", ...route, "--run", "journey_1"]],
    ["status", ["journey", "status", ...route, "--run", "journey_1"]],
    ["decide", ["journey", "decide", ...route, "--run", "journey_1", "--answer", "Use the existing contract"]],
    ["approve-route", ["journey", "approve-route", ...route, "--run", "journey_1"]],
    ["select-explorer", ["journey", "select-explorer", ...route, "--run", "journey_1", "--review-cadence", "slice"]],
    ["progress", ["journey", "progress", ...route, "--run", "journey_1", "--stage", "gather-supplies"]],
  ] as const)("dispatches %s through the local-session seam and emits one success receipt", async (action, args) => {
    const ctx = newCtx();
    const calls: unknown[] = [];
    await run([...args], {
      ...ctx.d,
      headlessJourney: async (request) => {
        calls.push(request);
        return { ok: true, runId: request.runId, revision: 3, stage: "gather-supplies", status: "waiting", allowedActions: ["status", "progress"] };
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ action, runId: "journey_1" });
    expect(ctx.getExitCode()).toBeUndefined();
    expect(ctx.out).toHaveLength(1);
    expect(JSON.parse(ctx.out[0]!)).toEqual({ ok: true, runId: "journey_1", revision: 3, stage: "gather-supplies", status: "waiting", allowedActions: ["status", "progress"] });
    expect(ctx.err).toEqual([]);
  });

  it("writes exactly one stable receipt and preserves a rejected journey", async () => {
    const ctx = newCtx();
    let revision = 4;
    const calls: unknown[] = [];
    await run(["journey", "progress", ...route, "--run", "journey_1", "--stage", "execute-explorer"], {
      ...ctx.d,
      headlessJourney: async (request) => {
        calls.push(request);
        return { ok: false, code: "illegal_transition", runId: request.runId, revision };
      },
    });
    expect(calls).toHaveLength(1);
    expect(revision).toBe(4);
    expect(ctx.getExitCode()).toBe(1);
    expect(ctx.err).toEqual([]);
    expect(ctx.out).toHaveLength(1);
    expect(JSON.parse(ctx.out[0]!)).toEqual({ ok: false, code: "illegal_transition", runId: "journey_1", revision: 4 });
  });

  it("returns usage and exit code two without calling the transition layer for malformed input", async () => {
    const ctx = newCtx();
    let called = false;
    await run(["journey", "progress", "--repo", "/tmp/bearing-cli-repository", "--run", "journey_1", "--stage", "invalid"], {
      ...ctx.d,
      headlessJourney: async () => {
        called = true;
        return { ok: true, runId: "journey_1", revision: 0, stage: "repository-fit", allowedActions: [] };
      },
    });
    expect(called).toBe(false);
    expect(ctx.getExitCode()).toBe(2);
    expect(ctx.out).toEqual([]);
    expect(ctx.err.join("")).toContain("bearing journey create");
  });

  it("uses the authenticated local-session layer for creation and rejects an out-of-order stage without a durable mutation", async () => {
    const root = await mkdtemp(join(tmpdir(), "bearing-headless-"));
    roots.push(root);
    await mkdir(join(root, ".git"));
    const runner: ProcessRunner = {
      executableAvailable: () => true,
      verify: async () => true,
      run: async () => ({
        exitCode: 0,
        events: [{ type: "completed", data: { content: 'BEARING_RESULT {"kind":"action","summary":"Ready.","artifacts":[]}' } }],
        usage: { tokens: 1 },
      }),
    };
    const base = { repository: root, provider: "codex", model: "gpt-5.6-terra", reasoning: "medium", runId: "headless_1" } as const;
    const created = await executeHeadlessJourney({ action: "create", ...base, goal: "Prove the local-session transition boundary." }, { processRunner: runner });
    expect(created).toMatchObject({ ok: true, runId: "headless_1" });
    expect(JSON.stringify(created)).not.toContain(root);
    const before = new BearingStore(root);
    const revision = (await before.load("headless_1")).revision;
    const rejected = await executeHeadlessJourney({ action: "progress", ...base, stage: "execute-explorer" }, { processRunner: runner });
    expect(rejected).toEqual({ ok: false, code: "illegal_transition", runId: "headless_1", revision });
    expect((await before.load("headless_1")).revision).toBe(revision);
  });

  it("records a headless owner answer and advances the durable waiting stage without repeating its question", async () => {
    const root = await mkdtemp(join(tmpdir(), "bearing-headless-decision-"));
    roots.push(root);
    await Promise.all([
      mkdir(join(root, ".git")),
      mkdir(join(root, "docs/plans/headless-decision"), { recursive: true }),
    ]);
    const question = "Use this repository and plan directory?";
    const answer = "Approved";
    const runner: ProcessRunner = {
      executableAvailable: () => true,
      verify: async () => true,
      run: async () => {
        return {
          exitCode: 0,
          events: [{ type: "completed", data: { content: `BEARING_RESULT ${JSON.stringify({
            kind: "fit",
            ok: true,
            assumption: {
              repository: root,
              planDirectory: "docs/plans/headless-decision",
              rationale: "The package manifest identifies the selected repository.",
              evidence: [{ kind: "manifest", path: "package.json", detail: "The manifest identifies this package." }],
            },
            question,
          })}` } }],
          usage: { tokens: 1 },
        };
      },
    };
    const base = { repository: root, provider: "codex", model: "gpt-5.6-terra", reasoning: "medium", runId: "headless_decision_1" } as const;
    const created = await executeHeadlessJourney({ action: "create", ...base, goal: "Advance the accepted repository-fit decision." }, { processRunner: runner });
    expect(created).toMatchObject({ ok: true, stage: "repository-fit", status: "waiting", allowedActions: ["status", "resume", "decide"] });

    const store = new BearingStore(root);
    const before = await store.load(base.runId);
    const decisionId = before.pendingDecision?.decisionId;
    expect(decisionId).toBeTypeOf("string");
    expect(before.journeyCheckpoint).toMatchObject({ stage: "repository-fit", status: "waiting", question, questionDecisionId: decisionId });

    const decided = await executeHeadlessJourney({ action: "decide", ...base, answer, stage: "review" }, { processRunner: runner });
    const after = await store.load(base.runId);
    expect(decided).toEqual({
      ok: true,
      runId: base.runId,
      revision: before.revision + 2,
      stage: "repository-fit",
      status: "waiting",
      allowedActions: ["status", "resume", "progress"],
    });
    expect(after.revision).toBe(before.revision + 2);
    expect(after.pendingDecision).toBeNull();
    expect(after.journeyCheckpoint).toMatchObject({
      stage: "repository-fit",
      status: "waiting",
      resolvedPlanDirectory: "docs/plans/headless-decision",
      repositoryFitDecision: { outcome: "confirmed", planDirectory: "docs/plans/headless-decision", repository: root },
    });
    expect(after.journeyCheckpoint?.question).toBeUndefined();
    expect(JSON.parse(after.journeyCheckpoint?.qaJson ?? "null")).toEqual([{ question, answer }]);
    expect(after.events.slice(before.events.length).filter((event) => event.type === "ownerAnswered")).toEqual([
      expect.objectContaining({ payload: expect.objectContaining({ decisionId, answer }) }),
    ]);
  });

  it("rejects review before a completed execution checkpoint without changing the journey", async () => {
    const root = await mkdtemp(join(tmpdir(), "bearing-headless-review-"));
    roots.push(root);
    await mkdir(join(root, ".git"));
    const runner: ProcessRunner = {
      executableAvailable: () => true,
      verify: async () => true,
      run: async () => ({ exitCode: 0, events: [{ type: "completed", data: { content: "review complete" } }], usage: { tokens: 1 } }),
    };
    const base = { repository: root, provider: "codex", model: "gpt-5.6-terra", reasoning: "medium", runId: "review_1" } as const;
    expect((await executeHeadlessJourney({ action: "create", ...base, goal: "Keep the review gate closed." }, { processRunner: runner })).ok).toBe(true);
    const store = new BearingStore(root);
    const before = await store.load(base.runId);
    const checkpoint = await store.apply({
      schemaVersion: 1, commandId: "review-checkpoint", correlationId: "review-checkpoint", runId: base.runId, expectedRevision: before.revision,
      session: { sessionId: "bearing", actor: "bearing" }, type: "recordJourneyCheckpoint",
      payload: { stage: "gather-supplies", status: "waiting", artifacts: [], qaJson: "[]", selectionProvider: "codex", selectionModel: "gpt-5.6-terra", selectionReasoning: "medium" },
    });
    expect(checkpoint.ok).toBe(true);
    const revision = (await store.load(base.runId)).revision;
    expect(await executeHeadlessJourney({ action: "progress", ...base, stage: "review" }, { processRunner: runner })).toEqual({ ok: false, code: "illegal_transition", runId: base.runId, revision });
    const after = await store.load(base.runId);
    expect(after.revision).toBe(revision);
    expect(after.journeyCheckpoint?.stage).toBe("gather-supplies");
  });

  it("rejects a non-adjacent forward planning stage without changing durable state", async () => {
    const root = await mkdtemp(join(tmpdir(), "bearing-headless-stage-order-"));
    roots.push(root);
    await mkdir(join(root, ".git"));
    const runner: ProcessRunner = {
      executableAvailable: () => true,
      verify: async () => true,
      run: async () => ({ exitCode: 0, events: [{ type: "completed", data: { content: 'BEARING_RESULT {"kind":"action","summary":"Ready.","artifacts":[]}' } }], usage: { tokens: 1 } }),
    };
    const base = { repository: root, provider: "codex", model: "gpt-5.6-terra", reasoning: "medium", runId: "stage_order_1" } as const;
    expect((await executeHeadlessJourney({ action: "create", ...base, goal: "Keep planning phases adjacent." }, { processRunner: runner })).ok).toBe(true);
    const store = new BearingStore(root), current = await store.load(base.runId);
    const fit = await store.apply({
      schemaVersion: 1, commandId: "stage-order-fit", correlationId: "stage-order-fit", runId: base.runId, expectedRevision: current.revision,
      session: { sessionId: "bearing", actor: "bearing" }, type: "recordJourneyCheckpoint",
      payload: {
        stage: "repository-fit", status: "waiting", artifacts: [], qaJson: "[]", planDirectory: "docs/plans/stage-order", resolvedPlanDirectory: "docs/plans/stage-order",
        repositoryFitDecision: { outcome: "confirmed", planDirectory: "docs/plans/stage-order", repository: root, decidedAt: "2026-07-29T00:00:00.000Z" },
        selectionProvider: "codex", selectionModel: "gpt-5.6-terra", selectionReasoning: "medium",
      },
    });
    expect(fit.ok).toBe(true);
    const before = await store.load(base.runId);
    const receipt = await executeHeadlessJourney({ action: "progress", ...base, stage: "map-route" }, { processRunner: runner });
    const after = await store.load(base.runId);
    expect.soft(receipt).toEqual({ ok: false, code: "illegal_transition", runId: base.runId, revision: before.revision });
    expect.soft(after.revision).toBe(before.revision);
    expect.soft(after.events).toEqual(before.events);
    expect(after.journeyCheckpoint?.stage).toBe("repository-fit");
  });

  it("permits same-stage retries and backward planning remediation", async () => {
    const root = await mkdtemp(join(tmpdir(), "bearing-headless-stage-remediation-"));
    roots.push(root);
    await mkdir(join(root, ".git"));
    const runner: ProcessRunner = {
      executableAvailable: () => true,
      verify: async () => true,
      run: async () => ({ exitCode: 0, events: [{ type: "completed", data: { content: 'BEARING_RESULT {"kind":"action","summary":"Ready.","artifacts":[]}' } }], usage: { tokens: 1 } }),
    };
    const base = { repository: root, provider: "codex", model: "gpt-5.6-terra", reasoning: "medium", runId: "stage_remediation_1" } as const;
    expect((await executeHeadlessJourney({ action: "create", ...base, goal: "Preserve remediation paths." }, { processRunner: runner })).ok).toBe(true);
    const store = new BearingStore(root), current = await store.load(base.runId);
    const seeded = await store.apply({
      schemaVersion: 1, commandId: "stage-remediation-seed", correlationId: "stage-remediation-seed", runId: base.runId, expectedRevision: current.revision,
      session: { sessionId: "bearing", actor: "bearing" }, type: "recordJourneyCheckpoint",
      payload: {
        stage: "gather-supplies", status: "waiting", artifacts: [], qaJson: "[]", planDirectory: "docs/plans/stage-remediation", resolvedPlanDirectory: "docs/plans/stage-remediation",
        repositoryFitDecision: { outcome: "confirmed", planDirectory: "docs/plans/stage-remediation", repository: root, decidedAt: "2026-07-29T00:00:00.000Z" },
        planningState: "REQUIREMENTS_READY", selectionProvider: "codex", selectionModel: "gpt-5.6-terra", selectionReasoning: "medium",
      },
    });
    expect(seeded.ok).toBe(true);
    expect(await executeHeadlessJourney({ action: "progress", ...base, stage: "gather-supplies" }, { processRunner: runner })).toMatchObject({ ok: true, stage: "gather-supplies" });
    expect(await executeHeadlessJourney({ action: "progress", ...base, stage: "set-bearings" }, { processRunner: runner })).toMatchObject({ ok: true, stage: "set-bearings" });
  });

  it("rejects route approval before plan review without changing durable state", async () => {
    const root = await mkdtemp(join(tmpdir(), "bearing-headless-early-approval-"));
    roots.push(root);
    await mkdir(join(root, ".git"));
    const runner: ProcessRunner = {
      executableAvailable: () => true,
      verify: async () => true,
      run: async () => ({ exitCode: 0, events: [{ type: "completed", data: { content: 'BEARING_RESULT {"kind":"action","summary":"Ready.","artifacts":[]}' } }], usage: { tokens: 1 } }),
    };
    const base = { repository: root, provider: "codex", model: "gpt-5.6-terra", reasoning: "medium", runId: "early_approval_1" } as const;
    expect((await executeHeadlessJourney({ action: "create", ...base, goal: "Wait for plan review." }, { processRunner: runner })).ok).toBe(true);
    const store = new BearingStore(root), before = await store.load(base.runId);
    const receipt = await executeHeadlessJourney({ action: "approve-route", ...base }, { processRunner: runner });
    const after = await store.load(base.runId);
    expect.soft(receipt).toEqual({ ok: false, code: "illegal_transition", runId: base.runId, revision: before.revision });
    expect.soft(after.revision).toBe(before.revision);
    expect.soft(after.events).toEqual(before.events);
    expect(after.pendingDecision).toBeNull();
  });

  it("creates and answers only the canonical route-review decision", async () => {
    const root = await mkdtemp(join(tmpdir(), "bearing-headless-approval-"));
    roots.push(root);
    await mkdir(join(root, ".git"));
    const runner: ProcessRunner = {
      executableAvailable: () => true,
      verify: async () => true,
      run: async () => ({ exitCode: 0, events: [{ type: "completed", data: { content: 'BEARING_RESULT {"kind":"action","summary":"Ready.","artifacts":[]}' } }], usage: { tokens: 1 } }),
    };
    const base = { repository: root, provider: "codex", model: "gpt-5.6-terra", reasoning: "medium", runId: "approval_1" } as const;
    expect((await executeHeadlessJourney({ action: "create", ...base, goal: "Record the route review." }, { processRunner: runner })).ok).toBe(true);
    await seedPlanReviewBoundary(root, base.runId);
    const reviewStatus = await executeHeadlessJourney({ action: "status", ...base }, { processRunner: runner });
    expect(reviewStatus.allowedActions).toContain("approve-route");
    expect(reviewStatus.allowedActions).not.toContain("select-explorer");
    expect(await executeHeadlessJourney({ action: "approve-route", ...base }, { processRunner: runner })).toMatchObject({ ok: true, runId: base.runId });
    const events = (await new BearingStore(root).load(base.runId)).events;
    const decision = events.find((event) => event.type === "decisionRequired");
    expect(decision?.payload.question).toBe("Approve the complete planning package before implementation?");
    expect(events.some((event) => event.type === "ownerAnswered" && event.payload.decisionId === decision?.payload.decisionId && event.payload.answer === "Approved for execution-mode selection")).toBe(true);
    expect((await executeHeadlessJourney({ action: "status", ...base }, { processRunner: runner })).allowedActions).toContain("select-explorer");
  });

  it("rejects route approval behind an unrelated owner decision without mutating it", async () => {
    const root = await mkdtemp(join(tmpdir(), "bearing-headless-unrelated-"));
    roots.push(root);
    await mkdir(join(root, ".git"));
    const runner: ProcessRunner = {
      executableAvailable: () => true,
      verify: async () => true,
      run: async () => ({ exitCode: 0, events: [{ type: "completed", data: { content: 'BEARING_RESULT {"kind":"action","summary":"Ready.","artifacts":[]}' } }], usage: { tokens: 1 } }),
    };
    const base = { repository: root, provider: "codex", model: "gpt-5.6-terra", reasoning: "medium", runId: "unrelated_1" } as const;
    expect((await executeHeadlessJourney({ action: "create", ...base, goal: "Preserve the owner question." }, { processRunner: runner })).ok).toBe(true);
    const store = new BearingStore(root), current = await store.load(base.runId);
    const required = await store.apply({
      schemaVersion: 1, commandId: "unrelated-question", correlationId: "unrelated-question", runId: base.runId, expectedRevision: current.revision,
      session: { sessionId: "owner", actor: "owner" }, type: "requireDecision",
      payload: { decisionId: "unrelated-question", question: "Choose the migration owner.", consequential: true },
    });
    expect(required.ok).toBe(true);
    const revision = (await store.load(base.runId)).revision;
    expect(await executeHeadlessJourney({ action: "approve-route", ...base }, { processRunner: runner })).toEqual({ ok: false, code: "illegal_transition", runId: base.runId, revision });
    const after = await store.load(base.runId);
    expect(after.revision).toBe(revision);
    expect(after.pendingDecision).toMatchObject({ decisionId: "unrelated-question", question: "Choose the migration owner." });
  });

  it("rejects absent and cross-repository stable IDs without disclosing a repository path", async () => {
    const first = await mkdtemp(join(tmpdir(), "bearing-headless-first-"));
    const second = await mkdtemp(join(tmpdir(), "bearing-headless-second-"));
    roots.push(first, second);
    await Promise.all([mkdir(join(first, ".git")), mkdir(join(second, ".git"))]);
    const runner: ProcessRunner = {
      executableAvailable: () => true,
      verify: async () => true,
      run: async () => ({ exitCode: 0, events: [{ type: "completed", data: { content: 'BEARING_RESULT {"kind":"action","summary":"Ready.","artifacts":[]}' } }], usage: { tokens: 1 } }),
    };
    const shared = { provider: "codex", model: "gpt-5.6-terra", reasoning: "medium" } as const;
    expect((await executeHeadlessJourney({ action: "create", repository: first, runId: "existing_1", goal: "Own this journey.", ...shared }, { processRunner: runner })).ok).toBe(true);
    for (const request of [
      { action: "status" as const, repository: first, runId: "missing_1", ...shared },
      { action: "resume" as const, repository: first, runId: "missing_1", ...shared },
      { action: "status" as const, repository: second, runId: "existing_1", ...shared },
      { action: "resume" as const, repository: second, runId: "existing_1", ...shared },
    ]) {
      const receipt = await executeHeadlessJourney(request, { processRunner: runner });
      expect(receipt).toMatchObject({ ok: false, code: "run_not_found", runId: request.runId });
      expect(JSON.stringify(receipt)).not.toContain(first);
      expect(JSON.stringify(receipt)).not.toContain(second);
      expect((await new BearingStore(request.repository).load(request.runId)).revision).toBe(0);
    }
  });

  it("keeps a missing read non-mutating and defers first-launch disclosure to create", async () => {
    const root = await mkdtemp(join(tmpdir(), "bearing-headless-fresh-read-"));
    roots.push(root);
    await Promise.all([
      mkdir(join(root, ".git")),
      writeFile(join(root, ".gitignore"), "dist/\n"),
    ]);
    const runner: ProcessRunner = {
      executableAvailable: () => true,
      verify: async () => true,
      run: async () => ({ exitCode: 0, events: [{ type: "completed", data: { content: 'BEARING_RESULT {"kind":"action","summary":"Ready.","artifacts":[]}' } }], usage: { tokens: 1 } }),
    };
    const base = { repository: root, provider: "codex", model: "gpt-5.6-terra", reasoning: "medium", runId: "fresh_read_1" } as const;

    expect(await executeHeadlessJourney({ action: "status", ...base }, { processRunner: runner })).toMatchObject({
      ok: false,
      code: "run_not_found",
      runId: base.runId,
      revision: 0,
    });
    await expect(access(join(root, ".bearing"))).rejects.toBeDefined();

    const created = await executeHeadlessJourney({ action: "create", ...base, goal: "Initialize only for a write." }, { processRunner: runner });
    expect(created).toMatchObject({
      ok: true,
      disclosure: expect.stringContaining(".bearing/"),
      gitignoreMissing: true,
    });
    expect(JSON.stringify(created)).not.toContain(root);
    await expect(access(join(root, ".bearing", "workspace.json"))).resolves.toBeUndefined();
  });

  it("reads durable route-review state when provider readiness is unavailable", async () => {
    const root = await mkdtemp(join(tmpdir(), "bearing-headless-unavailable-read-"));
    roots.push(root);
    await mkdir(join(root, ".git"));
    const available: ProcessRunner = {
      executableAvailable: () => true,
      verify: async () => true,
      run: async () => ({ exitCode: 0, events: [{ type: "completed", data: { content: 'BEARING_RESULT {"kind":"action","summary":"Ready.","artifacts":[]}' } }], usage: { tokens: 1 } }),
    };
    const unavailable: ProcessRunner = {
      executableAvailable: () => false,
      verify: async () => false,
      run: async () => { throw new Error("provider must not run for a read"); },
    };
    const base = { repository: root, provider: "codex", model: "gpt-5.6-terra", reasoning: "medium", runId: "unavailable_read_1" } as const;
    expect((await executeHeadlessJourney({ action: "create", ...base, goal: "Preserve durable route review." }, { processRunner: available })).ok).toBe(true);
    await seedPlanReviewBoundary(root, base.runId);

    for (const action of ["status", "resume"] as const) {
      const receipt = await executeHeadlessJourney({ action, ...base }, { processRunner: unavailable });
      expect(receipt).toMatchObject({
        ok: true,
        runId: base.runId,
        stage: "draft-implementation",
        status: "waiting",
        readiness: "unavailable",
      });
      expect(receipt.allowedActions).toContain("approve-route");
    }
  });

  it("never advertises Explorer when the same handler rejects its missing approval", async () => {
    const root = await mkdtemp(join(tmpdir(), "bearing-headless-actions-"));
    roots.push(root);
    await mkdir(join(root, ".git"));
    const runner: ProcessRunner = {
      executableAvailable: () => true,
      verify: async () => true,
      run: async () => ({ exitCode: 0, events: [{ type: "completed", data: { content: 'BEARING_RESULT {"kind":"action","summary":"Ready.","artifacts":[]}' } }], usage: { tokens: 1 } }),
    };
    const base = { repository: root, provider: "codex", model: "gpt-5.6-terra", reasoning: "medium", runId: "actions_1" } as const;
    expect((await executeHeadlessJourney({ action: "create", ...base, goal: "Keep Explorer unavailable." }, { processRunner: runner })).ok).toBe(true);
    const store = new BearingStore(root), current = await store.load(base.runId);
    const checkpoint = await store.apply({
      schemaVersion: 1, commandId: "draft-checkpoint", correlationId: "draft-checkpoint", runId: base.runId, expectedRevision: current.revision,
      session: { sessionId: "bearing", actor: "bearing" }, type: "recordJourneyCheckpoint",
      payload: {
        stage: "draft-implementation", status: "waiting", artifacts: [], qaJson: "[]", planDirectory: "docs/plans/headless", resolvedPlanDirectory: "docs/plans/headless", reviewBaselineRevision: current.revision,
        repositoryFitDecision: { outcome: "confirmed", planDirectory: "docs/plans/headless", repository: root, decidedAt: "2026-07-29T00:00:00.000Z" },
        selectionProvider: "codex", selectionModel: "gpt-5.6-terra", selectionReasoning: "medium",
      },
    });
    expect(checkpoint.ok).toBe(true);
    const revision = (await store.load(base.runId)).revision;
    const status = await executeHeadlessJourney({ action: "status", ...base }, { processRunner: runner });
    expect(status).toMatchObject({ ok: true, runId: base.runId });
    expect(status.allowedActions).not.toContain("select-explorer");
    expect(await executeHeadlessJourney({ action: "select-explorer", ...base, reviewCadence: "slice" }, { processRunner: runner })).toEqual({ ok: false, code: "illegal_transition", runId: base.runId, revision });
    expect((await store.load(base.runId)).revision).toBe(revision);
  });
});

describe("improve commands", () => {
  const thresholds = Object.freeze({
    minSettledRuns: 20,
    minOccurrences: 5,
    minDistinctRuns: 3,
    minDenominator: 20,
    minEffect: 0.15,
    trialMinOccurrences: 5,
    trialMinDistinctRuns: 3,
    trialMaxAgeDays: 90,
  });
  const metric = Object.freeze({
    id: "first-pass-success" as const,
    value: 0.8,
    numerator: 16,
    denominator: 20,
    sufficient: true,
  });
  const report = Object.freeze({
    settledRuns: 20,
    unreadableRuns: 1,
    thresholds,
    metrics: Object.freeze([metric]),
    recommendation: Object.freeze({
      status: "ready" as const,
      thresholds,
      recommendations: Object.freeze([Object.freeze({
        patternId: "grader-disagreement" as const,
        surface: "review-cadence" as const,
        target: Object.freeze({ role: "surveyor" as const }),
        from: "per-phase" as const,
        to: "per-slice" as const,
        evidence: Object.freeze({
          recordRefs: Object.freeze(["a".repeat(64)]),
          occurrences: 5,
          distinctRuns: 3,
        }),
        baseline: metric,
        guards: Object.freeze([metric]),
        trial: Object.freeze({
          minOccurrences: 5,
          minDistinctRuns: 3,
          maxAgeDays: 90,
          openedAtRef: "b".repeat(64),
        }),
        revert: Object.freeze({
          surface: "review-cadence" as const,
          target: Object.freeze({ role: "surveyor" as const }),
          value: "per-phase" as const,
        }),
      })]),
    }),
    trialVerdicts: Object.freeze([Object.freeze({
      status: "retain" as const,
      prescribedAction: "retain" as const,
      reason: "target_improved" as const,
      occurrences: 5,
      distinctRuns: 3,
      requiredOccurrences: 5,
      requiredDistinctRuns: 3,
      ageDays: 7,
      targetImprovement: 0.2,
      minEffect: 0.15,
      noiseFloor: 0.05,
      guardRegressions: Object.freeze([]),
    })]),
  }) satisfies ImprovementCliReport;

  it("accepts only the bounded handoff form", async () => {
    expect(parseImproveArgs(["improve", "handoff"])).toEqual({ ok: true, action: "handoff" });
    for (const args of [
      ["improve", "handoff", "--anything"],
      ["improve", "handoff", "extra"],
      ["improve"],
    ]) {
      expect(parseImproveArgs(args)).toEqual({ ok: false });
      const ctx = newCtx();
      await run(args, ctx.d);
      expect(ctx.getExitCode()).toBe(2);
    }
  });

  it("parses only the three bounded improve forms", () => {
    expect(parseImproveArgs(["improve", "status"])).toEqual({ ok: true, action: "status" });
    expect(parseImproveArgs(["improve", "report"])).toEqual({ ok: true, action: "report" });
    expect(parseImproveArgs(["improve", "export", "--out", "contrib/improvement.json"]))
      .toEqual({ ok: true, action: "export", destination: "contrib/improvement.json" });

    for (const args of [
      ["improve"],
      ["improve", "status", "--verbose"],
      ["improve", "report", "--format", "json"],
      ["improve", "export"],
      ["improve", "export", "--unknown", "contrib/improvement.json"],
      ["improve", "export", "--out", "/tmp/improvement.json"],
      ["improve", "export", "--out", "../improvement.json"],
      ["improve", "export", "--out", "nested/../../improvement.json"],
      ["improve", "export", "--out", "C:\\private\\improvement.json"],
      ["improve", "export", "--out", "x".repeat(1_025)],
    ]) expect(parseImproveArgs(args)).toEqual({ ok: false });

    const inherited = Object.create(["improve", "export", "--out", "contrib/improvement.json"]);
    expect(parseImproveArgs(inherited as string[])).toEqual({ ok: false });
  });

  it("renders status and report only through fixed templates over typed values", async () => {
    for (const [action, expected] of [
      ["status", [
        "Improvement status",
        "Settled runs: 20",
        "Unreadable runs: 1",
        "Evidence threshold: 20 settled runs",
        "Open trials: 1",
      ]],
      ["report", [
        "Improvement report",
        "Metric first-pass success: 16/20 = 0.8",
        "Recommendation grader disagreement: tighten review cadence from per-phase to per-slice",
        "Trial retain: target improved; prescribed action retain",
      ]],
    ] as const) {
      const ctx = newCtx();
      const calls: string[] = [];
      await run(["improve", action], {
        ...ctx.d,
        cwd: "/tmp/bearing-repository",
        improvement: {
          report: async (repositoryRoot) => {
            calls.push(repositoryRoot);
            return { ok: true, value: report };
          },
          export: async () => ({ ok: false, reason: "export_failed" }),
        },
      });

      expect(ctx.getExitCode()).toBeUndefined();
      expect(calls).toEqual(["/tmp/bearing-repository"]);
      for (const line of expected) expect(ctx.out).toContain(`${line}\n`);
      expect(ctx.err).toEqual([]);
    }
  });

  it("dispatches writes only for export and reports its owner-named destination", async () => {
    const calls: unknown[] = [];
    const improvement = {
      report: async (repositoryRoot: string) => {
        calls.push(["report", repositoryRoot]);
        return { ok: true as const, value: report };
      },
      export: async (repositoryRoot: string, destination: string) => {
        calls.push(["export", repositoryRoot, destination]);
        return { ok: true as const, destination };
      },
    };

    for (const action of ["status", "report"] as const) {
      const ctx = newCtx();
      await run(["improve", action], { ...ctx.d, cwd: "/tmp/bearing-repository", improvement });
    }
    const ctx = newCtx();
    await run(["improve", "export", "--out", "contrib/improvement.json"], {
      ...ctx.d,
      cwd: "/tmp/bearing-repository",
      improvement,
    });

    expect(calls).toEqual([
      ["report", "/tmp/bearing-repository"],
      ["report", "/tmp/bearing-repository"],
      ["export", "/tmp/bearing-repository", "contrib/improvement.json"],
    ]);
    expect(ctx.out).toEqual(["Exported improvement bundle: contrib/improvement.json\n"]);
    expect(ctx.getExitCode()).toBeUndefined();
  });

  it("exits nonzero for invalid arguments and truthy typed failures", async () => {
    const invalid = newCtx();
    await run(["improve", "report", "--unknown"], invalid.d);
    expect(invalid.getExitCode()).toBe(2);
    expect(invalid.err.join("")).toContain("usage");

    const rejected = newCtx();
    await run(["improve", "report"], {
      ...rejected.d,
      improvement: {
        report: async () => ({ ok: false, reason: "store_read_failed" }),
        export: async () => ({ ok: false, reason: "export_failed" }),
      },
    });
    expect(rejected.getExitCode()).toBe(1);
    expect(rejected.err).toEqual(["bearing improve: store_read_failed\n"]);
  });

  it("refuses a prototype-carried improvement provider", async () => {
    let inheritedCalled = false;
    const ctx = newCtx();
    const inheritedDeps = Object.assign(Object.create({
      improvement: {
        report: async () => {
          inheritedCalled = true;
          return { ok: true, value: report };
        },
      },
    }), {
      stdout: ctx.d.stdout,
      stderr: ctx.d.stderr,
      exit: ctx.d.exit,
    }) as LauncherDeps;

    await run(["improve", "report"], inheritedDeps);

    expect(inheritedCalled).toBe(false);
    expect(ctx.getExitCode()).toBe(1);
    expect(ctx.err).toEqual(["bearing improve: configuration_invalid\n"]);
  });

  it("runs status, report, and export through the real selected-repository pipeline", async () => {
    const root = await mkdtemp(join(tmpdir(), "bearing-improve-real-"));
    roots.push(root);
    await mkdir(join(root, "contrib"));
    await seedSettledImprovementRun(root);

    for (const action of ["status", "report"] as const) {
      const ctx = newCtx();
      await run(["improve", action], {
        cwd: root,
        stdout: ctx.d.stdout,
        stderr: ctx.d.stderr,
        exit: ctx.d.exit,
      });
      expect(ctx.getExitCode()).toBeUndefined();
      expect(ctx.err).toEqual([]);
      expect(ctx.out.join("")).toContain(action === "status" ? "Improvement status" : "Improvement report");
      if (action === "report") {
        for (const metric of [
          "coordination overhead",
          "first-pass success",
          "grading accuracy",
          "escaped defects",
          "cost per accepted criterion",
        ]) expect(ctx.out).toContain(`Metric ${metric}: insufficient (0/0)\n`);
      }
    }

    const exported = newCtx();
    await run(["improve", "export", "--out", "contrib/improvement.json"], {
      cwd: root,
      stdout: exported.d.stdout,
      stderr: exported.d.stderr,
      exit: exported.d.exit,
    });
    expect(exported.getExitCode()).toBeUndefined();
    expect(exported.err).toEqual([]);
    expect(JSON.parse(await readFile(join(root, "contrib/improvement.json"), "utf8"))).toEqual({
      schemaVersion: 1,
      policyValues: [],
      benchmarkCases: [],
      testCases: [],
      workflowNotes: [],
    });

    const empty = await mkdtemp(join(tmpdir(), "bearing-improve-empty-"));
    roots.push(empty);
    const emptyCtx = newCtx();
    await run(["improve", "report"], {
      cwd: empty,
      stdout: emptyCtx.d.stdout,
      stderr: emptyCtx.d.stderr,
      exit: emptyCtx.d.exit,
    });
    // A repository that has never run Bearing is an empty evidence position, not a broken ledger.
    expect(emptyCtx.getExitCode()).toBeUndefined();
    expect(emptyCtx.err).toEqual([]);
    expect(emptyCtx.out.join("")).toContain("Improvement report");

    const unreadable = await mkdtemp(join(tmpdir(), "bearing-improve-unreadable-"));
    roots.push(unreadable);
    await seedSettledImprovementRun(unreadable, "corrupt-run");
    await writeFile(join(unreadable, ".bearing/runs/corrupt-run/events.jsonl"), "not-json\n", "utf8");
    const unreadableCtx = newCtx();
    await run(["improve", "status"], {
      cwd: unreadable,
      stdout: unreadableCtx.d.stdout,
      stderr: unreadableCtx.d.stderr,
      exit: unreadableCtx.d.exit,
    });
    expect(unreadableCtx.getExitCode()).toBe(1);
    expect(unreadableCtx.err).toEqual(["bearing improve: store_read_failed\n"]);
  });

  it("names the cause of an export write failure instead of a bare code", async () => {
    const root = await mkdtemp(join(tmpdir(), "bearing-improve-detail-"));
    const missing = newCtx();
    await run(["improve", "export", "--out", "contrib/bundle.json"], {
      cwd: root, stdout: missing.d.stdout, stderr: missing.d.stderr, exit: missing.d.exit,
    });
    expect(missing.getExitCode()).toBe(1);
    expect(missing.err.join("")).toContain("the destination directory does not exist");

    await mkdir(join(root, "contrib"), { recursive: true });
    const first = newCtx();
    await run(["improve", "export", "--out", "contrib/bundle.json"], {
      cwd: root, stdout: first.d.stdout, stderr: first.d.stderr, exit: first.d.exit,
    });
    expect(first.getExitCode()).toBeUndefined();

    const again = newCtx();
    await run(["improve", "export", "--out", "contrib/bundle.json"], {
      cwd: root, stdout: again.d.stdout, stderr: again.d.stderr, exit: again.d.exit,
    });
    expect(again.getExitCode()).toBe(1);
    expect(again.err.join("")).toContain("the destination already exists");
  });

  it("derives retained policy values and keeps the export allowlist as the final write gate", async () => {
    const root = await mkdtemp(join(tmpdir(), "bearing-improve-derived-export-"));
    roots.push(root);
    await mkdir(join(root, "contrib"));
    const ctx = newCtx();
    await run(["improve", "export", "--out", "contrib/retained.json"], {
      cwd: root,
      stdout: ctx.d.stdout,
      stderr: ctx.d.stderr,
      exit: ctx.d.exit,
      improvement: { report: async () => ({ ok: true, value: report }) },
    });
    expect(ctx.getExitCode()).toBeUndefined();
    expect(JSON.parse(await readFile(join(root, "contrib/retained.json"), "utf8"))).toMatchObject({
      policyValues: [{
        surface: "review-cadence",
        target: "surveyor",
        from: "per-phase",
        to: "per-slice",
        verdict: "retain",
      }],
      benchmarkCases: [],
      testCases: [],
      workflowNotes: [],
    });

    for (const [name, leaked] of [
      ["digest", "a".repeat(64)],
      ["run id", "run-private-1"],
      ["timestamp", "2026-07-26T12:00:00.000Z"],
      ["provider session id", "9b3c924c-2fd8-4b61-a9e2-901e9af95cec"],
      ["plan directory", "docs/plans/private"],
      ["repository path", "private/repository"],
    ] as const) {
      const destination = `contrib/refused-${name.replaceAll(" ", "-")}.json`;
      const unsafe = {
        ...report,
        recommendation: {
          ...report.recommendation,
          recommendations: [{ ...report.recommendation.recommendations[0]!, to: leaked }],
        },
      } as unknown as ImprovementCliReport;
      const refused = newCtx();
      await run(["improve", "export", "--out", destination], {
        cwd: root,
        stdout: refused.d.stdout,
        stderr: refused.d.stderr,
        exit: refused.d.exit,
        improvement: { report: async () => ({ ok: true, value: unsafe }) },
      });
      expect(refused.getExitCode()).toBe(1);
      expect(refused.err).toEqual(["bearing improve: export_shape_invalid\n"]);
      await expect(access(join(root, destination))).rejects.toMatchObject({ code: "ENOENT" });
    }
  });
});

describe("run launcher", () => {
  it("names every accepted reasoning value when rejecting the flag", async () => {
    const ctx = newCtx();
    await run(["start", "--reasoning", "maximum"], ctx.d);
    expect(ctx.getExitCode()).toBe(2);
    expect(ctx.err.join(" ")).toContain("minimal, low, medium, high, very-high, max, default, off, none, xhigh, ultra, thinking");
  });

  it("launches standalone Focus state in the detached guard boundary", async () => {
    const ctx = newCtx();
    const calls: unknown[] = [];
    await run(["focus", "begin", "--request", ".bearing/focus/request.json"], {
      ...ctx.d,
      cwd: "/tmp/focus-repository",
      launchFocusGuard: async (requestPath, cwd) => {
        calls.push([requestPath, cwd]);
        return { ok: true, runId: `v1.12345.${"a".repeat(64)}`, envelope: { role: "crewmate" } };
      },
    });
    expect(calls).toEqual([[".bearing/focus/request.json", "/tmp/focus-repository"]]);
    expect(JSON.parse(ctx.out.join(""))).toMatchObject({ ok: true, runId: `v1.12345.${"a".repeat(64)}` });
  });

  it("flushes a failed focus guard result before disconnecting and exiting", async () => {
    const root = await mkdtemp(join(tmpdir(), "bearing-focus-guard-"));
    roots.push(root);
    const events: string[] = [];
    let sent: unknown;
    const sendDescriptor = Object.getOwnPropertyDescriptor(process, "send");
    const disconnectDescriptor = Object.getOwnPropertyDescriptor(process, "disconnect");
    const originalGuard = process.env.BEARING_FOCUS_GUARD_CHILD;
    process.env.BEARING_FOCUS_GUARD_CHILD = "1";
    Object.defineProperty(process, "send", {
      configurable: true,
      value: (message: unknown, callback?: () => void) => {
        sent = message;
        events.push("send");
        if (callback) {
          setImmediate(() => {
            events.push("flushed");
            callback();
          });
        }
        return true;
      },
    });
    Object.defineProperty(process, "disconnect", {
      configurable: true,
      value: () => events.push("disconnect"),
    });

    try {
      await run(["focus", "guard", "--request", "missing.json"], {
        cwd: root,
        exit: () => events.push("exit"),
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
    } finally {
      if (sendDescriptor) Object.defineProperty(process, "send", sendDescriptor);
      else Reflect.deleteProperty(process, "send");
      if (disconnectDescriptor) Object.defineProperty(process, "disconnect", disconnectDescriptor);
      else Reflect.deleteProperty(process, "disconnect");
      if (originalGuard === undefined) delete process.env.BEARING_FOCUS_GUARD_CHILD;
      else process.env.BEARING_FOCUS_GUARD_CHILD = originalGuard;
    }

    expect(sent).toEqual({
      type: "bearing-focus-ready",
      result: { ok: false, reason: "request_invalid" },
    });
    expect(events).toEqual(["send", "flushed", "disconnect", "exit"]);
  });

  it("detaches through the portable child launcher and prints its URL", async () => {
    const ctx = newCtx();
    const launched: string[][] = [];
    const server = await run(["start", "--detach", "--no-open"], {
      ...ctx.d,
      launchDetached: async (args) => {
        launched.push(args);
        return "http://127.0.0.1:43210/#cap=abc123";
      },
    });

    expect(server).toBeUndefined();
    expect(launched).toEqual([["start", "--no-open"]]);
    expect(ctx.out).toEqual(["http://127.0.0.1:43210/#cap=abc123\n"]);
    expect(ctx.opened).toEqual([]);
  });

  it("binds loopback, prints the URL, and opens the browser exactly once", async () => {
    const ctx = newCtx();
    const server = await run(["start"], ctx.d);
    if (!server) throw new Error("expected a listening server");
    servers.push(server);

    const url = ctx.out.join("").trim();
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/#cap=[0-9a-f]+$/);
    expect(ctx.getExitCode()).toBeUndefined();
    expect(ctx.opened).toEqual([url]);

    const addr = server.address();
    expect(addr).toMatchObject({ address: "127.0.0.1" });
    expect(typeof (addr as { port: number }).port).toBe("number");
    expect((addr as { port: number }).port).toBeGreaterThan(0);
  });

  it("`start --no-open` prints the URL but never opens a browser", async () => {
    const ctx = newCtx();
    const server = await run(["start", "--no-open"], ctx.d);
    if (!server) throw new Error("expected a listening server");
    servers.push(server);

    expect(ctx.opened).toEqual([]);
    expect(ctx.out.join("")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/#cap=[0-9a-f]+\n$/);
  });

  it("serves the native HTML placeholder over loopback HTTP", async () => {
    const ctx = newCtx();
    const server = await run(["start", "--no-open"], ctx.d);
    if (!server) throw new Error("expected a listening server");
    servers.push(server);

    const url = new URL(ctx.out.join("").trim());
    const body = await new Promise<string>((resolve, reject) => {
      get(url, (res) => {
        let b = "";
        res.setEncoding("utf-8");
        res.on("data", (c: string) => (b += c));
        res.on("end", () => resolve(b));
      }).on("error", reject);
    });
    expect(body).toContain("<title>Bearing</title>");
  });

  it("rejects an unknown command with a nonzero exit and usage on stderr", async () => {
    const ctx = newCtx();
    const server = await run(["bogus"], ctx.d);
    expect(server).toBeUndefined();
    expect(ctx.getExitCode()).toBe(2);
    expect(ctx.err.join("")).toMatch(/usage/);
  });

  it("rejects an unknown flag with a nonzero exit", async () => {
    const ctx = newCtx();
    const server = await run(["start", "--evil"], ctx.d);
    expect(server).toBeUndefined();
    expect(ctx.getExitCode()).toBe(2);
  });
});

describe("plan validate", () => {
  it.each([
    ["PASS", validImplementation, validPlan, 0],
    ["NEEDS_AMENDMENT", validImplementation.replace("status: complete", "status: draft"), validPlan, 1],
    ["OWNER_DECISION_REQUIRED", validImplementation, validPlan.replace("Bounded account data is imported.", "Either CSV or JSON is imported."), 2],
  ] as const)("reports %s without mutating the plan or creating run state", async (verdict, implementation, plan, exitCode) => {
    const root = await mkdtemp(join(tmpdir(), "bearing-plan-validate-"));
    roots.push(root);
    const directory = await writePlan(root, implementation, plan);
    const before = await planTree(directory);
    const ctx = newCtx();

    await run(["plan", "validate", "docs/plans/import"], { ...ctx.d, cwd: root });

    expect(ctx.getExitCode() ?? 0).toBe(exitCode);
    expect(ctx.out[0]).toBe(`${verdict}\n`);
    if (verdict !== "PASS") {
      expect(ctx.out.slice(1).join("")).toMatch(/^[a-z_]+ · (?:plan-spec|implementation)\.md · (?:-|[A-Za-z0-9.]+) · .+ · .+ · .+\n/m);
    }
    expect(await planTree(directory)).toEqual(before);
    expect(await readdir(root)).not.toContain(".bearing");
    expect(await readdir(directory)).not.toContain("review.html");
  });

  it("returns typed input failures for outside, symlinked, and incomplete plan directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "bearing-plan-root-"));
    const outside = await mkdtemp(join(tmpdir(), "bearing-plan-outside-"));
    roots.push(root, outside);
    await writePlan(outside, validImplementation, validPlan, "plan");
    await mkdir(join(root, "docs/plans"), { recursive: true });
    await symlink(join(outside, "plan"), join(root, "docs/plans/escape"));
    await mkdir(join(root, "docs/plans/incomplete"));

    for (const directory of [join(outside, "plan"), "docs/plans/escape", "docs/plans/incomplete"]) {
      const ctx = newCtx();
      await expect(run(["plan", "validate", directory], { ...ctx.d, cwd: root })).resolves.toBeUndefined();
      expect(ctx.getExitCode()).toBe(3);
      expect(ctx.err.join("")).toContain("plan_input_invalid");
    }
    expect(await readFile(join(outside, "plan/plan-spec.md"), "utf8")).toBe(validPlan);
  });

  it("strips terminal control sequences from findings produced by an untrusted plan", async () => {
    const root = await mkdtemp(join(tmpdir(), "bearing-plan-controls-"));
    roots.push(root);
    const hostile = validPlan.replace(
      "Bounded account data is imported.",
      "Either CSV \u001b[31mred\u001b[0m or JSON \u001b]0;forged title\u0007 is imported.",
    );
    await writePlan(root, validImplementation, hostile);
    const ctx = newCtx();

    await run(["plan", "validate", "docs/plans/import"], { ...ctx.d, cwd: root });

    expect(ctx.getExitCode()).toBe(2);
    const output = ctx.out.join("");
    expect(output).toContain("Either CSV red or JSON is imported.");
    expect(output.replace(/\n/g, "")).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    expect(output).not.toContain("forged title");
  });
});

describe("workspace commands", () => {
  it("prints workspace status for a valid repository", async () => {
    const root = await mkdtemp(join(tmpdir(), "bearing-status-"));
    roots.push(root);
    await mkdir(join(root, ".git"));
    await mkdir(join(root, ".bearing"));
    await writeFile(join(root, ".bearing", "state.json"), "state");
    await writeFile(join(root, ".gitignore"), ".bearing/\n");
    const ctx = newCtx();

    expect(await run(["workspace", "status", "--repo", root], {
      ...ctx.d,
      workspace: { cwd: root, home: root, pathEnv: "" },
    })).toBeUndefined();

    const output = ctx.out.join("");
    expect(output).toContain(`Resolved repository: ${root}`);
    expect(output).toContain(`Bearing workspace: ${join(root, ".bearing")}`);
    expect(output).toContain("Workspace bytes: 5 bytes");
    expect(output).toContain("Gitignore: ignored");
    expect(output).toContain("Safety verdict: safe");
    expect(ctx.getExitCode()).toBeUndefined();
  });

  it("agrees with bootstrap on every literal .bearing ignore spelling", async () => {
    for (const line of [".bearing", ".bearing/", "/.bearing", "/.bearing/"]) {
      const root = await mkdtemp(join(tmpdir(), "bearing-status-ignore-"));
      roots.push(root);
      await mkdir(join(root, ".git"));
      await writeFile(join(root, ".gitignore"), `dist/\n${line}\n`);
      const ctx = newCtx();

      await run(["workspace", "status", "--repo", root], {
        ...ctx.d,
        workspace: { cwd: root, home: root, pathEnv: "" },
      });

      expect(ctx.out.join("")).toContain("Gitignore: ignored");
    }

    for (const line of [".bearings", "bearing/", "#.bearing", ".bearing/runs"]) {
      const root = await mkdtemp(join(tmpdir(), "bearing-status-unignored-"));
      roots.push(root);
      await mkdir(join(root, ".git"));
      await writeFile(join(root, ".gitignore"), `dist/\n${line}\n`);
      const ctx = newCtx();

      await run(["workspace", "status", "--repo", root], {
        ...ctx.d,
        workspace: { cwd: root, home: root, pathEnv: "" },
      });

      expect(ctx.out.join("")).toContain("Gitignore: not ignored");
    }
  });

  it("reports a home workspace without deleting it", async () => {
    const home = await mkdtemp(join(tmpdir(), "bearing-doctor-home-"));
    roots.push(home);
    const workspace = join(home, ".bearing");
    await mkdir(workspace);
    await writeFile(join(workspace, "workspace.json"), "preserved");
    const ctx = newCtx();

    expect(await run(["workspace", "doctor"], {
      ...ctx.d,
      workspace: { cwd: home, home, pathEnv: "" },
    })).toBeUndefined();

    expect(ctx.out.join("")).toContain(`MISPLACED: ${workspace}`);
    expect(await readFile(join(workspace, "workspace.json"), "utf8")).toBe("preserved");
  });

  it("quarantines exactly one detected workspace and preserves its files", async () => {
    const root = await mkdtemp(join(tmpdir(), "bearing-doctor-relocate-"));
    const home = await mkdtemp(join(tmpdir(), "bearing-doctor-empty-home-"));
    roots.push(root, home);
    const workspace = join(root, ".bearing");
    await mkdir(workspace);
    await writeFile(join(workspace, "state.json"), "durable state");
    const ctx = newCtx();
    const now = new Date("2026-07-24T12:34:56.789Z");

    expect(await run(["workspace", "doctor", "--scan", root, "--relocate", workspace], {
      ...ctx.d,
      workspace: { cwd: root, home, pathEnv: "", now: () => now },
    })).toBeUndefined();

    const quarantine = (await readdir(root)).find((entry) => entry.startsWith(".bearing.quarantine-"));
    expect(quarantine).toBeDefined();
    expect(await readFile(join(root, quarantine!, "state.json"), "utf8")).toBe("durable state");
    expect((await readdir(root)).includes(".bearing")).toBe(false);

    const second = newCtx();
    await run(["workspace", "doctor", "--scan", root, "--relocate", workspace], {
      ...second.d,
      workspace: { cwd: root, home, pathEnv: "", now: () => now },
    });
    expect(second.getExitCode()).toBe(1);
    expect(second.err.join("")).toContain("was not detected");
  });

  it("refuses relocation while an interrupted-initialization marker exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "bearing-doctor-active-"));
    const home = await mkdtemp(join(tmpdir(), "bearing-doctor-active-home-"));
    roots.push(root, home);
    const workspace = join(root, ".bearing");
    await mkdir(workspace);
    await mkdir(join(root, ".bearing.tmp-123"));
    await writeFile(join(workspace, "state.json"), "still active");
    const ctx = newCtx();

    await run(["workspace", "doctor", "--scan", root, "--relocate", workspace], {
      ...ctx.d,
      workspace: { cwd: root, home, pathEnv: "" },
    });

    expect(ctx.getExitCode()).toBe(1);
    expect(ctx.err.join("")).toContain("in-progress or interrupted initialization marker");
    expect(await readFile(join(workspace, "state.json"), "utf8")).toBe("still active");
  });

  it.each(["compact", "prune"] as const)(
    "refuses workspace %s without a policy flag and leaves the workspace byte-identical",
    async (command) => {
      const root = await mkdtemp(join(tmpdir(), `bearing-${command}-policy-`));
      roots.push(root);
      await mkdir(join(root, ".git"));
      await mkdir(join(root, ".bearing"));
      await writeFile(join(root, ".bearing", "state.json"), "preserved");
      const before = await readFile(join(root, ".bearing", "state.json"));
      const ctx = newCtx();

      await run(["workspace", command, "--repo", root], {
        ...ctx.d,
        workspace: { cwd: root, home: root, pathEnv: "" },
      });

      expect(ctx.getExitCode()).not.toBe(0);
      expect(ctx.err.join("")).toContain("usage");
      expect(await readFile(join(root, ".bearing", "state.json"))).toEqual(before);
    },
  );

  it.each([
    ["compact", ["--compact-settled"], "compact", "compact_settled"],
    ["prune", ["--max-completed-runs", "0"], "prune", "max_completed_runs"],
  ] as const)("prints the workspace %s plan before applying it", async (
    command,
    policyFlags,
    action,
    reason,
  ) => {
    const root = await mkdtemp(join(tmpdir(), `bearing-${command}-plan-`));
    roots.push(root);
    await mkdir(join(root, ".git"));
    const ctx = newCtx();
    const order: string[] = [];
    const head = "a".repeat(40);
    const store = {
      async retentionPlan() {
        order.push("plan");
        return [{ runId: "settled", action, reason }] as const;
      },
      async applyRetention() {
        order.push(ctx.out.join("").includes(`${action} settled (${reason})`) ? "apply-after-print" : "apply-before-print");
        return [{ runId: "settled", action, reason }] as const;
      },
    };

    await run(["workspace", command, "--repo", root, ...policyFlags], {
      ...ctx.d,
      workspace: {
        cwd: root,
        home: root,
        pathEnv: "",
        git: async (_cwd, args) => {
          if (args[0] === "worktree") return { exitCode: 0, stdout: `worktree ${root}\0HEAD ${head}\0branch refs/heads/main\0\0` };
          if (args[0] === "status") return { exitCode: 0, stdout: "" };
          if (args[0] === "rev-parse") return { exitCode: 0, stdout: `${head}\n` };
          if (args[0] === "merge-base") return { exitCode: 0, stdout: "" };
          return { exitCode: 2, stdout: "" };
        },
        storeFactory: () => store,
      },
    });

    expect(ctx.getExitCode()).toBeUndefined();
    expect(order).toEqual(["plan", "apply-after-print"]);
    expect(ctx.out.join("")).toContain(`Plan:\n${action} settled (${reason})\n`);
    expect(ctx.out.join("")).toContain("Applied 1");
  });
});

describe("defaultOpenBrowser error safety", () => {
  it("absorbs an async spawn error so a missing opener cannot crash Bearing", () => {
    const child = new EventEmitter() as unknown as ChildProcess;
    let unrefed = false;
    (child as { unref(): void }).unref = () => {
      unrefed = true;
    };
    const spawnFn = () => child;

    expect(() => defaultOpenBrowser("http://127.0.0.1:1/", spawnFn)).not.toThrow();
    expect(unrefed).toBe(true);
    // Emitting `error` throws on an EventEmitter with no listener; the attached
    // listener must absorb it. This fails the moment the `.on("error")` guard is removed.
    expect(() => child.emit("error", new Error("spawn ENOENT"))).not.toThrow();
  });
});
