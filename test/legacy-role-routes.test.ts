/**
 * The owner-only legacy role-route binding.
 *
 * This is the one command a pending owner decision does not block, so the tests below carry
 * the burden of proving that the exception is exactly one command wide, that the command
 * cannot move journey progress, and that every other gate the aggregate already enforced is
 * still enforced. Each test states one distinct contract.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import {
  hashLegacyRoleRoutes,
  hashExecutionContractBody,
  type ExecutionContractBody,
  type RoleRoute,
} from "../src/contracts/execution-contract.js";
import { parseCommandEnvelope, type CommandEnvelopeV1, type EventEnvelopeV1 } from "../src/contracts/run.js";
import { createDispatcher, type JsonRpcResponse } from "../src/mcp/server.js";
import { readDurableContinuation } from "../src/server/local-session.js";
import { BearingStore } from "../src/store/bearing-store.js";
import { decide, initialRunState, replay, type DecideDeps, type RunState } from "../src/workflow/aggregate.js";

const RUN_ID = "legacy-run-1";
const OWNER = { sessionId: "sess-owner", actor: "owner" };
const QUESTION = "Has either unblock condition changed for the pending infrastructure item?";
const DECISION_ID = "decision-legacy-1";

/** The shape the owner approves: one registered route per required role, no fallbacks. */
const ROUTES: readonly RoleRoute[] = [
  { role: "execution-author", primary: "grok-build", fallbacks: [] },
  { role: "review-general", primary: "codex", fallbacks: [] },
  { role: "review-security", primary: "codex", fallbacks: [] },
];

function deps(): DecideDeps {
  let n = 0;
  return { recordedAt: "2026-08-04T00:00:00Z", nextEventId: () => `evt-${++n}` };
}

function bindCommand(overrides: {
  readonly commandId?: string;
  readonly expectedRevision: number;
  readonly roleRoutes?: unknown;
  readonly approvedContentHash?: string;
  readonly actor?: string;
  readonly runId?: string;
}): CommandEnvelopeV1 {
  const runId = overrides.runId ?? RUN_ID;
  const roleRoutes = overrides.roleRoutes ?? ROUTES;
  return {
    schemaVersion: 1,
    commandId: overrides.commandId ?? "bind-1",
    runId,
    expectedRevision: overrides.expectedRevision,
    session: { sessionId: OWNER.sessionId, actor: overrides.actor ?? OWNER.actor },
    correlationId: "corr-bind",
    type: "approveLegacyRoleRoutes",
    payload: {
      roleRoutes,
      approvedContentHash: overrides.approvedContentHash ?? hashLegacyRoleRoutes(runId, roleRoutes as readonly RoleRoute[]),
    },
  } as unknown as CommandEnvelopeV1;
}

/** A run parked on a genuine pending owner decision, exactly like the legacy run being migrated. */
function pendingRun(): RunState {
  const d = deps();
  let state = initialRunState(RUN_ID);
  const created = decide(state, {
    schemaVersion: 1,
    commandId: "c-create",
    runId: RUN_ID,
    expectedRevision: 0,
    session: OWNER,
    correlationId: "corr-create",
    type: "createWorkRequest",
    payload: { title: "Legacy work", goal: "Complete the approved bounded work" },
  } as CommandEnvelopeV1, d);
  if (!created.ok) throw new Error(created.reason);
  state = created.state;
  const checkpoint = decide(state, {
    schemaVersion: 1,
    commandId: "c-checkpoint",
    runId: RUN_ID,
    expectedRevision: state.revision,
    session: { sessionId: "sess-bearing", actor: "bearing" },
    correlationId: "corr-checkpoint",
    type: "recordJourneyCheckpoint",
    payload: {
      stage: "execute-expedition",
      status: "waiting",
      artifacts: ["docs/plans/legacy/plan-spec.md"],
      planDirectory: "docs/plans/legacy",
      question: QUESTION,
      questionDecisionId: DECISION_ID,
    },
  } as CommandEnvelopeV1, d);
  if (!checkpoint.ok) throw new Error(checkpoint.reason);
  return checkpoint.state;
}

/** Every command type other than the two the pending-decision path admits. */
const BLOCKED_WHILE_PENDING: readonly { readonly name: string; readonly command: (revision: number) => CommandEnvelopeV1 }[] = [
  {
    name: "createWorkRequest",
    command: (expectedRevision) => ({
      schemaVersion: 1, commandId: "b-create", runId: RUN_ID, expectedRevision, session: OWNER,
      correlationId: "b", type: "createWorkRequest", payload: { title: "t", goal: "g" },
    }) as CommandEnvelopeV1,
  },
  {
    name: "requireDecision",
    command: (expectedRevision) => ({
      schemaVersion: 1, commandId: "b-require", runId: RUN_ID, expectedRevision, session: OWNER,
      correlationId: "b", type: "requireDecision", payload: { decisionId: "d-2", question: "q?", consequential: true },
    }) as CommandEnvelopeV1,
  },
  {
    name: "recommendExecutionMode",
    command: (expectedRevision) => ({
      schemaVersion: 1, commandId: "b-recommend", runId: RUN_ID, expectedRevision, session: OWNER,
      correlationId: "b", type: "recommendExecutionMode",
      payload: { workItems: 2, maxCrewmatesPerExplorer: 3, perAgentTokenEstimate: 10 },
    }) as CommandEnvelopeV1,
  },
  {
    name: "approveExecutionMode",
    command: (expectedRevision) => ({
      schemaVersion: 1, commandId: "b-approve", runId: RUN_ID, expectedRevision, session: OWNER,
      correlationId: "b", type: "approveExecutionMode", payload: { recommendationEventId: "evt-9" },
    }) as CommandEnvelopeV1,
  },
  {
    name: "overrideExecutionMode",
    command: (expectedRevision) => ({
      schemaVersion: 1, commandId: "b-override", runId: RUN_ID, expectedRevision, session: OWNER,
      correlationId: "b", type: "overrideExecutionMode",
      payload: { recommendationEventId: "evt-9", selectedMode: "expedition" },
    }) as CommandEnvelopeV1,
  },
  {
    name: "recordJourneyCheckpoint",
    command: (expectedRevision) => ({
      schemaVersion: 1, commandId: "b-checkpoint", runId: RUN_ID, expectedRevision,
      session: { sessionId: "sess-bearing", actor: "bearing" },
      correlationId: "b", type: "recordJourneyCheckpoint",
      payload: { stage: "review", status: "complete", artifacts: [] },
    }) as CommandEnvelopeV1,
  },
  {
    name: "recordOwnerImprovementApplication",
    command: (expectedRevision) => ({
      schemaVersion: 1, commandId: "b-improvement", runId: RUN_ID, expectedRevision, session: OWNER,
      correlationId: "b", type: "recordOwnerImprovementApplication",
      payload: {
        improvementProposalRef: "prop-1",
        externalEvidenceHash: "a".repeat(64),
        surface: "profile",
        targetJson: "{}",
        valueJson: "{}",
      },
    }) as CommandEnvelopeV1,
  },
];

describe("pending-decision exception is exactly one command wide", () => {
  it("admits the owner role-route binding while a decision is pending", () => {
    const state = pendingRun();
    expect(state.pendingDecision).not.toBeNull();
    const result = decide(state, bindCommand({ expectedRevision: state.revision }), deps());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.events.map((event) => event.type)).toEqual(["legacyRoleRoutesApproved"]);
  });

  it.each(BLOCKED_WHILE_PENDING)("still blocks $name with pending_decision_blocks", ({ command }) => {
    const state = pendingRun();
    const result = decide(state, command(state.revision), deps());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("pending_decision_blocks");
  });

  it.each(BLOCKED_WHILE_PENDING)("still blocks $name after a binding is recorded", ({ command }) => {
    const state = pendingRun();
    const bound = decide(state, bindCommand({ expectedRevision: state.revision }), deps());
    expect(bound.ok).toBe(true);
    if (!bound.ok) return;
    const result = decide(bound.state, command(bound.state.revision), deps());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("pending_decision_blocks");
  });

  it("leaves recordOwnerAnswer the only command that clears the decision", () => {
    const state = pendingRun();
    const bound = decide(state, bindCommand({ expectedRevision: state.revision }), deps());
    expect(bound.ok).toBe(true);
    if (!bound.ok) return;
    expect(bound.state.pendingDecision).toEqual(state.pendingDecision);
    const answered = decide(bound.state, {
      schemaVersion: 1, commandId: "c-answer", runId: RUN_ID, expectedRevision: bound.state.revision,
      session: OWNER, correlationId: "corr-answer", type: "recordOwnerAnswer",
      payload: { decisionId: DECISION_ID, answer: "Nothing changed." },
    } as CommandEnvelopeV1, deps());
    expect(answered.ok).toBe(true);
    if (!answered.ok) return;
    expect(answered.state.pendingDecision).toBeNull();
  });
});

describe("the binding projects role routes and nothing else", () => {
  it("advances only revision, hash, and timestamp, leaving every progress field untouched", () => {
    const before = pendingRun();
    const result = decide(before, bindCommand({ expectedRevision: before.revision }), deps());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const after = result.state;
    expect(after.revision).toBe(before.revision + 1);
    expect(after.legacyRoleRoutes).toEqual(ROUTES);
    expect(after.pendingDecision).toEqual(before.pendingDecision);
    expect(after.journeyCheckpoint).toEqual(before.journeyCheckpoint);
    expect(after.workRequestCreated).toBe(before.workRequestCreated);
    expect(after.executionRecommendation).toBe(before.executionRecommendation);
    expect(after.executionApproval).toBe(before.executionApproval);
    expect(after.events.slice(0, before.revision)).toEqual(before.events);
  });

  it("records exactly the two approved payload keys and drops nothing else in", () => {
    const state = pendingRun();
    const result = decide(state, bindCommand({ expectedRevision: state.revision }), deps());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.events[0].payload).sort()).toEqual(["approvedContentHash", "roleRoutes"]);
    expect(result.events[0].actor).toBe("owner");
    expect(result.events[0].previousHash).toBe(state.events.at(-1)!.hash);
  });
});

describe("every binding gate fails closed", () => {
  it("refuses a non-owner actor", () => {
    const state = pendingRun();
    const result = decide(state, bindCommand({ expectedRevision: state.revision, actor: "bearing" }), deps());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("non_owner_approval");
  });

  it("refuses a stale expected revision", () => {
    const state = pendingRun();
    const result = decide(state, bindCommand({ expectedRevision: state.revision - 1 }), deps());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("stale_revision");
  });

  it("refuses a tampered content hash", () => {
    const state = pendingRun();
    const result = decide(state, bindCommand({ expectedRevision: state.revision, approvedContentHash: "b".repeat(64) }), deps());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("role_routes_hash_mismatch");
  });

  it("refuses routes swapped under a hash the owner signed for a different route set", () => {
    const state = pendingRun();
    const tampered = [{ role: "execution-author", primary: "codex", fallbacks: [] }, ...ROUTES.slice(1)];
    const result = decide(state, bindCommand({
      expectedRevision: state.revision,
      roleRoutes: tampered,
      approvedContentHash: hashLegacyRoleRoutes(RUN_ID, ROUTES),
    }), deps());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("role_routes_hash_mismatch");
  });

  it("refuses an approval hash minted for another run", () => {
    const state = pendingRun();
    const result = decide(state, bindCommand({
      expectedRevision: state.revision,
      approvedContentHash: hashLegacyRoleRoutes("some-other-run", ROUTES),
    }), deps());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("role_routes_hash_mismatch");
  });

  it.each([
    ["a missing required role", ROUTES.slice(0, 2)],
    ["a duplicate role", [ROUTES[0], ROUTES[0], ROUTES[1]]],
    ["an extra role", [...ROUTES, { role: "review-general", primary: "codex", fallbacks: [] }]],
    ["an unregistered primary route", [{ role: "execution-author", primary: "totally-unknown", fallbacks: [] }, ...ROUTES.slice(1)]],
    ["an unregistered fallback route", [{ role: "review-general", primary: "codex", fallbacks: ["totally-unknown"] }, ROUTES[0], ROUTES[2]]],
    ["surveyor as the execution-author fallback", [{ role: "execution-author", primary: "grok-build", fallbacks: ["surveyor"] }, ...ROUTES.slice(1)]],
    ["a primary repeated as its own fallback", [{ role: "execution-author", primary: "grok-build", fallbacks: ["grok-build"] }, ...ROUTES.slice(1)]],
    ["an unknown role name", [{ role: "implementer", primary: "codex", fallbacks: [] }, ...ROUTES.slice(1)]],
    ["an extra key on a route", [{ role: "execution-author", primary: "grok-build", fallbacks: [], tier: "high" }, ...ROUTES.slice(1)]],
  ])("refuses %s", (_name, roleRoutes) => {
    const state = pendingRun();
    const result = decide(state, bindCommand({ expectedRevision: state.revision, roleRoutes }), deps());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // A malformed set can never match a hash derived from a well-formed one, so the shape
    // check must fire first for the refusal to name the real defect.
    expect(result.reason).toBe("role_routes_invalid");
  });

  it("refuses a binding on a run that was never created", () => {
    const result = decide(initialRunState(RUN_ID), bindCommand({ expectedRevision: 0 }), deps());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("illegal_transition");
  });
});

describe("the binding is write-once", () => {
  it("refuses a second, different binding", () => {
    const state = pendingRun();
    const first = decide(state, bindCommand({ expectedRevision: state.revision }), deps());
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const other = [{ role: "execution-author", primary: "codex", fallbacks: [] }, ...ROUTES.slice(1)];
    const second = decide(first.state, bindCommand({
      commandId: "bind-2", expectedRevision: first.state.revision, roleRoutes: other,
    }), deps());
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.reason).toBe("role_routes_already_bound");
  });

  it("refuses a second binding that repeats the same routes under a new command id", () => {
    const state = pendingRun();
    const first = decide(state, bindCommand({ expectedRevision: state.revision }), deps());
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = decide(first.state, bindCommand({ commandId: "bind-2", expectedRevision: first.state.revision }), deps());
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.reason).toBe("role_routes_already_bound");
  });

  it("replays an identical command id as an accepted no-op", () => {
    const state = pendingRun();
    const command = bindCommand({ expectedRevision: state.revision });
    const first = decide(state, command, deps());
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const replayed = decide(first.state, command, deps());
    expect(replayed.ok).toBe(true);
    if (!replayed.ok) return;
    expect(replayed.events).toEqual([]);
    expect(replayed.state.revision).toBe(first.state.revision);
  });

  it("refuses the same command id carrying different routes", () => {
    const state = pendingRun();
    const first = decide(state, bindCommand({ expectedRevision: state.revision }), deps());
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const other = [{ role: "execution-author", primary: "codex", fallbacks: [] }, ...ROUTES.slice(1)];
    const conflicting = decide(first.state, bindCommand({ expectedRevision: state.revision, roleRoutes: other }), deps());
    expect(conflicting.ok).toBe(false);
    if (conflicting.ok) return;
    expect(conflicting.reason).toBe("conflicting_duplicate");
  });
});

describe("replay re-derives the binding from the ledger alone", () => {
  function boundLedger(): readonly EventEnvelopeV1[] {
    const state = pendingRun();
    const result = decide(state, bindCommand({ expectedRevision: state.revision }), deps());
    if (!result.ok) throw new Error(result.reason);
    return result.state.events;
  }

  it("restores the exact routes", () => {
    expect(replay(boundLedger()).legacyRoleRoutes).toEqual(ROUTES);
  });

  it("refuses a ledger whose binding payload was edited after the fact", () => {
    const events = [...boundLedger()];
    const last = events.at(-1)!;
    events[events.length - 1] = {
      ...last,
      payload: { ...last.payload, roleRoutes: [{ role: "execution-author", primary: "codex", fallbacks: [] }, ...ROUTES.slice(1)] },
    };
    expect(() => replay(events)).toThrow(/approved content hash/);
  });

  it("refuses a ledger whose binding was written by a non-owner", () => {
    const events = [...boundLedger()];
    events[events.length - 1] = { ...events.at(-1)!, actor: "bearing" };
    expect(() => replay(events)).toThrow(/legacy role-route approval/);
  });

  it("refuses a ledger carrying two bindings", () => {
    const events = boundLedger();
    const doubled = [...events, { ...events.at(-1)!, eventId: "evt-dup", sequence: events.length + 1 }];
    expect(() => replay(doubled)).toThrow(/already bound/);
  });

  it("refuses a ledger whose binding carries an incomplete role set", () => {
    const events = [...boundLedger()];
    const last = events.at(-1)!;
    const partial = ROUTES.slice(0, 2);
    events[events.length - 1] = {
      ...last,
      payload: { roleRoutes: partial, approvedContentHash: hashLegacyRoleRoutes(RUN_ID, partial as readonly RoleRoute[]) },
    };
    expect(() => replay(events)).toThrow(/complete registered binding/);
  });
});

describe("the command envelope boundary", () => {
  const base = {
    schemaVersion: 1, commandId: "bind-1", runId: RUN_ID, expectedRevision: 2,
    session: OWNER, correlationId: "corr-bind", type: "approveLegacyRoleRoutes",
  };

  it("accepts a well-formed envelope", () => {
    expect(parseCommandEnvelope({
      ...base, payload: { roleRoutes: ROUTES, approvedContentHash: hashLegacyRoleRoutes(RUN_ID, ROUTES) },
    }).ok).toBe(true);
  });

  it.each([
    ["an extra payload key", { roleRoutes: ROUTES, approvedContentHash: "a".repeat(64), note: "x" }],
    ["a missing hash", { roleRoutes: ROUTES }],
    ["a non-hash approval", { roleRoutes: ROUTES, approvedContentHash: "not-a-hash" }],
    ["an empty route list", { roleRoutes: [], approvedContentHash: "a".repeat(64) }],
    ["a non-array route list", { roleRoutes: "codex", approvedContentHash: "a".repeat(64) }],
    ["a route missing its fallbacks", { roleRoutes: [{ role: "review-general", primary: "codex" }], approvedContentHash: "a".repeat(64) }],
    ["a route with a non-string fallback", { roleRoutes: [{ role: "review-general", primary: "codex", fallbacks: [7] }], approvedContentHash: "a".repeat(64) }],
  ])("refuses %s", (_name, payload) => {
    expect(parseCommandEnvelope({ ...base, payload })).toEqual({ ok: false, reason: "malformed" });
  });
});

// --- Durable and projected behavior -----------------------------------------

const roots: string[] = [];
afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

async function tempRepo(): Promise<string> {
  const created = await mkdtemp(join(tmpdir(), "bearing-legacy-routes-"));
  roots.push(created);
  const root = await realpath(created);
  await new Promise<void>((resolve, reject) => {
    execFile("git", ["init", "-q"], { cwd: root }, (error) => (error ? reject(error) : resolve()));
  });
  return root;
}

/** A durable run parked exactly where the migrated legacy run is: waiting on an owner question. */
async function seedPendingRun(root: string, runId: string): Promise<{ store: BearingStore; planDirectory: string }> {
  const store = new BearingStore(root);
  const planDirectory = `docs/plans/${runId}`;
  await mkdir(join(root, planDirectory), { recursive: true });
  const created = await store.apply({
    schemaVersion: 1, commandId: `create-${runId}`, runId, expectedRevision: 0,
    session: OWNER, correlationId: `create-${runId}`, type: "createWorkRequest",
    payload: { title: "Legacy work", goal: "Complete the approved bounded work" },
  } as CommandEnvelopeV1);
  if (!created.ok) throw new Error(created.reason);
  const checkpoint = await store.apply({
    schemaVersion: 1, commandId: `checkpoint-${runId}`, runId, expectedRevision: created.state.revision,
    session: { sessionId: "sess-bearing", actor: "bearing" }, correlationId: `checkpoint-${runId}`,
    type: "recordJourneyCheckpoint",
    payload: {
      stage: "execute-expedition",
      status: "waiting",
      artifacts: [`${planDirectory}/plan-spec.md`],
      planDirectory,
      resolvedPlanDirectory: planDirectory,
      question: QUESTION,
      questionDecisionId: DECISION_ID,
      lastResultJson: JSON.stringify({ status: "question", questions: [QUESTION], tokens: 12 }),
      selectionProvider: "codex",
      selectionModel: "gpt-5.4",
      selectionReasoning: "medium",
      repositoryFitDecision: { outcome: "confirmed", planDirectory, repository: root, decidedAt: "2026-08-02T00:00:00.000Z" },
    },
  } as CommandEnvelopeV1);
  if (!checkpoint.ok) throw new Error(checkpoint.reason);
  return { store, planDirectory };
}

function callTool(dispatch: ReturnType<typeof createDispatcher>, args: unknown): Promise<JsonRpcResponse | null> {
  return dispatch({
    jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "bearing_bind_legacy_role_routes", arguments: args },
  });
}

function structured(response: JsonRpcResponse | null): Record<string, unknown> {
  const value = (response?.result as { structuredContent?: unknown } | undefined)?.structuredContent;
  if (typeof value !== "object" || value === null) throw new Error(`no structuredContent: ${JSON.stringify(response)}`);
  return value as Record<string, unknown>;
}

const PROJECTED_ROUTES = {
  authorRoute: { primary: "grok-build", fallbacks: [] },
  reviewSlots: { general: { primary: "codex", fallbacks: [] }, security: { primary: "codex", fallbacks: [] } },
};

describe("durable store round-trip", () => {
  it("persists the binding through the snapshot and restores it on reload", async () => {
    const root = await tempRepo();
    const runId = "durable-1";
    const { store } = await seedPendingRun(root, runId);
    const before = await store.load(runId);
    const applied = await store.apply({
      schemaVersion: 1, commandId: `bind-${runId}`, runId, expectedRevision: before.revision,
      session: OWNER, correlationId: `bind-${runId}`, type: "approveLegacyRoleRoutes",
      payload: { roleRoutes: ROUTES, approvedContentHash: hashLegacyRoleRoutes(runId, ROUTES) },
    } as CommandEnvelopeV1);
    expect(applied.ok).toBe(true);

    const reloaded = await store.load(runId);
    expect(reloaded.legacyRoleRoutes).toEqual(ROUTES);
    expect(reloaded.revision).toBe(before.revision + 1);
    expect(reloaded.pendingDecision).toEqual(before.pendingDecision);
    expect(reloaded.journeyCheckpoint).toEqual(before.journeyCheckpoint);
    const snapshot = JSON.parse(await readFile(join(root, (await store.runWorkspacePath(runId)) ?? join(".bearing", "runs", runId), "snapshot.json"), "utf8"));
    expect(snapshot.legacyRoleRoutes).toEqual(ROUTES);
  });

  it("still loads a snapshot written before the field existed", async () => {
    const root = await tempRepo();
    const runId = "durable-2";
    const { store } = await seedPendingRun(root, runId);
    const path = join(root, (await store.runWorkspacePath(runId)) ?? join(".bearing", "runs", runId), "snapshot.json");
    const snapshot = JSON.parse(await readFile(path, "utf8"));
    expect(snapshot).not.toHaveProperty("legacyRoleRoutes");
    const loaded = await store.load(runId);
    expect(loaded.legacyRoleRoutes).toBeNull();
  });
});

describe("attach and handoff source the binding only as a last resort", () => {
  it("projects the owner binding when no execution contract resolves", async () => {
    const root = await tempRepo();
    const runId = "projected-1";
    const dispatch = createDispatcher();
    const { store } = await seedPendingRun(root, runId);
    const before = await store.load(runId);

    const bound = structured(await callTool(dispatch, {
      repository: root, runId, expectedRevision: before.revision,
      roleRoutes: ROUTES, approvedContentHash: hashLegacyRoleRoutes(runId, ROUTES),
    }));
    expect(bound).toMatchObject({ revision: before.revision + 1, recorded: true, roleRoutes: PROJECTED_ROUTES });

    const read = await readDurableContinuation(root, runId);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.roleRoutes).toEqual(PROJECTED_ROUTES);
    expect(read.roleRoutesBlocker).toBeUndefined();
    expect(read.stage).toBe("execute-expedition");
    expect(read.status).toBe("waiting");
  });

  it("refuses to bind, and keeps the contract authoritative, when an approved contract resolves", async () => {
    const root = await tempRepo();
    const runId = "projected-2";
    const dispatch = createDispatcher();
    const { store, planDirectory } = await seedPendingRun(root, runId);
    const durable = await store.load(runId);
    const contractRoutes: readonly RoleRoute[] = [
      { role: "execution-author", primary: "codex", fallbacks: [] },
      { role: "review-general", primary: "claude", fallbacks: [] },
      { role: "review-security", primary: "claude", fallbacks: [] },
    ];
    const body: ExecutionContractBody = {
      schemaVersion: 1,
      contractId: `contract-${runId}`,
      runId,
      planDirectory,
      objective: "Complete the approved bounded work",
      mode: "explorer",
      reviewCadence: "per-slice",
      phases: [{ phaseId: "P1", title: "Phase 1", entryCriteria: "Plan approved", exitCriteria: "Slice reviewed" }],
      slices: [{
        sliceId: "1.1", phaseId: "P1", requirementIds: ["AC-1"], writeSet: ["src/import.ts"],
        acceptance: "Complete bounded work.", evidenceCommandIds: ["CMD-UNIT"], dependsOn: [],
        parallelSafe: false, role: "explorer", reasoningTier: "medium",
      }],
      dependencyEdges: [],
      roleRoutes: contractRoutes,
    };
    const contentHash = hashExecutionContractBody(body);
    // The owner approval that binds this contract is the run's own pending decision answer.
    const answered = await store.apply({
      schemaVersion: 1, commandId: `answer-${runId}`, runId, expectedRevision: durable.revision,
      session: OWNER, correlationId: `answer-${runId}`, type: "recordOwnerAnswer",
      payload: { decisionId: DECISION_ID, answer: "Approved for execution-mode selection", ownerApprovedContentHash: contentHash },
    } as CommandEnvelopeV1);
    if (!answered.ok) throw new Error(answered.reason);
    await writeFile(join(root, planDirectory, "execution-contract.json"), JSON.stringify({
      ...body,
      contentHash,
      ownerApproval: { kind: "owner-approval", recordedBy: "owner", durable: true, recordId: answered.events[0].eventId, contentHash },
    }));

    const refused = structured(await callTool(dispatch, {
      repository: root, runId, expectedRevision: answered.state.revision,
      roleRoutes: ROUTES, approvedContentHash: hashLegacyRoleRoutes(runId, ROUTES),
    }));
    expect(refused.code).toBe("execution_contract_authoritative");

    const read = await readDurableContinuation(root, runId);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.roleRoutes).toEqual({
      authorRoute: { primary: "codex", fallbacks: [] },
      reviewSlots: { general: { primary: "claude", fallbacks: [] }, security: { primary: "claude", fallbacks: [] } },
    });
    expect((await store.load(runId)).legacyRoleRoutes).toBeNull();
  });
});

describe("an unverifiable execution contract fails closed, never open to legacy routes", () => {
  /** Binds legacy routes first, then plants a contract artifact that cannot be validated. */
  async function boundRunWithBrokenContract(runId: string, contract: string): Promise<{ root: string; store: BearingStore }> {
    const root = await tempRepo();
    const { store, planDirectory } = await seedPendingRun(root, runId);
    const before = await store.load(runId);
    const applied = await store.apply({
      schemaVersion: 1, commandId: `bind-${runId}`, runId, expectedRevision: before.revision,
      session: OWNER, correlationId: `bind-${runId}`, type: "approveLegacyRoleRoutes",
      payload: { roleRoutes: ROUTES, approvedContentHash: hashLegacyRoleRoutes(runId, ROUTES) },
    } as CommandEnvelopeV1);
    if (!applied.ok) throw new Error(applied.reason);
    await writeFile(join(root, planDirectory, "execution-contract.json"), contract);
    return { root, store };
  }

  it.each([
    ["malformed", "{ not a contract }"],
    ["present but with unverifiable owner approval", JSON.stringify({
      schemaVersion: 1, contractId: "c", runId: "unverified", planDirectory: "docs/plans/unverified",
      objective: "o", mode: "explorer", reviewCadence: "per-slice",
      phases: [{ phaseId: "P1", title: "T", entryCriteria: "e", exitCriteria: "x" }],
      slices: [{
        sliceId: "1.1", phaseId: "P1", requirementIds: ["AC-1"], writeSet: ["src/a.ts"], acceptance: "a",
        evidenceCommandIds: ["CMD-UNIT"], dependsOn: [], parallelSafe: false, role: "explorer", reasoningTier: "medium",
      }],
      dependencyEdges: [],
      contentHash: "c".repeat(64),
      ownerApproval: { kind: "owner-approval", recordedBy: "owner", durable: true, recordId: "never-recorded", contentHash: "c".repeat(64) },
    })],
  ])("does not project legacy routes when the contract is %s", async (name, contract) => {
    const runId = name === "malformed" ? "broken-1" : "unverified";
    const { root } = await boundRunWithBrokenContract(runId, contract);
    const read = await readDurableContinuation(root, runId);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    // The binding is still durable, but an unvalidatable contract is not proof that none exists.
    expect(read.roleRoutes).toBeUndefined();
  });

  it("does not project legacy routes when a contract artifact is present but unreadable", async () => {
    // A directory at the contract path is refused by the source reader exactly like a missing
    // file. Absence must be proved from the filesystem, not inferred from that one answer.
    const root = await tempRepo();
    const runId = "unreadable-1";
    const { store, planDirectory } = await seedPendingRun(root, runId);
    const before = await store.load(runId);
    const applied = await store.apply({
      schemaVersion: 1, commandId: `bind-${runId}`, runId, expectedRevision: before.revision,
      session: OWNER, correlationId: `bind-${runId}`, type: "approveLegacyRoleRoutes",
      payload: { roleRoutes: ROUTES, approvedContentHash: hashLegacyRoleRoutes(runId, ROUTES) },
    } as CommandEnvelopeV1);
    if (!applied.ok) throw new Error(applied.reason);
    await mkdir(join(root, planDirectory, "execution-contract.json"), { recursive: true });

    const read = await readDurableContinuation(root, runId);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.roleRoutes).toBeUndefined();
  });

  it("refuses a new binding when a contract artifact is present but unreadable", async () => {
    const root = await tempRepo();
    const runId = "unreadable-2";
    const dispatch = createDispatcher();
    const { store, planDirectory } = await seedPendingRun(root, runId);
    await mkdir(join(root, planDirectory, "execution-contract.json"), { recursive: true });
    const before = await store.load(runId);
    const refused = structured(await callTool(dispatch, {
      repository: root, runId, expectedRevision: before.revision,
      roleRoutes: ROUTES, approvedContentHash: hashLegacyRoleRoutes(runId, ROUTES),
    }));
    expect(refused.code).toBe("execution_contract_unresolved");
    expect((await store.load(runId)).legacyRoleRoutes).toBeNull();
  });

  it("refuses a new binding when a contract artifact exists but cannot be validated", async () => {
    const root = await tempRepo();
    const runId = "refuse-broken";
    const dispatch = createDispatcher();
    const { store, planDirectory } = await seedPendingRun(root, runId);
    await writeFile(join(root, planDirectory, "execution-contract.json"), "{ not a contract }");
    const before = await store.load(runId);
    const refused = structured(await callTool(dispatch, {
      repository: root, runId, expectedRevision: before.revision,
      roleRoutes: ROUTES, approvedContentHash: hashLegacyRoleRoutes(runId, ROUTES),
    }));
    expect(refused.code).toBe("execution_contract_malformed");
    expect((await store.load(runId)).legacyRoleRoutes).toBeNull();
  });
});

describe("a durable contract approval outranks a deleted artifact", () => {
  it("stops projecting legacy routes once the owner has approved a contract by hash", async () => {
    const root = await tempRepo();
    const runId = "deleted-contract";
    const { store, planDirectory } = await seedPendingRun(root, runId);
    const before = await store.load(runId);
    const bound = await store.apply({
      schemaVersion: 1, commandId: `bind-${runId}`, runId, expectedRevision: before.revision,
      session: OWNER, correlationId: `bind-${runId}`, type: "approveLegacyRoleRoutes",
      payload: { roleRoutes: ROUTES, approvedContentHash: hashLegacyRoleRoutes(runId, ROUTES) },
    } as CommandEnvelopeV1);
    if (!bound.ok) throw new Error(bound.reason);
    // While no contract has ever been approved, the binding is the only route source.
    const legacy = await readDurableContinuation(root, runId);
    expect(legacy.ok && legacy.roleRoutes).toEqual(PROJECTED_ROUTES);

    // The owner then approves a contract by content hash — durable evidence in the ledger.
    const answered = await store.apply({
      schemaVersion: 1, commandId: `approve-${runId}`, runId, expectedRevision: bound.state.revision,
      session: OWNER, correlationId: `approve-${runId}`, type: "recordOwnerAnswer",
      payload: {
        decisionId: DECISION_ID,
        answer: "Approved for execution-mode selection",
        ownerApprovedContentHash: "d".repeat(64),
      },
    } as CommandEnvelopeV1);
    if (!answered.ok) throw new Error(answered.reason);
    // The artifact itself is never written, which is exactly the "deleted contract" state.
    expect(existsSync(join(root, planDirectory, "execution-contract.json"))).toBe(false);

    const read = await readDurableContinuation(root, runId);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.roleRoutes).toBeUndefined();
  });
});

describe("a compacted run cannot prove a contract is absent", () => {
  it("stops projecting legacy routes once the ledger is sealed away", async () => {
    const root = await tempRepo();
    const runId = "compacted-1";
    const { store, planDirectory } = await seedPendingRun(root, runId);
    let revision = (await store.load(runId)).revision;
    const step = async (command: Record<string, unknown>): Promise<void> => {
      const applied = await store.apply({
        schemaVersion: 1, runId, expectedRevision: revision, correlationId: String(command.commandId), ...command,
      } as CommandEnvelopeV1);
      if (!applied.ok) throw new Error(String(applied.reason));
      revision = applied.state.revision;
    };
    await step({
      commandId: `bind-${runId}`, session: OWNER, type: "approveLegacyRoleRoutes",
      payload: { roleRoutes: ROUTES, approvedContentHash: hashLegacyRoleRoutes(runId, ROUTES) },
    });
    await step({
      commandId: `answer-${runId}`, session: OWNER, type: "recordOwnerAnswer",
      payload: { decisionId: DECISION_ID, answer: "Nothing changed." },
    });
    await step({
      commandId: `settle-${runId}`, session: { sessionId: "sess-bearing", actor: "bearing" },
      type: "recordJourneyCheckpoint",
      payload: { stage: "review", status: "complete", artifacts: [], planDirectory, resolvedPlanDirectory: planDirectory },
    });
    // Before sealing, the binding is readable exactly as bound.
    const live = await readDurableContinuation(root, runId);
    expect(live.ok && live.roleRoutes).toEqual(PROJECTED_ROUTES);

    await store.compact(runId, { noDirtyOrUnmergedLane: true, runNotBusy: true });
    const sealed = await readDurableContinuation(root, runId);
    expect(sealed.ok).toBe(true);
    if (!sealed.ok) return;
    // A sealed ledger records no plan directory, so no contract can be resolved from it, so
    // absence cannot be proved and the legacy binding must not supplant a contract route.
    expect(sealed.roleRoutes).toBeUndefined();
  });
});

describe("the browser command gateway is not a binding path", () => {
  it("refuses the binding command instead of forwarding it to the store", async () => {
    const { CommandGateway } = await import("../src/server/command-gateway.js");
    let applied = 0;
    const gateway = new CommandGateway(
      { apply: () => { applied += 1; return Promise.resolve({ ok: false, reason: "malformed_command" }); } } as never,
      { validOrigin: () => true, authenticateRequest: () => true, ownerSessionId: () => "owner-session" } as never,
      { publish: () => {} } as never,
    );
    const body = JSON.stringify({
      schemaVersion: 1, commandId: "bind-1", runId: "gw-1", expectedRevision: 0,
      session: { sessionId: "owner-session", actor: "owner" }, correlationId: "corr",
      type: "approveLegacyRoleRoutes",
      payload: { roleRoutes: ROUTES, approvedContentHash: hashLegacyRoleRoutes("gw-1", ROUTES) },
    });
    const req = Object.assign(new (await import("node:stream")).Readable({
      read() { this.push(body); this.push(null); },
    }), { headers: { origin: "http://127.0.0.1", "content-type": "application/json" } });
    const status = await new Promise<number>((resolve) => {
      gateway.handle(req as never, { writeHead: (code: number) => resolve(code), end: () => {} } as never, "gw-1");
    });
    expect(status).toBe(400);
    expect(applied).toBe(0);
  });
});

describe("the MCP binding surface", () => {
  it("reports an exact re-submission as already durable without writing again", async () => {
    const root = await tempRepo();
    const runId = "mcp-1";
    const dispatch = createDispatcher();
    const { store } = await seedPendingRun(root, runId);
    const before = await store.load(runId);
    const args = {
      repository: root, runId, expectedRevision: before.revision,
      roleRoutes: ROUTES, approvedContentHash: hashLegacyRoleRoutes(runId, ROUTES),
    };
    const first = structured(await callTool(dispatch, args));
    expect(first).toMatchObject({ recorded: true, revision: before.revision + 1 });
    const again = structured(await callTool(dispatch, args));
    expect(again).toMatchObject({ recorded: false, revision: before.revision + 1 });
    expect((await store.load(runId)).revision).toBe(before.revision + 1);
  });

  it("refuses a different second binding", async () => {
    const root = await tempRepo();
    const runId = "mcp-2";
    const dispatch = createDispatcher();
    const { store } = await seedPendingRun(root, runId);
    const before = await store.load(runId);
    await callTool(dispatch, {
      repository: root, runId, expectedRevision: before.revision,
      roleRoutes: ROUTES, approvedContentHash: hashLegacyRoleRoutes(runId, ROUTES),
    });
    const other: readonly RoleRoute[] = [{ role: "execution-author", primary: "codex", fallbacks: [] }, ...ROUTES.slice(1)];
    const refused = structured(await callTool(dispatch, {
      repository: root, runId, expectedRevision: before.revision + 1,
      roleRoutes: other, approvedContentHash: hashLegacyRoleRoutes(runId, other),
    }));
    expect(refused.code).toBe("role_routes_already_bound");
  });

  it.each([
    ["stale_revision", (revision: number) => ({ expectedRevision: revision - 1, roleRoutes: ROUTES })],
    ["role_routes_hash_mismatch", () => ({ roleRoutes: ROUTES, approvedContentHash: "b".repeat(64) })],
    ["role_routes_invalid", () => ({ roleRoutes: [ROUTES[0], ROUTES[0], ROUTES[1]] })],
  ])("refuses with %s", async (code, build) => {
    const root = await tempRepo();
    const runId = `mcp-${code}`;
    const dispatch = createDispatcher();
    const { store } = await seedPendingRun(root, runId);
    const before = await store.load(runId);
    const overrides = build(before.revision) as { expectedRevision?: number; roleRoutes: readonly RoleRoute[]; approvedContentHash?: string };
    const refused = structured(await callTool(dispatch, {
      repository: root,
      runId,
      expectedRevision: overrides.expectedRevision ?? before.revision,
      roleRoutes: overrides.roleRoutes,
      approvedContentHash: overrides.approvedContentHash ?? hashLegacyRoleRoutes(runId, overrides.roleRoutes),
    }));
    expect(refused.code).toBe(code);
    expect((await store.load(runId)).revision).toBe(before.revision);
  });

  it("refuses an unknown run without creating one", async () => {
    const root = await tempRepo();
    const dispatch = createDispatcher();
    const refused = structured(await callTool(dispatch, {
      repository: root, runId: "never-created", expectedRevision: 0,
      roleRoutes: ROUTES, approvedContentHash: hashLegacyRoleRoutes("never-created", ROUTES),
    }));
    expect(refused.code).toBe("run_not_found");
  });

  it.each([
    ["a role outside the required set", [{ role: "implementer", primary: "codex", fallbacks: [] }, ROUTES[1], ROUTES[2]]],
    ["fewer routes than required roles", ROUTES.slice(0, 2)],
    ["a non-hash approval", ROUTES],
  ])("rejects %s at the schema boundary", async (name, roleRoutes) => {
    const root = await tempRepo();
    const dispatch = createDispatcher();
    const response = await callTool(dispatch, {
      repository: root, runId: "schema-check", expectedRevision: 0, roleRoutes,
      approvedContentHash: name === "a non-hash approval" ? "nope" : hashLegacyRoleRoutes("schema-check", ROUTES),
    });
    expect(response?.error?.code).toBe(-32602);
  });
});
