import { describe, expect, it } from "vitest";
import { executionContractApprovalRecorded } from "../src/server/local-session.js";
import {
  COMMAND_SCHEMA_VERSION,
  EVENT_SCHEMA_VERSION,
  MAX_RECOMMENDATION_CHECKPOINTS,
  MAX_RECOMMENDATION_CREWMATES,
  MAX_RECOMMENDATION_EDGES,
  MAX_RECOMMENDATION_PHASES,
  MAX_RECOMMENDATION_SERVICES,
  MAX_RECOMMENDATION_SLICES,
  MAX_RECOMMENDATION_SUB_EXPLORERS,
  MAX_RECOMMENDATION_THRESHOLD,
  MAX_RECOMMENDATION_TOKENS,
  MAX_RECOMMENDATION_WORK_ITEMS,
  RECORD_JOURNEY_CHECKPOINT_STAGES,
  hashCommand,
  hashEvent,
  parseCommandEnvelope,
  parseEventEnvelope,
  type CommandEnvelopeV1,
} from "../src/contracts/run.js";
import { EXECUTION_MODES } from "../src/execution/execution-mode.js";
import { HARD_TRIGGER_IDS, MAX_COMPLEXITY_SCORE } from "../src/execution/selection-score.js";
import { PLANNING_STATES } from "../src/journey/planning-state.js";
import { PLANNING_STATE_VALUES } from "../src/contracts/run.js";
import {
  decide,
  initialRunState,
  replay,
  type DecideDeps,
} from "../src/workflow/aggregate.js";

const RUN_ID = "run-v1";

function checkpoint(payload: Readonly<Record<string, unknown>>): unknown {
  return {
    schemaVersion: 1,
    commandId: "command-checkpoint",
    runId: RUN_ID,
    expectedRevision: 1,
    type: "recordJourneyCheckpoint",
    payload,
    session: { sessionId: "session-bearing", actor: "bearing" },
    correlationId: "correlation-v1",
  };
}

const LEGACY_CHECKPOINT_PAYLOAD = {
  stage: "gather-supplies",
  status: "complete",
  artifacts: ["plan/requirements.md"],
} as const;
const FIT_DECISION = {
  outcome: "confirmed",
  planDirectory: "docs/plans/bearing-improvements/phase-2a",
  repository: "/workspace/repository",
  decidedAt: "2026-07-24T00:00:00.000Z",
} as const;
const EXPECTED_CHECKPOINT_STAGES = [
  "repository-fit",
  "set-bearings",
  "gather-supplies",
  "map-route",
  "recon",
  "draft-implementation",
  "execute-explorer",
  "execute-expedition",
  "review",
] as const;

describe("owner contract approval fields", () => {
  it("binds a contract hash to an owner-authored durable answer", () => {
    expect(executionContractApprovalRecorded([{
      type: "ownerAnswered",
      eventId: "owner-answer-1",
      actor: "owner",
      payload: {
        decisionId: "contract-review",
        answer: "Approved for execution-mode selection",
        ownerApprovedContentHash: "a".repeat(64),
      },
    }], "owner-answer-1", "a".repeat(64))).toBe(true);
  });

  it("rejects a Bearing-authored checkpoint with the matching hash", () => {
    expect(executionContractApprovalRecorded([{
      type: "journeyCheckpointRecorded",
      eventId: "checkpoint-1",
      actor: "bearing",
      payload: {
        answer: "Approved for execution-mode selection",
        ownerApprovedContentHash: "a".repeat(64),
      },
    }], "checkpoint-1", "a".repeat(64))).toBe(false);
  });
});

describe("journey checkpoint planning fields", () => {
  it("keeps the typed and runtime checkpoint stage lists identical", () => {
    expect(RECORD_JOURNEY_CHECKPOINT_STAGES).toEqual(EXPECTED_CHECKPOINT_STAGES);
    for (const stage of EXPECTED_CHECKPOINT_STAGES) {
      expect(parseCommandEnvelope(checkpoint({
        ...LEGACY_CHECKPOINT_PAYLOAD,
        stage,
      })).ok, stage).toBe(true);
    }
  });

  it("accepts both optional planning fields when valid", () => {
    const parsed = parseCommandEnvelope(checkpoint({
      ...LEGACY_CHECKPOINT_PAYLOAD,
      planningState: PLANNING_STATES[5],
      planningFailure: "MISSING_VALIDATION",
    }));

    expect(parsed.ok).toBe(true);
  });

  it("accepts the existing v1 payload without planning fields", () => {
    expect(parseCommandEnvelope(checkpoint(LEGACY_CHECKPOINT_PAYLOAD)).ok).toBe(true);
  });

  it("keeps both schemas at v1 while accepting pre-Recon ledgers", () => {
    expect(COMMAND_SCHEMA_VERSION).toBe(1);
    expect(EVENT_SCHEMA_VERSION).toBe(1);
    expect(parseCommandEnvelope(checkpoint(LEGACY_CHECKPOINT_PAYLOAD)).ok).toBe(true);
  });

  it("rejects an unknown planning state", () => {
    expect(parseCommandEnvelope(checkpoint({
      ...LEGACY_CHECKPOINT_PAYLOAD,
      planningState: "NOT_A_PLANNING_STATE",
    })).ok).toBe(false);
  });

  it.each([
    ["empty", ""],
    ["over 256 characters", "x".repeat(257)],
    ["the wrong type", 42],
  ])("rejects planning failure when %s", (_label, planningFailure) => {
    expect(parseCommandEnvelope(checkpoint({
      ...LEGACY_CHECKPOINT_PAYLOAD,
      planningFailure,
    })).ok).toBe(false);
  });

  it.each([
    "MISSING_VALIDATON",
    "not-a-state",
    "DRAFT",
    "OWNER_APPROVED",
    "x".repeat(256),
  ])("rejects undeclared planning failure %s", (planningFailure) => {
    expect(parseCommandEnvelope(checkpoint({
      ...LEGACY_CHECKPOINT_PAYLOAD,
      planningFailure,
    })).ok).toBe(false);
  });

  it("still rejects an unexpected payload key", () => {
    expect(parseCommandEnvelope(checkpoint({
      ...LEGACY_CHECKPOINT_PAYLOAD,
      unexpected: true,
    })).ok).toBe(false);
  });

  it("rejects inherited required fields", () => {
    const payload = Object.assign(Object.create({ artifacts: [] }), {
      stage: "draft-implementation",
      status: "complete",
    });

    expect(parseCommandEnvelope(checkpoint(payload)).ok).toBe(false);
  });

  it("rejects an inherited optional planning failure", () => {
    const payload = Object.assign(Object.create({
      planningFailure: "MISSING_VALIDATION",
    }), {
      stage: "draft-implementation",
      status: "failed",
      artifacts: [],
    });

    expect(parseCommandEnvelope(checkpoint(payload)).ok).toBe(false);
  });
});

describe("journey checkpoint repository-fit fields", () => {
  it("accepts and round-trips both optional fit fields", () => {
    const input = checkpoint({
      ...LEGACY_CHECKPOINT_PAYLOAD,
      repositoryFitDecision: FIT_DECISION,
      resolvedPlanDirectory: FIT_DECISION.planDirectory,
    });
    const parsed = parseCommandEnvelope(JSON.parse(JSON.stringify(input)));

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.reason);
    expect(parsed.value.payload).toEqual((input as { payload: unknown }).payload);
  });

  it.each([
    "confirmed",
    { outcome: "confirmed", planDirectory: FIT_DECISION.planDirectory, repository: FIT_DECISION.repository },
    { ...FIT_DECISION, outcome: "guessed" },
    { ...FIT_DECISION, extra: true },
  ])("rejects an unguarded repository fit decision %#", (repositoryFitDecision) => {
    expect(parseCommandEnvelope(checkpoint({
      ...LEGACY_CHECKPOINT_PAYLOAD,
      repositoryFitDecision,
    })).ok).toBe(false);
  });

  it.each(["", 42, { path: FIT_DECISION.planDirectory }])(
    "rejects an invalid resolved plan directory %#",
    (resolvedPlanDirectory) => {
      expect(parseCommandEnvelope(checkpoint({
        ...LEGACY_CHECKPOINT_PAYLOAD,
        resolvedPlanDirectory,
      })).ok).toBe(false);
    },
  );

  it("accepts the declined decision shape without inventing a path", () => {
    expect(parseCommandEnvelope(checkpoint({
      ...LEGACY_CHECKPOINT_PAYLOAD,
      repositoryFitDecision: { outcome: "declined" },
    })).ok).toBe(true);
  });
});

describe("v1 ledger compatibility", () => {
  it("replays a pre-existing ledger without additive checkpoint keys with unchanged hashes and state", () => {
    let eventNumber = 0;
    const deps: DecideDeps = {
      recordedAt: "2026-07-24T00:00:00.000Z",
      nextEventId: () => `event-${++eventNumber}`,
    };
    let state = initialRunState(RUN_ID);
    const create: CommandEnvelopeV1 = {
      schemaVersion: 1,
      commandId: "command-create",
      runId: RUN_ID,
      expectedRevision: 0,
      type: "createWorkRequest",
      payload: { title: "Legacy plan", goal: "Replay unchanged" },
      session: { sessionId: "session-owner", actor: "owner" },
      correlationId: "correlation-v1",
    };
    const created = decide(state, create, deps);
    if (!created.ok) throw new Error(`create failed: ${created.reason}`);
    state = created.state;

    const recordCheckpoint: CommandEnvelopeV1 = {
      schemaVersion: 1,
      commandId: "command-checkpoint",
      runId: RUN_ID,
      expectedRevision: 1,
      type: "recordJourneyCheckpoint",
      payload: LEGACY_CHECKPOINT_PAYLOAD,
      session: { sessionId: "session-bearing", actor: "bearing" },
      correlationId: "correlation-v1",
    };
    expect(Object.hasOwn(recordCheckpoint.payload, "runtimeStateJson")).toBe(false);
    expect(Object.hasOwn(recordCheckpoint.payload, "improvementProposalRef")).toBe(false);
    expect(Object.hasOwn(recordCheckpoint.payload, "requirementRefs")).toBe(false);
    const recorded = decide(state, recordCheckpoint, deps);
    if (!recorded.ok) throw new Error(`checkpoint failed: ${recorded.reason}`);
    state = recorded.state;

    expect(state.events.map((event) => event.hash)).toEqual([
      "afe7217262e93d903704590959f16364867a9776be581e47740d5145f7365fc0",
      "0479a485749e8c33721b48968417ee5565095c9da5890ad39fb1a9529ad143d3",
    ]);
    expect(state.events[1].previousHash).toBe(state.events[0].hash);
    for (const event of state.events) {
      const { hash: _hash, ...body } = event;
      expect(event.hash).toBe(hashEvent(body));
    }

    const replayed = replay(state.events);
    expect(replayed.revision).toBe(2);
    expect(replayed.events).toEqual(state.events);
    expect([...replayed.outcomes]).toEqual([...state.outcomes]);
    expect(replayed.journeyCheckpoint).toEqual({
      ...LEGACY_CHECKPOINT_PAYLOAD,
      eventId: "event-2",
    });
  });

  it("keeps command and event schema versions at v1", () => {
    expect(COMMAND_SCHEMA_VERSION).toBe(1);
    expect(EVENT_SCHEMA_VERSION).toBe(1);
  });
});

const VALID_IMPROVEMENT_PROPOSAL_REF = "ab".repeat(32);

describe("slice 6.2 additive improvement-proposal checkpoint key", () => {
  it("accepts a 64-lowercase-hex reference without bumping either ledger schema version", () => {
    expect(COMMAND_SCHEMA_VERSION).toBe(1);
    expect(EVENT_SCHEMA_VERSION).toBe(1);

    const parsed = parseCommandEnvelope(checkpoint({
      ...LEGACY_CHECKPOINT_PAYLOAD,
      improvementProposalRef: VALID_IMPROVEMENT_PROPOSAL_REF,
    }));

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.reason);
    if (parsed.value.type !== "recordJourneyCheckpoint") throw new Error("expected journey checkpoint command");
    expect(parsed.value.payload.improvementProposalRef).toBe(VALID_IMPROVEMENT_PROPOSAL_REF);
  });

  it.each([
    ["too short", "a".repeat(63)],
    ["too long", "a".repeat(65)],
    ["uppercase", "A".repeat(64)],
    ["non-hex", "g".repeat(64)],
    ["wrong type", 64],
  ])("rejects a %s improvement proposal reference with a typed result", (_label, improvementProposalRef) => {
    const parsed = parseCommandEnvelope(checkpoint({
      ...LEGACY_CHECKPOINT_PAYLOAD,
      improvementProposalRef,
    }));

    expect(parsed).toBeTruthy();
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toBe("malformed");
  });

  it("rejects a prototype-carried improvement proposal reference", () => {
    const payload = Object.assign(
      Object.create({ improvementProposalRef: VALID_IMPROVEMENT_PROPOSAL_REF }) as Record<string, unknown>,
      LEGACY_CHECKPOINT_PAYLOAD,
    );

    const parsed = parseCommandEnvelope(checkpoint(payload));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toBe("malformed");
  });

  it("accepts recordOwnerImprovementApplication with 64-hex hashes at schema v1", () => {
    expect(COMMAND_SCHEMA_VERSION).toBe(1);
    expect(EVENT_SCHEMA_VERSION).toBe(1);
    const appCmd = {
      schemaVersion: 1,
      commandId: "cmd-app-1",
      runId: "run-xyz",
      expectedRevision: 3,
      session: { sessionId: "s1", actor: "owner" },
      correlationId: "corr-1",
      type: "recordOwnerImprovementApplication" as const,
      payload: {
        improvementProposalRef: VALID_IMPROVEMENT_PROPOSAL_REF,
        externalEvidenceHash: "cd".repeat(32),
        surface: "review-cadence",
        targetJson: '{"role":"surveyor"}',
        valueJson: '"per-slice"',
      },
    };
    const parsed = parseCommandEnvelope(appCmd);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.reason);
    expect(parsed.value.type).toBe("recordOwnerImprovementApplication");
  });

  it.each([
    ["bad proposal hash", { improvementProposalRef: "zz".repeat(32), externalEvidenceHash: "ab".repeat(32), surface: "review-cadence", targetJson: '{"role":"surveyor"}', valueJson: '"per-slice"' }],
    ["bad evidence hash", { improvementProposalRef: VALID_IMPROVEMENT_PROPOSAL_REF, externalEvidenceHash: "AB".repeat(32), surface: "review-cadence", targetJson: '{"role":"surveyor"}', valueJson: '"per-slice"' }],
    ["noncanonical target", { improvementProposalRef: VALID_IMPROVEMENT_PROPOSAL_REF, externalEvidenceHash: "ab".repeat(32), surface: "review-cadence", targetJson: '{"role": "surveyor"}', valueJson: '"per-slice"' }],
    ["wrong keys", { improvementProposalRef: VALID_IMPROVEMENT_PROPOSAL_REF }],
  ])("rejects malformed owner application command %s", (_label, payload) => {
    const cmd = {
      schemaVersion: 1,
      commandId: "c2",
      runId: "r2",
      expectedRevision: 0,
      session: { sessionId: "s", actor: "owner" },
      correlationId: "c2",
      type: "recordOwnerImprovementApplication" as const,
      payload,
    };
    const parsed = parseCommandEnvelope(cmd);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toBe("malformed");
  });

  it("rejects prototype-carried owner application fields", () => {
    const payload = Object.assign(
      Object.create({ valueJson: '"per-slice"' }) as Record<string, unknown>,
      {
        improvementProposalRef: VALID_IMPROVEMENT_PROPOSAL_REF,
        externalEvidenceHash: "ab".repeat(32),
        surface: "review-cadence",
        targetJson: '{"role":"surveyor"}',
        unrelated: true,
      },
    );
    const parsed = parseCommandEnvelope({
      schemaVersion: 1,
      commandId: "prototype-application",
      runId: "prototype-run",
      expectedRevision: 1,
      session: { sessionId: "owner", actor: "owner" },
      correlationId: "prototype-application",
      type: "recordOwnerImprovementApplication",
      payload,
    });
    expect(parsed).toEqual({ ok: false, reason: "malformed" });
  });
});

const VALID_REQUIREMENT_REFS = ["AC-6.10", "RISK-6.REG"] as const;

describe("slice 6.13 additive requirement-reference checkpoint key", () => {
  it("accepts bounded requirement references without bumping either ledger schema version", () => {
    expect(COMMAND_SCHEMA_VERSION).toBe(1);
    expect(EVENT_SCHEMA_VERSION).toBe(1);

    const parsed = parseCommandEnvelope(checkpoint({
      ...LEGACY_CHECKPOINT_PAYLOAD,
      requirementRefs: VALID_REQUIREMENT_REFS,
    }));

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.reason);
    if (parsed.value.type !== "recordJourneyCheckpoint") throw new Error("expected journey checkpoint command");
    expect(parsed.value.payload.requirementRefs).toEqual(VALID_REQUIREMENT_REFS);
  });

  it.each([
    ["an empty array", []],
    ["the wrong type", "AC-6.10"],
    ["too many entries", Array.from({ length: 129 }, (_, index) => `AC-${index + 1}`)],
    ["an empty entry", [""]],
    ["an overlong entry", [`AC-${"A".repeat(126)}`]],
    ["an untyped entry", ["REQ-6.10"]],
    ["a lowercase entry", ["ac-6.10"]],
  ])("rejects requirement references with %s using a typed result", (_label, requirementRefs) => {
    const parsed = parseCommandEnvelope(checkpoint({
      ...LEGACY_CHECKPOINT_PAYLOAD,
      requirementRefs,
    }));

    expect(parsed).toBeTruthy();
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toBe("malformed");
  });

  it("rejects a sparse requirement-reference array", () => {
    const requirementRefs = Array<string>(1);
    const parsed = parseCommandEnvelope(checkpoint({
      ...LEGACY_CHECKPOINT_PAYLOAD,
      requirementRefs,
    }));

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toBe("malformed");
  });

  it("rejects prototype-carried requirement references", () => {
    const payload = Object.assign(
      Object.create({ requirementRefs: VALID_REQUIREMENT_REFS }) as Record<string, unknown>,
      LEGACY_CHECKPOINT_PAYLOAD,
    );

    const parsed = parseCommandEnvelope(checkpoint(payload));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toBe("malformed");
  });
});

const VALID_RUNTIME_STATE_JSON = JSON.stringify({ version: 1, trace: [], retry: [] });

const VALID_TOKEN_USAGE = {
  total: 12,
  budget: 100,
  state: "within_budget",
} as const;
const VALID_RECOVERY_OUTCOME = {
  outcome: "repaired",
  attempts: 2,
} as const;

describe("slice 5.4 additive runtime-state checkpoint key", () => {
  it("accepts a parsed runtime state without bumping either ledger schema version", () => {
    expect(COMMAND_SCHEMA_VERSION).toBe(1);
    expect(EVENT_SCHEMA_VERSION).toBe(1);
    expect(parseCommandEnvelope(checkpoint({
      ...LEGACY_CHECKPOINT_PAYLOAD,
      runtimeStateJson: VALID_RUNTIME_STATE_JSON,
    })).ok).toBe(true);
  });

  it("rejects malformed runtimeStateJson rather than accepting an arbitrary string", () => {
    expect(parseCommandEnvelope(checkpoint({
      ...LEGACY_CHECKPOINT_PAYLOAD,
      runtimeStateJson: "not-json",
    })).ok).toBe(false);
  });

  it("rejects inherited runtimeStateJson", () => {
    const payload = Object.assign(
      Object.create({ runtimeStateJson: VALID_RUNTIME_STATE_JSON }) as Record<string, unknown>,
      LEGACY_CHECKPOINT_PAYLOAD,
    );

    expect(parseCommandEnvelope(checkpoint(payload)).ok).toBe(false);
  });
});

describe("slice 6 typed token and recovery checkpoint fields", () => {
  it("accepts bounded typed token and recovery observations without a schema bump", () => {
    expect(COMMAND_SCHEMA_VERSION).toBe(1);
    expect(EVENT_SCHEMA_VERSION).toBe(1);
    expect(parseCommandEnvelope(checkpoint({
      ...LEGACY_CHECKPOINT_PAYLOAD,
      tokenUsage: VALID_TOKEN_USAGE,
      recoveryOutcome: VALID_RECOVERY_OUTCOME,
    })).ok).toBe(true);
    expect(parseCommandEnvelope(checkpoint({
      ...LEGACY_CHECKPOINT_PAYLOAD,
      tokenUsage: { total: 12, budget: Number.MAX_SAFE_INTEGER, state: "within_budget" },
    })).ok).toBe(true);
    expect(parseCommandEnvelope(checkpoint({
      ...LEGACY_CHECKPOINT_PAYLOAD,
      tokenUsage: { total: 270_000, budget: 200_000, state: "within_budget" },
    })).ok).toBe(true);
  });

  it("rejects absent, negative, unbounded, unknown, inconsistent, and prototype-carried typed observations", () => {
    const malformed = [
      { tokenUsage: { total: -1, budget: 100, state: "within_budget" } },
      { tokenUsage: { total: Number.MAX_SAFE_INTEGER + 1, budget: 100, state: "exhausted" } },
      { tokenUsage: { total: 12, budget: 100, state: "unknown" } },
      { recoveryOutcome: { outcome: "unknown", attempts: 1 } },
      { recoveryOutcome: { outcome: "repaired", attempts: 0 } },
      { recoveryOutcome: { outcome: "stopped", attempts: 17 } },
    ];
    for (const extra of malformed) {
      expect(parseCommandEnvelope(checkpoint({ ...LEGACY_CHECKPOINT_PAYLOAD, ...extra })).ok).toBe(false);
    }

    const inherited = Object.assign(
      Object.create({ tokenUsage: VALID_TOKEN_USAGE, recoveryOutcome: VALID_RECOVERY_OUTCOME }) as Record<string, unknown>,
      LEGACY_CHECKPOINT_PAYLOAD,
    );
    expect(parseCommandEnvelope(checkpoint(inherited)).ok).toBe(false);
  });
});

// --- 4.7 regression (written before edit; additive verification key, no schema bump, hash identity)

const PRE_47_LEDGER_HASH_NO_VERIF = "2fe3f143812618cd654e9e97a44fe7c9f721c03dba627924c3abaa85f44f1eb1";
const PRE_47_CP_PAYLOAD_NO_VERIF = { stage: "gather-supplies", status: "complete", artifacts: ["plan/requirements.md"] } as const;

describe("slice 4.7 additive verification checkpoint key (hash-chained, no schema bump)", () => {
  it("schema versions remain 1; pre-existing ledger without verification key replays to identical captured hash", () => {
    expect(COMMAND_SCHEMA_VERSION).toBe(1);
    expect(EVENT_SCHEMA_VERSION).toBe(1);
    const cmd = {
      schemaVersion: 1,
      commandId: "command-checkpoint",
      runId: "run-v1",
      expectedRevision: 1,
      type: "recordJourneyCheckpoint",
      payload: PRE_47_CP_PAYLOAD_NO_VERIF,
      session: { sessionId: "session-bearing", actor: "bearing" },
      correlationId: "correlation-v1",
    } as const;
    expect(hashCommand(cmd)).toBe(PRE_47_LEDGER_HASH_NO_VERIF);
    // parse must still succeed for legacy without the key
    expect(parseCommandEnvelope(cmd).ok).toBe(true);
  });

  it("accepts well-formed verification payload (layer+verdict, optional rubric/findingCount)", () => {
    const withVerif = {
      ...PRE_47_CP_PAYLOAD_NO_VERIF,
      verification: { layer: "validator", verdict: "PASS", rubricVersion: "1", findingCount: 0 },
    };
    const parsed = parseCommandEnvelope(checkpoint(withVerif));
    expect(parsed.ok).toBe(true);
  });

  it.each([
    ["validator", "acceptable"],
    ["grader", "PASS"],
    ["park-ranger", "strong"],
  ])("rejects the %s layer with a verdict from another layer", (layer, verdict) => {
    const payload = {
      ...PRE_47_CP_PAYLOAD_NO_VERIF,
      verification: { layer, verdict },
    };

    expect(parseCommandEnvelope(checkpoint(payload)).ok).toBe(false);
  });

  it.each(["layer", "verdict", "rubricVersion"] as const)(
    "rejects an oversized verification %s string",
    (field) => {
      const verification = {
        layer: "validator",
        verdict: "PASS",
        rubricVersion: "1",
        [field]: "x".repeat(4_097),
      };

      expect(parseCommandEnvelope(checkpoint({
        ...PRE_47_CP_PAYLOAD_NO_VERIF,
        verification,
      })).ok).toBe(false);
    },
  );

  it("rejects a verification payload whose OPTIONAL fields are inherited rather than own", () => {
    // Object.keys() omits inherited keys, so the key allowlist passes while a property read still
    // walks the prototype. The live event would carry rubricVersion that vanishes on JSON
    // round-trip and replay — a persistence divergence, not merely a leak.
    const inherited = Object.create({ rubricVersion: "9", findingCount: 7 }) as Record<string, unknown>;
    inherited.layer = "grader";
    inherited.verdict = "strong";

    expect(parseCommandEnvelope(checkpoint({
      ...PRE_47_CP_PAYLOAD_NO_VERIF,
      verification: inherited,
    })).ok).toBe(false);
  });

  it("bounds rubricVersion tightly, not merely at the generic string cap", () => {
    // The 4097-char case above only proves the generic MAX_STRING (4096) bound. rubricVersion is a
    // short identifier ("1" today) and is the only free-form string left in this payload, so a
    // 2000-character value must be refused too — the ledger is append-only and an accepted value
    // inflates the bounded projection permanently.
    const withVersion = (rubricVersion: string) => parseCommandEnvelope(checkpoint({
      ...PRE_47_CP_PAYLOAD_NO_VERIF,
      verification: { layer: "validator", verdict: "PASS", rubricVersion },
    })).ok;

    expect(withVersion("x".repeat(2_000))).toBe(false);
    expect(withVersion("x".repeat(65))).toBe(false);
    expect(withVersion("x".repeat(64))).toBe(true);
    expect(withVersion("1")).toBe(true);
  });

  it("rejects malformed verification payload (unknown key, wrong shape) rather than accepting as unknown", () => {
    const badExtra = { ...PRE_47_CP_PAYLOAD_NO_VERIF, verification: { layer: "validator", verdict: "PASS", extra: 1 } };
    expect(parseCommandEnvelope(checkpoint(badExtra)).ok).toBe(false);
    const badMissing = { ...PRE_47_CP_PAYLOAD_NO_VERIF, verification: { layer: "validator" } };
    expect(parseCommandEnvelope(checkpoint(badMissing)).ok).toBe(false);
    const badType = { ...PRE_47_CP_PAYLOAD_NO_VERIF, verification: { layer: 1, verdict: "PASS" } };
    expect(parseCommandEnvelope(checkpoint(badType)).ok).toBe(false);
  });

  it("rejects a verification payload whose required keys are inherited rather than own", () => {
    // Object.keys() is empty for an inherited-only object, so an allowlist check alone passes it
    // and every property read then walks the prototype chain. Only the Object.hasOwn guard rejects
    // this. Same defect class as the `in`-vs-hasOwn finding an independent Phase 1 review caught,
    // where an owner-approved hash would not have bound the content that executes.
    const inherited = Object.create({ layer: "validator", verdict: "PASS" }) as Record<string, unknown>;
    const badInherited = { ...PRE_47_CP_PAYLOAD_NO_VERIF, verification: inherited };
    expect(parseCommandEnvelope(checkpoint(badInherited)).ok).toBe(false);
  });

  it("accepts typed validator completion and Park Ranger finding evidence", () => {
    expect(parseCommandEnvelope(checkpoint({
      ...PRE_47_CP_PAYLOAD_NO_VERIF,
      verification: {
        layer: "validator",
        verdict: "PASS",
        completedSlices: [{ sliceId: "1.1", requirementIds: ["AC-1", "RISK-1"] }],
      },
    })).ok).toBe(true);

    expect(parseCommandEnvelope(checkpoint({
      ...PRE_47_CP_PAYLOAD_NO_VERIF,
      verification: {
        layer: "park-ranger",
        verdict: "repair-required",
        findingCount: 1,
        confirmedFindings: [{ findingRef: "a".repeat(64), priority: "P1", sliceIds: ["1.1"] }],
      },
    })).ok).toBe(true);
  });

  it("rejects noncanonical, untyped, cross-layer, and unbounded verification evidence", () => {
    const cases = [
      {
        layer: "validator",
        verdict: "PASS",
        completedSlices: [{ sliceId: "1.1", requirementIds: ["AC-2", "AC-1"] }],
      },
      {
        layer: "validator",
        verdict: "PASS",
        completedSlices: [{ sliceId: "1.1", requirementIds: ["REQ-1"] }],
      },
      {
        layer: "grader",
        verdict: "strong",
        completedSlices: [{ sliceId: "1.1", requirementIds: ["AC-1"] }],
      },
      {
        layer: "park-ranger",
        verdict: "accept",
        findingCount: 1,
        confirmedFindings: [{ findingRef: "A".repeat(64), priority: "P1", sliceIds: ["1.1"] }],
      },
      {
        layer: "park-ranger",
        verdict: "accept",
        findingCount: 1,
        confirmedFindings: [{ findingRef: "a".repeat(64), priority: "P1", sliceIds: ["1.1", "1.1"] }],
      },
      {
        layer: "park-ranger",
        verdict: "accept",
        findingCount: 0,
        confirmedFindings: Array.from({ length: 129 }, () => ({ findingRef: "a".repeat(64), priority: "P1", sliceIds: ["1.1"] })),
      },
      {
        layer: "park-ranger",
        verdict: "accept",
        findingCount: 0,
        confirmedFindings: [{ findingRef: "a".repeat(64), priority: "P1", sliceIds: ["1.1"] }],
      },
    ];

    for (const verification of cases) {
      expect(parseCommandEnvelope(checkpoint({
        ...PRE_47_CP_PAYLOAD_NO_VERIF,
        verification,
      })).ok).toBe(false);
    }
  });
});

// --- Slice 3.3: additive recommendation payload contract --------------------

const HASH = "a".repeat(64);

const V1_TRADEOFFS = { tokens: "lower manager token overhead", coordination: "one Explorer coordinates all Crewmates" };

/** The pre-Phase-3 ten-key recommendation event payload. */
const LEGACY_RECOMMENDATION_PAYLOAD = {
  workItems: 2, maxCrewmatesPerExplorer: 3, perAgentTokenEstimate: 10,
  recommendedMode: "explorer", selectedMode: "explorer", overridden: false,
  estimatedAgents: 3, estimatedTokens: 30, tradeoffs: V1_TRADEOFFS, launchAuthorized: false,
} as const;

const VALID_SELECTION = {
  algorithmVersion: 2,
  threshold: 8,
  hardTriggers: { multiRepository: false, securityCriticalIntegration: false, dataMigration: true, irreversibleOperations: false, phaseExplorerCount: 0 },
  complexity: { phaseCount: 4, sliceCount: 50, dependencyEdgeCount: 45, sharedFileOverlapCount: 6, serviceCount: 3, expectedConcurrency: 4, integrationCheckpointCount: 2, riskRating: "high" },
  subExplorerCount: 0,
} as const;

const V2_RECOMMENDATION_PAYLOAD = {
  workItems: 4, maxCrewmatesPerExplorer: 3, perAgentTokenEstimate: 10,
  recommendedMode: "expedition", selectedMode: "expedition", overridden: false,
  estimatedAgents: 8, estimatedTokens: 80,
  tradeoffs: { tokens: "higher Navigator and Explorer token overhead", coordination: "bounded Explorer groups reduce coordination fan-out" },
  launchAuthorized: false,
  selection: VALID_SELECTION,
  algorithmVersion: 2,
  complexityScore: 17,
  firedHardTriggers: ["data_migration"],
  recommendedOrchestration: "trail-boss",
} as const;

const V2_ONLY_KEYS = ["selection", "algorithmVersion", "complexityScore", "firedHardTriggers", "recommendedOrchestration"] as const;

function recommendationEvent(payload: unknown): unknown {
  return {
    schemaVersion: 1, eventId: "event-1", runId: RUN_ID, sequence: 1,
    recordedAt: "2026-07-25T00:00:00.000Z", type: "executionModeRecommended",
    actor: "bearing", sessionId: "session-bearing", correlationId: "correlation-v1",
    causationId: "command-recommend", commandContentHash: HASH, payload,
    evidenceRefs: [], previousHash: "", hash: HASH,
  };
}

function recommendCommand(payload: unknown): unknown {
  return {
    schemaVersion: 1, commandId: "command-recommend", runId: RUN_ID, expectedRevision: 1,
    type: "recommendExecutionMode", payload,
    session: { sessionId: "session-owner", actor: "owner" }, correlationId: "correlation-v1",
  };
}

const eventOk = (payload: unknown): boolean => parseEventEnvelope(recommendationEvent(payload)).ok;
const commandOk = (payload: unknown): boolean => parseCommandEnvelope(recommendCommand(payload)).ok;

function without<T extends Record<string, unknown>>(value: T, key: string): Record<string, unknown> {
  const { [key]: _omit, ...rest } = value;
  return rest;
}

describe("recommendation event payload (design §3.5)", () => {
  it("still accepts the legacy ten-key payload", () => {
    expect(Object.keys(LEGACY_RECOMMENDATION_PAYLOAD)).toHaveLength(10);
    expect(eventOk(LEGACY_RECOMMENDATION_PAYLOAD)).toBe(true);
  });

  it("accepts the fifteen-key version-2 payload", () => {
    expect(Object.keys(V2_RECOMMENDATION_PAYLOAD)).toHaveLength(15);
    expect(eventOk(V2_RECOMMENDATION_PAYLOAD)).toBe(true);
  });

  it.each(V2_ONLY_KEYS)("rejects a partial version-2 group missing %s", (key) => {
    expect(eventOk(without(V2_RECOMMENDATION_PAYLOAD, key))).toBe(false);
  });

  it.each(V2_ONLY_KEYS)("rejects a legacy payload carrying only %s", (key) => {
    expect(eventOk({ ...LEGACY_RECOMMENDATION_PAYLOAD, [key]: V2_RECOMMENDATION_PAYLOAD[key] })).toBe(false);
  });

  it("rejects an unknown key on either shape", () => {
    expect(eventOk({ ...LEGACY_RECOMMENDATION_PAYLOAD, surprise: 1 })).toBe(false);
    expect(eventOk({ ...V2_RECOMMENDATION_PAYLOAD, surprise: 1 })).toBe(false);
  });

  it("requires algorithm version 2 whenever the group is present", () => {
    expect(eventOk({ ...V2_RECOMMENDATION_PAYLOAD, algorithmVersion: 1 })).toBe(false);
    expect(eventOk({ ...V2_RECOMMENDATION_PAYLOAD, algorithmVersion: 3 })).toBe(false);
    expect(eventOk({ ...V2_RECOMMENDATION_PAYLOAD, algorithmVersion: "2" })).toBe(false);
  });

  it("rejects a trail-boss orchestration paired with explorer mode", () => {
    expect(eventOk({
      ...V2_RECOMMENDATION_PAYLOAD, recommendedMode: "explorer", selectedMode: "explorer",
      tradeoffs: V1_TRADEOFFS,
    })).toBe(false);
    expect(eventOk({
      ...V2_RECOMMENDATION_PAYLOAD, recommendedMode: "explorer", selectedMode: "explorer",
      tradeoffs: V1_TRADEOFFS, recommendedOrchestration: "explorer",
    })).toBe(true);
  });

  it("rejects an unknown orchestration value", () => {
    expect(eventOk({ ...V2_RECOMMENDATION_PAYLOAD, recommendedOrchestration: "navigator" })).toBe(false);
    expect(eventOk({ ...V2_RECOMMENDATION_PAYLOAD, recommendedOrchestration: "expedition" })).toBe(false);
  });

  it("preserves the overridden coupling verbatim on both shapes", () => {
    expect(eventOk({ ...LEGACY_RECOMMENDATION_PAYLOAD, overridden: true })).toBe(false);
    expect(eventOk({ ...V2_RECOMMENDATION_PAYLOAD, overridden: true })).toBe(false);
  });

  it("bounds the derived score and validates the fired-trigger list", () => {
    expect(eventOk({ ...V2_RECOMMENDATION_PAYLOAD, complexityScore: -1 })).toBe(false);
    expect(eventOk({ ...V2_RECOMMENDATION_PAYLOAD, complexityScore: MAX_COMPLEXITY_SCORE + 1 })).toBe(false);
    expect(eventOk({ ...V2_RECOMMENDATION_PAYLOAD, complexityScore: MAX_COMPLEXITY_SCORE })).toBe(true);
    expect(eventOk({ ...V2_RECOMMENDATION_PAYLOAD, firedHardTriggers: ["unknown_trigger"] })).toBe(false);
    expect(eventOk({ ...V2_RECOMMENDATION_PAYLOAD, firedHardTriggers: ["data_migration", "data_migration"] })).toBe(false);
    expect(eventOk({ ...V2_RECOMMENDATION_PAYLOAD, firedHardTriggers: "data_migration" })).toBe(false);
    // Declaration order is the contract; a sorted or reordered list is malformed.
    expect(eventOk({ ...V2_RECOMMENDATION_PAYLOAD, firedHardTriggers: ["data_migration", "multi_repository"] })).toBe(false);
    expect(eventOk({ ...V2_RECOMMENDATION_PAYLOAD, firedHardTriggers: ["multi_repository", "data_migration"] })).toBe(true);
    expect(eventOk({ ...V2_RECOMMENDATION_PAYLOAD, firedHardTriggers: [...HARD_TRIGGER_IDS] })).toBe(true);
  });
});

describe("recommend command payload (design §3.5)", () => {
  const INPUTS = { workItems: 4, maxCrewmatesPerExplorer: 3, perAgentTokenEstimate: 10 } as const;

  it("still accepts the three-input payload and accepts an added selection vector", () => {
    expect(commandOk(INPUTS)).toBe(true);
    expect(commandOk({ ...INPUTS, selection: VALID_SELECTION })).toBe(true);
  });

  it("F6 regression: isMode derives from EXECUTION_MODES (override/approval/mode fields accept canonical list only)", () => {
    // The override payload and v2 records use isMode; after fix no second list in run.ts
    for (const mode of EXECUTION_MODES) {
      const overrideCmd = {
        schemaVersion: 1, type: "overrideExecutionMode", commandId: "ov", runId: "r", expectedRevision: 0,
        payload: { recommendationEventId: "e1", selectedMode: mode },
        session: { sessionId: "s", actor: "owner" }, correlationId: "c",
      } as const;
      expect(parseCommandEnvelope(overrideCmd)).toMatchObject({ ok: true });
    }
    // invalid mode still rejected (via isMode)
    const bad = { ...({ schemaVersion: 1, type: "overrideExecutionMode", commandId: "ov", runId: "r", expectedRevision: 0, payload: { recommendationEventId: "e1", selectedMode: "banana" }, session: { sessionId: "s", actor: "owner" }, correlationId: "c" } as const) };
    expect(parseCommandEnvelope(bad)).toMatchObject({ ok: false });
  });

  it("keeps the ledger planning-state list identical to the canonical one", () => {
    // Was a hand-maintained copy in run.ts. The previous guard here asserted
    // nothing — deleting "RECON_READY" from the copy left it green — so this
    // asserts the two exported lists ARE the same object contents, which a
    // restated copy cannot satisfy.
    expect([...PLANNING_STATE_VALUES]).toEqual([...PLANNING_STATES]);
    expect(PLANNING_STATE_VALUES).toBe(PLANNING_STATES as unknown as typeof PLANNING_STATE_VALUES);
  });

  it("rejects an unknown key beside the optional selection vector", () => {
    expect(commandOk({ ...INPUTS, surprise: 1 })).toBe(false);
    expect(commandOk({ ...INPUTS, selection: VALID_SELECTION, surprise: 1 })).toBe(false);
  });

  it("rejects a structurally invalid selection vector", () => {
    expect(commandOk({ ...INPUTS, selection: {} })).toBe(false);
    expect(commandOk({ ...INPUTS, selection: without(VALID_SELECTION, "subExplorerCount") })).toBe(false);
    expect(commandOk({ ...INPUTS, selection: { ...VALID_SELECTION, surprise: 1 } })).toBe(false);
    expect(commandOk({ ...INPUTS, selection: { ...VALID_SELECTION, algorithmVersion: 1 } })).toBe(false);
    expect(commandOk({ ...INPUTS, selection: { ...VALID_SELECTION, complexity: { ...VALID_SELECTION.complexity, riskRating: "extreme" } } })).toBe(false);
    expect(commandOk({ ...INPUTS, selection: { ...VALID_SELECTION, hardTriggers: { ...VALID_SELECTION.hardTriggers, dataMigration: "yes" } } })).toBe(false);
  });

  it.each([
    ["threshold", MAX_RECOMMENDATION_THRESHOLD],
    ["subExplorerCount", MAX_RECOMMENDATION_SUB_EXPLORERS],
  ] as const)("bounds %s at %i", (key, max) => {
    expect(commandOk({ ...INPUTS, selection: { ...VALID_SELECTION, [key]: max } })).toBe(true);
    expect(commandOk({ ...INPUTS, selection: { ...VALID_SELECTION, [key]: max + 1 } })).toBe(false);
  });

  it.each([
    ["phaseCount", MAX_RECOMMENDATION_PHASES],
    ["sliceCount", MAX_RECOMMENDATION_SLICES],
    ["dependencyEdgeCount", MAX_RECOMMENDATION_EDGES],
    ["sharedFileOverlapCount", MAX_RECOMMENDATION_EDGES],
    ["serviceCount", MAX_RECOMMENDATION_SERVICES],
    ["integrationCheckpointCount", MAX_RECOMMENDATION_CHECKPOINTS],
    ["expectedConcurrency", MAX_RECOMMENDATION_WORK_ITEMS],
  ] as const)("bounds complexity.%s at %i", (key, max) => {
    expect(commandOk({ ...INPUTS, selection: { ...VALID_SELECTION, complexity: { ...VALID_SELECTION.complexity, [key]: max } } })).toBe(true);
    expect(commandOk({ ...INPUTS, selection: { ...VALID_SELECTION, complexity: { ...VALID_SELECTION.complexity, [key]: max + 1 } } })).toBe(false);
  });

  it("bounds the phase explorer count", () => {
    expect(commandOk({ ...INPUTS, selection: { ...VALID_SELECTION, hardTriggers: { ...VALID_SELECTION.hardTriggers, phaseExplorerCount: MAX_RECOMMENDATION_WORK_ITEMS } } })).toBe(true);
    expect(commandOk({ ...INPUTS, selection: { ...VALID_SELECTION, hardTriggers: { ...VALID_SELECTION.hardTriggers, phaseExplorerCount: MAX_RECOMMENDATION_WORK_ITEMS + 1 } } })).toBe(false);
  });

  it("rejects a zero threshold, which would fire on every score", () => {
    expect(commandOk({ ...INPUTS, selection: { ...VALID_SELECTION, threshold: 0 } })).toBe(false);
    expect(commandOk({ ...INPUTS, selection: { ...VALID_SELECTION, threshold: 1 } })).toBe(true);
  });

  it("keeps the existing three-input bounds", () => {
    expect(commandOk({ ...INPUTS, workItems: MAX_RECOMMENDATION_WORK_ITEMS + 1 })).toBe(false);
    expect(commandOk({ ...INPUTS, maxCrewmatesPerExplorer: MAX_RECOMMENDATION_CREWMATES + 1 })).toBe(false);
    expect(commandOk({ ...INPUTS, perAgentTokenEstimate: MAX_RECOMMENDATION_TOKENS + 1 })).toBe(false);
  });

  it("adds no schema bump", () => {
    expect(COMMAND_SCHEMA_VERSION).toBe(1);
    expect(EVENT_SCHEMA_VERSION).toBe(1);
  });
});
