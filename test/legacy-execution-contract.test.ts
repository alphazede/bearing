/**
 * Issue 135 legacy execution-contract migration tests.
 *
 * Validates reproduction of the pre-migration execution_contract_unavailable issue,
 * the legacyExecutionContractApproved event, aggregate projection, local-session handler,
 * resolver legacy branch, MCP tool, full refusal matrix, exact replay, SEIT-36 trace assertion,
 * and modern-contract non-regression.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("../src/server/local-session.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/server/local-session.js")>();
  return {
    ...actual,
    applyLegacyExecutionContractApproval: vi.fn(actual.applyLegacyExecutionContractApproval),
  };
});

import {
  hashExecutionContractBody,
  hashLegacyRoleRoutes,
  type ApprovedExecutionContract,
  type ExecutionContractBody,
  type RoleRoute,
} from "../src/contracts/execution-contract.js";
import { type CommandEnvelopeV1 } from "../src/contracts/run.js";
import { createDispatcher, type JsonRpcResponse } from "../src/mcp/server.js";
import {
  applyLegacyExecutionContractApproval,
  readReviewContext,
} from "../src/server/local-session.js";
import { BearingStore } from "../src/store/bearing-store.js";
import { decide, initialRunState, type DecideDeps, type RunState } from "../src/workflow/aggregate.js";

const applyLegacyExecutionContractApprovalMock = vi.mocked(applyLegacyExecutionContractApproval);

const RUN_ID = "legacy-run-135";
const OWNER = { sessionId: "sess-owner", actor: "owner" };
const QUESTION = "Has either unblock condition changed for the pending infrastructure item?";
const DECISION_ID = "decision-legacy-135";

const LEGACY_ROUTES: readonly RoleRoute[] = [
  { role: "execution-author", primary: "opencode", fallbacks: [] },
  { role: "review-general", primary: "codex", fallbacks: [] },
  { role: "review-security", primary: "codex", fallbacks: [] },
];

const S11_REQUIREMENT_IDS = new Set([
  "AC-135-01", "AC-135-02", "AC-135-03", "AC-135-04", "AC-135-05", "AC-135-06",
]);

const S11_COMMAND_IDS = new Set([
  "CMD-DIFF-CHECK", "CMD-TEST-LEGACY-CONTRACT", "CMD-TEST-LEGACY-ROUTES",
  "CMD-TEST-MCP", "CMD-TEST-SESSION", "CMD-TYPECHECK", "CMD-TYPECHECK-TEST",
  "PROC-GROK-SAFE-FAILURE", "PROC-GROK-SAFE-PREFLIGHT",
]);

function deps(): DecideDeps {
  let n = 0;
  return { recordedAt: "2026-08-05T00:00:00Z", nextEventId: () => `evt-${++n}` };
}

function structured(response: JsonRpcResponse | null): Record<string, unknown> {
  const value = (response?.result as { structuredContent?: unknown } | undefined)?.structuredContent;
  if (typeof value !== "object" || value === null) throw new Error(`no structuredContent: ${JSON.stringify(response)}`);
  return value as Record<string, unknown>;
}

async function callTool(
  dispatch: ReturnType<typeof createDispatcher>,
  name: string,
  args: Record<string, unknown>,
): Promise<JsonRpcResponse | null> {
  return dispatch({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name,
      arguments: args,
    },
  });
}

const roots: string[] = [];
afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

async function tempRepo(): Promise<string> {
  const created = await mkdtemp(join(tmpdir(), "bearing-legacy-contract-test-"));
  roots.push(created);
  const root = await realpath(created);
  await new Promise<void>((resolve, reject) => {
    execFile("git", ["init", "-q"], { cwd: root }, (error) => (error ? reject(error) : resolve()));
  });
  await new Promise<void>((resolve, reject) => {
    execFile("git", ["config", "user.email", "test@example.com"], { cwd: root }, (error) => (error ? reject(error) : resolve()));
  });
  await new Promise<void>((resolve, reject) => {
    execFile("git", ["config", "user.name", "Test User"], { cwd: root }, (error) => (error ? reject(error) : resolve()));
  });
  await writeFile(join(root, ".gitignore"), ".bearing/\n");
  await new Promise<void>((resolve, reject) => {
    execFile("git", ["add", ".gitignore"], { cwd: root }, (error) => (error ? reject(error) : resolve()));
  });
  await new Promise<void>((resolve, reject) => {
    execFile("git", ["commit", "-q", "-m", "initial"], { cwd: root }, (error) => (error ? reject(error) : resolve()));
  });
  return root;
}

/** Seed a legacy run with a pending owner decision and an approved legacy role-route binding. */
async function seedLegacyRun(root: string, runId: string = RUN_ID): Promise<{ store: BearingStore; planDirectory: string }> {
  const store = new BearingStore(root);
  const planDirectory = "docs/plans/legacy-135";
  await mkdir(join(root, planDirectory), { recursive: true });

  const created = await store.apply({
    schemaVersion: 1,
    commandId: `c-create-${runId}`,
    runId,
    expectedRevision: 0,
    session: OWNER,
    correlationId: `corr-create-${runId}`,
    type: "createWorkRequest",
    payload: { title: "Legacy work 135", goal: "Complete legacy execution" },
  } as CommandEnvelopeV1);
  if (!created.ok) throw new Error(created.reason);

  const checkpoint = await store.apply({
    schemaVersion: 1,
    commandId: `c-checkpoint-${runId}`,
    runId,
    expectedRevision: created.state.revision,
    session: { sessionId: "sess-bearing", actor: "bearing" },
    correlationId: `corr-checkpoint-${runId}`,
    type: "recordJourneyCheckpoint",
    payload: {
      stage: "execute-expedition",
      status: "waiting",
      artifacts: [`${planDirectory}/plan-spec.md`],
      planDirectory,
      question: QUESTION,
      questionDecisionId: DECISION_ID,
    },
  } as CommandEnvelopeV1);
  if (!checkpoint.ok) throw new Error(checkpoint.reason);

  const routesBound = await store.apply({
    schemaVersion: 1,
    commandId: `c-routes-${runId}`,
    runId,
    expectedRevision: checkpoint.state.revision,
    session: OWNER,
    correlationId: `corr-routes-${runId}`,
    type: "approveLegacyRoleRoutes",
    payload: {
      roleRoutes: LEGACY_ROUTES,
      approvedContentHash: hashLegacyRoleRoutes(runId, LEGACY_ROUTES),
    },
  } as CommandEnvelopeV1);
  if (!routesBound.ok) throw new Error(routesBound.reason);

  return { store, planDirectory };
}

function sampleContractBody(runId: string = RUN_ID, planDirectory: string = "docs/plans/legacy-135", roleRoutes?: readonly RoleRoute[]): ExecutionContractBody {
  return {
    schemaVersion: 1,
    contractId: `contract-${runId}`,
    runId,
    planDirectory,
    objective: "Execute issue 135 legacy contract migration",
    mode: "expedition",
    reviewCadence: "per-slice",
    phases: [
      { phaseId: "P1", title: "Migration phase", entryCriteria: "Legacy run pending", exitCriteria: "Contract bound" },
    ],
    slices: [
      {
        sliceId: "S11",
        phaseId: "P1",
        requirementIds: ["AC-135-01", "AC-135-02", "AC-135-03", "AC-135-04", "AC-135-05", "AC-135-06"],
        writeSet: ["src/contracts/run.ts", "src/workflow/aggregate.ts"],
        acceptance: "Complete bounded work.",
        evidenceCommandIds: ["CMD-DIFF-CHECK", "CMD-TEST-LEGACY-CONTRACT", "CMD-TEST-LEGACY-ROUTES", "CMD-TEST-MCP", "CMD-TEST-SESSION", "CMD-TYPECHECK", "CMD-TYPECHECK-TEST", "PROC-GROK-SAFE-FAILURE", "PROC-GROK-SAFE-PREFLIGHT"],
        dependsOn: [],
        parallelSafe: false,
        role: "crewmate",
        reasoningTier: "high",
      },
    ],
    dependencyEdges: [],
    roleRoutes: roleRoutes ?? LEGACY_ROUTES,
  };
}

describe("Issue 135 — Pre-contract recovery addendum", () => {
  it("reproduces failing-before: legacy run with legacy role-routes and no contract fails readReviewContext with execution_contract_unavailable", async () => {
    const root = await tempRepo();
    await seedLegacyRun(root, RUN_ID);

    const context = await readReviewContext(root, RUN_ID, "general");
    expect(context.ok).toBe(false);
    if (context.ok) return;
    expect(context.code).toBe("execution_contract_unavailable");
  });

  it("admits legacy execution contract approval and recovers readReviewContext to ok: true (passing-after)", async () => {
    const root = await tempRepo();
    const { store } = await seedLegacyRun(root, RUN_ID);
    const durable = await store.load(RUN_ID);

    const body = sampleContractBody();
    const approvedContentHash = hashExecutionContractBody(body);

    const result = await applyLegacyExecutionContractApproval({
      repository: root,
      runId: RUN_ID,
      expectedRevision: durable.revision,
      ownerSessionId: OWNER.sessionId,
      body,
      approvedContentHash,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.recorded).toBe(true);

    const context = await readReviewContext(root, RUN_ID, "general");
    expect(context.ok).toBe(true);
    if (!context.ok) return;
    expect(context.contractHash).toBe(approvedContentHash);
    expect(context.scope).toEqual(["S11"]);
  });

  it("enforces DES-29 legacy role-route consistency: refuses legacy_role_routes_conflict when contract roleRoutes mismatch existing binding", async () => {
    const root = await tempRepo();
    const { store } = await seedLegacyRun(root, RUN_ID);
    const durable = await store.load(RUN_ID);

    const conflictingRoutes: readonly RoleRoute[] = [
      { role: "execution-author", primary: "codex", fallbacks: [] },
      { role: "review-general", primary: "codex", fallbacks: [] },
      { role: "review-security", primary: "codex", fallbacks: [] },
    ];
    const bodyMismatched = sampleContractBody(RUN_ID, "docs/plans/legacy-135", conflictingRoutes);

    const result = await applyLegacyExecutionContractApproval({
      repository: root,
      runId: RUN_ID,
      expectedRevision: durable.revision,
      ownerSessionId: OWNER.sessionId,
      body: bodyMismatched,
      approvedContentHash: hashExecutionContractBody(bodyMismatched),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("legacy_role_routes_conflict");
  });

  it("refuses content_hash_mismatch when caller-supplied approvedContentHash does not match computed hash", async () => {
    const root = await tempRepo();
    const { store } = await seedLegacyRun(root, RUN_ID);
    const durable = await store.load(RUN_ID);

    const body = sampleContractBody();
    const badHash = "a".repeat(64);

    const result = await applyLegacyExecutionContractApproval({
      repository: root,
      runId: RUN_ID,
      expectedRevision: durable.revision,
      ownerSessionId: OWNER.sessionId,
      body,
      approvedContentHash: badHash,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("content_hash_mismatch");
  });

  it("refuses parseApprovedExecutionContract structural defect reasons (e.g. invalid_mode, empty_write_set, dangling_dependency)", async () => {
    const root = await tempRepo();
    const { store } = await seedLegacyRun(root, RUN_ID);
    const durable = await store.load(RUN_ID);

    const badModeBody = { ...sampleContractBody(), mode: "invalid-mode" as any };
    const badModeResult = await applyLegacyExecutionContractApproval({
      repository: root,
      runId: RUN_ID,
      expectedRevision: durable.revision,
      ownerSessionId: OWNER.sessionId,
      body: badModeBody,
      approvedContentHash: hashExecutionContractBody(badModeBody),
    });
    expect(badModeResult.ok).toBe(false);
    if (badModeResult.ok) return;
    expect(badModeResult.code).toBe("invalid_mode");

    const emptyWriteBody = sampleContractBody();
    (emptyWriteBody as any).slices = [{ ...emptyWriteBody.slices[0], writeSet: [] }];
    const emptyWriteResult = await applyLegacyExecutionContractApproval({
      repository: root,
      runId: RUN_ID,
      expectedRevision: durable.revision,
      ownerSessionId: OWNER.sessionId,
      body: emptyWriteBody,
      approvedContentHash: hashExecutionContractBody(emptyWriteBody),
    });
    expect(emptyWriteResult.ok).toBe(false);
    if (emptyWriteResult.ok) return;
    expect(emptyWriteResult.code).toBe("empty_write_set");
  });

  it("handles identical re-binding as execution_contract_authoritative after F2 hoist (legacy binding resolves)", async () => {
    const root = await tempRepo();
    const { store } = await seedLegacyRun(root, RUN_ID);
    const durable = await store.load(RUN_ID);

    const body = sampleContractBody();
    const approvedContentHash = hashExecutionContractBody(body);

    const first = await applyLegacyExecutionContractApproval({
      repository: root,
      runId: RUN_ID,
      expectedRevision: durable.revision,
      ownerSessionId: OWNER.sessionId,
      body,
      approvedContentHash,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.recorded).toBe(true);

    const second = await applyLegacyExecutionContractApproval({
      repository: root,
      runId: RUN_ID,
      expectedRevision: first.revision,
      ownerSessionId: OWNER.sessionId,
      body,
      approvedContentHash,
    });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.code).toBe("execution_contract_authoritative");
  });

  it("SEIT-36 trace assertion: migrated contract requirement IDs and evidence command IDs are exactly the S11 manifest set", async () => {
    const root = await tempRepo();
    const { store } = await seedLegacyRun(root, RUN_ID);
    const durable = await store.load(RUN_ID);

    const body = sampleContractBody();
    const approvedContentHash = hashExecutionContractBody(body);

    const result = await applyLegacyExecutionContractApproval({
      repository: root,
      runId: RUN_ID,
      expectedRevision: durable.revision,
      ownerSessionId: OWNER.sessionId,
      body,
      approvedContentHash,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const context = await readReviewContext(root, RUN_ID, "general");
    expect(context.ok).toBe(true);
    if (!context.ok) return;

    for (const slice of result.contract.slices) {
      expect(new Set(slice.requirementIds)).toEqual(S11_REQUIREMENT_IDS);
      expect(new Set(slice.evidenceCommandIds)).toEqual(S11_COMMAND_IDS);
    }
  });

  it("MCP tool bearing_bind_legacy_execution_contract executes successfully and returns recorded contract", async () => {
    const root = await tempRepo();
    const { store } = await seedLegacyRun(root, RUN_ID);
    const durable = await store.load(RUN_ID);

    const dispatch = createDispatcher();
    const body = sampleContractBody();
    const approvedContentHash = hashExecutionContractBody(body);

    const res = await callTool(dispatch, "bearing_bind_legacy_execution_contract", {
      repository: root,
      runId: RUN_ID,
      expectedRevision: durable.revision,
      body,
      approvedContentHash,
    });

    const content = structured(res);
    expect(content.runId).toBe(RUN_ID);
    expect(content.recorded).toBe(true);
    expect((content.contract as any).contractId).toBe(`contract-${RUN_ID}`);
  });

  it("refuses a workspace swap during lock cleanup without deleting through the replacement", async () => {
    const root = await tempRepo();
    const { store } = await seedLegacyRun(root, RUN_ID);
    const durable = await store.load(RUN_ID);

    const dispatch = createDispatcher();
    const body = sampleContractBody();
    const approvedContentHash = hashExecutionContractBody(body);

    const bearing = join(root, ".bearing");
    const original = join(root, ".bearing-original");
    const external = join(tmpdir(), `test-ext-legacy-exec-lock-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const externalLock = join(external, "runs", `${RUN_ID}.lock`);

    // Install a one-time impl that performs the workspace swap from inside the withRunLock operation,
    // mirroring the PR-#137 pattern. The finally assertWorkspaceRoot will then throw, producing the
    // typed refusal without the replacement being deleted or written through.
    applyLegacyExecutionContractApprovalMock.mockImplementationOnce(async () => {
      await mkdir(join(external, "runs"), { recursive: true });
      await writeFile(externalLock, "external-lock\n");
      await rename(bearing, original);
      await symlink(external, bearing);
      return {
        ok: true as const,
        revision: durable.revision + 1,
        recorded: true,
        contract: { contractId: `contract-${RUN_ID}` } as unknown as ApprovedExecutionContract,
      };
    });

    try {
      const res = await callTool(dispatch, "bearing_bind_legacy_execution_contract", {
        repository: root,
        runId: RUN_ID,
        expectedRevision: durable.revision,
        body,
        approvedContentHash,
      });
      const response = structured(res);
      expect(response.code).toBe("workspace_root_changed");
      expect(response.runId).toBe(RUN_ID);
      expect(await readFile(externalLock, "utf8")).toBe("external-lock\n");
    } finally {
      await unlink(bearing).catch(() => undefined);
      await rename(original, bearing).catch(() => undefined);
      await rm(external, { recursive: true, force: true });
    }
  });

  it("refuses execution_contract_authoritative when a resolvable file-based contract is present", async () => {
    const root = await tempRepo();
    const store = new BearingStore(root);
    const planDirectory = "docs/plans/legacy-135";
    await mkdir(join(root, planDirectory), { recursive: true });

    const created = await store.apply({
      schemaVersion: 1, commandId: "c-create-auth", runId: RUN_ID, expectedRevision: 0,
      session: OWNER, correlationId: "corr-create-auth",
      type: "createWorkRequest", payload: { title: "Auth test", goal: "Test authoritative" },
    } as CommandEnvelopeV1);
    if (!created.ok) throw new Error(created.reason);

    const checkpoint = await store.apply({
      schemaVersion: 1, commandId: "c-cp-auth", runId: RUN_ID, expectedRevision: created.state.revision,
      session: { sessionId: "sess-bearing", actor: "bearing" }, correlationId: "corr-cp-auth",
      type: "recordJourneyCheckpoint",
      payload: { stage: "draft-implementation", status: "complete", artifacts: [], planDirectory },
    } as CommandEnvelopeV1);
    if (!checkpoint.ok) throw new Error(checkpoint.reason);

    const required = await store.apply({
      schemaVersion: 1, commandId: "c-req-auth", runId: RUN_ID, expectedRevision: checkpoint.state.revision,
      session: { sessionId: "sess-bearing", actor: "bearing" }, correlationId: "corr-req-auth",
      type: "requireDecision",
      payload: { decisionId: "plan-review-auth", question: "Approve plan?", consequential: true },
    } as CommandEnvelopeV1);
    if (!required.ok) throw new Error(required.reason);

    const body = sampleContractBody();
    const contentHash = hashExecutionContractBody(body);
    const answered = await store.apply({
      schemaVersion: 1, commandId: "c-ans-auth", runId: RUN_ID, expectedRevision: required.state.revision,
      session: OWNER, correlationId: "corr-ans-auth",
      type: "recordOwnerAnswer",
      payload: { decisionId: "plan-review-auth", answer: "Approved for execution-mode selection", ownerApprovedContentHash: contentHash },
    } as CommandEnvelopeV1);
    if (!answered.ok) throw new Error(answered.reason);

    const recordId = answered.events[0].eventId;
    await writeFile(join(root, planDirectory, "execution-contract.json"), JSON.stringify({
      ...body,
      contentHash,
      ownerApproval: { kind: "owner-approval", recordedBy: "owner", durable: true, recordId, contentHash },
    }));

    const durable = await store.load(RUN_ID);
    const result = await applyLegacyExecutionContractApproval({
      repository: root,
      runId: RUN_ID,
      expectedRevision: durable.revision,
      ownerSessionId: OWNER.sessionId,
      body,
      approvedContentHash: contentHash,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("execution_contract_authoritative");
  });

  it("refuses execution_contract_malformed when a file-based contract is present but invalid", async () => {
    const root = await tempRepo();
    const { store } = await seedLegacyRun(root, RUN_ID);
    const durable = await store.load(RUN_ID);

    await writeFile(join(root, "docs/plans/legacy-135", "execution-contract.json"), JSON.stringify({ schemaVersion: 1 }));

    const body = sampleContractBody();
    const result = await applyLegacyExecutionContractApproval({
      repository: root,
      runId: RUN_ID,
      expectedRevision: durable.revision,
      ownerSessionId: OWNER.sessionId,
      body,
      approvedContentHash: hashExecutionContractBody(body),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("execution_contract_malformed");
  });

  it("refuses execution_contract_unresolved when a non-genuine absence is planted (symlink)", async () => {
    const root = await tempRepo();
    const { store } = await seedLegacyRun(root, RUN_ID);
    const durable = await store.load(RUN_ID);

    const contractPath = join(root, "docs/plans/legacy-135", "execution-contract.json");
    await symlink("/dev/null", contractPath);

    const body = sampleContractBody();
    const result = await applyLegacyExecutionContractApproval({
      repository: root,
      runId: RUN_ID,
      expectedRevision: durable.revision,
      ownerSessionId: OWNER.sessionId,
      body,
      approvedContentHash: hashExecutionContractBody(body),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("execution_contract_unresolved");
  });

  it("refuses legacy_contract_run_mismatch when the run has no checkpoint events (compacted-run path)", async () => {
    const root = await tempRepo();
    const store = new BearingStore(root);

    const created = await store.apply({
      schemaVersion: 1, commandId: "c-create-compact", runId: RUN_ID, expectedRevision: 0,
      session: OWNER, correlationId: "corr-create-compact",
      type: "createWorkRequest", payload: { title: "No checkpoint", goal: "Test compacted path" },
    } as CommandEnvelopeV1);
    if (!created.ok) throw new Error(created.reason);

    const body = sampleContractBody();
    const result = await applyLegacyExecutionContractApproval({
      repository: root,
      runId: RUN_ID,
      expectedRevision: created.state.revision,
      ownerSessionId: OWNER.sessionId,
      body,
      approvedContentHash: hashExecutionContractBody(body),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("legacy_contract_run_mismatch");
  });

  it("refuses stale_revision when expectedRevision does not match current revision", async () => {
    const root = await tempRepo();
    const { store } = await seedLegacyRun(root, RUN_ID);
    const durable = await store.load(RUN_ID);

    const body = sampleContractBody();
    const result = await applyLegacyExecutionContractApproval({
      repository: root,
      runId: RUN_ID,
      expectedRevision: durable.revision - 1,
      ownerSessionId: OWNER.sessionId,
      body,
      approvedContentHash: hashExecutionContractBody(body),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("stale_revision");
  });

  it("refuses non_owner_approval at the aggregate decide boundary for a non-owner session", async () => {
    const root = await tempRepo();
    const { store } = await seedLegacyRun(root, RUN_ID);
    const durable = await store.load(RUN_ID);

    const body = sampleContractBody();
    const contentHash = hashExecutionContractBody(body);
    const candidate = {
      ...body,
      contentHash,
      ownerApproval: { kind: "owner-approval", recordedBy: "owner", durable: true, recordId: "test-record", contentHash },
    };

    const result = await store.apply({
      schemaVersion: 1, commandId: "non-owner-contract", runId: RUN_ID,
      expectedRevision: durable.revision,
      session: { sessionId: "sess-agent", actor: "agent" },
      correlationId: "non-owner-contract",
      type: "approveLegacyExecutionContract",
      payload: { contract: candidate as unknown as Record<string, unknown>, approvedContentHash: contentHash },
    } as CommandEnvelopeV1);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("non_owner_approval");
  });

  it("refuses legacy_role_routes_conflict when contract body omits roleRoutes but the run has an existing legacy binding", async () => {
    const root = await tempRepo();
    const { store } = await seedLegacyRun(root, RUN_ID);
    const durable = await store.load(RUN_ID);

    const base = sampleContractBody();
    const { roleRoutes: _omit, ...bodyWithoutRoutes } = base;

    const result = await applyLegacyExecutionContractApproval({
      repository: root,
      runId: RUN_ID,
      expectedRevision: durable.revision,
      ownerSessionId: OWNER.sessionId,
      body: bodyWithoutRoutes as ExecutionContractBody,
      approvedContentHash: hashExecutionContractBody(bodyWithoutRoutes as ExecutionContractBody),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("legacy_role_routes_conflict");
  });

  it("refuses execution_contract_already_bound at the aggregate when a contract is already bound", async () => {
    const root = await tempRepo();
    const { store } = await seedLegacyRun(root, RUN_ID);
    const durable = await store.load(RUN_ID);

    const body = sampleContractBody();
    const contentHash = hashExecutionContractBody(body);
    const first = await applyLegacyExecutionContractApproval({
      repository: root,
      runId: RUN_ID,
      expectedRevision: durable.revision,
      ownerSessionId: OWNER.sessionId,
      body,
      approvedContentHash: contentHash,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const differentBody = { ...sampleContractBody(), objective: "A completely different objective" };
    const diffHash = hashExecutionContractBody(differentBody);
    const candidate = {
      ...differentBody,
      contentHash: diffHash,
      ownerApproval: { kind: "owner-approval", recordedBy: "owner", durable: true, recordId: "test-record", contentHash: diffHash },
    };

    const result = await store.apply({
      schemaVersion: 1, commandId: "second-contract", runId: RUN_ID,
      expectedRevision: first.revision,
      session: OWNER, correlationId: "second-contract",
      type: "approveLegacyExecutionContract",
      payload: { contract: candidate as unknown as Record<string, unknown>, approvedContentHash: diffHash },
    } as CommandEnvelopeV1);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("execution_contract_already_bound");
  });

  it("refuses run_busy when a run lock is held at the MCP layer", async () => {
    const root = await tempRepo();
    await seedLegacyRun(root, RUN_ID);

    const lockDir = join(tmpdir(), `bearing-mcp-locks-${typeof process.getuid === "function" ? process.getuid() : "user"}`);
    await mkdir(lockDir, { recursive: true });
    const identity = createHash("sha256").update(root).update("\0").update(RUN_ID).digest("hex");
    await writeFile(join(lockDir, `${identity}.lock`), `${process.pid}\n`);

    const dispatch = createDispatcher();
    const body = sampleContractBody();
    const approvedContentHash = hashExecutionContractBody(body);

    const res = await callTool(dispatch, "bearing_bind_legacy_execution_contract", {
      repository: root,
      runId: RUN_ID,
      expectedRevision: 3,
      body,
      approvedContentHash,
    });

    const content = structured(res);
    expect(content.code).toBe("run_busy");
  });

  it("refuses dangling_dependency when a dependency edge references a non-existent slice", async () => {
    const root = await tempRepo();
    const { store } = await seedLegacyRun(root, RUN_ID);
    const durable = await store.load(RUN_ID);

    const base = sampleContractBody();
    const danglingBody: ExecutionContractBody = {
      ...base,
      dependencyEdges: [{ from: "S11", to: "S99" }],
    };

    const result = await applyLegacyExecutionContractApproval({
      repository: root,
      runId: RUN_ID,
      expectedRevision: durable.revision,
      ownerSessionId: OWNER.sessionId,
      body: danglingBody,
      approvedContentHash: hashExecutionContractBody(danglingBody),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("dangling_dependency");
  });

  it("refuses legacy_contract_run_mismatch when body.runId differs from request.runId", async () => {
    const root = await tempRepo();
    const { store } = await seedLegacyRun(root, RUN_ID);
    const durable = await store.load(RUN_ID);

    const body = sampleContractBody("wrong-run-id");
    const result = await applyLegacyExecutionContractApproval({
      repository: root,
      runId: RUN_ID,
      expectedRevision: durable.revision,
      ownerSessionId: OWNER.sessionId,
      body,
      approvedContentHash: hashExecutionContractBody(body),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("legacy_contract_run_mismatch");
  });

  it("refuses legacy_contract_run_mismatch when body.planDirectory differs from recorded plan directory", async () => {
    const root = await tempRepo();
    const { store } = await seedLegacyRun(root, RUN_ID);
    const durable = await store.load(RUN_ID);

    const body = sampleContractBody(RUN_ID, "docs/plans/wrong-directory");
    const result = await applyLegacyExecutionContractApproval({
      repository: root,
      runId: RUN_ID,
      expectedRevision: durable.revision,
      ownerSessionId: OWNER.sessionId,
      body,
      approvedContentHash: hashExecutionContractBody(body),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("legacy_contract_run_mismatch");
  });

  it("SEIT-36 negative: migrated contract with pre-existing legacy-scope IDs fails the exact trace check", async () => {
    const root = await tempRepo();
    const { store } = await seedLegacyRun(root, RUN_ID);
    const durable = await store.load(RUN_ID);

    const base = sampleContractBody();
    const tainted: ExecutionContractBody = {
      ...base,
      slices: [{
        ...base.slices[0],
        requirementIds: ["AC-101-01", ...base.slices[0].requirementIds],
        evidenceCommandIds: ["CMD-TEST-FIT", ...base.slices[0].evidenceCommandIds],
      }],
    };
    const result = await applyLegacyExecutionContractApproval({
      repository: root,
      runId: RUN_ID,
      expectedRevision: durable.revision,
      ownerSessionId: OWNER.sessionId,
      body: tainted,
      approvedContentHash: hashExecutionContractBody(tainted),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const actualReqIds = new Set(result.contract.slices.flatMap((s) => s.requirementIds));
    const actualCmdIds = new Set(result.contract.slices.flatMap((s) => s.evidenceCommandIds));
    expect(actualReqIds).not.toEqual(S11_REQUIREMENT_IDS);
    expect(actualCmdIds).not.toEqual(S11_COMMAND_IDS);
  });
});
