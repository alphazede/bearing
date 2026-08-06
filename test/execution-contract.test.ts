import { describe, expect, it } from "vitest";
import {
  deriveFocusEnvelope,
  EXECUTION_CONTRACT_SCHEMA_VERSION,
  hashExecutionContractBody,
  parseApprovedExecutionContract,
  type ApprovedExecutionContract,
  type ExecutionContractBody,
  type RoleRoute,
} from "../src/contracts/execution-contract.js";

const body: ExecutionContractBody = {
  schemaVersion: 1,
  contractId: "contract-1",
  runId: "run-1",
  planDirectory: "docs/plans/bearing-1.4",
  objective: "Ship the approved Phase 1 execution contract.",
  mode: "expedition",
  reviewCadence: "per-slice",
  phases: [
    {
      phaseId: "phase-1",
      title: "Foundations",
      entryCriteria: "The design is owner approved.",
      exitCriteria: "All foundation commands pass.",
    },
  ],
  slices: [
    {
      sliceId: "1.1",
      phaseId: "phase-1",
      requirementIds: ["AC-1"],
      writeSet: ["src/contracts/first.ts"],
      acceptance: "The first contract boundary is deterministic.",
      evidenceCommandIds: ["CMD-FIRST"],
      dependsOn: [],
      parallelSafe: true,
      role: "crewmate",
      reasoningTier: "high",
    },
    {
      sliceId: "1.2",
      phaseId: "phase-1",
      requirementIds: ["AC-2"],
      writeSet: ["src/contracts/second.ts"],
      acceptance: "The second contract boundary is deterministic.",
      evidenceCommandIds: ["CMD-SECOND", "PROC-REVIEW"],
      dependsOn: ["1.1"],
      parallelSafe: false,
      role: "crewmate",
      reasoningTier: "medium",
    },
  ],
  dependencyEdges: [{ from: "1.1", to: "1.2" }],
};

function approve(contractBody: ExecutionContractBody = body): ApprovedExecutionContract {
  const contentHash = hashExecutionContractBody(contractBody);
  return {
    ...contractBody,
    contentHash,
    ownerApproval: {
      kind: "owner-approval",
      recordedBy: "owner",
      durable: true,
      recordId: "approval-1",
      contentHash,
    },
  };
}

function changed(mutator: (value: Record<string, any>) => void): ApprovedExecutionContract {
  const value = structuredClone(body) as unknown as Record<string, any>;
  mutator(value);
  return approve(value as unknown as ExecutionContractBody);
}

describe("Approved Execution Contract", () => {
  it("keeps schema v1 and the pre-Phase-3 contract hash byte-identical", () => {
    expect(EXECUTION_CONTRACT_SCHEMA_VERSION).toBe(1);
    expect(hashExecutionContractBody(body)).toBe("edee3f047847e3512efe58cd5288546ee19269dca1169127991e747f7d66f79e");
  });

  it("parses a valid owner-approved contract", () => {
    const result = parseApprovedExecutionContract(approve());
    expect(result).toMatchObject({ ok: true, advisories: [] });
  });

  it("accepts bounded optional phase-graph metadata and cross-checks authored phase dependencies", () => {
    const enriched = changed((value) => {
      value.phases.push({
        phaseId: "phase-2",
        title: "Integration",
        entryCriteria: "Foundations pass.",
        exitCriteria: "Integration passes.",
        dependsOnPhases: ["phase-1"],
        integrationCheckpointCount: 2,
      });
      value.slices[0].sharedInterfaces = ["src/contracts/execution-contract.ts#ExecutionContractBody"];
      value.slices[0].integrationBoundary = "approved execution contract";
      value.slices[1].phaseId = "phase-2";
    });

    expect(parseApprovedExecutionContract(enriched)).toMatchObject({ ok: true });
    expect(parseApprovedExecutionContract(changed((value) => {
      value.phases.push({
        phaseId: "phase-2",
        title: "Integration",
        entryCriteria: "Foundations pass.",
        exitCriteria: "Integration passes.",
        dependsOnPhases: [],
        integrationCheckpointCount: 2,
      });
      value.slices[1].phaseId = "phase-2";
    }))).toEqual({ ok: false, reason: "phase_dependency_mismatch" });
  });

  it("accepts interleaving phases derived from an acyclic slice graph (even when phase metadata declares the cross-phase links)", () => {
    const interleavedPhases = changed((value) => {
      value.phases[0].dependsOnPhases = ["phase-2"];
      value.phases.push({
        phaseId: "phase-2",
        title: "Integration",
        entryCriteria: "Foundations pass.",
        exitCriteria: "Integration passes.",
        dependsOnPhases: ["phase-1"],
      });
      value.slices[1].phaseId = "phase-2";
      value.slices.push({
        ...value.slices[0],
        sliceId: "1.3",
        phaseId: "phase-2",
        dependsOn: [],
      }, {
        ...value.slices[0],
        sliceId: "1.4",
        dependsOn: ["1.3"],
      });
    });

    // Derived phase cycle exists (phase-1 <-> phase-2), but slice DAG 1.1->1.2 , 1.3->1.4 is acyclic.
    // Per F1, this must be accepted; phase cycle derived from slices is not a contract defect.
    expect(parseApprovedExecutionContract(interleavedPhases)).toMatchObject({ ok: true });
  });

  it("F1 regression: accepts v1 contract with interleaved phases (no new phase metadata) when slice DAG is acyclic", () => {
    const interleaved = changed((value) => {
      value.phases.push({
        phaseId: "phase-2",
        title: "Integration",
        entryCriteria: "Foundations pass.",
        exitCriteria: "Integration passes.",
      });
      value.slices[1].phaseId = "phase-2";
      value.slices.push({
        ...value.slices[0],
        sliceId: "1.3",
        phaseId: "phase-1",
        dependsOn: ["1.2"],
      });
    });
    const result = parseApprovedExecutionContract(interleaved);
    expect(result).toMatchObject({ ok: true });
  });

  it.each([
    ["shared interfaces", (value: Record<string, any>) => { value.slices[0].sharedInterfaces = [""]; }],
    ["duplicate shared interfaces", (value: Record<string, any>) => { value.slices[0].sharedInterfaces = ["api", "api"]; }],
    ["integration boundary", (value: Record<string, any>) => { value.slices[0].integrationBoundary = " "; }],
    ["phase dependencies", (value: Record<string, any>) => { value.phases[0].dependsOnPhases = [1]; }],
    ["integration checkpoint count", (value: Record<string, any>) => { value.phases[0].integrationCheckpointCount = -1; }],
    ["unknown slice key", (value: Record<string, any>) => { value.slices[0].unexpected = true; }],
    ["unknown phase key", (value: Record<string, any>) => { value.phases[0].unexpected = true; }],
  ] as const)("rejects malformed optional %s metadata", (_name, mutate) => {
    expect(parseApprovedExecutionContract(changed(mutate))).toEqual({ ok: false, reason: "malformed" });
  });

  it.each(["minimal", "low", "medium", "high", "very-high", "max"])("accepts the abstract %s reasoning tier", (reasoningTier) => {
    expect(parseApprovedExecutionContract(changed((value) => { value.slices[0].reasoningTier = reasoningTier; }))).toMatchObject({ ok: true });
  });

  it("rejects an unresolvable reasoning tier", () => {
    expect(parseApprovedExecutionContract(changed((value) => { value.slices[0].reasoningTier = "banana"; }))).toEqual({ ok: false, reason: "malformed" });
  });

  it("returns an immutable detached snapshot that preserves the approved projection", () => {
    const contract = approve();
    const parsed = parseApprovedExecutionContract(contract);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("valid contract did not parse");

    expect(parsed.value).not.toBe(contract);
    expect(parsed.value.slices).not.toBe(contract.slices);
    expect(parsed.value.slices[0].writeSet).not.toBe(contract.slices[0].writeSet);

    expect(() => {
      (parsed.value as unknown as Record<string, any>).objective = "unapproved objective";
    }).toThrow(TypeError);
    expect(() => {
      (parsed.value.slices[0].writeSet as unknown as string[])[0] = "private/unapproved.ts";
    }).toThrow(TypeError);

    expect(deriveFocusEnvelope(parsed.value, "1.1", { role: "crewmate" })).toMatchObject({
      immutableObjective: body.objective,
      allowedPaths: body.slices[0].writeSet,
    });
  });

  it.each([
    ["cyclic_dependency", (value: Record<string, any>) => {
      value.slices[0].dependsOn = ["1.2"];
    }],
    ["dangling_dependency", (value: Record<string, any>) => {
      value.slices[0].dependsOn = ["9.9"];
    }],
    ["dangling_dependency", (value: Record<string, any>) => {
      value.dependencyEdges = [{ from: "1.1", to: "9.9" }];
    }],
    ["missing_requirement_trace", (value: Record<string, any>) => {
      value.slices[0].requirementIds = [];
    }],
    ["missing_evidence_command", (value: Record<string, any>) => {
      value.slices[0].evidenceCommandIds = [];
    }],
    ["invalid_write_set_path", (value: Record<string, any>) => {
      value.slices[0].writeSet = ["/absolute/path.ts"];
    }],
    ["invalid_write_set_path", (value: Record<string, any>) => {
      value.slices[0].writeSet = [""];
    }],
    ["invalid_write_set_path", (value: Record<string, any>) => {
      value.slices[0].writeSet = ["../../.ssh/id_ed25519"];
    }],
    ["invalid_write_set_path", (value: Record<string, any>) => {
      value.slices[0].writeSet = ["src/../secrets.ts"];
    }],
    ["empty_write_set", (value: Record<string, any>) => {
      value.slices[0].writeSet = [];
    }],
    ["invalid_mode", (value: Record<string, any>) => {
      value.mode = "solo";
    }],
    ["invalid_review_cadence", (value: Record<string, any>) => {
      value.reviewCadence = "whenever";
    }],
    ["unknown_phase", (value: Record<string, any>) => {
      value.slices[0].phaseId = "missing-phase";
    }],
    ["duplicate_slice_id", (value: Record<string, any>) => {
      value.slices[1].sliceId = "1.1";
      value.slices[1].dependsOn = [];
      value.dependencyEdges = [];
    }],
    ["duplicate_phase_id", (value: Record<string, any>) => {
      value.phases.push(structuredClone(value.phases[0]));
    }],
  ] as const)("rejects invalid contracts with %s", (reason, mutate) => {
    expect(parseApprovedExecutionContract(changed(mutate))).toEqual({ ok: false, reason });
  });

  it("returns overlapping parallel write sets as an advisory, not a failure", () => {
    const contract = changed((value) => {
      value.slices[1].writeSet = ["src/contracts/first.ts"];
    });
    expect(parseApprovedExecutionContract(contract)).toMatchObject({
      ok: true,
      advisories: [{
        code: "overlapping_parallel_write_set",
        sliceIds: ["1.1", "1.2"],
        paths: ["src/contracts/first.ts"],
      }],
    });
  });

  it("keeps a contract replayable but advises when parallel-safe slices share an integration boundary", () => {
    const contract = changed((value) => {
      value.slices[0].integrationBoundary = "execution handoff";
      value.slices[1].parallelSafe = true;
      value.slices[1].integrationBoundary = "execution handoff";
    });

    expect(parseApprovedExecutionContract(contract)).toMatchObject({
      ok: true,
      advisories: [{
        code: "parallel_safety_conflict",
        sliceIds: ["1.1", "1.2"],
        paths: [],
        integrationBoundaries: ["execution handoff"],
      }],
    });
  });

  it("hashes the canonical body independent of object-key order", () => {
    const reordered: ExecutionContractBody = {
      dependencyEdges: body.dependencyEdges.map((edge) => ({ to: edge.to, from: edge.from })),
      slices: body.slices.map((slice) => ({
        reasoningTier: slice.reasoningTier,
        role: slice.role,
        parallelSafe: slice.parallelSafe,
        dependsOn: slice.dependsOn,
        evidenceCommandIds: slice.evidenceCommandIds,
        acceptance: slice.acceptance,
        writeSet: slice.writeSet,
        requirementIds: slice.requirementIds,
        phaseId: slice.phaseId,
        sliceId: slice.sliceId,
      })),
      phases: body.phases.map((phase) => ({
        exitCriteria: phase.exitCriteria,
        entryCriteria: phase.entryCriteria,
        title: phase.title,
        phaseId: phase.phaseId,
      })),
      reviewCadence: body.reviewCadence,
      mode: body.mode,
      objective: body.objective,
      planDirectory: body.planDirectory,
      runId: body.runId,
      contractId: body.contractId,
      schemaVersion: body.schemaVersion,
    };
    expect(hashExecutionContractBody(reordered)).toBe(hashExecutionContractBody(body));
    expect(hashExecutionContractBody({ ...body, objective: `${body.objective} Changed.` }))
      .not.toBe(hashExecutionContractBody(body));
  });

  it("rejects a body change that is not covered by its hash", () => {
    const contract = approve() as unknown as Record<string, any>;
    contract.objective = "A different objective.";
    expect(parseApprovedExecutionContract(contract)).toEqual({ ok: false, reason: "content_hash_mismatch" });
  });

  it("rejects sparse contract arrays before graph validation", () => {
    const contract = changed((value) => {
      value.slices = new Array(1);
    });
    expect(() => parseApprovedExecutionContract(contract)).not.toThrow();
    expect(parseApprovedExecutionContract(contract)).toEqual({ ok: false, reason: "malformed" });
  });

  it.each([
    ["phases", (value: Record<string, any>) => {
      value.phases = new Array(1);
    }],
    ["dependencyEdges", (value: Record<string, any>) => {
      value.dependencyEdges = new Array(1);
    }],
    ["requirementIds", (value: Record<string, any>) => {
      value.slices[0].requirementIds = new Array(1);
    }],
    ["writeSet", (value: Record<string, any>) => {
      value.slices[0].writeSet = new Array(1);
    }],
    ["evidenceCommandIds", (value: Record<string, any>) => {
      value.slices[0].evidenceCommandIds = new Array(1);
    }],
    ["dependsOn", (value: Record<string, any>) => {
      value.slices[0].dependsOn = new Array(1);
    }],
  ] as const)("rejects a sparse %s array", (_name, mutate) => {
    const contract = changed(mutate);
    expect(() => parseApprovedExecutionContract(contract)).not.toThrow();
    expect(parseApprovedExecutionContract(contract)).toEqual({ ok: false, reason: "malformed" });
  });

  it("rejects inherited required fields even when the own-key count matches", () => {
    const ownBody = structuredClone(body) as unknown as Record<string, any>;
    delete ownBody.objective;
    ownBody.padding = "HASHED PADDING";
    const contentHash = hashExecutionContractBody(ownBody as ExecutionContractBody);
    const contract = Object.assign(Object.create({ objective: "UNHASHED OBJECTIVE" }), ownBody, {
      contentHash,
      ownerApproval: {
        kind: "owner-approval",
        recordedBy: "owner",
        durable: true,
        recordId: "approval-1",
        contentHash,
      },
    });

    expect(parseApprovedExecutionContract(contract)).toEqual({ ok: false, reason: "malformed" });
  });

  it("hashes only own enumerable contract properties", () => {
    const inherited = Object.assign(Object.create({ hidden: "not hashed" }), structuredClone(body));
    expect(hashExecutionContractBody(inherited)).toBe(hashExecutionContractBody(body));
  });

  it.each([
    ["sliceId", (value: Record<string, any>) => {
      value.slices[0].sliceId = "bad id";
    }],
    ["overlong sliceId", (value: Record<string, any>) => {
      const sliceId = `S${"1".repeat(128)}`;
      value.slices[0].sliceId = sliceId;
      value.slices[1].dependsOn = [sliceId];
      value.dependencyEdges = [{ from: sliceId, to: "1.2" }];
    }],
    ["dependsOn", (value: Record<string, any>) => {
      value.slices[1].dependsOn = ["bad id"];
    }],
    ["dependency edge", (value: Record<string, any>) => {
      value.dependencyEdges = [{ from: "bad id", to: "1.2" }];
    }],
  ] as const)("rejects a Focus-incompatible %s", (_name, mutate) => {
    expect(parseApprovedExecutionContract(changed(mutate))).toEqual({ ok: false, reason: "malformed" });
  });

  it.each([
    "C:/outside.ts",
    "C:\\outside.ts",
    " ",
  ])("rejects non-POSIX-relative write-set path %j during parsing", (path) => {
    const contract = changed((value) => {
      value.slices[0].writeSet = [path];
    });
    expect(parseApprovedExecutionContract(contract)).toEqual({ ok: false, reason: "invalid_write_set_path" });
  });

  it("rejects a correctly hashed plan directory traversal before Focus projection", () => {
    const contract = changed((value) => {
      value.planDirectory = "../outside";
    });

    expect.soft(parseApprovedExecutionContract(contract)).toEqual({ ok: false, reason: "malformed" });
    expect(deriveFocusEnvelope(contract, "1.1", { role: "crewmate" }))
      .toEqual({ ok: false, reason: "slice_not_projectable" });
  });

  it("rejects an NTFS alternate-data-stream write-set path before Focus projection", () => {
    const contract = changed((value) => {
      value.slices[0].writeSet = ["src/a.ts:secret"];
    });

    expect.soft(parseApprovedExecutionContract(contract)).toEqual({ ok: false, reason: "invalid_write_set_path" });
    expect(deriveFocusEnvelope(contract, "1.1", { role: "crewmate" }))
      .toEqual({ ok: false, reason: "slice_not_projectable" });
  });

  it.each([
    ["overlong acceptance", "malformed", (value: Record<string, any>) => { value.slices[0].acceptance = "x".repeat(513); }],
    ["duplicate write-set path", "invalid_write_set_path", (value: Record<string, any>) => { value.slices[0].writeSet = ["src/a.ts", "src/a.ts"]; }],
    ["non-normalized write-set path", "invalid_write_set_path", (value: Record<string, any>) => { value.slices[0].writeSet = ["src/./a.ts"]; }],
    ["duplicate evidence command", "malformed", (value: Record<string, any>) => { value.slices[0].evidenceCommandIds = ["CMD-FIRST", "CMD-FIRST"]; }],
    ["invalid evidence command", "malformed", (value: Record<string, any>) => { value.slices[0].evidenceCommandIds = ["run tests"]; }],
  ] as const)("rejects a projection-incompatible %s during parsing", (_name, reason, mutate) => {
    expect(parseApprovedExecutionContract(changed(mutate))).toEqual({ ok: false, reason });
  });
});

describe("roleRoutes", () => {
  const roleRoutes: readonly RoleRoute[] = [
    { role: "execution-author", primary: "codex", fallbacks: ["claude"] },
    { role: "review-general", primary: "claude", fallbacks: [] },
    { role: "review-security", primary: "claude", fallbacks: ["surveyor"] },
  ];
  const withRoleRoutes = (routes: readonly RoleRoute[]): ApprovedExecutionContract => approve({ ...body, roleRoutes: routes });

  it("accepts a contract with valid roleRoutes and changes the content hash", () => {
    expect(hashExecutionContractBody({ ...body, roleRoutes })).not.toBe(hashExecutionContractBody(body));
    expect(parseApprovedExecutionContract(withRoleRoutes(roleRoutes))).toMatchObject({ ok: true });
  });

  it("keeps a pre-Phase-3 contract without roleRoutes parseable and byte-identical", () => {
    expect(parseApprovedExecutionContract(approve())).toMatchObject({ ok: true });
    expect(hashExecutionContractBody(body)).toBe("edee3f047847e3512efe58cd5288546ee19269dca1169127991e747f7d66f79e");
  });

  it("preserves exact primary/fallback order through parsing", () => {
    const parsed = parseApprovedExecutionContract(withRoleRoutes(roleRoutes));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("valid roleRoutes contract did not parse");
    expect(parsed.value.roleRoutes).toEqual(roleRoutes);
  });

  it("changes the content hash when fallback order changes", () => {
    const forward = roleRoutes.map((route) =>
      route.role === "execution-author" ? { ...route, fallbacks: ["claude", "agy"] } : route);
    const reversed = roleRoutes.map((route) =>
      route.role === "execution-author" ? { ...route, fallbacks: ["agy", "claude"] } : route);
    expect(hashExecutionContractBody({ ...body, roleRoutes: forward }))
      .not.toBe(hashExecutionContractBody({ ...body, roleRoutes: reversed }));
  });

  it.each([
    ["duplicate role (and an implicitly missing role)", (routes: RoleRoute[]) => { routes[2] = { ...routes[1] }; }],
    ["missing role", (routes: RoleRoute[]) => { routes.pop(); }],
    ["duplicate fallback", (routes: RoleRoute[]) => { routes[0] = { ...routes[0], fallbacks: ["claude", "claude"] }; }],
    ["primary repeated as fallback", (routes: RoleRoute[]) => { routes[0] = { ...routes[0], primary: "codex", fallbacks: ["codex"] }; }],
    ["unknown key", (routes: RoleRoute[]) => { (routes[0] as unknown as Record<string, unknown>).extra = true; }],
    ["oversized unknown route id", (routes: RoleRoute[]) => { routes[0] = { ...routes[0], primary: `sk-${"a".repeat(200)}` }; }],
    ["unrecognized route id", (routes: RoleRoute[]) => { routes[0] = { ...routes[0], primary: "totally-unknown-route" }; }],
    ["surveyor as a primary route", (routes: RoleRoute[]) => { routes[0] = { ...routes[0], primary: "surveyor" }; }],
    ["surveyor as the execution-author fallback", (routes: RoleRoute[]) => { routes[0] = { ...routes[0], fallbacks: ["surveyor"] }; }],
  ] as const)("fails closed on %s", (_name, mutate) => {
    const mutated = structuredClone(roleRoutes) as RoleRoute[];
    mutate(mutated);
    expect(parseApprovedExecutionContract(withRoleRoutes(mutated))).toEqual({ ok: false, reason: "malformed" });
  });

  it("accepts surveyor as the review-general fallback", () => {
    const withSurveyorFallback = roleRoutes.map((route) =>
      route.role === "review-general" ? { ...route, fallbacks: ["surveyor"] } : route);
    expect(parseApprovedExecutionContract(withRoleRoutes(withSurveyorFallback))).toMatchObject({ ok: true });
  });
});

describe("deriveFocusEnvelope", () => {
  it("projects exactly one slice into the existing FocusEnvelope contract", () => {
    const envelope = deriveFocusEnvelope(approve(), "1.1", { role: "crewmate" });
    expect(envelope).toEqual({
      version: 1,
      role: "crewmate",
      immutableObjective: body.objective,
      currentAcceptanceCriterion: body.slices[0].acceptance,
      allowedPaths: body.slices[0].writeSet,
      requiredEvidence: ["CMD-FIRST: passing command evidence"],
      seitCommandIds: ["CMD-FIRST"],
      currentBlocker: "none",
      remainingSlices: ["1.1", "1.2"],
      gateFailureFingerprint: "none",
      prohibition: "Do not perform unrelated work.",
    });
    expect(Object.keys(envelope).sort()).toEqual([
      "allowedPaths",
      "currentAcceptanceCriterion",
      "currentBlocker",
      "gateFailureFingerprint",
      "immutableObjective",
      "prohibition",
      "remainingSlices",
      "requiredEvidence",
      "role",
      "seitCommandIds",
      "version",
    ]);
    for (const contractOnly of [
      "dependencyEdges", "parallelSafe", "phases", "mode", "reviewCadence",
      "reasoningTier", "sharedInterfaces", "integrationBoundary", "dependsOnPhases",
      "integrationCheckpointCount", "contentHash", "ownerApproval",
    ]) {
      expect(envelope).not.toHaveProperty(contractOnly);
    }
  });

  it("keeps optional contract metadata behind the Focus envelope boundary", () => {
    const contract = changed((value) => {
      value.phases[0].dependsOnPhases = [];
      value.phases[0].integrationCheckpointCount = 1;
      value.slices[0].sharedInterfaces = ["src/contracts/execution-contract.ts#ExecutionContractBody"];
      value.slices[0].integrationBoundary = "approved execution contract";
    });

    expect(deriveFocusEnvelope(contract, "1.1", { role: "crewmate" })).toEqual({
      version: 1,
      role: "crewmate",
      immutableObjective: body.objective,
      currentAcceptanceCriterion: body.slices[0].acceptance,
      allowedPaths: body.slices[0].writeSet,
      requiredEvidence: ["CMD-FIRST: passing command evidence"],
      seitCommandIds: ["CMD-FIRST"],
      currentBlocker: "none",
      remainingSlices: ["1.1", "1.2"],
      gateFailureFingerprint: "none",
      prohibition: "Do not perform unrelated work.",
    });
  });

  it("uses runtime-only blocker fields and projects later remaining slices", () => {
    expect(deriveFocusEnvelope(approve(), "1.2", {
      role: "explorer",
      currentBlocker: "Waiting for owner evidence.",
      gateFailureFingerprint: "CMD-SECOND failed once.",
    })).toMatchObject({
      role: "explorer",
      currentBlocker: "Waiting for owner evidence.",
      gateFailureFingerprint: "CMD-SECOND failed once.",
      remainingSlices: ["1.2"],
    });
  });

  it("projects remaining slices in dependency order from an unordered contract", () => {
    const unordered = changed((value) => {
      value.slices = [value.slices[1], value.slices[0]];
    });

    expect(deriveFocusEnvelope(unordered, "1.1", { role: "crewmate" })).toMatchObject({
      remainingSlices: ["1.1", "1.2"],
    });
    expect(deriveFocusEnvelope(unordered, "1.2", { role: "crewmate" })).toMatchObject({
      remainingSlices: ["1.2"],
    });
  });

  it("fails closed for an unknown slice and rejects an unsafe write set at intake", () => {
    expect(deriveFocusEnvelope(approve(), "9.9", { role: "crewmate" }))
      .toEqual({ ok: false, reason: "unknown_slice" });

    const unsafe = changed((value) => {
      value.slices[0].writeSet = ["src/../secrets.ts"];
    });
    expect(parseApprovedExecutionContract(unsafe))
      .toEqual({ ok: false, reason: "invalid_write_set_path" });
  });

  it("re-verifies the content hash and owner approval before projection", () => {
    const changedBody = approve() as unknown as Record<string, any>;
    changedBody.objective = "unapproved objective";
    expect(deriveFocusEnvelope(
      changedBody as ApprovedExecutionContract,
      "1.1",
      { role: "crewmate" },
    )).toEqual({ ok: false, reason: "slice_not_projectable" });

    const changedApproval = structuredClone(approve()) as unknown as Record<string, any>;
    changedApproval.ownerApproval.contentHash = "0".repeat(64);
    expect(deriveFocusEnvelope(
      changedApproval as ApprovedExecutionContract,
      "1.1",
      { role: "crewmate" },
    )).toEqual({ ok: false, reason: "slice_not_projectable" });
  });

  it("re-verifies the content hash and owner approval before projection", () => {
    const changedBody = approve() as unknown as Record<string, any>;
    changedBody.objective = "unapproved objective";
    expect(deriveFocusEnvelope(
      changedBody as ApprovedExecutionContract,
      "1.1",
      { role: "crewmate" },
    )).toEqual({ ok: false, reason: "slice_not_projectable" });

    const changedApproval = structuredClone(approve()) as unknown as Record<string, any>;
    changedApproval.ownerApproval.contentHash = "0".repeat(64);
    expect(deriveFocusEnvelope(
      changedApproval as ApprovedExecutionContract,
      "1.1",
      { role: "crewmate" },
    )).toEqual({ ok: false, reason: "slice_not_projectable" });
  });

  it("projects valid paths through the real Focus envelope boundary up to the item ceiling", () => {
    const paths = Array.from({ length: 128 }, (_, index) => `src/generated/part-${index}.ts`);
    const contract = changed((value) => {
      value.slices[0].writeSet = paths;
    });
    const envelope = deriveFocusEnvelope(contract, "1.1", { role: "crewmate" });
    expect(envelope).not.toMatchObject({ ok: false });
    if ("ok" in envelope) throw new Error("valid generated paths were not projectable");
    expect(envelope.allowedPaths).toEqual(paths);
  });

  it.each([
    ["sparse", new Array(1)],
    ["over ceiling", Array.from({ length: 129 }, (_, index) => `src/generated/part-${index}.ts`)],
    ["parent traversal", ["../escape.ts"]],
    ["normalized alias", ["src/./alias.ts"]],
    ["empty segment", ["src//empty.ts"]],
    ["glob", ["src/*.ts"]],
    ["angle bracket", ["src/<secret>.ts"]],
    ["Windows separator", ["src\\windows.ts"]],
    ["padded", [" src/padded.ts"]],
    ["whitespace only", [" "]],
    ["control character", ["src/control\u0007.ts"]],
    ["Windows forward absolute", ["C:/outside.ts"]],
    ["Windows backslash absolute", ["C:\\outside.ts"]],
  ] as const)("fails closed at the Focus envelope boundary for %s paths", (_name, paths) => {
      const contract = changed((value) => {
        value.slices[0].writeSet = paths;
      });
      expect(() => deriveFocusEnvelope(contract, "1.1", { role: "crewmate" })).not.toThrow();
      expect(deriveFocusEnvelope(contract, "1.1", { role: "crewmate" }))
        .toEqual({ ok: false, reason: "slice_not_projectable" });
  });

  it("never projects a Focus-incompatible slice id", () => {
    expect(deriveFocusEnvelope(approve(), "bad id", { role: "crewmate" }))
      .toEqual({ ok: false, reason: "slice_not_projectable" });
  });
});
