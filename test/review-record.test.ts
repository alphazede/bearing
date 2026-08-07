import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import { createDispatcher, type JsonRpcResponse } from "../src/mcp/server.js";
import {
  isReviewRecord,
  isReviewRecords,
  parseCommandEnvelope,
  type CommandEnvelopeV1,
  type ReviewRecord,
} from "../src/contracts/run.js";
import { hashExecutionContractBody, type ExecutionContractBody, type RoleRoute } from "../src/contracts/execution-contract.js";
import {
  readReviewContext,
  recordReviewGate,
  type HeadlessJourneyReceipt,
  type HeadlessJourneyRequest,
  type ReviewGateRequest,
} from "../src/server/local-session.js";
import { BearingStore } from "../src/store/bearing-store.js";

const exec = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const PLAN_REVIEW_QUESTION = "Approve the complete planning package before implementation?";
const PLAN_REVIEW_APPROVAL = "Approved for execution-mode selection";
const RUN_ID = "review-run";
const PLAN_DIRECTORY = "docs/plans/import";
const IMPLEMENTER = "implementer-session";
const REVIEWER = "reviewer-session";

function contractBody(runId = RUN_ID, planDirectory = PLAN_DIRECTORY, roleRoutes?: readonly RoleRoute[]): ExecutionContractBody {
  return {
    schemaVersion: 1,
    contractId: "contract-1",
    runId,
    planDirectory,
    objective: "Import bounded data",
    mode: "explorer",
    reviewCadence: "per-slice",
    phases: [{ phaseId: "P1", title: "Phase 1", entryCriteria: "Plan approved", exitCriteria: "Slice reviewed" }],
    slices: [{
      sliceId: "1.1",
      phaseId: "P1",
      requirementIds: ["AC-1"],
      writeSet: ["src/import.ts"],
      acceptance: "Import bounded data.",
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

interface Fixture {
  readonly root: string;
  readonly store: BearingStore;
  readonly revision: number;
  readonly contractHash: string;
  readonly head: string;
}

async function apply(store: BearingStore, command: CommandEnvelopeV1) {
  const result = await store.apply(command);
  if (!result.ok) throw new Error(result.reason);
  return result;
}

/**
 * A repository parked exactly where an independent review gate is decided: an
 * owner-approved execution contract on disk, its approval on the ledger, and a
 * clean committed worktree.
 */
async function fixture(
  runId = RUN_ID,
  roleRoutes?: readonly RoleRoute[],
  status: "complete" | "waiting" = "complete",
): Promise<Fixture> {
  const created = await mkdtemp(join(tmpdir(), "bearing-review-"));
  roots.push(created);
  const root = await realpath(created);
  await mkdir(join(root, PLAN_DIRECTORY), { recursive: true });
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src/import.ts"), "export const imported = true;\n");
  // A provisioned repository ignores both the hidden ledger and the visible
  // per-plan workspaces; committing the migrated audit trail would make every
  // subsequent gate record a tracked-tree change and the candidate permanently dirty.
  await writeFile(join(root, ".gitignore"), ".bearing/\nbearing-*/\n");
  await exec("git", ["init", "-q"], { cwd: root });
  await exec("git", ["config", "user.email", "bearing@example.invalid"], { cwd: root });
  await exec("git", ["config", "user.name", "Bearing Test"], { cwd: root });

  const store = new BearingStore(root);
  const work = await apply(store, {
    schemaVersion: 1,
    commandId: "create",
    runId,
    expectedRevision: 0,
    type: "createWorkRequest",
    payload: { title: "Bounded work", goal: "Import bounded data" },
    session: { sessionId: "test-owner", actor: "owner" },
    correlationId: "create",
  });
  const checkpoint = await apply(store, {
    schemaVersion: 1,
    commandId: "checkpoint",
    runId,
    expectedRevision: work.state.revision,
    type: "recordJourneyCheckpoint",
    payload: {
      stage: "draft-implementation",
      status,
      artifacts: [`${PLAN_DIRECTORY}/plan-spec.md`],
      planDirectory: PLAN_DIRECTORY,
      resolvedPlanDirectory: PLAN_DIRECTORY,
      selectionProvider: "codex",
      selectionModel: "gpt-test",
      selectionReasoning: "medium",
    },
    session: { sessionId: IMPLEMENTER, actor: "bearing" },
    correlationId: "checkpoint",
  });
  const required = await apply(store, {
    schemaVersion: 1,
    commandId: "require",
    runId,
    expectedRevision: checkpoint.state.revision,
    type: "requireDecision",
    payload: { decisionId: "plan-review", question: PLAN_REVIEW_QUESTION, consequential: true },
    session: { sessionId: IMPLEMENTER, actor: "bearing" },
    correlationId: "require",
  });
  const body = contractBody(runId, PLAN_DIRECTORY, roleRoutes);
  const contractHash = hashExecutionContractBody(body);
  const answered = await apply(store, {
    schemaVersion: 1,
    commandId: "approve",
    runId,
    expectedRevision: required.state.revision,
    type: "recordOwnerAnswer",
    payload: { decisionId: "plan-review", answer: PLAN_REVIEW_APPROVAL, ownerApprovedContentHash: contractHash },
    session: { sessionId: "test-owner", actor: "owner" },
    correlationId: "approve",
  });
  const recordId = answered.events[0].eventId;
  await writeFile(join(root, PLAN_DIRECTORY, "execution-contract.json"), JSON.stringify({
    ...body,
    contentHash: contractHash,
    ownerApproval: { kind: "owner-approval", recordedBy: "owner", durable: true, recordId, contentHash: contractHash },
  }));
  await writeFile(join(root, PLAN_DIRECTORY, "plan-spec.md"), "# plan\n");

  await exec("git", ["add", "."], { cwd: root });
  await exec("git", ["commit", "-qm", "candidate"], { cwd: root });
  const { stdout } = await exec("git", ["rev-parse", "HEAD"], { cwd: root });
  return { root, store, revision: answered.state.revision, contractHash, head: stdout.trim() };
}

function request(fixed: Fixture, overrides: Partial<ReviewGateRequest> = {}): ReviewGateRequest {
  return {
    repository: fixed.root,
    runId: RUN_ID,
    expectedRevision: fixed.revision,
    reviewClass: "general",
    reviewerSessionId: REVIEWER,
    reviewedRevision: fixed.head,
    contractHash: fixed.contractHash,
    scope: ["1.1"],
    verdict: "PASS",
    commands: [{ commandId: "CMD-UNIT", status: "passed", summary: "1 test passed" }],
    findings: [],
    ...overrides,
  };
}

function structured(response: JsonRpcResponse | null): Record<string, unknown> {
  const value = (response?.result as { structuredContent?: unknown } | undefined)?.structuredContent;
  if (typeof value !== "object" || value === null) throw new Error(`no structuredContent: ${JSON.stringify(response)}`);
  return value as Record<string, unknown>;
}

function callTool(name: string, args: unknown, dispatch = createDispatcher()): Promise<JsonRpcResponse | null> {
  return dispatch({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
}

/** Byte-level durable fingerprint: proves a call mutated nothing at all. */
async function durableFingerprint(root: string): Promise<string> {
  const walk = async (path: string, prefix: string): Promise<string[]> => {
    let entries;
    try { entries = await readdir(path, { withFileTypes: true }); }
    catch { return [`${prefix}:absent`]; }
    const lines: string[] = [];
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const child = join(path, entry.name);
      const name = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) lines.push(...await walk(child, name));
      else lines.push(`${name}:${(await readFile(child)).toString("base64")}`);
    }
    return lines;
  };
  // Slice-1 relocation: the migrated audit trail lives in the visible per-plan
  // workspaces, so a mutation-free proof must cover them or it proves nothing.
  const targets = [join(root, ".bearing")];
  const visible = (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && /^bearing-/.test(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of visible) targets.push(join(root, entry.name));
  return (await Promise.all(targets.map((target) => walk(target, basename(target))))).flat().join("\n");
}

async function storedReview(root: string, runId = RUN_ID): Promise<readonly ReviewRecord[] | undefined> {
  // A fresh store and a fresh replay: nothing in the writer's process is trusted.
  return (await new BearingStore(root).load(runId)).journeyCheckpoint?.review;
}

const PASSING: ReviewRecord = {
  reviewClass: "general",
  verdict: "PASS",
  contractHash: "a".repeat(64),
  reviewedRevision: "b".repeat(40),
  scope: ["1.1"],
  reviewerIdentity: "0".repeat(16),
  implementerIdentities: ["1".repeat(16)],
  commands: [{ commandId: "CMD-UNIT", status: "passed", summary: "1 test passed" }],
  findings: [],
};

describe("durable review record contract", () => {
  it("accepts one bounded record and refuses every unsound variant", () => {
    expect(isReviewRecord(PASSING)).toBe(true);
    // Self-review and ancestry overlap are the same defect: the reviewer is an implementer.
    expect(isReviewRecord({ ...PASSING, implementerIdentities: [PASSING.reviewerIdentity] })).toBe(false);
    // A failed rerun cannot support a pass, and a non-pass with no finding says nothing.
    expect(isReviewRecord({ ...PASSING, commands: [{ commandId: "CMD-UNIT", status: "failed", summary: "1 test failed" }] })).toBe(false);
    expect(isReviewRecord({ ...PASSING, verdict: "FAIL" })).toBe(false);
    expect(isReviewRecord({ ...PASSING, verdict: "FAIL", findings: [{ summary: "boundary unchecked", evidence: "src/import.ts:4" }] })).toBe(true);
    expect(isReviewRecord({ ...PASSING, reviewedRevision: "zz" })).toBe(false);
    expect(isReviewRecord({ ...PASSING, reviewerIdentity: "/etc/passwd" })).toBe(false);
    expect(isReviewRecord({ ...PASSING, scope: ["1.1", "1.1"] })).toBe(false);
    expect(isReviewRecord({ ...PASSING, extra: 1 })).toBe(false);
    expect(isReviewRecord({ ...PASSING, findings: Array.from({ length: 65 }, () => ({ summary: "s", evidence: "e" })) })).toBe(false);
  });

  it("binds every class in one checkpoint to a single reviewed revision", () => {
    const security = { ...PASSING, reviewClass: "security" as const };
    expect(isReviewRecords([PASSING, security])).toBe(true);
    expect(isReviewRecords([security, PASSING])).toBe(false);
    expect(isReviewRecords([PASSING, PASSING])).toBe(false);
    expect(isReviewRecords([PASSING, { ...security, reviewedRevision: "c".repeat(40) }])).toBe(false);
    expect(isReviewRecords([])).toBe(false);
  });

  it("refuses a malformed review on the checkpoint command boundary", () => {
    const envelope = (review: unknown) => parseCommandEnvelope({
      schemaVersion: 1,
      commandId: "c",
      runId: RUN_ID,
      expectedRevision: 0,
      type: "recordJourneyCheckpoint",
      payload: { stage: "review", status: "complete", artifacts: [], review },
      session: { sessionId: "s", actor: "bearing" },
      correlationId: "c",
    });
    expect(envelope([PASSING]).ok).toBe(true);
    expect(envelope([{ ...PASSING, implementerIdentities: [PASSING.reviewerIdentity] }]).ok).toBe(false);
    expect(envelope("PASS").ok).toBe(false);
  });
});

describe("independent review gate", () => {
  it("reports the approved contract, exact scope, and clean candidate revision without leaking the repository", async () => {
    const fixed = await fixture();
    const context = await readReviewContext(fixed.root, RUN_ID, "security");
    expect(context.ok).toBe(true);
    if (!context.ok) throw new Error(context.code);
    expect(context).toMatchObject({
      runId: RUN_ID,
      reviewClass: "security",
      revision: fixed.revision,
      contractHash: fixed.contractHash,
      reviewedRevision: fixed.head,
      scope: ["1.1"],
      gates: [],
    });
    expect(context.implementerIdentities.length).toBeGreaterThan(0);
    expect(context.implementerIdentities.every((id) => /^[a-f0-9]{16}$/.test(id))).toBe(true);
    let engineCalls = 0;
    const dispatch = createDispatcher({
      headlessJourney: async () => { engineCalls += 1; throw new Error("a review read must never reach the transition engine"); },
    });
    const before = await durableFingerprint(fixed.root);
    const body = structured(await callTool("bearing_review_context", { repository: fixed.root, runId: RUN_ID, reviewClass: "general" }, dispatch));
    expect(engineCalls).toBe(0);
    expect(await durableFingerprint(fixed.root)).toBe(before);
    expect(JSON.stringify(body)).not.toContain(fixed.root);
    expect(JSON.stringify(body)).not.toContain(IMPLEMENTER);
    expect(JSON.stringify(body)).not.toMatch(/capability|cookie|bearing_session|Bearer /i);
    expect(body.repository).toMatch(/^[0-9a-f]{16}$/);
    expect(body).toMatchObject({ contractHash: fixed.contractHash, reviewedRevision: fixed.head, scope: ["1.1"] });
    expect(body.code).toBeUndefined();
    // The fingerprint has to be able to fail, or "mutation-free" proves nothing.
    await recordReviewGate(request(fixed));
    expect(await durableFingerprint(fixed.root)).not.toBe(before);
  });

  it("records one gate that survives a fresh store and checkpoint compaction", async () => {
    const fixed = await fixture();
    const recorded = await recordReviewGate(request(fixed));
    expect(recorded).toMatchObject({ ok: true, recorded: true });
    if (!recorded.ok) throw new Error(recorded.code);

    const durable = await storedReview(fixed.root);
    expect(durable).toEqual([recorded.record]);
    expect(recorded.record.reviewedRevision).toBe(fixed.head);
    // A gate certifies the run; it must not advance it.
    const checkpoint = (await new BearingStore(fixed.root).load(RUN_ID)).journeyCheckpoint;
    expect(checkpoint).toMatchObject({ stage: "draft-implementation", status: "complete", planDirectory: PLAN_DIRECTORY });
    expect(recorded.record.implementerIdentities).not.toContain(recorded.record.reviewerIdentity);

    // Sealing the run truncates the ledger; the snapshot is all that remains.
    const settled = await new BearingStore(fixed.root).apply({
      schemaVersion: 1,
      commandId: "settle",
      runId: RUN_ID,
      expectedRevision: recorded.revision,
      type: "recordJourneyCheckpoint",
      payload: { stage: "review", status: "complete", artifacts: [], planDirectory: PLAN_DIRECTORY, review: [recorded.record] },
      session: { sessionId: IMPLEMENTER, actor: "bearing" },
      correlationId: "settle",
    });
    expect(settled.ok).toBe(true);
    const sealed = await new BearingStore(fixed.root).compact(RUN_ID, { noDirtyOrUnmergedLane: true, runNotBusy: true });
    expect(sealed.events).toEqual([]);
    const runDir = join(fixed.root, (await fixed.store.runWorkspacePath(RUN_ID)) ?? join(".bearing", "runs", RUN_ID));
    expect(await readFile(join(runDir, "events.jsonl"), "utf8")).toBe("");
    expect(JSON.parse(await readFile(join(runDir, "snapshot.json"), "utf8")))
      .toMatchObject({ journeyCheckpoint: { review: [recorded.record] } });
    expect((await storedReview(fixed.root))).toEqual([recorded.record]);
  });

  it("keeps each class and drops every gate the candidate revision moved past", async () => {
    const fixed = await fixture();
    const general = await recordReviewGate(request(fixed));
    if (!general.ok) throw new Error(general.code);
    const security = await recordReviewGate(request(fixed, {
      reviewClass: "security",
      expectedRevision: general.revision,
      verdict: "NEEDS_MORE_EVIDENCE",
      findings: [{ summary: "input bound unverified", evidence: "src/import.ts:1" }],
    }));
    if (!security.ok) throw new Error(security.code);
    expect((await storedReview(fixed.root))?.map((record) => record.reviewClass)).toEqual(["general", "security"]);

    const context = await readReviewContext(fixed.root, RUN_ID, "general");
    if (!context.ok) throw new Error(context.code);
    expect(context.gates).toEqual([
      { reviewClass: "general", verdict: "PASS", reviewerIdentity: general.record.reviewerIdentity, findingCount: 0 },
      { reviewClass: "security", verdict: "NEEDS_MORE_EVIDENCE", reviewerIdentity: security.record.reviewerIdentity, findingCount: 1 },
    ]);

    // One remediation commit moves the candidate; no prior pass may certify it.
    await writeFile(join(fixed.root, "src/import.ts"), "export const imported = false;\n");
    await exec("git", ["commit", "-aqm", "remediate"], { cwd: fixed.root });
    const moved = await readReviewContext(fixed.root, RUN_ID, "general");
    if (!moved.ok) throw new Error(moved.code);
    expect(moved.reviewedRevision).not.toBe(fixed.head);
    expect(moved.gates).toEqual([]);
    expect(await recordReviewGate(request(fixed, { expectedRevision: security.revision })))
      .toMatchObject({ ok: false, code: "revision_changed" });
  });

  it("replays the exact same gate without appending a second record", async () => {
    const fixed = await fixture();
    const first = await recordReviewGate(request(fixed));
    if (!first.ok) throw new Error(first.code);
    const replay = await recordReviewGate(request(fixed));
    expect(replay).toMatchObject({ ok: true, recorded: false, revision: first.revision });
    expect(await storedReview(fixed.root)).toEqual([first.record]);
  });

  it("derives reviewer independence from the dispatcher's trusted identity", async () => {
    const fixed = await fixture(RUN_ID, undefined, "waiting");
    const author = createDispatcher({
      sessionId: IMPLEMENTER,
      headlessJourney: async (journey: HeadlessJourneyRequest): Promise<HeadlessJourneyReceipt> => {
        expect(journey.sessionId).toBe(IMPLEMENTER);
        const durable = await fixed.store.load(RUN_ID);
        const { eventId: _eventId, ...checkpoint } = durable.journeyCheckpoint!;
        const applied = await fixed.store.apply({
          schemaVersion: 1,
          commandId: "mcp-author",
          runId: RUN_ID,
          expectedRevision: durable.revision,
          type: "recordJourneyCheckpoint",
          payload: checkpoint,
          session: { sessionId: journey.sessionId!, actor: "bearing" },
          correlationId: "mcp-author",
        });
        return { ok: applied.ok, runId: RUN_ID, revision: applied.state.revision };
      },
    });
    const transition = structured(await callTool("bearing_transition", {
      repository: fixed.root,
      runId: RUN_ID,
      action: "progress",
      expectedRevision: fixed.revision,
      provider: "codex",
      model: "gpt-test",
      reasoning: "medium",
    }, author));
    expect(transition.code).toBeUndefined();
    expect(JSON.stringify(transition)).not.toContain(IMPLEMENTER);

    const context = structured(await callTool("bearing_review_context", {
      repository: fixed.root,
      runId: RUN_ID,
      reviewClass: "general",
    }, author));
    const review = {
      repository: fixed.root,
      runId: RUN_ID,
      expectedRevision: context.revision,
      reviewClass: "general",
      reviewedRevision: fixed.head,
      contractHash: fixed.contractHash,
      scope: ["1.1"],
      verdict: "PASS",
      commands: [{ commandId: "CMD-UNIT", status: "passed", summary: "1 test passed" }],
      findings: [],
    };
    const before = await durableFingerprint(fixed.root);
    const spoofed = await callTool("bearing_review_record", { ...review, reviewerSessionId: REVIEWER }, author);
    expect(spoofed?.error).toMatchObject({ code: -32602, data: { violation: "unexpected property: reviewerSessionId" } });
    expect(await durableFingerprint(fixed.root)).toBe(before);

    const selfReview = structured(await callTool("bearing_review_record", review, author));
    expect(selfReview).toMatchObject({ code: "reviewer_not_independent", revision: context.revision });
    expect(await durableFingerprint(fixed.root)).toBe(before);
    expect(JSON.stringify(selfReview)).not.toContain(IMPLEMENTER);

    const reviewer = createDispatcher({ sessionId: REVIEWER });
    const independent = structured(await callTool("bearing_review_record", review, reviewer));
    expect(independent).toMatchObject({ recorded: true, review: { reviewedRevision: fixed.head } });
    expect(JSON.stringify(independent)).not.toContain(REVIEWER);
  });

  it("refuses every stale, dependent, mismatched, or unsupported gate", async () => {
    const fixed = await fixture();
    const cases: readonly [string, Partial<ReviewGateRequest>][] = [
      ["stale_revision", { expectedRevision: fixed.revision + 1 }],
      ["revision_changed", { reviewedRevision: "f".repeat(40) }],
      ["contract_mismatch", { contractHash: "0".repeat(64) }],
      ["scope_mismatch", { scope: ["1.2"] }],
      ["reviewer_not_independent", { reviewerSessionId: IMPLEMENTER }],
      ["evidence_invalid", { commands: [{ commandId: "CMD-UNDECLARED", status: "passed", summary: "ran" }] }],
      ["evidence_invalid", { commands: [{ commandId: "CMD-UNIT", status: "passed", summary: "token: sk-abcdefghijkl" }] }],
      // Free text a reviewer supplies is echoed back and stored forever: it passes the
      // same scrubber every other projected string does, in both fields.
      ["evidence_invalid", { verdict: "FAIL" as const, findings: [{ summary: "leaked Bearer abcdefghij", evidence: "src/import.ts:1" }] }],
      ["evidence_invalid", { verdict: "FAIL" as const, findings: [{ summary: "unbounded read", evidence: "password: hunter2" }] }],
      ["verdict_unsupported", { commands: [{ commandId: "CMD-UNIT", status: "failed", summary: "1 test failed" }] }],
      ["verdict_unsupported", { verdict: "FAIL" }],
    ];
    for (const [code, overrides] of cases) {
      expect([code, await recordReviewGate(request(fixed, overrides))])
        .toMatchObject([code, { ok: false, code }]);
    }
    expect(await storedReview(fixed.root)).toBeUndefined();
    // The refusals have to be able to pass, or none of them proves anything.
    expect(await recordReviewGate(request(fixed))).toMatchObject({ ok: true });
  });

  it("refuses a dirty candidate, an unadmitted repository, and an unknown run", async () => {
    const fixed = await fixture();
    expect(await readReviewContext(join(fixed.root, "src"), RUN_ID, "general")).toEqual({ ok: false, code: "repository_rejected" });
    expect(await readReviewContext(`${fixed.root}/../${join(fixed.root).split("/").pop()}`, RUN_ID, "general"))
      .toEqual({ ok: false, code: "repository_rejected" });
    expect(await readReviewContext(fixed.root, "absent-run", "general")).toEqual({ ok: false, code: "run_not_found" });
    await writeFile(join(fixed.root, "src/import.ts"), "export const imported = false;\n");
    expect(await readReviewContext(fixed.root, RUN_ID, "general")).toEqual({ ok: false, code: "candidate_unclean" });
    expect(await recordReviewGate(request(fixed))).toEqual({ ok: false, code: "candidate_unclean" });
  });

  it("lets only one of two concurrent writers append", async () => {
    const fixed = await fixture();
    const { reviewerSessionId: _generalReviewer, ...general } = request(fixed);
    const { reviewerSessionId: _securityReviewer, ...security } = request(fixed, {
      reviewClass: "security",
      verdict: "FAIL",
      findings: [{ summary: "unbounded read", evidence: "src/import.ts:1" }],
    });
    const [left, right] = await Promise.all([
      callTool("bearing_review_record", general),
      callTool("bearing_review_record", security),
    ]);
    const bodies = [structured(left), structured(right)];
    expect(bodies.filter((body) => body.recorded === true)).toHaveLength(1);
    expect(bodies.filter((body) => body.code === "stale_revision" || body.code === "run_busy")).toHaveLength(1);
    expect(await storedReview(fixed.root)).toHaveLength(1);
  });
});

describe("approved role-route projection on the review gate", () => {
  const ROLE_ROUTES: readonly RoleRoute[] = [
    { role: "execution-author", primary: "codex", fallbacks: ["claude", "agy"] },
    { role: "review-general", primary: "claude", fallbacks: ["surveyor"] },
    { role: "review-security", primary: "agy", fallbacks: ["claude", "surveyor"] },
  ];

  it("returns only the matching review-general or review-security route, in exact stored order, for its reviewClass", async () => {
    const fixed = await fixture(RUN_ID, ROLE_ROUTES);

    const general = await readReviewContext(fixed.root, RUN_ID, "general");
    if (!general.ok) throw new Error(general.code);
    expect(general.reviewRoute).toEqual({ primary: "claude", fallbacks: ["surveyor"] });
    expect(general).not.toHaveProperty("reviewRouteBlocker");

    const security = await readReviewContext(fixed.root, RUN_ID, "security");
    if (!security.ok) throw new Error(security.code);
    expect(security.reviewRoute).toEqual({ primary: "agy", fallbacks: ["claude", "surveyor"] });

    // Two fresh dispatchers must project the identical route order for the same class.
    const first = structured(await callTool("bearing_review_context", { repository: fixed.root, runId: RUN_ID, reviewClass: "general" }, createDispatcher()));
    const second = structured(await callTool("bearing_review_context", { repository: fixed.root, runId: RUN_ID, reviewClass: "general" }, createDispatcher()));
    expect(first).toEqual(second);
    expect(first.reviewRoute).toEqual({ primary: "claude", fallbacks: ["surveyor"] });
    expect(first).not.toHaveProperty("requiredOwnerAction");
    // The author route is never leaked through a review-class request.
    expect(JSON.stringify(first)).not.toContain("codex");
  });

  it("returns a typed OWNER_DECISION_REQUIRED blocker, and stays otherwise readable, when the approved contract has no roleRoutes", async () => {
    const fixed = await fixture();

    const context = await readReviewContext(fixed.root, RUN_ID, "security");
    if (!context.ok) throw new Error(context.code);
    expect(context.reviewRoute).toBeUndefined();
    expect(context.reviewRouteBlocker).toEqual({ type: "OWNER_DECISION_REQUIRED", reason: "role_routes_missing" });
    // Legacy runs remain readable: everything else the caller needs is still here.
    expect(context).toMatchObject({ contractHash: fixed.contractHash, reviewedRevision: fixed.head, scope: ["1.1"] });

    const body = structured(await callTool("bearing_review_context", { repository: fixed.root, runId: RUN_ID, reviewClass: "security" }));
    expect(body.requiredOwnerAction).toEqual({ type: "OWNER_DECISION_REQUIRED", reason: "role_routes_missing" });
    expect(body).not.toHaveProperty("reviewRoute");
  });
});
