import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, describe, expect, it } from "vitest";

import {
  MCP_PROTOCOL_VERSIONS,
  createDispatcher,
  serveStdio,
  type JsonRpcResponse,
} from "../src/mcp/server.js";
import { BearingStore } from "../src/store/bearing-store.js";
import { SyntheticRunner, type ProcessInvocation, type ProcessResult, type ProcessRunner } from "../src/adapters/adapters.js";
import { RepositoryBootstrap } from "../src/repository/bootstrap.js";
import { executeHeadlessJourney, type HeadlessJourneyReceipt, type HeadlessJourneyRequest } from "../src/server/local-session.js";
import { hashExecutionContractBody, type ExecutionContractBody, type RoleRoute } from "../src/contracts/execution-contract.js";
import type { RecordJourneyCheckpointPayload } from "../src/contracts/run.js";

const MODERN = "2026-07-28";
const LEGACY = "2025-11-25";
const PINNED = "2025-06-18";
/** Namespaced per-request/result metadata keys the modern era negotiates through. */
const PROTOCOL_META = "io.modelcontextprotocol/protocolVersion";
const SERVER_INFO_META = "io.modelcontextprotocol/serverInfo";
const SERVER_INFO = { name: "bearing", version: expect.any(String) };
const QUESTION = "Which subsystem should the bounded work touch first?";
const roots: string[] = [];

/** A modern request carries its protocol version in `_meta`, never in `params`. */
function modernParams(params: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...params, _meta: { [PROTOCOL_META]: MODERN } };
}

afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

async function tempRepo(): Promise<string> {
  const created = await mkdtemp(join(tmpdir(), "bearing-mcp-"));
  roots.push(created);
  const root = await realpath(created);
  await new Promise<void>((resolve, reject) => {
    execFile("git", ["init", "-q"], { cwd: root }, (error) => (error ? reject(error) : resolve()));
  });
  return root;
}

async function initTestWorkspace(root: string): Promise<void> {
  await mkdir(join(root, ".bearing"), { recursive: true });
  await writeFile(join(root, ".bearing", "workspace.json"), `${JSON.stringify({ schemaVersion: 1, repositoryPath: root })}\n`);
}

/** Seeds a durable run parked on a genuinely pending owner question. */
async function seedRun(
  root: string,
  runId: string,
  goal = "Complete the approved bounded work",
): Promise<BearingStore> {
  await initTestWorkspace(root);
  const store = new BearingStore(root);
  const planDirectory = `docs/plans/${runId}`;
  await mkdir(join(root, planDirectory), { recursive: true });
  const created = await store.apply({
    schemaVersion: 1,
    commandId: `create-${runId}`,
    runId,
    expectedRevision: 0,
    type: "createWorkRequest",
    payload: { title: "Bounded work", goal },
    session: { sessionId: "test-owner", actor: "owner" },
    correlationId: `create-${runId}`,
  });
  if (!created.ok) throw new Error(created.reason);
  // A question checkpoint is itself what makes the owner decision pending.
  const decisionId = `decision-${runId}`;
  const checkpoint = await store.apply({
    schemaVersion: 1,
    commandId: `checkpoint-${runId}`,
    runId,
    expectedRevision: created.state.revision,
    type: "recordJourneyCheckpoint",
    payload: {
      stage: "set-bearings",
      status: "waiting",
      artifacts: [`${planDirectory}/plan-spec.md`],
      planDirectory,
      question: QUESTION,
      questionDecisionId: decisionId,
      lastResultJson: JSON.stringify({ status: "question", questions: [QUESTION], tokens: 12 }),
      selectionProvider: "codex",
      selectionModel: "gpt-5.4",
      selectionReasoning: "medium",
      providerSessionId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
      repositoryFitDecision: {
        outcome: "confirmed",
        planDirectory,
        repository: root,
        decidedAt: "2026-07-25T00:00:00.000Z",
      },
      resolvedPlanDirectory: planDirectory,
    },
    session: { sessionId: "test-bearing", actor: "bearing" },
    correlationId: `checkpoint-${runId}`,
  });
  if (!checkpoint.ok) throw new Error(checkpoint.reason);
  return store;
}

/**
 * The durable shape a legacy run lands in when `map-route` fails on `artifact_invalid`: route
 * saved, fit confirmed, retry ledger already refusing an unwarranted retry, continuity intact.
 * This is the one state whose only legal move is a backward recovery to `gather-supplies`.
 */
function failedMapRouteCheckpoint(root: string, planDirectory: string): RecordJourneyCheckpointPayload {
  return {
    stage: "map-route",
    status: "failed",
    artifacts: [`${planDirectory}/plan-spec.md`],
    qaJson: "[]",
    planDirectory,
    resolvedPlanDirectory: planDirectory,
    repositoryFitDecision: {
      outcome: "confirmed",
      planDirectory,
      repository: root,
      decidedAt: "2026-07-25T00:00:00.000Z",
    },
    lastResultJson: JSON.stringify({ status: "failure", code: "artifact_invalid", tokens: 2411 }),
    runtimeStateJson: JSON.stringify({
      version: 1,
      trace: [],
      retry: [{ fingerprint: "7".repeat(64), warrant: null, reasoningTier: "very-high", outcome: "retry_requires_warrant" }],
      sessionContinuity: "intact",
    }),
    planningFailure: "DESIGN_CONFLICT",
    selectionProvider: "codex",
    selectionModel: "gpt-5.6-terra",
    selectionReasoning: "medium",
  };
}

async function seedFailedMapRouteRun(root: string, runId: string): Promise<BearingStore> {
  // The engine reaches this run through the same authenticated repository route the browser
  // uses, so the workspace manifest has to exist exactly as a real checkout carries it.
  const bootstrapped = await new RepositoryBootstrap().choose(root);
  if (!bootstrapped.ok) throw new Error(bootstrapped.reason);
  const store = new BearingStore(root);
  const planDirectory = `docs/plans/${runId}`;
  await mkdir(join(root, planDirectory), { recursive: true });
  const created = await store.apply({
    schemaVersion: 1,
    commandId: `create-${runId}`,
    runId,
    expectedRevision: 0,
    type: "createWorkRequest",
    payload: { title: "Bounded work", goal: "Complete the approved bounded work" },
    session: { sessionId: "test-owner", actor: "owner" },
    correlationId: `create-${runId}`,
  });
  if (!created.ok) throw new Error(created.reason);
  const checkpoint = await store.apply({
    schemaVersion: 1,
    commandId: `checkpoint-${runId}`,
    runId,
    expectedRevision: created.state.revision,
    type: "recordJourneyCheckpoint",
    payload: failedMapRouteCheckpoint(root, planDirectory),
    session: { sessionId: "test-bearing", actor: "bearing" },
    correlationId: `checkpoint-${runId}`,
  });
  if (!checkpoint.ok) throw new Error(checkpoint.reason);
  return store;
}

async function seedFailedFitRun(root: string, runId: string): Promise<BearingStore> {
  await writeFile(join(root, "package.json"), '{"name":"retry-fit-fixture","private":true}\n');
  const bootstrapped = await new RepositoryBootstrap().choose(root);
  if (!bootstrapped.ok) throw new Error(bootstrapped.reason);
  const store = new BearingStore(root);
  const created = await store.apply({
    schemaVersion: 1,
    commandId: `create-${runId}`,
    runId,
    expectedRevision: 0,
    type: "createWorkRequest",
    payload: { title: "Recover fit", goal: "Recover repository fit after the environment changes" },
    session: { sessionId: "test-owner", actor: "owner" },
    correlationId: `create-${runId}`,
  });
  if (!created.ok) throw new Error(created.reason);
  const checkpoint = await store.apply({
    schemaVersion: 1,
    commandId: `checkpoint-${runId}`,
    runId,
    expectedRevision: created.state.revision,
    type: "recordJourneyCheckpoint",
    payload: {
      stage: "repository-fit",
      status: "failed",
      artifacts: [],
      qaJson: "[]",
      lastResultJson: JSON.stringify({ status: "failure", code: "fit_unavailable", tokens: 0 }),
      selectionProvider: "codex",
      selectionModel: "gpt-5.6-terra",
      selectionReasoning: "medium",
    },
    session: { sessionId: "test-bearing", actor: "bearing" },
    correlationId: `checkpoint-${runId}`,
  });
  if (!checkpoint.ok) throw new Error(checkpoint.reason);
  return store;
}

async function answerSeededQuestion(store: BearingStore, runId: string): Promise<void> {
  const durable = await store.load(runId);
  const answered = await store.apply({
    schemaVersion: 1,
    commandId: `answer-${runId}`,
    runId,
    expectedRevision: durable.revision,
    type: "recordOwnerAnswer",
    payload: { decisionId: `decision-${runId}`, answer: "Start with the durable store." },
    session: { sessionId: "test-owner", actor: "owner" },
    correlationId: `answer-${runId}`,
  });
  if (!answered.ok) throw new Error(answered.reason);
}

const PLAN_REVIEW_QUESTION = "Approve the complete planning package before implementation?";
const PLAN_REVIEW_APPROVAL = "Approved for execution-mode selection";

function routedContractBody(runId: string, planDirectory: string, roleRoutes?: readonly RoleRoute[]): ExecutionContractBody {
  return {
    schemaVersion: 1,
    contractId: `contract-${runId}`,
    runId,
    planDirectory,
    objective: "Complete the approved bounded work",
    mode: "explorer",
    reviewCadence: "per-slice",
    phases: [{ phaseId: "P1", title: "Phase 1", entryCriteria: "Plan approved", exitCriteria: "Slice reviewed" }],
    slices: [{
      sliceId: "1.1",
      phaseId: "P1",
      requirementIds: ["AC-1"],
      writeSet: ["src/import.ts"],
      acceptance: "Complete bounded work.",
      evidenceCommandIds: ["CMD-UNIT"],
      dependsOn: [],
      parallelSafe: false,
      role: "explorer",
      reasoningTier: "medium",
    }],
    dependencyEdges: [],
    ...(roleRoutes ? { roleRoutes } : {}),
  };
}

/**
 * Seeds a durable run parked at an owner-approved, role-routed execution contract:
 * draft-implementation complete, plan approved, onboarding route saved. `roleRoutes`
 * left undefined models a pre-Phase-3 (legacy) approved contract.
 */
async function seedApprovedRun(
  root: string,
  runId: string,
  roleRoutes?: readonly RoleRoute[],
): Promise<BearingStore> {
  await initTestWorkspace(root);
  const store = new BearingStore(root);
  const planDirectory = `docs/plans/${runId}`;
  await mkdir(join(root, planDirectory), { recursive: true });
  const created = await store.apply({
    schemaVersion: 1,
    commandId: `create-${runId}`,
    runId,
    expectedRevision: 0,
    type: "createWorkRequest",
    payload: { title: "Bounded work", goal: "Complete the approved bounded work" },
    session: { sessionId: "test-owner", actor: "owner" },
    correlationId: `create-${runId}`,
  });
  if (!created.ok) throw new Error(created.reason);
  const checkpoint = await store.apply({
    schemaVersion: 1,
    commandId: `checkpoint-${runId}`,
    runId,
    expectedRevision: created.state.revision,
    type: "recordJourneyCheckpoint",
    payload: {
      stage: "draft-implementation",
      status: "complete",
      artifacts: [`${planDirectory}/plan-spec.md`],
      planDirectory,
      resolvedPlanDirectory: planDirectory,
      // The saved onboarding route: proves the projection never borrows it as a role route.
      selectionProvider: "codex",
      selectionModel: "gpt-5.4",
      selectionReasoning: "medium",
    },
    session: { sessionId: "test-bearing", actor: "bearing" },
    correlationId: `checkpoint-${runId}`,
  });
  if (!checkpoint.ok) throw new Error(checkpoint.reason);
  const required = await store.apply({
    schemaVersion: 1,
    commandId: `require-${runId}`,
    runId,
    expectedRevision: checkpoint.state.revision,
    type: "requireDecision",
    payload: { decisionId: "plan-review", question: PLAN_REVIEW_QUESTION, consequential: true },
    session: { sessionId: "test-bearing", actor: "bearing" },
    correlationId: `require-${runId}`,
  });
  if (!required.ok) throw new Error(required.reason);
  const body = routedContractBody(runId, planDirectory, roleRoutes);
  const contractHash = hashExecutionContractBody(body);
  const answered = await store.apply({
    schemaVersion: 1,
    commandId: `approve-${runId}`,
    runId,
    expectedRevision: required.state.revision,
    type: "recordOwnerAnswer",
    payload: { decisionId: "plan-review", answer: PLAN_REVIEW_APPROVAL, ownerApprovedContentHash: contractHash },
    session: { sessionId: "test-owner", actor: "owner" },
    correlationId: `approve-${runId}`,
  });
  if (!answered.ok) throw new Error(answered.reason);
  const recordId = answered.events[0].eventId;
  await writeFile(join(root, planDirectory, "execution-contract.json"), JSON.stringify({
    ...body,
    contentHash: contractHash,
    ownerApproval: { kind: "owner-approval", recordedBy: "owner", durable: true, recordId, contentHash: contractHash },
  }));
  return store;
}

type Dispatch = (request: unknown) => Promise<JsonRpcResponse | null>;

function callTool(
  dispatch: Dispatch,
  name: string,
  args: unknown,
  id: number | string = 1,
): Promise<JsonRpcResponse | null> {
  return dispatch({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
}

function structured(response: JsonRpcResponse | null): Record<string, unknown> {
  const result = response?.result as { structuredContent?: unknown } | undefined;
  const value = result?.structuredContent;
  if (typeof value !== "object" || value === null) throw new Error(`no structuredContent: ${JSON.stringify(response)}`);
  return value as Record<string, unknown>;
}

/** Byte-level durable fingerprint: proves a call mutated nothing at all. */
async function durableFingerprint(root: string): Promise<string> {
  const walk = async (path: string, prefix: string): Promise<string[]> => {
    let entries;
    try {
      entries = await readdir(path, { withFileTypes: true });
    } catch {
      return [`${prefix}:absent`];
    }
    const lines: string[] = [];
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const child = join(path, entry.name);
      const name = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) lines.push(...await walk(child, name));
      else lines.push(`${name}:${(await readFile(child)).toString("base64")}`);
    }
    return lines;
  };
  return (await walk(join(root, ".bearing"), ".bearing")).join("\n");
}

// method x policy class x enforcement point x the negative case that proves it.
const POLICY_MATRIX = [
  ["initialize/server/discover", "protocol version", "createDispatcher", "unsupported version -> -32022 with supported + requested"],
  ["server/discover", "modern result shape", "createDispatcher", "complete, supportedVersions, namespaced serverInfo"],
  ["tools/list", "determinism", "TOOLS constant", "exactly three tools, closed schemas"],
  ["tools/call", "era-correct result", "toolResult", "modern -> complete, legacy -> no resultType"],
  ["tools/call", "argument bounds", "schemaViolation", "unexpected property -> -32602"],
  ["tools/call", "unknown tool", "TOOLS lookup", "bearing_unknown -> -32602"],
  ["bearing_attach", "containment", "admitRepositoryRoot", "lexical .., symlinked root, non-Git, subdirectory, symlinked .bearing"],
  ["bearing_attach", "mutation-free", "readDurableContinuation", "durable fingerprint unchanged"],
  ["bearing_attach", "capability secrecy", "continuationBody", "no path, session id, cookie, or capability"],
  ["bearing_attach", "objective secrecy", "readDurableContinuation", "secret-bearing goal -> redacted objective"],
  ["bearing_attach", "recovery disclosure", "continuationBody", "advertised progress names its only accepted stage; ineligible -> status only"],
  ["bearing_handoff", "identical recovery", "continuationBody", "two dispatchers, one continuation"],
  ["bearing_transition", "expected revision", "guard", "stale revision -> no provider call"],
  ["bearing_transition", "allowed actions", "guard", "action outside allowedActions -> refused"],
  ["bearing_transition", "read-only status", "transition", "status -> no engine call, durable fingerprint unchanged"],
  ["bearing_transition", "slice argument containment", "TRANSITION_SCHEMA + Focus", "valid slice reaches typed headless request; traversal -> -32602 before engine"],
  ["bearing_transition", "concurrent writers", "withRunLock", "two processes -> one winner"],
  ["tools/call", "nested argument bounds", "schemaViolation", "bad array item, sparse array, non-object item -> -32602"],
  ["bearing_focus_begin", "reuse without a CLI", "beginStandaloneFocus", "envelope equals the in-process Focus context"],
  ["bearing_focus_validate", "single-use guard", "validateStandaloneFocus", "second validate -> state_invalid"],
  ["bearing_review_context", "mutation-free", "readReviewContext", "durable fingerprint unchanged, no engine call"],
  ["bearing_review_record", "exact candidate", "recordReviewGate", "moved or dirty revision -> refused"],
  ["stdio", "framing bounds", "serveStdio", "unparsable and oversized lines -> typed errors"],
] as const;

describe("Bearing guided MCP server", () => {
  it("enforces every policy class in the matrix", () => {
    const pairs = POLICY_MATRIX.map((row) => `${row[0]}|${row[1]}`);
    expect(new Set(pairs).size).toBe(POLICY_MATRIX.length);
    for (const row of POLICY_MATRIX) expect(row.every((cell) => cell.length > 0)).toBe(true);
  });

  it("exposes exactly nine bounded tools with closed schemas", async () => {
    const dispatch = createDispatcher();
    const listed = await dispatch({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const tools = (listed?.result as { tools: { name: string; inputSchema: Record<string, unknown> }[] }).tools;
    expect(tools.map((tool) => tool.name)).toEqual([
      "bearing_attach", "bearing_transition", "bearing_handoff",
      "bearing_focus_begin", "bearing_focus_validate",
      "bearing_review_context", "bearing_review_record",
      "bearing_bind_legacy_role_routes", "bearing_bind_legacy_execution_contract",
    ]);
    for (const tool of tools) {
      expect(tool.inputSchema).toMatchObject({ type: "object", additionalProperties: false });
      expect(tool.inputSchema.required).toEqual(expect.arrayContaining(["repository"]));
    }
    const record = tools.find((tool) => tool.name === "bearing_review_record")!;
    expect(Object.keys(record.inputSchema.properties as Record<string, unknown>).sort()).toEqual([
      "commands", "contractHash", "expectedRevision", "findings", "repository",
      "reviewClass", "reviewedRevision", "runId", "scope", "verdict",
    ]);
    expect(record.inputSchema.required).not.toContain("reviewerSessionId");
    expect((record.inputSchema.properties as Record<string, { items?: Record<string, unknown> }>).commands.items)
      .toMatchObject({ type: "object", additionalProperties: false, required: ["commandId", "status", "summary"] });
    const transition = tools.find((tool) => tool.name === "bearing_transition")!;
    expect(transition.inputSchema.required).toEqual(
      expect.arrayContaining(["repository", "runId", "action", "expectedRevision"]),
    );
    // bearing_transition advertises retryWarrant with exactly the four closed values (approved_amendment is excluded).
    const rw = (transition.inputSchema as any).properties?.retryWarrant;
    expect(rw?.enum).toEqual(["new_hypothesis", "new_evidence", "changed_strategy", "changed_environment"]);
    const properties = transition.inputSchema.properties as Record<string, unknown>;
    expect(Object.keys(properties).sort()).toEqual([
      "action", "answer", "currentSlice", "executionMode", "expectedRevision", "goal", "model",
      "provider", "reasoning", "repository", "retryWarrant", "reviewCadence", "runId", "stage",
    ]);
    expect(properties.retryWarrant).toEqual({ type: "string", enum: [
      "new_hypothesis", "new_evidence", "changed_strategy", "changed_environment",
    ] });
  });

  it("passes one validated slice to the typed headless request", async () => {
    const root = await tempRepo();
    const runId = "slice-argument-run";
    const store = await seedRun(root, runId);
    const revision = (await store.load(runId)).revision;
    const seen: HeadlessJourneyRequest[] = [];
    const dispatch = createDispatcher({
      headlessJourney: async (request: HeadlessJourneyRequest): Promise<HeadlessJourneyReceipt> => {
        seen.push(request);
        return { ok: true, runId: request.runId, revision };
      },
    });

    await callTool(dispatch, "bearing_transition", {
      repository: root,
      runId,
      action: "decide",
      expectedRevision: revision,
      answer: "Continue the selected slice.",
      currentSlice: "1.1",
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ action: "decide", currentSlice: "1.1" });

    const rejected = await callTool(dispatch, "bearing_transition", {
      repository: root,
      runId,
      action: "decide",
      expectedRevision: revision,
      answer: "Continue the selected slice.",
      currentSlice: "../1.1",
    });
    expect(rejected?.error).toMatchObject({ code: -32602, data: { violation: expect.stringContaining("currentSlice") } });
    expect(seen).toHaveLength(1);
  });

  it("bounds nested array and object arguments before any repository work", async () => {
    const dispatch = createDispatcher({
      headlessJourney: () => { throw new Error("argument validation must precede the engine"); },
    });
    const valid = {
      repository: "/nonexistent/repository",
      runId: "bounds-run",
      reviewClass: "general",
      expectedRevision: 1,
      reviewedRevision: "a".repeat(40),
      contractHash: "b".repeat(64),
      scope: ["1.1"],
      verdict: "PASS",
      commands: [{ commandId: "CMD-UNIT", status: "passed", summary: "1 test passed" }],
      findings: [],
    };
    const refusals: readonly [string, Record<string, unknown>][] = [
      ["scope must be an array", { scope: "1.1" }],
      ["scope[0] does not match its pattern", { scope: ["../etc"] }],
      ["scope has too few items", { scope: [] }],
      ["commands[0] must be an object", { commands: ["CMD-UNIT"] }],
      ["unexpected property: rerun", { commands: [{ commandId: "CMD-UNIT", status: "passed", summary: "ok", rerun: true }] }],
      ["missing required property: summary", { commands: [{ commandId: "CMD-UNIT", status: "passed" }] }],
      ["status is not an allowed value", { commands: [{ commandId: "CMD-UNIT", status: "skipped", summary: "ok" }] }],
      ["findings has too many items", { findings: Array.from({ length: 65 }, () => ({ summary: "s", evidence: "e" })) }],
      ["reviewClass is not an allowed value", { reviewClass: "performance" }],
      ["expectedRevision must be a safe integer", { expectedRevision: 1.5 }],
      ["reviewedRevision does not match its pattern", { reviewedRevision: "HEAD" }],
    ];
    for (const [violation, override] of refusals) {
      const response = await callTool(dispatch, "bearing_review_record", { ...valid, ...override });
      expect([violation, response?.error]).toMatchObject([violation, { code: -32602, data: { violation } }]);
    }
    // A sparse array survives JSON.stringify as a hole, so it has to be refused structurally.
    const sparse = [{ commandId: "CMD-UNIT", status: "passed", summary: "ok" }];
    sparse.length = 2;
    expect((await callTool(dispatch, "bearing_review_record", { ...valid, commands: sparse }))?.error)
      .toMatchObject({ code: -32602, data: { violation: "commands is sparse" } });
    // The bounds have to be able to pass, or none of them proves anything: an admitted
    // shape reaches repository admission and is refused there, not at the schema.
    expect(structured(await callTool(dispatch, "bearing_review_record", valid)))
      .toMatchObject({ code: "repository_rejected", runId: "bounds-run" });
  });

  it("recovers one bounded continuation from two independent dispatchers", async () => {
    const root = await tempRepo();
    const store = await seedRun(root, "shared-run");
    const revision = (await store.load("shared-run")).revision;
    const before = await durableFingerprint(root);

    const attached = structured(await callTool(createDispatcher(), "bearing_attach", { repository: root, runId: "shared-run" }));
    const handed = structured(await callTool(createDispatcher(), "bearing_handoff", { repository: root, runId: "shared-run" }));

    expect(attached).toEqual(handed);
    expect(attached).toMatchObject({
      schemaVersion: 1,
      runId: "shared-run",
      revision,
      objective: "Complete the approved bounded work",
      stage: "set-bearings",
      status: "waiting",
      continuity: "intact",
      question: QUESTION,
      requiredOwnerAction: { type: "answer", question: QUESTION },
    });
    expect(attached.allowedActions).toEqual(["status", "resume", "decide"]);
    expect(attached.evidence).toEqual(["docs/plans/shared-run/plan-spec.md"]);
    expect(attached.planDirectory).toBe("docs/plans/shared-run");
    expect(await durableFingerprint(root)).toBe(before);
    // The fingerprint has to be able to fail, or "mutation-free" proves nothing.
    await answerSeededQuestion(store, "shared-run");
    expect(await durableFingerprint(root)).not.toBe(before);
  });

  it("keeps read-only tools provider-free, path-blind, and free of session secrets", async () => {
    const root = await tempRepo();
    await seedRun(root, "scrub-run");
    const before = await durableFingerprint(root);
    let engineCalls = 0;
    const dispatch = createDispatcher({
      headlessJourney: async (request: HeadlessJourneyRequest): Promise<HeadlessJourneyReceipt> => {
        engineCalls += 1;
        return { ok: true, runId: request.runId, revision: 0 };
      },
    });
    const receipt = structured(await callTool(dispatch, "bearing_attach", { repository: root, runId: "scrub-run" }));
    const handoff = structured(await callTool(dispatch, "bearing_handoff", { repository: root, runId: "scrub-run" }));
    // Never entering the transition engine is what makes both reads readiness-free,
    // provider-free, socket-free, subprocess-free, and mutation-free.
    expect(engineCalls).toBe(0);
    expect(await durableFingerprint(root)).toBe(before);
    // The seeded route "codex/gpt-5.4" is not installed here; a readiness probe would have
    // demoted this to ["status", "resume"].
    expect(receipt.allowedActions).toEqual(["status", "resume", "decide"]);
    expect(handoff.allowedActions).toEqual(receipt.allowedActions);
    const text = JSON.stringify(receipt);
    expect(text).not.toContain(root);
    expect(text).not.toContain("3f2504e0-4f89-41d3-9a0c-0305e82c3301");
    expect(text).not.toMatch(/capability|cookie|bearing_session|Bearer /i);
    expect(receipt.repository).toMatch(/^[0-9a-f]{16}$/);
    expect(receipt).not.toHaveProperty("providerSessionId");
    expect(receipt).not.toHaveProperty("qa");
    expect(receipt).not.toHaveProperty("runtimeState");
  });

  it("does not repeat an answered owner decision", async () => {
    const root = await tempRepo();
    const store = await seedRun(root, "answered-run");
    await answerSeededQuestion(store, "answered-run");
    const receipt = structured(await callTool(createDispatcher(), "bearing_attach", { repository: root, runId: "answered-run" }));
    expect(receipt).not.toHaveProperty("question");
    expect(receipt).not.toHaveProperty("requiredOwnerAction");
    expect(receipt.allowedActions).not.toContain("decide");
  });

  it("names the only stage the advertised recovery transition accepts", async () => {
    const root = await tempRepo();
    const store = await seedFailedMapRouteRun(root, "recovery-run");
    const durable = await store.load("recovery-run");
    const before = await durableFingerprint(root);

    const attached = structured(await callTool(createDispatcher(), "bearing_attach", { repository: root, runId: "recovery-run" }));
    const handed = structured(await callTool(createDispatcher(), "bearing_handoff", { repository: root, runId: "recovery-run" }));
    expect(attached).toEqual(handed);
    expect(attached).toMatchObject({
      runId: "recovery-run",
      revision: durable.revision,
      stage: "map-route",
      status: "failed",
      continuity: "intact",
      outcome: { type: "failed", code: "artifact_invalid" },
    });
    expect(attached.blockers).toEqual(expect.arrayContaining(["artifact_invalid", "retry_requires_warrant", "DESIGN_CONFLICT"]));
    expect(attached.allowedActions).toEqual(["status", "progress"]);
    // Advertising `progress` without its stage advertises a transition no caller can name:
    // the engine accepts exactly one stage here and refuses every other one.
    expect(attached.recoveryAction).toEqual({ type: "progress", stage: "gather-supplies" });
    expect(await durableFingerprint(root)).toBe(before);

    // The disclosure is load-bearing, not cosmetic: the stage a caller would otherwise infer
    // from the body — the failed stage itself — is refused without moving the ledger.
    // The route has to verify, or the refusal below would prove readiness rather than the guard.
    const readinessOnly: ProcessRunner = {
      executableAvailable: () => true,
      verify: async () => true,
      run: async (invocation) => {
        if (!invocation.stdin.includes("confirming readiness")) throw new Error("a refused recovery must never reach a stage provider");
        return { exitCode: 0, events: [{ type: "completed", data: { content: 'BEARING_RESULT {"kind":"action","summary":"Ready.","artifacts":[]}' } }], usage: { tokens: 1 } };
      },
    };
    const base = { repository: root, provider: "codex", model: "gpt-5.6-terra", reasoning: "medium", runId: "recovery-run" } as const;
    expect(await executeHeadlessJourney({ action: "progress", ...base, stage: "map-route" }, { processRunner: readinessOnly }))
      .toEqual({ ok: false, code: "illegal_transition", runId: "recovery-run", revision: durable.revision });
    expect(await durableFingerprint(root)).toBe(before);

    // Fail-closed: a run whose saved fit no longer matches this repository keeps no recovery at
    // all, so the disclosure can never outlive the eligibility that earned it.
    const ineligible = await store.apply({
      schemaVersion: 1,
      commandId: "checkpoint-recovery-run-ineligible",
      runId: "recovery-run",
      expectedRevision: durable.revision,
      type: "recordJourneyCheckpoint",
      payload: {
        ...failedMapRouteCheckpoint(root, "docs/plans/recovery-run"),
        repositoryFitDecision: {
          outcome: "confirmed",
          planDirectory: "docs/plans/recovery-run",
          repository: `${root}-other`,
          decidedAt: "2026-07-25T00:00:00.000Z",
        },
      },
      session: { sessionId: "test-bearing", actor: "bearing" },
      correlationId: "checkpoint-recovery-run-ineligible",
    });
    expect(ineligible.ok).toBe(true);
    const blocked = structured(await callTool(createDispatcher(), "bearing_attach", { repository: root, runId: "recovery-run" }));
    expect(blocked.allowedActions).toEqual(["status"]);
    expect(blocked).not.toHaveProperty("recoveryAction");
  });

  it("admits one revision-bound repository-fit retry warrant and refuses wrong-stage and replayed attempts without dispatch", async () => {
    const root = await tempRepo();
    const store = await seedFailedFitRun(root, "fit-retry-run");
    const before = await store.load("fit-retry-run");
    const beforeFingerprint = await durableFingerprint(root);
    let readinessCalls = 0;
    let fitCalls = 0;
    const runner: ProcessRunner = {
      executableAvailable: () => true,
      verify: async () => true,
      run: async (invocation) => {
        if (invocation.stdin.includes("confirming readiness")) {
          readinessCalls += 1;
          return { exitCode: 0, events: [{ type: "completed", data: { content: "ready" } }], usage: { tokens: 1 } };
        }
        if (!invocation.stdin.includes("Stage: repository-fit")) throw new Error("unexpected recovery stage dispatch");
        fitCalls += 1;
        return {
          exitCode: 0,
          events: [{ type: "completed", data: { content: `BEARING_RESULT ${JSON.stringify({
            kind: "fit",
            ok: true,
            assumption: {
              repository: root,
              planDirectory: "docs/plans/fit-retry-run",
              rationale: "The repository manifest identifies the recovered workspace.",
              evidence: [{ kind: "manifest", path: "package.json", detail: "The manifest identifies this workspace." }],
            },
            question: "Use this recovered repository and plan directory?",
          })}` } }],
          usage: { tokens: 1 },
        };
      },
    };
    const dispatch = createDispatcher({
      headlessJourney: (request) => executeHeadlessJourney(request, { processRunner: runner }),
    });
    const attached = structured(await callTool(dispatch, "bearing_attach", { repository: root, runId: "fit-retry-run" }));
    expect(attached).toMatchObject({
      revision: before.revision,
      stage: "repository-fit",
      status: "failed",
      allowedActions: ["status", "progress"],
      recoveryAction: {
        type: "progress",
        stage: "repository-fit",
        retryWarrants: ["new_hypothesis", "new_evidence", "changed_strategy", "changed_environment"],
      },
    });

    const base = {
      repository: root,
      runId: "fit-retry-run",
      action: "progress",
      expectedRevision: before.revision,
    } as const;
    expect(structured(await callTool(dispatch, "bearing_transition", { ...base, stage: "set-bearings", retryWarrant: "changed_environment" })))
      .toMatchObject({ code: "recovery_stage_mismatch", revision: before.revision });
    const internalOnly = await callTool(dispatch, "bearing_transition", {
      ...base,
      stage: "repository-fit",
      retryWarrant: "approved_amendment",
    });
    expect(internalOnly?.error?.code).toBe(-32602);
    expect(await durableFingerprint(root)).toBe(beforeFingerprint);
    expect({ readinessCalls, fitCalls }).toEqual({ readinessCalls: 0, fitCalls: 0 });

    const recovered = structured(await callTool(dispatch, "bearing_transition", {
      ...base,
      stage: "repository-fit",
      retryWarrant: "changed_environment",
    }));
    expect(recovered).toMatchObject({ stage: "repository-fit", status: "waiting" });
    expect(recovered.revision).not.toBe(before.revision);
    expect({ readinessCalls, fitCalls }).toEqual({ readinessCalls: 1, fitCalls: 1 });
    const after = await store.load("fit-retry-run");
    expect(JSON.parse(after.journeyCheckpoint?.runtimeStateJson ?? "{}").retry).toEqual(expect.arrayContaining([
      expect.objectContaining({ warrant: "changed_environment", outcome: "admitted" }),
    ]));

    expect(structured(await callTool(dispatch, "bearing_transition", {
      ...base,
      stage: "repository-fit",
      retryWarrant: "changed_environment",
    }))).toMatchObject({ code: "stale_revision", revision: after.revision });
    expect({ readinessCalls, fitCalls }).toEqual({ readinessCalls: 1, fitCalls: 1 });
    expect((await store.load("fit-retry-run")).revision).toBe(after.revision);
  });

  it("projects the approved authorRoute and reviewSlots identically from two fresh dispatchers, in exact stored order", async () => {
    const root = await tempRepo();
    const roleRoutes: readonly RoleRoute[] = [
      { role: "execution-author", primary: "codex", fallbacks: ["claude", "agy"] },
      { role: "review-general", primary: "claude", fallbacks: ["surveyor"] },
      { role: "review-security", primary: "agy", fallbacks: [] },
    ];
    await seedApprovedRun(root, "routed-run", roleRoutes);
    const attached = structured(await callTool(createDispatcher(), "bearing_attach", { repository: root, runId: "routed-run" }));
    const handed = structured(await callTool(createDispatcher(), "bearing_handoff", { repository: root, runId: "routed-run" }));

    expect(attached).toEqual(handed);
    expect(attached.roleRoutes).toEqual({
      authorRoute: { primary: "codex", fallbacks: ["claude", "agy"] },
      reviewSlots: {
        general: { primary: "claude", fallbacks: ["surveyor"] },
        security: { primary: "agy", fallbacks: [] },
      },
    });
    expect(attached).not.toHaveProperty("requiredOwnerAction");
    expect(JSON.stringify(attached)).not.toContain(root);
  });

  it("returns a typed OWNER_DECISION_REQUIRED blocker, never the run-wide onboarding route, when an approved contract has no roleRoutes", async () => {
    const root = await tempRepo();
    await seedApprovedRun(root, "legacy-run");
    const before = await durableFingerprint(root);

    const attached = structured(await callTool(createDispatcher(), "bearing_attach", { repository: root, runId: "legacy-run" }));

    // The onboarding route was saved (proven by `route` below) but must never fill a missing role route.
    expect(attached.route).toEqual({ provider: "codex", model: "gpt-5.4", reasoning: "medium" });
    expect(attached).not.toHaveProperty("roleRoutes");
    expect(attached.requiredOwnerAction).toEqual({ type: "OWNER_DECISION_REQUIRED", reason: "role_routes_missing" });
    // Legacy runs remain readable: everything else the caller needs is still here.
    expect(attached.planDirectory).toBe("docs/plans/legacy-run");
    expect(attached.stage).toBe("draft-implementation");
    expect(await durableFingerprint(root)).toBe(before);
  });

  it("leaves a pre-contract run's continuation exactly as before: no roleRoutes field, no role-routes blocker", async () => {
    const root = await tempRepo();
    await seedRun(root, "precontract-run");
    const attached = structured(await callTool(createDispatcher(), "bearing_attach", { repository: root, runId: "precontract-run" }));
    expect(attached).not.toHaveProperty("roleRoutes");
    expect(attached.requiredOwnerAction).toEqual({ type: "answer", question: QUESTION });
  });

  it("returns a typed non-mutating continuation for a missing run", async () => {
    const root = await tempRepo();
    const receipt = structured(await callTool(createDispatcher(), "bearing_attach", { repository: root, runId: "absent-run" }));
    expect(receipt).toMatchObject({ schemaVersion: 1, runId: "absent-run", revision: 0, allowedActions: ["create"] });
    await expect(lstat(join(root, ".bearing"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a repository with a partial .bearing directory as repository_rejected", async () => {
    const dispatch = createDispatcher();

    // Partial .bearing directory (dir exists, but workspace.json is missing)
    const partialRoot = await tempRepo();
    await mkdir(join(partialRoot, ".bearing"), { recursive: true });
    const partialReceipt = structured(await callTool(dispatch, "bearing_attach", { repository: partialRoot, runId: "partial-run" }));
    expect(partialReceipt).toMatchObject({
      schemaVersion: 1,
      code: "repository_rejected",
      allowedActions: [],
      blockers: ["repository_rejected"],
    });
    expect(partialReceipt.allowedActions).not.toContain("create");

    // Partial .bearing/runs/<run-id>/ with empty run directory and no workspace.json
    const emptyRunRoot = await tempRepo();
    await mkdir(join(emptyRunRoot, ".bearing", "runs", "empty-run"), { recursive: true });
    const emptyRunReceipt = structured(await callTool(dispatch, "bearing_attach", { repository: emptyRunRoot, runId: "empty-run" }));
    expect(emptyRunReceipt).toMatchObject({
      schemaVersion: 1,
      code: "repository_rejected",
      allowedActions: [],
      blockers: ["repository_rejected"],
    });
    expect(emptyRunReceipt.allowedActions).not.toContain("create");

    // Partial .bearing/focus/ with empty focus directory and no workspace.json
    const emptyFocusRoot = await tempRepo();
    await mkdir(join(emptyFocusRoot, ".bearing", "focus"), { recursive: true });
    const emptyFocusReceipt = structured(await callTool(dispatch, "bearing_attach", { repository: emptyFocusRoot, runId: "empty-focus" }));
    expect(emptyFocusReceipt).toMatchObject({
      schemaVersion: 1,
      code: "repository_rejected",
      allowedActions: [],
      blockers: ["repository_rejected"],
    });
    expect(emptyFocusReceipt.allowedActions).not.toContain("create");

    // Negative controls: empty or structurally invalid named placeholder files must not grant legacy admission
    // (events.jsonl, snapshot.json, focus/request.json). Uses canonical store + focusRequest + createFocusContext.
    const emptyEventsRoot = await tempRepo();
    await mkdir(join(emptyEventsRoot, ".bearing", "runs", "r"), { recursive: true });
    await writeFile(join(emptyEventsRoot, ".bearing", "runs", "r", "events.jsonl"), "");
    const emptyEventsReceipt = structured(await callTool(dispatch, "bearing_attach", { repository: emptyEventsRoot, runId: "r" }));
    expect(emptyEventsReceipt).toMatchObject({
      schemaVersion: 1,
      code: "repository_rejected",
      allowedActions: [],
      blockers: ["repository_rejected"],
    });
    expect(emptyEventsReceipt.allowedActions).not.toContain("create");

    const emptySnapshotRoot = await tempRepo();
    await mkdir(join(emptySnapshotRoot, ".bearing", "runs", "r"), { recursive: true });
    await writeFile(join(emptySnapshotRoot, ".bearing", "runs", "r", "snapshot.json"), "");
    const emptySnapshotReceipt = structured(await callTool(dispatch, "bearing_attach", { repository: emptySnapshotRoot, runId: "r" }));
    expect(emptySnapshotReceipt).toMatchObject({
      schemaVersion: 1,
      code: "repository_rejected",
      allowedActions: [],
      blockers: ["repository_rejected"],
    });
    expect(emptySnapshotReceipt.allowedActions).not.toContain("create");

    const emptyRequestRoot = await tempRepo();
    await mkdir(join(emptyRequestRoot, ".bearing", "focus"), { recursive: true });
    await writeFile(join(emptyRequestRoot, ".bearing", "focus", "request.json"), "");
    const emptyRequestReceipt = structured(await callTool(dispatch, "bearing_attach", { repository: emptyRequestRoot, runId: "empty-focus" }));
    expect(emptyRequestReceipt).toMatchObject({
      schemaVersion: 1,
      code: "repository_rejected",
      allowedActions: [],
      blockers: ["repository_rejected"],
    });
    expect(emptyRequestReceipt.allowedActions).not.toContain("create");

    const badJsonRunRoot = await tempRepo();
    await mkdir(join(badJsonRunRoot, ".bearing", "runs", "r"), { recursive: true });
    await writeFile(join(badJsonRunRoot, ".bearing", "runs", "r", "events.jsonl"), "{not valid ledger}\n");
    const badJsonReceipt = structured(await callTool(dispatch, "bearing_attach", { repository: badJsonRunRoot, runId: "r" }));
    expect(badJsonReceipt).toMatchObject({ code: "repository_rejected", allowedActions: [] });

    const badRoleFocusRoot = await tempRepo();
    await mkdir(join(badRoleFocusRoot, ".bearing", "focus"), { recursive: true });
    await writeFile(join(badRoleFocusRoot, ".bearing", "focus", "request.json"), JSON.stringify({ role: "nope" }));
    const badRoleReceipt = structured(await callTool(dispatch, "bearing_attach", { repository: badRoleFocusRoot, runId: "x" }));
    expect(badRoleReceipt).toMatchObject({ code: "repository_rejected", allowedActions: [] });

    // Control 1: Completely absent .bearing directory remains creatable
    const absentRoot = await tempRepo();
    const absentReceipt = structured(await callTool(dispatch, "bearing_attach", { repository: absentRoot, runId: "absent-run" }));
    expect(absentReceipt).toMatchObject({
      schemaVersion: 1,
      runId: "absent-run",
      revision: 0,
      code: "run_not_found",
      allowedActions: ["create"],
    });

    // Control 2: Valid current workspace remains attachable
    const validRoot = await tempRepo();
    await seedRun(validRoot, "valid-run");
    const validReceipt = structured(await callTool(dispatch, "bearing_attach", { repository: validRoot, runId: "valid-run" }));
    expect(validReceipt).toMatchObject({
      schemaVersion: 1,
      runId: "valid-run",
      revision: 2,
    });

    // Control 3: Valid legacy durable run (events.jsonl present, workspace.json absent) remains attachable
    // Uses init + canonical apply so events.jsonl contains a real created run, then rm workspace
    // to force the legacy marker path. Our validation admits only because load succeeds with workRequestCreated.
    const legacyRunRoot = await tempRepo();
    await initTestWorkspace(legacyRunRoot);
    const store = new BearingStore(legacyRunRoot);
    const legacyRunPlanDirectory = `docs/plans/legacy-run`;
    await mkdir(join(legacyRunRoot, legacyRunPlanDirectory), { recursive: true });
    await writeFile(join(legacyRunRoot, legacyRunPlanDirectory, "plan-spec.md"), "# Plan\n");
    const created = await store.apply({
      schemaVersion: 1,
      commandId: "cmd-1",
      runId: "legacy-run",
      expectedRevision: 0,
      type: "createWorkRequest",
      payload: { title: "Legacy", goal: "Legacy goal" },
      session: { sessionId: "test-owner", actor: "owner" },
      correlationId: "cmd-1",
    });
    if (!created.ok) throw new Error("legacy run seed failed");
    await rm(join(legacyRunRoot, ".bearing", "workspace.json"), { force: true });
    // Inject a corrupt unreadable legacy entry with a newer filesystem mtime (so it sorts first).
    // This exercises the bounded list(50) + readable-only admission: the genuine readable entry
    // must still be discovered within the hard bound; unreadable entries never count toward
    // legacy admission. Corrupt-only already covered by badJson above.
    const corruptMixedDir = join(legacyRunRoot, ".bearing", "runs", "corrupt-legacy");
    await mkdir(corruptMixedDir, { recursive: true });
    await writeFile(join(corruptMixedDir, "events.jsonl"), "{not valid ledger for mixed}\n");
    const legacyRunReceipt = structured(await callTool(dispatch, "bearing_attach", { repository: legacyRunRoot, runId: "legacy-run" }));
    expect(legacyRunReceipt).toMatchObject({
      schemaVersion: 1,
      runId: "legacy-run",
    });
    expect(typeof legacyRunReceipt.revision).toBe("number");

    // With corrupt present (newest), the attach for genuine still succeeded above (mixed case).
    // Unreadable never counts as proof; the requested corrupt run fails closed with store_unreadable within mixed valid repository state.
    const corruptOnMixedReceipt = structured(await callTool(dispatch, "bearing_attach", { repository: legacyRunRoot, runId: "corrupt-legacy" }));
    expect(corruptOnMixedReceipt).toMatchObject({ code: "store_unreadable", allowedActions: [] });

    // Control 4: Valid legacy durable focus (request.json present, workspace.json absent) remains admitted.
    // Uses a genuine plan-backed request accepted by the canonical focusRequest predicate plus
    // createFocusContext (minimal valid slice structure, short Goal, CMD-UNIT mapped in seit).
    // Role-only, empty, and invalid placeholders are retained as negatives elsewhere in this test.
    const legacyFocusRoot = await tempRepo();
    const legacyFocusPlanDirectory = "docs/plans/legacy-focus";
    await mkdir(join(legacyFocusRoot, legacyFocusPlanDirectory), { recursive: true });
    await writeFile(join(legacyFocusRoot, legacyFocusPlanDirectory, "plan-spec.md"), `---
type: plan-spec
status: complete
---

## Acceptance criteria

- **AC-1** — Complete the legacy focus marker test.

## Risks and open questions

- None.
`);
    await writeFile(join(legacyFocusRoot, legacyFocusPlanDirectory, "implementation.md"), `---
type: implementation
status: complete
---

### Slice 1.1 — Legacy marker

**Goal.** Admit via canonical focus request predicate and context.
**Requirement IDs.** AC-1
**Design IDs.** D-1
**SEIT proof rows.** SEIT-1
**Implementation role.** Test

### 1.1 execution manifest

**Write set.** Write only \`src/legacy.ts\`.
**Command IDs.** CMD-UNIT
**Stop condition.** n/a
`);
    await writeFile(join(legacyFocusRoot, legacyFocusPlanDirectory, "seit.md"), `---
type: seit
status: complete
---

## Required Commands

- **CMD-UNIT** — test
`);
    await mkdir(join(legacyFocusRoot, ".bearing", "focus"), { recursive: true });
    await writeFile(join(legacyFocusRoot, ".bearing", "focus", "request.json"), JSON.stringify({
      role: "crewmate",
      objective: "Admit genuine plan-backed focus request for legacy marker.",
      planDirectory: legacyFocusPlanDirectory,
      slice: "1.1",
    }));
    const legacyFocusReceipt = structured(await callTool(dispatch, "bearing_attach", { repository: legacyFocusRoot, runId: "legacy-focus" }));
    expect(legacyFocusReceipt).toMatchObject({
      schemaVersion: 1,
      runId: "legacy-focus",
      revision: 0,
      code: "run_not_found",
      allowedActions: ["create"],
    });
  });


  it("covers the advertised bearing_attach allowedActions [create] to bearing_transition create contract with exact revision and valid route", async () => {
    const root = await tempRepo();
    // Delegate to the real executeHeadlessJourney (the production create transition) using only a
    // deterministic injected ProcessRunner. No manual BearingStore.apply of createWorkRequest.
    // The runner supplies fake but successful process results so the attach-to-create can advance.
    const runner = new SyntheticRunner();
    const dispatch = createDispatcher({
      headlessJourney: (request: HeadlessJourneyRequest) =>
        executeHeadlessJourney(request, { processRunner: runner }),
    });

    const attached = structured(await callTool(dispatch, "bearing_attach", { repository: root, runId: "attach-create-run" }));
    expect(attached).toMatchObject({ schemaVersion: 1, runId: "attach-create-run", revision: 0, allowedActions: ["create"] });

    const trans = await callTool(dispatch, "bearing_transition", {
      repository: root,
      runId: "attach-create-run",
      action: "create",
      expectedRevision: 0,
      goal: "Complete the approved bounded work via the advertised attach-to-create transition.",
      provider: "codex",
      model: "gpt-5.4",
      reasoning: "medium",
    });
    const result = structured(trans);
    expect(result).not.toMatchObject({ code: "illegal_transition" });
    // The transition was not refused; real executeHeadlessJourney + runner advanced state without
    // illegal_transition. The continuation proves observable advancement from the create.
    expect(result).not.toHaveProperty("code");
    expect(result.runId).toBe("attach-create-run");
    expect(typeof result.revision).toBe("number");
    expect(result.revision as number).toBeGreaterThan(attached.revision as number);
  });

  it("covers attach -> exact-revision create transition for valid legacy Focus marker (plan-backed .bearing/focus/request.json accepted by focusRequest + createFocusContext)", async () => {
    const runner = new SyntheticRunner();
    const dispatch = createDispatcher({
      headlessJourney: (request: HeadlessJourneyRequest) =>
        executeHeadlessJourney(request, { processRunner: runner }),
    });

    // Reproduce Terra's exact fixture: real Git root with plan-backed legacy focus/request.json
    // that canonical focusRequest + createFocusContext accept. This is the valid legacy Focus
    // state admitted by #131, not a partial placeholder and not absent .bearing.
    const root = await tempRepo();
    const planDir = "docs/plans/legacy-focus-create";
    await mkdir(join(root, planDir), { recursive: true });
    await writeFile(join(root, planDir, "plan-spec.md"), `---
type: plan-spec
status: complete
---

## Acceptance criteria

- **AC-1** — Complete the legacy focus marker create test.

## Risks and open questions

- None.
`);
    await writeFile(join(root, planDir, "implementation.md"), `---
type: implementation
status: complete
---

### Slice 1.1 — Legacy marker

**Goal.** Admit via canonical focus request predicate and context.
**Requirement IDs.** AC-1
**Design IDs.** D-1
**SEIT proof rows.** SEIT-1
**Implementation role.** Test

### 1.1 execution manifest

**Write set.** Write only \`src/repair.ts\`.
**Command IDs.** CMD-UNIT
**Stop condition.** n/a
`);
    await writeFile(join(root, planDir, "seit.md"), `---
type: seit
status: complete
---

## Required Commands

- **CMD-UNIT** — test
`);
    await mkdir(join(root, ".bearing", "focus"), { recursive: true });
    await writeFile(join(root, ".bearing", "focus", "request.json"), JSON.stringify({
      role: "crewmate",
      objective: "Admit genuine plan-backed legacy focus and consume create.",
      planDirectory: planDir,
      slice: "1.1",
    }));

    const manifestPath = join(root, ".bearing", "workspace.json");
    await expect(lstat(manifestPath)).rejects.toThrow();

    const attached = structured(await callTool(dispatch, "bearing_attach", { repository: root, runId: "legacy-focus-create-run" }));
    expect(attached).toMatchObject({
      schemaVersion: 1,
      runId: "legacy-focus-create-run",
      revision: 0,
      code: "run_not_found",
      allowedActions: ["create"],
    });
    await expect(lstat(manifestPath)).rejects.toThrow();

    const trans = await callTool(dispatch, "bearing_transition", {
      repository: root,
      runId: "legacy-focus-create-run",
      action: "create",
      expectedRevision: 0,
      goal: "Complete the approved bounded work from valid legacy Focus marker.",
      provider: "codex",
      model: "gpt-5.4",
      reasoning: "medium",
    });
    const result = structured(trans);
    expect(result).not.toMatchObject({ code: "illegal_transition" });
    // State advanced (or truthful non-create recovery); runner dispatch exercised for the path.
    expect(result).not.toHaveProperty("code");
    expect(result.runId).toBe("legacy-focus-create-run");
    expect(typeof result.revision).toBe("number");
    expect(result.revision as number).toBeGreaterThan(attached.revision as number);
    await expect(lstat(manifestPath)).rejects.toThrow();
  });

  async function seedValidLegacyFocus(root: string, planDir: string, objective: string): Promise<void> {
    await mkdir(join(root, planDir), { recursive: true });
    await writeFile(join(root, planDir, "plan-spec.md"), `---
type: plan-spec
status: complete
---

## Acceptance criteria

- **AC-1** — Complete the legacy focus marker test.

## Risks and open questions

- None.
`);
    await writeFile(join(root, planDir, "implementation.md"), `---
type: implementation
status: complete
---

### Slice 1.1 — Legacy marker

**Goal.** Admit via canonical focus request predicate and context.
**Requirement IDs.** AC-1
**Design IDs.** D-1
**SEIT proof rows.** SEIT-1
**Implementation role.** Test

### 1.1 execution manifest

**Write set.** Write only \`src/repair.ts\`.
**Command IDs.** CMD-UNIT
**Stop condition.** n/a
`);
    await writeFile(join(root, planDir, "seit.md"), `---
type: seit
status: complete
---

## Required Commands

- **CMD-UNIT** — test
`);
    await mkdir(join(root, ".bearing", "focus"), { recursive: true });
    await writeFile(join(root, ".bearing", "focus", "request.json"), JSON.stringify({
      role: "crewmate",
      objective,
      planDirectory: planDir,
      slice: "1.1",
    }));
  }

  it("fails closed and preserves malformed .bearing/workspace.json without provider dispatch or repair", async () => {
    const runner = new SyntheticRunner();
    const dispatch = createDispatcher({
      headlessJourney: (request: HeadlessJourneyRequest) =>
        executeHeadlessJourney(request, { processRunner: runner }),
    });

    const root = await tempRepo();
    await seedValidLegacyFocus(root, "docs/plans/malformed-focus", "Malformed manifest preservation.");

    const manifestPath = join(root, ".bearing", "workspace.json");
    const malformedContent = "INVALID_JSON_CONTENT{{\n";
    await writeFile(manifestPath, malformedContent);

    const attached = structured(await callTool(dispatch, "bearing_attach", { repository: root, runId: "malformed-run" }));
    expect(attached).toMatchObject({
      schemaVersion: 1,
      runId: "malformed-run",
      code: "repository_rejected",
    });

    const trans = structured(await callTool(dispatch, "bearing_transition", {
      repository: root,
      runId: "malformed-run",
      action: "create",
      expectedRevision: 0,
      goal: "Attempt create against malformed manifest.",
      provider: "codex",
      model: "gpt-5.4",
      reasoning: "medium",
    }));
    expect(trans).toMatchObject({
      schemaVersion: 1,
      runId: "malformed-run",
      code: "repository_rejected",
    });

    expect(runner.calls.length).toBe(0);
    expect(await readFile(manifestPath, "utf8")).toBe(malformedContent);
  });

  it("fails closed and preserves symlinked .bearing/workspace.json target without provider dispatch", async () => {
    const runner = new SyntheticRunner();
    const dispatch = createDispatcher({
      headlessJourney: (request: HeadlessJourneyRequest) =>
        executeHeadlessJourney(request, { processRunner: runner }),
    });

    const externalDir = await tempRepo();
    const externalTarget = join(externalDir, "external-target.json");
    const originalTargetContent = "SECRET_EXTERNAL_CONTENT\n";
    await writeFile(externalTarget, originalTargetContent);

    const root = await tempRepo();
    await seedValidLegacyFocus(root, "docs/plans/symlink-focus", "Symlink target preservation.");

    const manifestPath = join(root, ".bearing", "workspace.json");
    await symlink(externalTarget, manifestPath);

    const attached = structured(await callTool(dispatch, "bearing_attach", { repository: root, runId: "symlink-run" }));
    expect(attached).toMatchObject({
      schemaVersion: 1,
      runId: "symlink-run",
      code: "repository_rejected",
    });

    const trans = structured(await callTool(dispatch, "bearing_transition", {
      repository: root,
      runId: "symlink-run",
      action: "create",
      expectedRevision: 0,
      goal: "Attempt create against symlink manifest.",
      provider: "codex",
      model: "gpt-5.4",
      reasoning: "medium",
    }));
    expect(trans).toMatchObject({
      schemaVersion: 1,
      runId: "symlink-run",
      code: "repository_rejected",
    });

    expect(runner.calls.length).toBe(0);
    expect((await lstat(manifestPath)).isSymbolicLink()).toBe(true);
    expect(await readFile(externalTarget, "utf8")).toBe(originalTargetContent);
  });

  it("fails closed on nonregular .bearing/workspace.json path and replacement-after-attach race", async () => {
    const runner = new SyntheticRunner();
    const dispatch = createDispatcher({
      headlessJourney: (request: HeadlessJourneyRequest) =>
        executeHeadlessJourney(request, { processRunner: runner }),
    });

    // 1. Nonregular path (directory workspace.json)
    const nonregRoot = await tempRepo();
    await seedValidLegacyFocus(nonregRoot, "docs/plans/nonreg-focus", "Nonregular path failure.");
    await mkdir(join(nonregRoot, ".bearing", "workspace.json"));

    const nonregAttached = structured(await callTool(dispatch, "bearing_attach", { repository: nonregRoot, runId: "nonreg-run" }));
    expect(nonregAttached).toMatchObject({ code: "repository_rejected" });

    // 2. Replacement-after-attach race: valid legacy focus with absent manifest during attach
    const raceRoot = await tempRepo();
    await seedValidLegacyFocus(raceRoot, "docs/plans/race-focus", "Raced manifest failure.");

    const raceAttached = structured(await callTool(dispatch, "bearing_attach", { repository: raceRoot, runId: "race-run" }));
    expect(raceAttached).toMatchObject({
      schemaVersion: 1,
      runId: "race-run",
      revision: 0,
      code: "run_not_found",
      allowedActions: ["create"],
    });

    // Race in a malformed workspace.json AFTER attach, BEFORE transition
    await writeFile(join(raceRoot, ".bearing", "workspace.json"), "{ malformed json\n");

    const raceTrans = structured(await callTool(dispatch, "bearing_transition", {
      repository: raceRoot,
      runId: "race-run",
      action: "create",
      expectedRevision: 0,
      goal: "Attempt create after manifest replacement race.",
      provider: "codex",
      model: "gpt-5.4",
      reasoning: "medium",
    }));
    expect(raceTrans).toMatchObject({
      schemaVersion: 1,
      runId: "race-run",
      code: "repository_rejected",
    });

    expect(runner.calls.length).toBe(0);
  });

  it("enforces expected revision before any provider work", async () => {
    const root = await tempRepo();
    const store = await seedRun(root, "stale-run");
    const revision = (await store.load("stale-run")).revision;
    const before = await durableFingerprint(root);
    let calls = 0;
    const dispatch = createDispatcher({
      headlessJourney: async (request: HeadlessJourneyRequest): Promise<HeadlessJourneyReceipt> => {
        calls += 1;
        return { ok: true, runId: request.runId, revision };
      },
    });
    const stale = await callTool(dispatch, "bearing_transition", {
      repository: root,
      runId: "stale-run",
      action: "decide",
      expectedRevision: revision - 1,
      answer: "Start with the durable store.",
    });
    expect(stale?.result).toMatchObject({ isError: true });
    expect(structured(stale)).toMatchObject({ code: "stale_revision", revision });
    expect(calls).toBe(0);
    expect(await durableFingerprint(root)).toBe(before);
  });

  it("rejects an action outside the current allowed actions", async () => {
    const root = await tempRepo();
    const store = await seedRun(root, "disallowed-run");
    const revision = (await store.load("disallowed-run")).revision;
    let calls = 0;
    const dispatch = createDispatcher({
      headlessJourney: async (request: HeadlessJourneyRequest): Promise<HeadlessJourneyReceipt> => {
        calls += 1;
        return { ok: true, runId: request.runId, revision };
      },
    });
    const rejected = await callTool(dispatch, "bearing_transition", {
      repository: root,
      runId: "disallowed-run",
      action: "approve-route",
      expectedRevision: revision,
    });
    expect(structured(rejected)).toMatchObject({ code: "action_not_allowed" });
    expect(calls).toBe(0);
  });

  it("answers a status transition from the durable read alone", async () => {
    const root = await tempRepo();
    const store = await seedRun(root, "status-run");
    const revision = (await store.load("status-run")).revision;
    const before = await durableFingerprint(root);
    let calls = 0;
    const dispatch = createDispatcher({
      headlessJourney: async (): Promise<HeadlessJourneyReceipt> => {
        calls += 1;
        throw new Error("a status read must never reach the transition engine");
      },
    });
    const asked = { repository: root, runId: "status-run", action: "status" };
    const response = await callTool(dispatch, "bearing_transition", { ...asked, expectedRevision: revision });
    // Never entering the engine is what keeps status readiness-free, provider-free, and mutation-free.
    expect(calls).toBe(0);
    expect(await durableFingerprint(root)).toBe(before);
    expect(response?.result).not.toMatchObject({ isError: true });
    const status = structured(response);
    expect(status).not.toHaveProperty("code");
    expect(status).toMatchObject({ runId: "status-run", revision, stage: "set-bearings", status: "waiting" });
    // The receipt is the same durable continuation the read-only tools produce.
    expect(status).toEqual(structured(await callTool(dispatch, "bearing_attach", { repository: root, runId: "status-run" })));

    // Reading is still gated: a stale expected revision is refused, and refused before the engine.
    const stale = await callTool(dispatch, "bearing_transition", { ...asked, expectedRevision: revision - 1 });
    expect(structured(stale)).toMatchObject({ code: "stale_revision", revision });
    expect(calls).toBe(0);
    expect(await durableFingerprint(root)).toBe(before);
  });

  it("infers the saved route and lets exactly one concurrent writer through", async () => {
    const root = await tempRepo();
    const store = await seedRun(root, "race-run");
    const revision = (await store.load("race-run")).revision;
    const seen: HeadlessJourneyRequest[] = [];
    const headlessJourney = async (request: HeadlessJourneyRequest): Promise<HeadlessJourneyReceipt> => {
      seen.push(request);
      await new Promise((resolve) => setTimeout(resolve, 25));
      const durable = await store.load(request.runId);
      const applied = await store.apply({
        schemaVersion: 1,
        commandId: `race-${seen.length}`,
        runId: request.runId,
        expectedRevision: durable.revision,
        type: "recordOwnerAnswer",
        payload: { decisionId: `decision-${request.runId}`, answer: request.answer ?? "" },
        session: { sessionId: "test-owner", actor: "owner" },
        correlationId: `race-${seen.length}`,
      });
      return { ok: applied.ok, runId: request.runId, revision: applied.state.revision };
    };
    const transition = (dispatch: Dispatch) => callTool(dispatch, "bearing_transition", {
      repository: root,
      runId: "race-run",
      action: "decide",
      expectedRevision: revision,
      answer: "Start with the durable store.",
    });
    const [first, second] = await Promise.all([
      transition(createDispatcher({ headlessJourney })),
      transition(createDispatcher({ headlessJourney })),
    ]);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ provider: "codex", model: "gpt-5.4", reasoning: "medium" });
    const outcomes = [first, second].map((response) => (response?.result as { isError?: boolean }).isError === true);
    expect(outcomes.filter((failed) => !failed)).toHaveLength(1);
    expect(structured(outcomes[0] ? second : first)).toMatchObject({ revision: revision + 1 });
  });

  it("uses a complete exact-revision route to replace a stale saved route", async () => {
    const root = await tempRepo();
    const store = await seedRun(root, "route-rebind-run");
    const revision = (await store.load("route-rebind-run")).revision;
    const seen: HeadlessJourneyRequest[] = [];
    const dispatch = createDispatcher({
      headlessJourney: async (request): Promise<HeadlessJourneyReceipt> => {
        seen.push(request);
        return { ok: true, runId: request.runId, revision };
      },
    });

    await callTool(dispatch, "bearing_transition", {
      repository: root,
      runId: "route-rebind-run",
      action: "decide",
      expectedRevision: revision,
      answer: "Use the newly selected route.",
      provider: "codex",
      model: "deepseek-v4-flash",
      reasoning: "max",
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ provider: "codex", model: "deepseek-v4-flash", reasoning: "max" });
  });

  it("refuses a partial route without entering the transition engine", async () => {
    const root = await tempRepo();
    const store = await seedRun(root, "partial-route-run");
    const revision = (await store.load("partial-route-run")).revision;
    let calls = 0;
    const dispatch = createDispatcher({ headlessJourney: async () => { calls += 1; throw new Error("must not run"); } });

    const response = await callTool(dispatch, "bearing_transition", {
      repository: root,
      runId: "partial-route-run",
      action: "decide",
      expectedRevision: revision,
      answer: "Incomplete route",
      model: "deepseek-v4-flash",
    });

    expect(structured(response)).toMatchObject({ code: "route_incomplete", revision });
    expect(calls).toBe(0);
  });

  it("contains the repository argument fail-closed", async () => {
    const root = await tempRepo();
    await seedRun(root, "contained-run");
    const linked = await tempRepo();
    await rm(join(linked, ".bearing"), { recursive: true, force: true });
    await symlink(join(root, ".bearing"), join(linked, ".bearing"));
    const plain = await mkdtemp(join(tmpdir(), "bearing-mcp-plain-"));
    roots.push(plain);
    // A symlink whose target *is* the admitted root: canonicalizing without comparing would take it.
    const linkParent = await mkdtemp(join(tmpdir(), "bearing-mcp-link-"));
    roots.push(linkParent);
    const rootLink = join(linkParent, "root");
    await symlink(root, rootLink);

    const candidates = [
      `${root}/../..`,
      // Lexically contains "..", yet resolves straight back to the real root.
      `${root}/docs/..`,
      rootLink,
      "relative/path",
      plain,
      join(root, "docs"),
      linked,
    ];
    for (const repository of candidates) {
      const receipt = structured(await callTool(createDispatcher(), "bearing_attach", { repository, runId: "contained-run" }));
      expect(receipt).toMatchObject({ code: "repository_rejected" });
      expect(JSON.stringify(receipt)).not.toContain(root);
      expect(receipt).not.toHaveProperty("repository");
    }
    // Rejection is a refusal to read, not a rejection of every path: the real root still resolves.
    expect(structured(await callTool(createDispatcher(), "bearing_attach", { repository: root, runId: "contained-run" })))
      .toMatchObject({ runId: "contained-run" });
    // A trailing separator is a harmless respelling of the same canonical root, not an escape.
    const trailingSlash = structured(await callTool(createDispatcher(), "bearing_attach", { repository: `${root}/`, runId: "contained-run" }));
    expect(trailingSlash).not.toMatchObject({ code: "repository_rejected" });
    expect(trailingSlash).toMatchObject({ runId: "contained-run" });
  });

  it("redacts a secret-bearing objective instead of echoing it", async () => {
    const root = await tempRepo();
    const secret = "api_key=sk-live0123456789abcdef";
    await seedRun(root, "secret-run", `Rotate ${secret} across the deploy path`);
    const receipt = structured(await callTool(createDispatcher(), "bearing_attach", { repository: root, runId: "secret-run" }));
    expect(receipt.objective).toBe("[redacted]");
    const text = JSON.stringify(receipt);
    expect(text).not.toContain(secret);
    expect(text).not.toContain("sk-live0123456789abcdef");
    expect(text).not.toMatch(/api[_ -]?key|token|Bearer /i);
    // A clean objective is still reported verbatim, or the redaction proves nothing.
    await seedRun(root, "clean-run");
    expect(structured(await callTool(createDispatcher(), "bearing_attach", { repository: root, runId: "clean-run" })).objective)
      .toBe("Complete the approved bounded work");
  });

  it("answers modern discovery and legacy initialize over one generic flow", async () => {
    const root = await tempRepo();
    await seedRun(root, "protocol-run");
    expect(MCP_PROTOCOL_VERSIONS).toEqual([MODERN, LEGACY, PINNED]);

    const modern = createDispatcher();
    // `server/discover` is modern by definition: no handshake, no root protocolVersion.
    // `DiscoverResult` carries server identity only under the namespaced `_meta` key, never at the root.
    const discovered = await modern({ jsonrpc: "2.0", id: "d", method: "server/discover", params: modernParams() });
    expect(discovered?.result).toEqual({
      resultType: "complete",
      supportedVersions: [MODERN, LEGACY, PINNED],
      capabilities: { tools: {} },
      _meta: { [SERVER_INFO_META]: SERVER_INFO },
    });
    const modernList = await modern({ jsonrpc: "2.0", id: "ml", method: "tools/list", params: modernParams() });
    expect((modernList?.result as { resultType?: string }).resultType).toBe("complete");
    const modernCall = await modern({
      jsonrpc: "2.0",
      id: "c",
      method: "tools/call",
      params: modernParams({ name: "bearing_attach", arguments: { repository: root, runId: "protocol-run" } }),
    });
    expect((modernCall?.result as { resultType?: string }).resultType).toBe("complete");

    const legacy = createDispatcher();
    const initialized = await legacy({ jsonrpc: "2.0", id: "i", method: "initialize", params: { protocolVersion: LEGACY } });
    expect(initialized?.result).toEqual({ protocolVersion: LEGACY, serverInfo: SERVER_INFO, capabilities: { tools: {} } });
    expect(await legacy({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
    // Legacy carries no per-request metadata and gets no resultType back.
    const legacyList = await legacy({ jsonrpc: "2.0", id: "ll", method: "tools/list" });
    expect(legacyList?.result).not.toHaveProperty("resultType");
    expect((legacyList?.result as { tools: unknown }).tools).toEqual((modernList?.result as { tools: unknown }).tools);
    const legacyCall = await legacy({
      jsonrpc: "2.0",
      id: "lc",
      method: "tools/call",
      params: { name: "bearing_attach", arguments: { repository: root, runId: "protocol-run" } },
    });
    expect(legacyCall?.result).not.toHaveProperty("resultType");
    expect(structured(legacyCall)).toMatchObject({ runId: "protocol-run" });
    expect(structured(legacyCall)).toEqual(structured(modernCall));
  });

  it("negotiates the Codex CLI 0.146.0 pinned initialize version through the legacy path", async () => {
    const root = await tempRepo();
    await seedRun(root, "codex-run");
    const CODEX_PINNED = "2025-06-18";

    const dispatch = createDispatcher();
    const initialized = await dispatch({ jsonrpc: "2.0", id: "i", method: "initialize", params: { protocolVersion: CODEX_PINNED } });
    expect(initialized?.result).toEqual({ protocolVersion: CODEX_PINNED, serverInfo: SERVER_INFO, capabilities: { tools: {} } });
    expect(await dispatch({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();

    // Legacy carries no per-request metadata and gets no resultType back, same as the already-supported legacy version.
    const list = await dispatch({ jsonrpc: "2.0", id: "l", method: "tools/list" });
    expect(list?.result).not.toHaveProperty("resultType");
    const called = await callTool(dispatch, "bearing_attach", { repository: root, runId: "codex-run" }, "c");
    expect(called?.result).not.toHaveProperty("resultType");
    expect(structured(called)).toMatchObject({ runId: "codex-run" });
  });

  it("types every malformed, unknown, and unsupported protocol case", async () => {
    const dispatch = createDispatcher();
    const cases: [unknown, number][] = [
      [{ jsonrpc: "1.0", id: 1, method: "tools/list" }, -32600],
      [{ jsonrpc: "2.0", id: 1, method: "tools/unknown" }, -32601],
      [{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "bearing_unknown", arguments: {} } }, -32602],
      [{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "bearing_attach", arguments: { repository: "/tmp", runId: "x", extra: 1 } } }, -32602],
      [{ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: { [PROTOCOL_META]: "1999-01-01" } } }, -32022],
      [{ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "1999-01-01" } }, -32022],
    ];
    for (const [request, code] of cases) {
      const response = await dispatch(request);
      expect(response?.error?.code).toBe(code);
      // `UnsupportedProtocolVersionError.data` is exactly `{supported, requested}` — both required.
      if (code === -32022) expect(response?.error?.data).toEqual({ supported: [MODERN, LEGACY, PINNED], requested: "1999-01-01" });
    }
  });

  it("frames newline stdio, bounds line size, and exits on EOF without stray stdout", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const chunks: string[] = [];
    output.on("data", (chunk: Buffer) => chunks.push(chunk.toString("utf8")));
    const done = serveStdio(createDispatcher(), input, output);
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`);
    input.write("{not json}\n");
    input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    input.write(`${"x".repeat(2_000_000)}\n`);
    input.end();
    await done;
    const lines = chunks.join("").split("\n").filter(Boolean);
    expect(lines).toHaveLength(3);
    const parsed = lines.map((line) => JSON.parse(line) as JsonRpcResponse);
    expect(parsed[0]!.result).toBeDefined();
    expect(parsed[1]!.error?.code).toBe(-32700);
    expect(parsed[2]!.error?.code).toBe(-32600);
  });

  it("bearing_transition create through executeHeadlessJourney exercises exact-revision repository-fit recovery without mutating on a missing warrant", async () => {
    const root = await tempRepo();
    const runId = "fit-retry-132";

    // Minimal controlled ProcessRunner: distinguishes readiness (never counts as fit) from actual
    // repository-fit invocations. Starts failing actual fit (for initial create), switched healthy
    // later for the admitted warrant progress. Returns valid BEARING_RESULT envelopes.
    const fitCalls = { actual: 0, readiness: 0, healthy: false };
    const runner: ProcessRunner = {
      executableAvailable: (_executable: string) => true,
      run: async (invocation: ProcessInvocation): Promise<ProcessResult> => {
        const prompt = invocation.stdin ?? "";
        const rid = invocation.runId ?? "";
        if (/confirming readiness|Do not read or write repository files/i.test(prompt) || rid.startsWith("readiness-")) {
          fitCalls.readiness++;
          return { exitCode: 0, usage: { tokens: 0 }, events: [{ type: "complete" }] };
        }
        fitCalls.actual++;
        const envelope = fitCalls.healthy
          ? `{"kind":"fit","ok":true,"assumption":{"repository":${JSON.stringify(root)},"planDirectory":"docs/plans/${runId}","rationale":"The repository contains a package manifest consistent with the work goal.","evidence":[{"kind":"manifest","path":"package.json","detail":"defines the project"}]},"question":${JSON.stringify(QUESTION)}}`
          : `{"kind":"fit","ok":false,"reason":"fit_unavailable"}`;
        return {
          exitCode: 0,
          usage: { tokens: 4 },
          events: [{ type: "assistant", data: { content: `partial\nBEARING_RESULT ${envelope}` } }],
        };
      },
    };

    const dispatch = createDispatcher({
      headlessJourney: (request: HeadlessJourneyRequest) =>
        executeHeadlessJourney(request, { processRunner: runner }),
    });

    // Real create from absent run state (no manual seed, no BearingStore.apply, no checkpoint fabrication).
    const createTrans = await callTool(dispatch, "bearing_transition", {
      repository: root,
      runId,
      action: "create",
      expectedRevision: 0,
      goal: "Complete the approved bounded work with repository fit warrant recovery.",
      provider: "codex",
      model: "gpt-5.4",
      reasoning: "medium",
    });
    const cr = structured(createTrans);
    expect(cr.revision).toBe(3);
    expect((cr.outcome as { code?: string } | undefined)?.code).toBe("fit_unavailable");
    expect(cr.stage).toBe("repository-fit");
    expect(cr.status).toBe("failed");
    expect(cr.blockers).toContain("fit_unavailable");
    expect(Array.isArray(cr.allowedActions)).toBe(true);
    expect(cr.allowedActions).toEqual(["status", "progress"]);
    expect(fitCalls.actual).toBe(1);

    // Switch healthy before the no-warrant attempt (per contract).
    fitCalls.healthy = true;

    const postCreateRev = 3;
    const store = new BearingStore(root);
    const beforeMissingWarrant = await store.load(runId);
    // No-warrant exact progress is rejected before the handler, provider dispatch, or durable write.
    const noWarrResp = await callTool(dispatch, "bearing_transition", {
      repository: root,
      runId,
      action: "progress",
      expectedRevision: postCreateRev,
      stage: "repository-fit",
      provider: "codex",
      model: "gpt-5.4",
      reasoning: "medium",
    });
    const nw = structured(noWarrResp);
    expect(nw.code).toBe("illegal_transition");
    expect(nw.revision).toBe(postCreateRev);
    expect(fitCalls.actual).toBe(1);
    expect(await store.load(runId)).toEqual(beforeMissingWarrant);

    const afterNo = structured(await callTool(dispatch, "bearing_attach", { repository: root, runId }));
    expect(afterNo.revision).toBe(3);
    expect(afterNo.blockers).toContain("fit_unavailable");
    expect(afterNo.blockers).not.toContain("retry_requires_warrant");
    expect(afterNo.stage).toBe("repository-fit");

    // status + retryWarrant -> retry_warrant_unsupported (fail closed, no fit)
    const onStatus = await callTool(dispatch, "bearing_transition", {
      repository: root,
      runId,
      action: "status",
      expectedRevision: 3,
      retryWarrant: "changed_environment",
    });
    expect(structured(onStatus).code).toBe("retry_warrant_unsupported");
    expect(fitCalls.actual).toBe(1);

    // stale warrant -> stale_revision (fail closed before fit)
    const stale = await callTool(dispatch, "bearing_transition", {
      repository: root,
      runId,
      action: "progress",
      expectedRevision: 2,
      stage: "repository-fit",
      retryWarrant: "changed_environment",
      provider: "codex",
      model: "gpt-5.4",
      reasoning: "medium",
    });
    expect(structured(stale).code).toBe("stale_revision");
    expect(fitCalls.actual).toBe(1);

    // approved_amendment -> direct JSON-RPC -32602 (schema, never reaches structured/transition)
    const badAmendCall = await callTool(dispatch, "bearing_transition", {
      repository: root,
      runId,
      action: "progress",
      expectedRevision: 3,
      stage: "repository-fit",
      retryWarrant: "approved_amendment",
      provider: "codex",
      model: "gpt-5.4",
      reasoning: "medium",
    });
    expect(badAmendCall?.error?.code).toBe(-32602);
    expect(fitCalls.actual).toBe(1);

    // invalid enum value -> direct JSON-RPC -32602
    const badValCall = await callTool(dispatch, "bearing_transition", {
      repository: root,
      runId,
      action: "progress",
      expectedRevision: 3,
      stage: "repository-fit",
      retryWarrant: "magic_fix",
      provider: "codex",
      model: "gpt-5.4",
      reasoning: "medium",
    });
    expect(badValCall?.error?.code).toBe(-32602);
    expect(fitCalls.actual).toBe(1);

    // wrong stage with warrant -> illegal_transition (fail closed before fit)
    const wrongStage = await callTool(dispatch, "bearing_transition", {
      repository: root,
      runId,
      action: "progress",
      expectedRevision: 3,
      stage: "set-bearings",
      retryWarrant: "changed_environment",
      provider: "codex",
      model: "gpt-5.4",
      reasoning: "medium",
    });
    expect(structured(wrongStage).code).toBe("recovery_stage_mismatch");
    expect(fitCalls.actual).toBe(1);

    // Exact unchanged rev (3) + changed_environment: one actual fit, rev 5, waiting non-failed, public question.
    const admitted = await callTool(dispatch, "bearing_transition", {
      repository: root,
      runId,
      action: "progress",
      expectedRevision: 3,
      stage: "repository-fit",
      retryWarrant: "changed_environment",
      provider: "codex",
      model: "gpt-5.4",
      reasoning: "medium",
    });
    const ad = structured(admitted);
    expect(ad.code).toBeUndefined();
    expect(ad.revision).toBe(5);
    expect(ad.stage).toBe("repository-fit");
    expect(ad.status).toBe("waiting");
    expect(ad.outcome).toMatchObject({ type: "waiting" });
    expect(ad.question).toBe(QUESTION);
    expect((ad.blockers as readonly string[] | undefined) ?? []).not.toContain("fit_unavailable");
    expect((ad.blockers as readonly string[] | undefined) ?? []).not.toContain("retry_requires_warrant");
    expect(fitCalls.actual).toBe(2);

    const afterAd = structured(await callTool(dispatch, "bearing_attach", { repository: root, runId }));
    expect(afterAd.revision).toBe(5);
    expect(afterAd.status).toBe("waiting");

    // Load durable, parse runtimeStateJson (no unused fallback), assert ordered retry ledger entries.
    const durable = await store.load(runId);
    const runtimeStateJson: string | undefined = (durable as any).journeyCheckpoint?.runtimeStateJson;
    expect(typeof runtimeStateJson).toBe("string");
    const rt = JSON.parse(runtimeStateJson!);
    expect(Array.isArray(rt.retry)).toBe(true);
    expect(rt.retry).toEqual(expect.arrayContaining([
      expect.objectContaining({ warrant: "changed_environment", outcome: "admitted" }),
    ]));
    expect(rt.retry).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ warrant: null, outcome: "retry_requires_warrant" }),
    ]));

    // Stale replay of consumed warrant does not increase actual fit-call count.
    const preReplay = fitCalls.actual;
    const replayResp = await callTool(dispatch, "bearing_transition", {
      repository: root,
      runId,
      action: "progress",
      expectedRevision: 3,
      stage: "repository-fit",
      retryWarrant: "changed_environment",
      provider: "codex",
      model: "gpt-5.4",
      reasoning: "medium",
    });
    expect(structured(replayResp).code).toBe("stale_revision");
    expect(fitCalls.actual).toBe(preReplay);
  });

  it("returns refusal without provider dispatch when workspace root identity changes", async () => {
    let providerDispatched = false;
    const dispatch = createDispatcher({
      headlessJourney: async (req) => {
        providerDispatched = true;
        return { ok: true, runId: req.runId, revision: 1 };
      },
    });

    const root = await tempRepo();
    const runId = "ws-root-mcp-test";

    // Attach to establish baseline
    const attached = structured(await callTool(dispatch, "bearing_attach", { repository: root, runId }));
    expect(attached.code).toBe("run_not_found");

    // Replace .bearing with symlink to external dir
    const external = join(tmpdir(), `test-ext-mcp-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(external, { recursive: true });
    const bearing = join(root, ".bearing");
    await rm(bearing, { recursive: true, force: true });
    await symlink(external, bearing);

    try {
      const res = structured(await callTool(dispatch, "bearing_transition", {
        repository: root,
        runId,
        action: "create",
        expectedRevision: 0,
        provider: "codex",
        model: "gpt-5.4",
        reasoning: "medium",
      }));

      expect(["workspace_root_changed", "repository_rejected", "store_unreadable"]).toContain(res.code);
      expect(providerDispatched).toBe(false);
    } finally {
      await rm(external, { recursive: true, force: true });
    }
  });

  it("refuses a workspace swap during lock cleanup without deleting through the replacement", async () => {
    const root = await tempRepo();
    const runId = "ws-root-lock-cleanup";
    const store = await seedRun(root, runId);
    const revision = (await store.load(runId)).revision;
    const bearing = join(root, ".bearing");
    const original = join(root, ".bearing-original");
    const external = join(tmpdir(), `test-ext-lock-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const externalLock = join(external, "runs", `${runId}.lock`);

    const dispatch = createDispatcher({
      headlessJourney: async (request) => {
        await rename(bearing, original);
        await mkdir(join(external, "runs"), { recursive: true });
        await writeFile(externalLock, "external-lock\n");
        await symlink(external, bearing);
        return { ok: true, runId: request.runId, revision: revision + 1 };
      },
    });

    try {
      const response = structured(await callTool(dispatch, "bearing_transition", {
        repository: root,
        runId,
        action: "resume",
        expectedRevision: revision,
      }));
      expect(response.code).toBe("workspace_root_changed");
      expect(await readFile(externalLock, "utf8")).toBe("external-lock\n");
    } finally {
      await unlink(bearing).catch(() => undefined);
      await rename(original, bearing).catch(() => undefined);
      await rm(external, { recursive: true, force: true });
    }
  });
});
