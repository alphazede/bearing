import { afterEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { createServer, request as httpRequest } from "node:http";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { access, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import type { LauncherDeps } from "../src/cli.js";
import { run } from "../src/cli.js";
import { SyntheticRunner, type ProcessInvocation, type ProcessResult, type ProcessRunner } from "../src/adapters/adapters.js";
import { hashExecutionContractBody, type ApprovedExecutionContract, type ExecutionContractBody } from "../src/contracts/execution-contract.js";
import {
  RECORD_JOURNEY_CHECKPOINT_STAGES,
  isVerificationCheckpointPayload,
  type CommandEnvelopeV1,
  type VerificationCheckpointPayload,
} from "../src/contracts/run.js";
import { parseRuntimeState, serializeRuntimeState } from "../src/contracts/runtime-state.js";
import { RepositoryBootstrap, type BootstrapResult } from "../src/repository/bootstrap.js";
import { currentPlanningVerdict, renderPlanningReview, type JourneyStage } from "../src/journey/planning-journey.js";
import { PLAN_REVIEW_APPROVAL, PLAN_REVIEW_QUESTION, next, type PlanningSignal, type PlanningState } from "../src/journey/planning-state.js";
import {
  LocalSessionService,
  SESSION_COOKIE_NAME,
  buildImprovementHandoffFacts,
  buildImprovementReport,
  createRequestHandler,
  greetingFor,
  measureImprovementWindow,
  unnamedGreetingFor,
  readCookie,
} from "../src/server/local-session.js";
import type { OutcomeRecord } from "../src/improvement/outcome-projection.js";
import { BearingStore } from "../src/store/bearing-store.js";
import { GRADER_RUBRIC, GRADER_RUBRIC_VERSION } from "../src/verification/grader-rubric.js";

const servers: Server[] = [];
const roots: string[] = [];
afterEach(async () => {
  while (servers.length) {
    const s = servers.pop()!;
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
  while (roots.length) {
    await rm(roots.pop()!, { recursive: true, force: true });
  }
});

interface Resp {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function call(
  port: number | string,
  opts: { method: string; path: string; headers?: Record<string, string>; body?: string },
): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        method: opts.method,
        path: opts.path,
        headers: opts.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

async function launch(): Promise<{ port: string; cap: string }> {
  const out: string[] = [];
  const d: LauncherDeps = {
    openBrowser: () => {},
    stdout: { write: (s: string) => { out.push(s); return true; } },
    stderr: { write: (s: string) => { out.push(s); return true; } },
    exit: () => {
      throw new Error("unexpected exit");
    },
  };
  const server = await run(["start", "--no-open"], d);
  if (!server) throw new Error("server did not start");
  servers.push(server);
  const url = new URL(out.join("").trim());
  const cap = /^#cap=([0-9a-f]+)$/.exec(url.hash)?.[1];
  if (!cap) throw new Error("no capability in launch URL");
  return { port: url.port, cap };
}

function sessionHeaders(port: string, extra: Record<string, string> = {}): Record<string, string> {
  return { origin: `http://127.0.0.1:${port}`, "content-type": "application/json", ...extra };
}

async function tempRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "bearing-session-"));
  roots.push(root);
  // A bare `mkdir(".git")` satisfies the repository-selection check but not `git rev-parse`,
  // so stages that snapshot Git state saw an unavailable snapshot. That used to pass silently
  // because Recon validation failed open; it now fails closed, so the fixture has to be a real
  // repository. An empty init is enough: `gitHead` maps "no commits yet" to null, not undefined.
  await new Promise<void>((resolve, reject) => {
    execFile("git", ["init", "-q"], { cwd: root }, (error) => (error ? reject(error) : resolve()));
  });
  return root;
}

async function tempDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "bearing-session-"));
  roots.push(root);
  return root;
}

async function treeSnapshot(root: string, prefix = ""): Promise<readonly [string, string][]> {
  const snapshot: [string, string][] = [];
  for (const name of (await readdir(join(root, prefix))).sort()) {
    const path = prefix ? `${prefix}/${name}` : name;
    const info = await lstat(join(root, path));
    if (info.isDirectory()) snapshot.push([`${path}/`, "directory"], ...await treeSnapshot(root, path));
    else snapshot.push([path, (await readFile(join(root, path))).toString("base64")]);
  }
  return snapshot;
}

function fitCheckpointPayload(root: string, planDirectory: string) {
  return {
    stage: "repository-fit" as const,
    status: "waiting" as const,
    artifacts: [] as const,
    repositoryFitDecision: {
      outcome: "confirmed" as const,
      planDirectory,
      repository: root,
      decidedAt: "2026-07-25T00:00:00.000Z",
    },
    resolvedPlanDirectory: planDirectory,
  };
}

async function launchHandler(
  repositoryBootstrap = new RepositoryBootstrap(),
  options: Parameters<typeof createRequestHandler>[2] = {},
): Promise<{ port: string; cap: string }> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      server.off("error", onError);
      resolve();
    });
  });
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing address");
  const port = String(address.port);
  const service = new LocalSessionService(`127.0.0.1:${port}`);
  server.on("request", createRequestHandler(service, repositoryBootstrap, options));
  return { port, cap: service.capability };
}

async function exchangeCookie(port: string, cap: string): Promise<string> {
  const r = await call(port, {
    method: "POST",
    path: "/api/v1/session",
    headers: sessionHeaders(port),
    body: JSON.stringify({ capability: cap }),
  });
  expect(r.status).toBe(200);
  const sc = r.headers["set-cookie"];
  if (!Array.isArray(sc)) throw new Error("missing Set-Cookie");
  return sc[0].split(";")[0];
}

async function selectRepository(port: string, cookie: string, root: string): Promise<void> {
  const selected = await call(port, {
    method: "POST",
    path: "/api/v1/repository",
    headers: sessionHeaders(port, { cookie }),
    body: JSON.stringify({ path: root }),
  });
  expect(selected.status).toBe(200);
}

async function readyJourneyHandler(root: string, runner: ProcessRunner): Promise<{ port: string; cookie: string }> {
  const { port, cap } = await launchHandler(new RepositoryBootstrap(), {
    processRunner: runner,
    verification: { verify: async () => true },
  });
  const cookie = await exchangeCookie(port, cap);
  await selectRepository(port, cookie, root);
  expect((await call(port, {
    method: "POST",
    path: "/api/v1/readiness",
    headers: sessionHeaders(port, { cookie }),
    body: JSON.stringify({ provider: "codex", model: "*", reasoning: "medium" }),
  })).status).toBe(200);
  return { port, cookie };
}

async function closeLatestServer(): Promise<void> {
  const server = servers.pop();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function beginFitFlow(root: string, runId: string): Promise<{ port: string; cookie: string; store: BearingStore }> {
  const runner = new SyntheticRunner(undefined, [{
    exitCode: 0,
    events: [{
      type: "item.completed",
      data: {
        content: `BEARING_RESULT ${JSON.stringify({
          kind: "fit",
          ok: true,
          assumption: {
            repository: root,
            planDirectory: "docs/plans/proposed",
            rationale: "The selected repository matches the work.",
            evidence: [{ kind: "git-root", path: ".git", detail: "The selected root is a Git repository." }],
          },
          question: "Confirm the proposed plan directory.",
        })}`,
      },
    }],
    usage: { tokens: 1 },
  }]);
  const { port, cap } = await launchHandler(new RepositoryBootstrap(), {
    processRunner: runner,
    verification: { verify: async () => true },
  });
  const cookie = await exchangeCookie(port, cap);
  await selectRepository(port, cookie, root);
  expect((await call(port, {
    method: "POST",
    path: "/api/v1/readiness",
    headers: sessionHeaders(port, { cookie }),
    body: JSON.stringify({ provider: "codex", model: "*", reasoning: "medium" }),
  })).status).toBe(200);
  const store = new BearingStore(root);
  const created = await store.apply({
    schemaVersion: 1,
    commandId: `create-${runId}`,
    runId,
    expectedRevision: 0,
    type: "createWorkRequest",
    payload: { title: "Resume shared", goal: "Resume shared" },
    session: { sessionId: "test-owner", actor: "owner" },
    correlationId: `create-${runId}`,
  });
  if (!created.ok) throw new Error(created.reason);
  expect((await call(port, {
    method: "POST",
    path: "/api/v1/journey",
    headers: sessionHeaders(port, { cookie }),
    body: JSON.stringify({ runId, stage: "repository-fit", workGoal: "Resume shared" }),
  })).status).toBe(200);
  return { port, cookie, store };
}

async function recordPendingAnswer(store: BearingStore, runId: string, answer: string, suffix: string): Promise<void> {
  const durable = await store.load(runId);
  if (!durable.pendingDecision) throw new Error("fit decision missing");
  const recorded = await store.apply({
    schemaVersion: 1,
    commandId: `answer-${runId}-${suffix}`,
    runId,
    expectedRevision: durable.revision,
    type: "recordOwnerAnswer",
    payload: { decisionId: durable.pendingDecision.decisionId, answer },
    session: { sessionId: "test-owner", actor: "owner" },
    correlationId: `answer-${runId}-${suffix}`,
  });
  if (!recorded.ok) throw new Error(recorded.reason);
}

async function recordPlanningApproval(store: BearingStore, runId: string, suffix = ""): Promise<void> {
  let durable = await store.load(runId);
  const idSuffix = suffix ? `-${suffix}` : "";
  const decisionId = `plan-review-${runId}${idSuffix}`;
  const required = await store.apply({
    schemaVersion: 1,
    commandId: `require-plan-review-${runId}${idSuffix}`,
    runId,
    expectedRevision: durable.revision,
    type: "requireDecision",
    payload: { decisionId, question: "Approve the complete planning package before implementation?", consequential: true },
    session: { sessionId: "test-owner", actor: "owner" },
    correlationId: `require-plan-review-${runId}${idSuffix}`,
  });
  if (!required.ok) throw new Error(required.reason);
  durable = await store.load(runId);
  const approved = await store.apply({
    schemaVersion: 1,
    commandId: `approve-plan-review-${runId}${idSuffix}`,
    runId,
    expectedRevision: durable.revision,
    type: "recordOwnerAnswer",
    payload: { decisionId, answer: "Approved for execution-mode selection" },
    session: { sessionId: "test-owner", actor: "owner" },
    correlationId: `approve-plan-review-${runId}${idSuffix}`,
  });
  if (!approved.ok) throw new Error(approved.reason);
}

async function seedRun(root: string, runId: string, planDirectory?: string): Promise<BearingStore> {
  const store = new BearingStore(root);
  const created = await store.apply({
    schemaVersion: 1,
    commandId: `create-${runId}`,
    runId,
    expectedRevision: 0,
    type: "createWorkRequest",
    payload: { title: "Bounded work", goal: "Complete the approved work" },
    session: { sessionId: "test-owner", actor: "owner" },
    correlationId: `create-${runId}`,
  });
  if (!created.ok) throw new Error(created.reason);
  const confirmedPlanDirectory = planDirectory ?? `docs/plans/${runId}`;
  const fitFields = confirmedPlanDirectory.startsWith("docs/plans/")
    ? fitCheckpointPayload(root, confirmedPlanDirectory)
    : undefined;
  const checkpoint = await store.apply({
    schemaVersion: 1,
    commandId: planDirectory ? `checkpoint-${runId}` : `fit-${runId}`,
    runId,
    expectedRevision: created.state.revision,
    type: "recordJourneyCheckpoint",
    payload: planDirectory
      ? { stage: "gather-supplies", status: "complete", artifacts: [], planDirectory, ...(fitFields ? {
        repositoryFitDecision: fitFields.repositoryFitDecision,
        resolvedPlanDirectory: fitFields.resolvedPlanDirectory,
      } : {}) }
      : fitCheckpointPayload(root, confirmedPlanDirectory),
    session: { sessionId: "test-bearing", actor: "bearing" },
    correlationId: planDirectory ? `checkpoint-${runId}` : `fit-${runId}`,
  });
  if (!checkpoint.ok) throw new Error(checkpoint.reason);
  return store;
}

// Records ordinary journey progress. Bearing may advance the stage; what it may
// never do is record the owner's approval hash on its own behalf.
async function advanceJourneyStage(
  store: BearingStore,
  runId: string,
  stage: (typeof RECORD_JOURNEY_CHECKPOINT_STAGES)[number],
  status: "running" | "waiting" | "stopped" | "failed" | "complete",
): Promise<void> {
  const durable = await store.load(runId);
  if (!durable.journeyCheckpoint) throw new Error("journey checkpoint missing");
  const { eventId: _eventId, ...payload } = durable.journeyCheckpoint;
  const recorded = await store.apply({
    schemaVersion: 1,
    commandId: `advance-${runId}-${stage}`,
    runId,
    expectedRevision: durable.revision,
    type: "recordJourneyCheckpoint",
    payload: { ...payload, stage, status },
    session: { sessionId: "test-bearing", actor: "bearing" },
    correlationId: `advance-${runId}-${stage}`,
  });
  if (!recorded.ok) throw new Error(recorded.reason);
}

function approvedContract(runId: string, overrides: Partial<ExecutionContractBody> = {}): ApprovedExecutionContract {
  const body: ExecutionContractBody = {
    schemaVersion: 1,
    contractId: `contract-${runId}`,
    runId,
    planDirectory: "docs/plans/approved",
    objective: "Complete the approved work",
    mode: "explorer",
    reviewCadence: "per-slice",
    phases: [{ phaseId: "phase-1", title: "Build", entryCriteria: "Approved", exitCriteria: "Validated" }],
    slices: [{ sliceId: "1.7", phaseId: "phase-1", requirementIds: ["AC-1.3"], writeSet: ["src/server/local-session.ts"], acceptance: "Expose bounded read-only state.", evidenceCommandIds: ["CMD-TEST-ALL"], dependsOn: [], parallelSafe: false, role: "crewmate", reasoningTier: "high" }],
    dependencyEdges: [],
    ...overrides,
  };
  const contentHash = hashExecutionContractBody(body);
  return { ...body, contentHash, ownerApproval: { kind: "owner-approval", recordedBy: "owner", durable: true, recordId: `approval-${runId}`, contentHash } };
}

async function recordContractApproval(store: BearingStore, contract: ApprovedExecutionContract): Promise<ApprovedExecutionContract> {
  return recordOwnerContractApproval(store, contract);
}

async function recordOwnerContractApproval(store: BearingStore, contract: ApprovedExecutionContract): Promise<ApprovedExecutionContract> {
  const decisionId = `contract-review-${contract.runId}`;
  let durable = await store.load(contract.runId);
  const required = await store.apply({
    schemaVersion: 1,
    commandId: `require-${decisionId}`,
    runId: contract.runId,
    expectedRevision: durable.revision,
    type: "requireDecision",
    payload: { decisionId, question: "Approve the complete planning package before implementation?", consequential: true },
    session: { sessionId: "test-bearing", actor: "bearing" },
    correlationId: `require-${decisionId}`,
  });
  if (!required.ok) throw new Error(required.reason);
  durable = await store.load(contract.runId);
  const answered = await store.apply({
    schemaVersion: 1,
    commandId: `answer-${decisionId}`,
    runId: contract.runId,
    expectedRevision: durable.revision,
    type: "recordOwnerAnswer",
    payload: {
      decisionId,
      answer: "Approved for execution-mode selection",
      ownerApprovedContentHash: contract.contentHash,
    },
    session: { sessionId: "test-owner", actor: "owner" },
    correlationId: `answer-${decisionId}`,
  });
  if (!answered.ok || !answered.events[0]) throw new Error(answered.ok ? "approval event missing" : answered.reason);
  return { ...contract, ownerApproval: { ...contract.ownerApproval, recordId: answered.events[0].eventId } };
}

async function recordVerificationCheckpoint(
  store: BearingStore,
  runId: string,
  verification: VerificationCheckpointPayload,
): Promise<{ readonly eventId: string; readonly sequence: number }> {
  const durable = await store.load(runId);
  const commandId = `verification-${runId}-${verification.layer}-${durable.revision}`;
  const recorded = await store.apply({
    schemaVersion: 1,
    commandId,
    runId,
    expectedRevision: durable.revision,
    type: "recordJourneyCheckpoint",
    payload: {
      stage: "review",
      status: "complete",
      artifacts: [],
      verification,
    },
    session: { sessionId: "test-bearing", actor: "bearing" },
    correlationId: commandId,
  });
  if (!recorded.ok || !recorded.events[0]) throw new Error(recorded.ok ? "verification event missing" : recorded.reason);
  return { eventId: recorded.events[0].eventId, sequence: recorded.events[0].sequence };
}

function graderReport(contractHash: string, level: 0 | 1 | 2 | 3 | 4 = 3, verdict: "strong" | "acceptable" | "weak" = "acceptable") {
  return {
    schemaVersion: 1,
    rubricVersion: GRADER_RUBRIC_VERSION,
    contractHash,
    scope: { kind: "slice", id: "1.7" },
    graderSessionId: "grader-session-4-13",
    scores: GRADER_RUBRIC.map(({ id }) => ({
      dimensionId: id,
      level,
      evidence: `HTTP evidence for ${id}`,
      confidence: "high",
    })),
    deficiencies: [],
    verdict,
  };
}

function parkRangerReport(options: {
  lens?: "correctness" | "security";
  sessionId?: string;
  priority?: "P0" | "P1";
  code?: string;
  adjudications?: readonly unknown[];
} = {}) {
  const lens = options.lens ?? "correctness";
  return {
    lens,
    sessionId: options.sessionId ?? "park-ranger-session-4-13",
    findings: [{
      id: "bounded-report-ingestion",
      ...(options.code ? { code: options.code } : {}),
      priority: options.priority ?? "P1",
      summary: "The verification report requires a bounded authenticated ingestion path",
      location: { path: "src/server/local-session.ts", line: 1 },
      reproduction: {
        inputs: "POST a validated Park Ranger report",
        observedFailure: "No checkpoint exists without the ingestion handler",
        commandId: "CMD-4-13-HTTP",
      },
      reachability: {
        entryPoint: "POST /api/v1/runs/run-1/verification/park-ranger",
        trustBoundary: "untrusted-input",
        path: ["createRequestHandler", "handleVerificationReportPost"],
      },
      lens,
      confirmedBy: [lens],
    }],
    questions: [],
    adjudications: options.adjudications ?? [],
  };
}

const planFixture = "---\ntype: plan-spec\nstatus: complete\n---\n\n## Acceptance criteria\n\n- **AC-1** — Bounded work is complete.\n\n## Risks and open questions\n\n- **RISK-1** — Invalid output fails closed.\n\n## Entry criteria\n\nApproved scope.\n\n## Exit criteria\n\nAll evidence passes.\n\n## Rollback or repair\n\nRepair the bounded slice.\n\n## Accountable controller\n\nNavigator.\n";
const designFixture = "---\ntype: design\nstatus: complete\n---\n\n## Use Cases and Communication Flows\n\nComplete flow.\n\n## Interface Option Check\n\ninterface_options: not needed - fixture\n\n## OOPDSA Implementation Design\n\n- **DES-1** — Use the existing boundary.\n- **CONTRACT-1** — Reject invalid output.\n";
const seitFixture = "---\ntype: seit\nstatus: complete\n---\n\n## Required Commands\n\n- **CMD-UNIT** — `pnpm test`\n\n## Traceability Matrix\n\n| SEIT row ID | Acceptance/risk ID | Design/contract ID | Boundary/test layer | Positive case | Negative/failure case | Command/procedure ID | Evidence |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n| SEIT-1 | AC-1 | DES-1, CONTRACT-1 | unit | valid output passes | invalid output fails closed | CMD-UNIT | test report |\n| SEIT-2 | RISK-1 | CONTRACT-1 | unit | valid output remains bounded | invalid output is rejected | CMD-UNIT | test report |\n\n## Cross-cutting Checks\n\nComplete checks.\n";
const implementationFixture = "---\ntype: implementation\nstatus: complete\nplan_spec: ./plan-spec.md\ndesign: ./design.md\nseit: ./seit.md\n---\n\n# Implementation\n\n## Phase 1 — Build\n\n### Slice 1.1 — Work\n\n**Goal.** Complete bounded work.\n\n**Requirement IDs.** AC-1\n\n**Design IDs.** DES-1, CONTRACT-1\n\n**SEIT proof rows.** SEIT-1\n\n**Type.** /tdd\n\n**Design lenses.** CDD\n\n**Implementation role.** Backend Engineer\n\n**Agent model route.** Codex agent default\n\n**Agent reasoning level.** medium.\n\n**Ponytail mode.** full\n\n**Review path.** native review\n\n### 1.1 execution manifest\n\n**Write set.** `src/work.ts` only.\n\n**Command IDs.** CMD-UNIT\n\n**Stop condition.** Stop if focused validation fails.\n\n**Human decision.** None.\n";
const reconBrief = {
  assumptionId: "parser-throughput",
  assumption: "The parser can sustain the required throughput.",
  materiality: ["architecture"],
  falsificationCriterion: "Throughput stays above 100 rows per second.",
  smallestExperiment: "Parse the bounded fixture once.",
  writeSet: ["tmp/recon.json"],
  evidenceCommandIds: ["CMD-RECON"],
  timeboxMinutes: 10,
} as const;
const reconReport = {
  assumptionId: "parser-throughput",
  measurements: [{ name: "throughput", value: "120 rows per second", method: "bounded fixture" }],
  feasibilityEvidence: ["CMD-RECON passed"],
  constraints: ["One bounded fixture"],
  rejectedOptions: [{ option: "Full benchmark", reason: "Larger than the timebox" }],
  recommendation: "proceed",
  materialChange: { cost: false, architecture: false, scope: false, risk: false },
  prototypePaths: ["tmp/recon.json"],
  productionEligible: false,
} as const;

class CheckpointRunner implements ProcessRunner {
  readonly calls: ProcessInvocation[] = [];
  private reconRecommendation: "proceed" | "stop" = "proceed";
  private adapterFailureStage?: "gather-supplies" | "map-route" | "recon" | "draft-implementation";
  constructor(
    private failingStage?: "gather-supplies" | "map-route" | "recon" | "draft-implementation",
    private planningVerdict?: "amendment",
    private readonly reconMaterialChange = false,
  ) {}
  failAt(stage: "gather-supplies" | "map-route" | "recon" | "draft-implementation"): void { this.failingStage = stage; }
  failAdapterAt(stage: "gather-supplies" | "map-route" | "recon" | "draft-implementation"): void {
    this.failingStage = undefined;
    this.adapterFailureStage = stage;
  }
  recommendRecon(recommendation: "proceed" | "stop"): void { this.reconRecommendation = recommendation; }
  executableAvailable(): boolean { return true; }
  async verify(): Promise<boolean> { return true; }
  async run(invocation: ProcessInvocation): Promise<ProcessResult> {
    this.calls.push(invocation);
    const planDirectory = /Validated plan directory: "([^"]+)"/.exec(invocation.stdin)?.[1] ?? "docs/plans/checkpoint";
    const stage = invocation.stdin.includes("Stage: execute-explorer")
      ? "execute-explorer"
      : invocation.stdin.includes("Stage: map-route")
        ? "map-route"
        : invocation.stdin.includes("Stage: recon")
          ? "recon"
        : invocation.stdin.includes("Stage: draft-implementation")
          ? "draft-implementation"
          : "gather-supplies";
    if (invocation.stdin.includes("Stage boundary: Read and inspect only.")) {
      return { exitCode: 0, events: [{ type: "item.completed", data: { content: 'BEARING_RESULT {"kind":"questions","questions":[]}' } }], usage: { tokens: 1 } };
    }
    if (stage === this.adapterFailureStage) {
      return { exitCode: 1, events: [], usage: { tokens: 1 } };
    }
    if (stage === this.failingStage) {
      const content = `BEARING_RESULT {"kind":"action","summary":"Invalid artifact.","artifacts":["${planDirectory}/missing.md"]}`;
      return { exitCode: 0, events: [{ type: "item.completed", data: { content } }], usage: { tokens: 1 } };
    }
    await mkdir(join(invocation.cwd, planDirectory), { recursive: true });
    if (stage === "gather-supplies") await writeFile(join(invocation.cwd, planDirectory, "plan-spec.md"), planFixture);
    if (stage === "map-route") await Promise.all([
      writeFile(join(invocation.cwd, planDirectory, "design.md"), designFixture),
      writeFile(
        join(invocation.cwd, planDirectory, "seit.md"),
        this.planningVerdict === "amendment"
          ? seitFixture.replace("invalid output fails closed", "valid output passes")
          : seitFixture,
      ),
    ]);
    if (stage === "recon") {
      await mkdir(join(invocation.cwd, "tmp"), { recursive: true });
      await writeFile(join(invocation.cwd, "tmp/recon.json"), "{}\n");
    }
    if (stage === "draft-implementation") await writeFile(join(invocation.cwd, planDirectory, "implementation.md"), implementationFixture);
    if (stage === "execute-explorer") {
      const reviewPath = join(invocation.cwd, planDirectory, "review.html");
      const review = await readFile(reviewPath, "utf8");
      await mkdir(join(invocation.cwd, "src"), { recursive: true });
      await Promise.all([
        writeFile(join(invocation.cwd, "src/work.ts"), "export const complete = true;\n"),
        writeFile(
          reviewPath,
          review.replace(
            '<section id="bearing-final-qa" data-status="pending"><h2>Actual implementation and QA</h2><p>Pending implementation and validation.</p></section>',
            '<section id="bearing-final-qa" data-status="complete"><h2>Actual implementation and QA</h2><p>Planned versus actual: src/work.ts changed exactly as planned.</p><p>Validation evidence: CMD-UNIT passed.</p></section>',
          ),
        ),
      ]);
      const content = `BEARING_RESULT ${JSON.stringify({ kind: "action", summary: "Execution complete.", artifacts: ["src/work.ts", `${planDirectory}/review.html`], evidence: [{ commandId: "CMD-UNIT", status: "passed", summary: "focused tests passed" }] })}`;
      return { exitCode: 0, events: [{ type: "item.completed", data: { content } }], usage: { tokens: 1 } };
    }
    const content = stage === "map-route"
      ? `BEARING_RESULT {"kind":"action","summary":"Route mapped.","artifacts":["${planDirectory}/design.md","${planDirectory}/seit.md"]}`
      : stage === "recon"
        ? `BEARING_RESULT ${JSON.stringify({ kind: "recon", summary: "Recon completed.", artifacts: ["tmp/recon.json"], brief: reconBrief, report: { ...reconReport, recommendation: this.reconRecommendation, ...(this.reconMaterialChange ? { materialChange: { ...reconReport.materialChange, architecture: true } } : {}) } })}`
      : stage === "draft-implementation"
        ? `BEARING_RESULT {"kind":"action","summary":"Implementation drafted.","artifacts":["${planDirectory}/implementation.md"]}`
        : `BEARING_RESULT {"kind":"action","summary":"Requirements ready.","artifacts":["${planDirectory}/plan-spec.md"]}`;
    return { exitCode: 0, events: [{ type: "item.completed", data: { content } }], usage: { tokens: 1 } };
  }
}

class MissingResultRunner implements ProcessRunner {
  readonly calls: ProcessInvocation[] = [];
  executableAvailable(): boolean { return true; }
  async verify(): Promise<boolean> { return true; }
  async run(invocation: ProcessInvocation): Promise<ProcessResult> {
    this.calls.push(invocation);
    invocation.onActivity?.({ sequence: 1, kind: "tool.completed", status: "token=unscrubbed-value", tool: "shell" });
    return { exitCode: 0, events: [], usage: { tokens: 1 } };
  }
}

class UnavailableSessionRunner implements ProcessRunner {
  readonly calls: ProcessInvocation[] = [];
  private readonly deadSession = "019f8d4e-a637-7e71-8c76-af9d7ec91adf";
  executableAvailable(): boolean { return true; }
  async verify(): Promise<boolean> { return true; }
  async run(invocation: ProcessInvocation): Promise<ProcessResult> {
    this.calls.push(invocation);
    if (this.calls.length === 1) {
      return {
        exitCode: 0,
        events: [{ type: "item.completed", data: { content: 'BEARING_RESULT {"kind":"questions","questions":["Continue?"]}' } }],
        usage: { tokens: 1 },
        providerSessionId: this.deadSession,
      };
    }
    return {
      exitCode: 1,
      error: { stderr: `Session not found for thread_id: ${this.deadSession}` },
    };
  }
}

class FocusAmendmentRunner extends CheckpointRunner {
  executionCalls = 0;
  override async run(invocation: ProcessInvocation): Promise<ProcessResult> {
    if (!invocation.stdin.includes("Stage: execute-explorer")) return super.run(invocation);
    this.calls.push(invocation);
    this.executionCalls += 1;
    if (this.executionCalls === 1) {
      const planDirectory = /Validated plan directory: "([^"]+)"/.exec(invocation.stdin)?.[1];
      if (!planDirectory) throw new Error("plan directory missing");
      const implementation = join(invocation.cwd, planDirectory, "implementation.md");
      await writeFile(implementation, `${await readFile(implementation, "utf8")}\n`);
      return { exitCode: 0, events: [], usage: { tokens: 1 } };
    }
    const planDirectory = /Validated plan directory: "([^"]+)"/.exec(invocation.stdin)?.[1];
    if (!planDirectory) throw new Error("plan directory missing");
    const reviewPath = join(invocation.cwd, planDirectory, "review.html");
    const review = await readFile(reviewPath, "utf8");
    await mkdir(join(invocation.cwd, "src"), { recursive: true });
    await Promise.all([
      writeFile(join(invocation.cwd, "src/work.ts"), "export const complete = true;\n"),
      writeFile(
        reviewPath,
        review.replace(
          '<section id="bearing-final-qa" data-status="pending"><h2>Actual implementation and QA</h2><p>Pending implementation and validation.</p></section>',
          '<section id="bearing-final-qa" data-status="complete"><h2>Actual implementation and QA</h2><p>Planned versus actual: src/work.ts changed exactly as planned.</p><p>Validation evidence: CMD-UNIT passed.</p></section>',
        ),
      ),
    ]);
    const content = `BEARING_RESULT ${JSON.stringify({ kind: "action", summary: "Execution complete.", artifacts: ["src/work.ts", `${planDirectory}/review.html`], evidence: [{ commandId: "CMD-UNIT", status: "passed", summary: "focused tests passed" }] })}`;
    return { exitCode: 0, events: [{ type: "item.completed", data: { content } }], usage: { tokens: 1 } };
  }
}

describe("LocalSessionService unit", () => {
  it("terminates every async run GET dispatch with a 500 rejection handler", async () => {
    const source = await readFile(join(process.cwd(), "src/server/local-session.ts"), "utf8");
    for (const dispatch of [
      "void handleExecutionContractGet(req, res, service, selected, executionContract[1], executionContract[2]).catch(() => writeRejection(res, 500));",
      "void handlePlanningStateGet(req, res, service, selected, planningState[1]).catch(() => writeRejection(res, 500));",
      "void handleJourneyArtifactGet(res, service, req, selected, journeyArtifact[1], journeyArtifact[2]).catch(() => writeRejection(res, 500));",
    ]) {
      expect(source).toContain(dispatch);
    }
  });

  it("keeps the existing GET and POST route-dispatch counts", async () => {
    const source = await readFile(join(process.cwd(), "src/server/local-session.ts"), "utf8");
    expect(source.match(/method === "GET"/g)).toHaveLength(23);
    expect(source.match(/method === "POST"/g)).toHaveLength(9);
  });

  it("rotates stable owner greetings by local date, time, and weekend", () => {
    const at = (year: number, month: number, date: number, hour: number) => new Date(year, month, date, hour);
    const mondayMorning = at(2026, 6, 20, 9);
    expect(greetingFor("Smokie", mondayMorning)).toBe(greetingFor("Smokie", mondayMorning));
    expect(greetingFor("Smokie", mondayMorning)).toContain("Smokie");
    expect(greetingFor("Smokie", at(2026, 6, 20, 13))).toMatch(/afternoon|Afternoon|Welcome back/);
    expect(greetingFor("Smokie", at(2026, 6, 20, 19))).toMatch(/evening|Evening/);
    expect(greetingFor("Smokie", at(2026, 6, 20, 23))).toMatch(/midnight oil|Late-night|exploring|trail is quiet|Night-owl/);
    expect(greetingFor("Smokie", at(2026, 6, 25, 9))).toContain("Weekend");
    expect(greetingFor("Smokie", at(2026, 6, 26, 23))).toMatch(/weekend|Weekend/);
    const weekdayMornings = [20, 21, 22, 23, 24, 27, 28, 29, 30, 31].map((date) => greetingFor("Smokie", at(2026, 6, date, 9)));
    expect(new Set(weekdayMornings).size).toBeGreaterThanOrEqual(3);
  });

  it("provides a time-aware unnamed greeting before repository selection", () => {
    expect(unnamedGreetingFor(new Date(2026, 6, 20, 9))).toBe("Good morning. What are we working on today?");
    expect(unnamedGreetingFor(new Date(2026, 6, 20, 13))).toBe("Good afternoon. What are we building today?");
    expect(unnamedGreetingFor(new Date(2026, 6, 20, 23))).toBe("Burning the midnight oil? What's on your mind to build?");
    expect(unnamedGreetingFor(new Date(2026, 6, 25, 19))).toContain("Weekend warrior");
  });

  it("issues a distinct high-entropy capability and validates Host/Origin", () => {
    const a = new LocalSessionService("127.0.0.1:5000");
    const b = new LocalSessionService("127.0.0.1:5000");
    expect(a.capability).toMatch(/^[0-9a-f]{64}$/);
    expect(a.capability).not.toBe(b.capability);
    expect(a.validHost("127.0.0.1:5000")).toBe(true);
    expect(a.validHost("127.0.0.1:5001")).toBe(false);
    expect(a.validHost(undefined)).toBe(false);
    expect(a.validOrigin("http://127.0.0.1:5000")).toBe(true);
    expect(a.validOrigin(undefined)).toBe(false);
    expect(a.validOrigin("https://127.0.0.1:5000")).toBe(false);
    expect(a.validOrigin("http://localhost:5000")).toBe(false);
    expect(a.validOrigin("http://127.0.0.1:5000/evil")).toBe(false);
    expect(a.validOrigin("null")).toBe(false);
  });

  it("exchanges the capability exactly once and is replay-safe on failure", () => {
    const s = new LocalSessionService("127.0.0.1:5000");
    const first = s.exchange(s.capability);
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.cookieValue).toMatch(/^[0-9a-f]{64}$/);
    // replay of the correct capability fails
    expect(s.exchange(s.capability).ok).toBe(false);
    // a wrong capability does not consume a fresh capability
    const s2 = new LocalSessionService("127.0.0.1:5000");
    expect(s2.exchange("0".repeat(64)).ok).toBe(false);
    expect(s2.exchange(s2.capability).ok).toBe(true);
  });

  it("authenticates only the issued session cookie, constant-time", () => {
    const s = new LocalSessionService("127.0.0.1:5000");
    expect(s.authenticate(undefined)).toBe(false);
    const r = s.exchange(s.capability);
    if (!r.ok) throw new Error("exchange failed");
    expect(s.authenticate(r.cookieValue)).toBe(true);
    expect(s.authenticate("0".repeat(64))).toBe(false);
    expect(s.authenticate(undefined)).toBe(false);
    // before any exchange a fresh service rejects every cookie
    expect(new LocalSessionService("127.0.0.1:5000").authenticate("0".repeat(64))).toBe(false);
  });

  it("parses the named session cookie without exposing unrelated cookies", () => {
    expect(readCookie(undefined, SESSION_COOKIE_NAME)).toBeUndefined();
    expect(readCookie("a=1; bearing_session=abc=123; b=2", SESSION_COOKIE_NAME)).toBe(
      "abc=123",
    );
    expect(
      readCookie("bearing_session=abc; bearing_session=def", SESSION_COOKIE_NAME),
    ).toBeUndefined();
    expect(readCookie("bearing_session=abc=123; other=x=y", SESSION_COOKIE_NAME)).toBe(
      "abc=123",
    );
    expect(readCookie("a=1; b=2", SESSION_COOKIE_NAME)).toBeUndefined();
  });
});

describe("GET /api/v1/improvement/report", () => {
  const path = "/api/v1/improvement/report";

  it("adapts only honestly available outcome fields into the five metrics", () => {
    const runRef = "a".repeat(64);
    const recordedAt = "2026-07-26T12:00:00.000Z";
    const records: readonly OutcomeRecord[] = [
      { schemaVersion: 1, runRef, sliceRef: "slice-a", recordedAt, signal: "reasoning_effectiveness", code: "complete", attempt: 1 },
      { schemaVersion: 1, runRef, sliceRef: "slice-b", recordedAt, signal: "reasoning_effectiveness", code: "failed", attempt: 1 },
      { schemaVersion: 1, runRef, sliceRef: "slice-a", recordedAt, signal: "grader_score", code: "strong" },
      { schemaVersion: 1, runRef, sliceRef: "slice-b", recordedAt, signal: "grader_score", code: "weak" },
      { schemaVersion: 1, runRef, sliceRef: "slice-a", recordedAt, signal: "park_ranger_finding", code: "P1" },
      { schemaVersion: 1, runRef, sliceRef: "slice-b", recordedAt, signal: "park_ranger_finding", code: "P2" },
      { schemaVersion: 1, runRef, recordedAt, signal: "coordination", code: "expedition", value: 4 },
    ];

    const metrics = measureImprovementWindow({ generatedAt: recordedAt, settledRuns: 1, records });

    expect(metrics.firstPassSuccess).toMatchObject({ sufficient: true, numerator: 1, denominator: 2, value: 0.5 });
    expect(metrics.gradingAccuracy).toMatchObject({
      sufficient: true,
      numerator: 1,
      denominator: 2,
      value: 0.5,
      confusion: { truePositive: 1, trueNegative: 0, falsePositive: 0, falseNegative: 1 },
    });
    for (const metric of [
      metrics.coordinationOverhead,
      metrics.escapedDefects,
      metrics.costPerAcceptedCriterion,
    ]) expect(metric).toMatchObject({ sufficient: false, numerator: 0, denominator: 0, value: null });
  });

  it("requires authentication, Host, Origin, and a selected repository", async () => {
    const { port, cap } = await launchHandler();
    const unauthenticated = await call(port, { method: "GET", path });
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.body).not.toContain(cap);

    const cookie = await exchangeCookie(port, cap);
    const noRepository = await call(port, { method: "GET", path, headers: { cookie } });
    expect(noRepository.status).toBe(409);
    expect(JSON.parse(noRepository.body)).toEqual({
      status: "blocked",
      code: "repository_not_selected",
      remedy: expect.any(String),
    });
    expect((await call(port, { method: "GET", path, headers: { host: "evil.example", cookie } })).status).toBe(421);
    expect((await call(port, { method: "GET", path, headers: { origin: "https://evil.example", cookie } })).status).toBe(403);
  });

  it("returns the selected repository improvement report as JSON", async () => {
    const expectedReport = Object.freeze({
      schemaVersion: 1 as const,
      generatedAt: "2026-07-26T12:00:00.000Z",
      listedRuns: 0,
      readableRuns: 0,
      settledRuns: 0,
      unreadableRuns: 0,
      recordsHeld: 0,
      recordsTruncated: false,
      records: Object.freeze([]),
      thresholds: Object.freeze({ minSettledRuns: 20 }),
      metrics: Object.freeze([]),
      recommendation: Object.freeze({ status: "insufficient_evidence", recommendations: Object.freeze([]) }),
    });
    const improvementReport = vi.fn(async () => ({ ok: true as const, value: expectedReport }));
    const { port, cap } = await launchHandler(new RepositoryBootstrap(), { improvementReport });
    const cookie = await exchangeCookie(port, cap);
    const root = await tempRepo();
    await selectRepository(port, cookie, root);

    const response = await call(port, { method: "GET", path, headers: { cookie } });

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(JSON.parse(response.body)).toEqual(expectedReport);
    expect(improvementReport).toHaveBeenCalledOnce();
    expect(improvementReport).toHaveBeenCalledWith(expect.objectContaining({ repositoryPath: root }));
    expect(response.body).not.toContain(cap);
    expect(response.body).not.toContain(cookie.split("=")[1]);
    expect(response.body).not.toContain(root);
  });

  it("uses the selected live store by default, reports an empty workspace, and fails typed on unreadable runs", async () => {
    const root = await tempRepo();
    const { port, cap } = await launchHandler();
    const cookie = await exchangeCookie(port, cap);
    await selectRepository(port, cookie, root);
    const store = await seedRun(root, "real-improvement-run", "docs/plans/improvement");
    const durable = await store.load("real-improvement-run");
    const completed = await store.apply({
      schemaVersion: 1,
      commandId: "real-improvement-run-complete",
      runId: "real-improvement-run",
      expectedRevision: durable.revision,
      type: "recordJourneyCheckpoint",
      payload: { stage: "review", status: "complete", artifacts: [] },
      session: { sessionId: "test-bearing", actor: "bearing" },
      correlationId: "real-improvement-run-complete",
    });
    if (!completed.ok) throw new Error(completed.reason);

    const response = await call(port, { method: "GET", path, headers: { cookie } });
    expect(response.status).toBe(200);
    const body = JSON.parse(response.body);
    expect(body).toMatchObject({ listedRuns: 1, readableRuns: 1, settledRuns: 1, unreadableRuns: 0 });
    expect(body.metrics).toMatchObject({
      coordinationOverhead: { sufficient: false, value: null },
      firstPassSuccess: { sufficient: false, value: null },
      gradingAccuracy: { sufficient: false, value: null },
      escapedDefects: { sufficient: false, value: null },
      costPerAcceptedCriterion: { sufficient: false, value: null },
    });

    const direct = await buildImprovementReport(store);
    expect(direct.ok).toBe(true);

    const emptyRoot = await tempRepo();
    const emptyStore = new BearingStore(emptyRoot);
    // An empty workspace reports an empty evidence position; only runs that exist and cannot be
    // read are a store failure. The corrupt case below still fails, which is what separates them.
    await expect(buildImprovementReport(emptyStore)).resolves.toMatchObject({
      ok: true,
      value: { listedRuns: 0, readableRuns: 0, settledRuns: 0 },
    });

    const corruptRoot = await tempRepo();
    await seedRun(corruptRoot, "unreadable-improvement-run", "docs/plans/improvement");
    await writeFile(join(corruptRoot, ".bearing/runs/unreadable-improvement-run/events.jsonl"), "not-json\n", "utf8");
    await expect(buildImprovementReport(new BearingStore(corruptRoot))).resolves.toEqual({ ok: false, reason: "store_read_failed" });
  });

  it("returns truthy typed service failures and exposes no mutating counterpart", async () => {
    const improvementReport = vi.fn(async () => ({ ok: false as const, reason: "stage_failed" as const }));
    const { port, cap } = await launchHandler(new RepositoryBootstrap(), { improvementReport });
    const cookie = await exchangeCookie(port, cap);
    const root = await tempRepo();
    await selectRepository(port, cookie, root);
    const before = await treeSnapshot(root);

    const failure = await call(port, { method: "GET", path, headers: { cookie } });
    expect(failure.status).toBe(503);
    expect(JSON.parse(failure.body)).toEqual({
      status: "blocked",
      code: "stage_failed",
      remedy: expect.any(String),
    });

    for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
      const response = await call(port, { method, path, headers: { cookie } });
      expect(response.status).toBe(404);
    }
    expect(improvementReport).toHaveBeenCalledOnce();
    expect(await treeSnapshot(root)).toEqual(before);
  });

  it("refuses a prototype-carried report provider", async () => {
    const inheritedReport = vi.fn(async () => ({ ok: true as const, value: { schemaVersion: 1 } }));
    const inheritedOptions = Object.create({ improvementReport: inheritedReport }) as Parameters<typeof createRequestHandler>[2];
    const { port, cap } = await launchHandler(new RepositoryBootstrap(), inheritedOptions);
    const cookie = await exchangeCookie(port, cap);
    const root = await tempRepo();
    await selectRepository(port, cookie, root);

    const response = await call(port, { method: "GET", path, headers: { cookie } });

    expect(response.status).toBe(503);
    expect(JSON.parse(response.body)).toEqual({
      status: "blocked",
      code: "configuration_invalid",
      remedy: expect.any(String),
    });
    expect(inheritedReport).not.toHaveBeenCalled();
  });
});

describe("GET /api/v1/improvement/handoff", () => {
  const path = "/api/v1/improvement/handoff";

  it("counts a verified stage as complete even though only review ever persists complete", async () => {
    // The journey handler persists `complete` only for the review stage; every other successful
    // stage persists `waiting`. A verified stage must therefore not be reported as in flight.
    const root = await tempRepo();
    const store = await seedRun(root, "waiting-run", "docs/plans/waiting");
    const durable = await store.load("waiting-run");
    const applied = await store.apply({
      schemaVersion: 1,
      commandId: "waiting-verified",
      runId: "waiting-run",
      expectedRevision: durable.revision,
      type: "recordJourneyCheckpoint",
      payload: {
        stage: "map-route",
        status: "waiting",
        artifacts: [],
        verification: { layer: "validator", verdict: "PASS" },
        runtimeStateJson: serializeRuntimeState({
          version: 1,
          trace: [],
          retry: [],
          sessionContinuity: "lost",
        }),
      },
      session: { sessionId: "test-bearing", actor: "bearing" },
      correlationId: "waiting-verified",
    });
    if (!applied.ok) throw new Error(applied.reason);

    const built = await buildImprovementHandoffFacts(store);
    expect(built).toMatchObject({
      ok: true,
      value: { verifiedCompleteStages: ["map-route"], itemInFlight: null },
    });
  });

  it("renders the same read-only bounded handoff through the CLI and panel route", async () => {
    const root = await tempRepo();
    const { port, cap } = await launchHandler();
    const unauthenticated = await call(port, { method: "GET", path });
    expect(unauthenticated.status).toBe(401);
    expect(JSON.parse(unauthenticated.body)).toMatchObject({ status: "blocked", code: "authentication_required" });
    const cookie = await exchangeCookie(port, cap);
    const noRepository = await call(port, { method: "GET", path, headers: { cookie } });
    expect(JSON.parse(noRepository.body)).toMatchObject({ status: "blocked", code: "repository_not_selected" });
    await selectRepository(port, cookie, root);

    const store = await seedRun(root, "handoff-run", "docs/plans/handoff");
    let durable = await store.load("handoff-run");
    const verified = await store.apply({
      schemaVersion: 1,
      commandId: "handoff-verified",
      runId: "handoff-run",
      expectedRevision: durable.revision,
      type: "recordJourneyCheckpoint",
      payload: {
        stage: "map-route",
        status: "complete",
        artifacts: [],
        planDirectory: "docs/plans/handoff",
        verification: { layer: "validator", verdict: "PASS" },
      },
      session: { sessionId: "test-bearing", actor: "bearing" },
      correlationId: "handoff-verified",
    });
    if (!verified.ok) throw new Error(verified.reason);
    durable = await store.load("handoff-run");
    const inFlight = await store.apply({
      schemaVersion: 1,
      commandId: "handoff-in-flight",
      runId: "handoff-run",
      expectedRevision: durable.revision,
      type: "recordJourneyCheckpoint",
      payload: {
        stage: "execute-explorer",
        status: "running",
        artifacts: [],
        resolvedPlanDirectory: "docs/plans/handoff\u0007",
        runtimeStateJson: serializeRuntimeState({
          version: 1,
          trace: [],
          retry: [],
          sessionContinuity: "lost",
        }),
      },
      session: { sessionId: "test-bearing", actor: "bearing" },
      correlationId: "handoff-in-flight",
    });
    if (!inFlight.ok) throw new Error(inFlight.reason);

    const built = await buildImprovementHandoffFacts(store);
    expect(built).toMatchObject({
      ok: true,
      value: {
        runId: "handoff-run",
        planDirectory: "docs/plans/handoff\u0007",
        verifiedCompleteStages: ["map-route"],
        agentReportedCompleteStages: ["gather-supplies"],
        itemInFlight: "execute-explorer",
        nextAction: "open-fresh-session",
        degradation: { ok: true, reasons: ["continuity_lost"] },
      },
    });

    const cliOut: string[] = [];
    let cliExit: number | undefined;
    await run(["improve", "handoff"], {
      cwd: root,
      stdout: { write: (text) => { cliOut.push(text); return true; } },
      stderr: { write: () => true },
      exit: (code) => { cliExit = code; },
    });
    expect(cliExit).toBeUndefined();

    const badOrigin = await call(port, { method: "GET", path, headers: { cookie, origin: "https://evil.example" } });
    expect(JSON.parse(badOrigin.body)).toMatchObject({ status: "blocked", code: "origin_rejected" });

    const response = await call(port, { method: "GET", path, headers: { cookie } });
    expect(response.status).toBe(200);
    const routeText = JSON.parse(response.body).text;
    expect(cliOut.join("")).toBe(routeText);
    expect(routeText).toContain("Verified complete stages: map-route");
    expect(routeText).toContain("Re-derive before trusting agent-reported complete stages: gather-supplies");
    expect(routeText).not.toContain("Verified complete stages: map-route, gather-supplies");
    expect(routeText).not.toContain("\u0007");
    for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
      expect((await call(port, { method, path, headers: { cookie } })).status).toBe(404);
    }

    const noSignalRoot = await tempRepo();
    await seedRun(noSignalRoot, "healthy-run", "docs/plans/healthy");
    const healthyOut: string[] = [];
    await run(["improve", "handoff"], {
      cwd: noSignalRoot,
      stdout: { write: (text) => { healthyOut.push(text); return true; } },
      stderr: { write: () => true },
      exit: () => { throw new Error("healthy handoff failed"); },
    });
    expect(healthyOut.join("")).toBe("No degradation signal is recorded.\n");
    expect(healthyOut.join("")).not.toContain("Copy-paste handoff prompt");

    const source = await readFile(join(process.cwd(), "src/server/local-session.ts"), "utf8");
    expect(source).toContain('id="improvement-handoff-text"');
    expect(source).toContain('handoffText.textContent = body.text;');
    expect(source).not.toContain("handoffText.innerHTML");
  });
});

describe("repository busy lease", () => {
  it("holds an expiring repository lease exactly while a journey run is busy", async () => {
    let started!: () => void;
    let release!: () => void;
    const runnerStarted = new Promise<void>((resolve) => { started = resolve; });
    const runnerReleased = new Promise<void>((resolve) => { release = resolve; });
    class BlockingRunner extends CheckpointRunner {
      override async run(invocation: ProcessInvocation): Promise<ProcessResult> {
        started();
        await runnerReleased;
        return super.run(invocation);
      }
    }
    const root = await tempRepo();
    const runId = "busy-lease-run";
    const { port, cookie } = await readyJourneyHandler(root, new BlockingRunner());
    await seedRun(root, runId);

    expect((await call(port, {
      method: "POST",
      path: "/api/v1/journey",
      headers: sessionHeaders(port, { cookie }),
      body: JSON.stringify({ runId, stage: "set-bearings", workGoal: "Complete the approved work" }),
    })).status).toBe(200);
    const pending = call(port, {
      method: "POST",
      path: "/api/v1/journey",
      headers: sessionHeaders(port, { cookie }),
      body: JSON.stringify({ runId, stage: "gather-supplies", workGoal: "Complete the approved work" }),
    });
    const first = await Promise.race([
      runnerStarted.then(() => ({ started: true as const })),
      pending.then((response) => ({ response })),
    ]);
    if ("response" in first) {
      release();
      throw new Error(`journey ended before the runner started: ${first.response.status} ${first.response.body}`);
    }

    const leasePath = join(root, ".bearing", "busy-lease.json");
    try {
      const lease = JSON.parse(await readFile(leasePath, "utf8")) as Record<string, unknown>;
      expect(lease).toEqual({
        schemaVersion: 1,
        runIds: [runId],
        expiresAt: expect.any(String),
      });
      expect(Date.parse(String(lease.expiresAt))).toBeGreaterThan(Date.now());
      expect(Date.parse(String(lease.expiresAt)) - Date.now()).toBeLessThanOrEqual(30_000);
    } finally {
      release();
    }
    expect((await pending).status).toBe(200);
    await expect(readFile(leasePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("GET / native page and fragment secrecy", () => {
  it("serves the native page and never embeds the capability server-side", async () => {
    const { port, cap } = await launch();
    const r = await call(port, { method: "GET", path: "/" });
    expect(r.status).toBe(200);
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
    expect(r.body).toContain("<title>Bearing</title>");
    expect(r.body).toContain('<link rel="icon" href="data:,">');
    expect(r.body).toContain("history.replaceState");
    expect(r.body).toContain('id="repository-panel" hidden');
    expect(r.body).toContain('id="current-repository" type="button" disabled');
    expect(r.body).toContain('id="browse-repository" type="button" disabled');
    expect(r.body).toContain("/api/v1/repository-options");
    expect(r.body).toContain("var browseAvailable = false");
    expect(r.body).toContain("function restoreRepositoryControls()");
    expect(r.body).toContain("browseRepository.disabled = !browseAvailable");
    expect(r.body).not.toContain('id="provider"');
    expect(r.body).not.toContain('id="model"');
    expect(r.body).toContain('<label for="owner-name">What should we call you?</label><input id="owner-name" type="text" required autocomplete="name" maxlength="80">');
    expect(r.body).toContain('id="route-options"');
    expect(r.body).toContain("document.createElement(\"input\")");
    expect(r.body).toContain('input.type = "radio"');
    expect(r.body).toContain('input.name = "route"');
    expect(r.body).toContain("input.disabled = !route.detected");
    expect(r.body).toContain("input.required = true");
    expect(r.body).toContain('input.addEventListener("change"');
    expect(r.body).toContain("configureRoute(route)");
    expect(r.body).not.toContain("input.checked = true");
    expect(r.body).toContain('Codex CLI');
    expect(r.body).toContain('Claude Code');
    expect(r.body).toContain('Agy');
    expect(r.body).toContain('Grok Build');
    expect(r.body).toContain('OpenCode');
    expect(r.body).toContain('"pi": "Pi"');
    expect(r.body).toContain('statusText.textContent = route.detected ? "Agent detected" : "Agent unavailable"');
    expect(r.body).toContain("routeForm.reportValidity()");
    expect(r.body).toContain("provider: selectedRoute.provider, model: selectedRoute.model");
    expect(r.body).toContain('JSON.stringify({ provider: selectedRoute.provider, model: selectedRoute.model, reasoning: selectedRoute.reasoning })');
    expect(r.body).toContain('var name = ownerName.value.trim()');
    expect(r.body).toContain('document.getElementById("owner-name").addEventListener("input", function () { this.setCustomValidity(""); })');
    expect(r.body).toContain('fetch("/api/v1/owner"');
    expect(r.body).toContain('function revealWork(greeting) { onboardingReady = true;');
    expect(r.body).toContain('revealWork(body.greeting)');
    expect(r.body).toContain('Your name could not be remembered. Try again.');
    expect(r.body).not.toContain('Ready, " + name + ". Your name could not be remembered.');
    expect(r.body).toContain('rememberedGreeting');
    expect(r.body).not.toContain("localStorage");
    expect(r.body).not.toContain("innerHTML");
    expect(r.body).toContain("Repository request failed. Try again.");
    expect(r.body).not.toContain('id="repository-path" name=');
    expect(r.body).not.toContain('for="repository-path"');
    expect(r.body).toContain('alt="A bear in sunglasses working at a tidy office desk."');
    expect(r.body).toContain('src="/assets/bearing-office.png"');
    expect(r.body.match(/src="\/assets\/bearing-title-mark\.png"/g)).toHaveLength(2);
    expect(r.body).toContain('<img class="title-mark" src="/assets/bearing-title-mark.png" alt="">');
    expect(r.body).not.toContain('class="brand-mark"');
    expect(r.body).toContain('class="signature-link" href="https://github.com/alphazede/bearing" target="_blank" rel="noopener noreferrer" aria-label="Open Bearing GitHub repository"');
    expect(r.body).toContain("<figcaption>GitHub repo \u2197</figcaption>");
    expect(r.body).toContain('<nav class="nav-state" aria-label="Runtime status"><a class="repo-switch" href="https://github.com/alphazede/bearing"');
    expect(r.body).not.toContain("github.com/alphazede/developers");
    expect(r.body).toContain("#repository-panel .signature-link{display:block;min-height:84px");
    expect(r.body).toContain('url("/assets/bearing-expedition.png")');
    expect(r.body).not.toContain('<img src="/assets/bearing-expedition.png"');
    expect(r.body).toContain("#repository-panel{max-width:780px;background:var(--s1)}");
    expect(r.body).toContain("#repository-panel .panel-head{padding:11px 16px}");
    expect(r.body).toContain("#repository-panel .repo-card{min-height:84px;padding:12px}");
    expect(r.body).toContain("#repository-panel .signature img{height:58px}");
    expect(r.body).toContain("background:rgba(15,16,17,.78)");
    expect(r.body).toContain("backdrop-filter:blur(8px)");
    expect(r.body).toContain("#repository-panel .repo-grid,.route-options,.route-details{grid-template-columns:1fr}");
    expect(r.body).toContain("#repository-panel .signature-link{display:none}");
    expect(r.body).toContain("--canvas:#010102");
    expect(r.body).toContain("html{zoom:1.2}.token-banner{");
    expect(r.body).toContain(".panel,#repository-panel{background:rgba(15,16,17,.35)");
    expect(r.body).toContain("padding:0 clamp(24px,4vw,72px)");
    expect(r.body).toContain("main{max-width:1180px;margin:0;padding:42px clamp(24px,4vw,72px) 72px}");
    expect(r.body).not.toContain("calc((100vw - 1180px)/2)");
    expect(r.body).toContain("@media(max-width:760px){header{padding:0 16px}");
    expect(r.body).toContain("main{padding:28px 16px 56px}");
    expect(r.body).toContain("/api/v1/repository");
    expect(r.body).toContain("/api/v1/routes");
    expect(r.body).toContain('"/api/v1/routes/" + encodeURIComponent(route.id) + "/models"');
    expect(r.body).toContain("Loading model choices for ");
    expect(r.body).toContain('id="detected-routes"');
    expect(r.body).toContain('Choose a discovered model and a reasoning level');
    expect(r.body).toContain('id="model-choice"');
    expect(r.body).toContain('id="reasoning-choice"');
    expect(r.body).toContain('var reasoningTiers = ["minimal", "low", "medium", "high", "very-high", "max"]');
    expect(r.body).toContain("reasoningTiers.forEach");
    expect(r.body).toContain('Bearing runs locally and requires no Bearing account. Selected agent CLIs may use external providers under their own accounts, credentials, and data policies.');
    expect(r.body).toContain("detectedRoutes.textContent");
    expect(r.body).toContain('<span class="step">AGENT SETTINGS</span>');
    expect(r.body).toContain('<button class="primary" id="launch-bearing" disabled>Apply settings</button>');
    expect(r.body).toContain('setStatus("Launching Bearing with "');
    expect(r.body).toContain('id="work-form"><div class="chat-heading"');
    expect(r.body).toMatch(/<h2 id="work-greeting">(Good morning|Good afternoon|Good evening|Burning the midnight oil)/);
    expect(r.body).not.toContain("Where should we start?");
    expect(r.body).toContain('id="work-back" type="button" aria-haspopup="dialog"><small>Agent</small>');
    expect(r.body).toContain('class="primary">Embark</button>');
    expect(r.body).toContain('id="app-shell"');
    expect(r.body).toContain('class="journey-rail" aria-label="Journey navigation"');
    expect(r.body).toContain('id="rail-history-list"');
    expect(r.body).toContain('id="workspace-chip"');
    expect(r.body).toContain('id="model-chip"');
    expect(r.body).toContain('id="reasoning-chip"');
    expect(r.body).toContain('data-starter="Add a feature to this codebase."');
    expect(r.body).toContain('.journey-rail{position:sticky');
    expect(r.body).toContain('background:rgba(8,9,10,.35)');
    expect(r.body).toContain('function renderRailHistory(entries)');
    expect(r.body).toContain('function syncShellSummary()');
    expect(r.body).toContain('function openRouteChooser()');
    expect(r.body).toContain('function closeSetupSheets()');
    expect(r.body).toContain('class="panel journey-surface" id="planning-panel"');
    expect(r.body).toContain('class="panel journey-surface" id="plan-review-panel"');
    expect(r.body).toContain('.setup-sheet{position:fixed');
    expect(r.body).toContain('workForm.hidden = false; syncShellSummary(); loadRepositoryOptions()');
    expect(r.body).toContain("Plan for substantial token use.");
    expect(r.body).toContain("consider a higher tier and choose reasoning deliberately");
    expect(r.body).toContain('An explicit <code>--budget</code> flag is available when you want a hard per-call token ceiling.');
    expect(r.body).toContain('workBack.addEventListener("click"');
    expect(r.body).toContain('.compact-back{min-height:32px');
    expect(r.body).toContain('id="work-goal" required maxlength="4096"');
    expect(r.body).not.toContain('id="run-id"');
    expect(r.body).not.toContain('id="work-items"');
    expect(r.body).not.toContain('id="crew-limit"');
    expect(r.body).not.toContain('id="agent-tokens"');
    expect(r.body).not.toContain('id="work-title"');
    expect(r.body).not.toContain('workItems: 1, maxCrewmatesPerExplorer: 3, perAgentTokenEstimate: 4000');
    expect(r.body).toContain('id="planning-panel" hidden');
    expect(r.body).toContain("You choose Explorer or Expedition after implementation.md is ready.");
    expect(r.body).toContain('<h2>Journey</h2>');
    expect(r.body).toContain('id="journey-phase">SET BEARINGS</span>');
    expect(r.body).toContain('var currentGoal = ""; var currentStage = "repository-fit"');
    expect(r.body).toContain('"repository-fit": "Repository fit"');
    expect(r.body).toContain('"set-bearings": "Set Bearings"');
    expect(r.body).toContain('"recon": "Recon"');
    expect(r.body).toContain('id="planning-answer-form"');
    expect(r.body).toContain('endQuestions.textContent = "End questions"');
    expect(r.body).toContain('invokeJourney("gather-supplies", { answer: answer, endQuestions: true })');
    expect(r.body).toContain('currentStage !== "gather-supplies"');
    expect(r.body).not.toContain("Anything else?");
    expect(r.body).toContain('if (!endQuestions.hidden) endQuestions.disabled = false');
    expect(r.body).toContain('<label for="planning-answer">Your answer</label>');
    expect(r.body).toContain('placeholder="Type your answer here…"');
    expect(r.body).toContain('fetch("/api/v1/journey"');
    expect(r.body).toContain('postCommand(currentRunId, state, "createWorkRequest"');
    expect(r.body).toContain('postCommand(currentRunId, state, "requireDecision"');
    expect(r.body).toContain('postCommand(currentRunId, state, "recordOwnerAnswer"');
    expect(r.body).toContain('invokeJourney("repository-fit")');
    expect(r.body).toContain('currentStage === "repository-fit") invokeJourney("set-bearings")');
    expect(r.body).toContain('currentStage === "set-bearings" ? "gather-supplies" : "map-route"');
    expect(r.body).toContain('if (body.status === "action" && currentStage === "gather-supplies") invokeJourney("map-route")');
    expect(r.body).toContain('currentStage === "map-route") invokeJourney("recon")');
    expect(r.body).toContain('currentStage === "recon" && body.recon && (body.recon.state === "SKIPPED" || body.recon.state === "RECON_READY")) invokeJourney("draft-implementation")');
    expect(r.body).toContain('body.recon.state === "OWNER_DECISION_REQUIRED" || body.recon.state === "RECON_FAILED"');
    expect(r.body).toContain('body.recon.state === "RECON_FAILED" ? "recon_failed" : "owner_decision_required"');
    expect(r.body).toContain('id="journey-wait" hidden');
    expect(r.body).toContain('role="progressbar" aria-label="Agent work in progress"');
    expect(r.body).not.toContain("aria-valuenow");
    expect(r.body).toContain('id="journey-body" aria-busy="false"');
    expect(r.body).toContain('id="wait-elapsed">0s elapsed');
    expect(r.body).toContain('id="wait-activity">Last real activity: waiting for the first event.');
    expect(r.body).toContain('id="wait-range">Typical time: about 3 minutes');
    expect(r.body).toContain("Safe to leave—resume this journey from History.");
    expect(r.body).toContain("Still active; this is taking longer than usual.");
    expect(r.body).toContain('function cacheEstimate(body)');
    expect(r.body).toContain('estimate.stage === "execute"');
    expect(r.body).toContain('function waitEstimate(stage)');
    expect(r.body).toContain('stage === "execute-explorer" || stage === "execute-expedition" ? waitEstimates.execute : null');
    expect(r.body).toContain('Timing estimate will appear after agent inspection.');
    expect(r.body).toContain('Agent estimate: " + estimate.minMinutes');
    expect(r.body).toContain('if (/\\blens(?:es)?\\b/i.test(question))');
    expect(r.body).not.toContain('currentStage === "map-route" && /\\blenses?\\b/i.test(question)');
    expect(r.body).toContain('function reconcileJourney()');
    expect(r.body).toContain('var reconcileTimer = null');
    expect(r.body).toContain('clearTimeout(reconcileTimer)');
    expect(r.body).toContain('reconcileTimer = setTimeout(function ()');
    expect(r.body).toContain('currentRunId === runId && currentStage === run.stage');
    expect(r.body).toContain('then(renderJourney, reconcileJourney)');
    expect(r.body).toContain('function renderSavedExecution(body)');
    expect(r.body).toContain('The follow-on review request disconnected. Your implementation success is saved; choose Retry to start Surveyor review.');
    expect(r.body).toContain('var stage = retryStage || currentStage; retryStage = ""; var extra = focusAmendmentPending ? { focusAmendmentConfirmed: true } : undefined');
    expect(r.body).toContain('retry.textContent = focusAmendmentPending ? "Confirm amendment" : "Retry"');
    expect(r.body).toContain('run.stage === "execute-explorer" || run.stage === "execute-expedition"');
    expect(r.body).toContain('For more information about lenses, use Glossary in the bottom-left.');
    expect(r.body).toContain('per-slice model and reasoning assignments');
    expect(r.body).toContain("Bearing is creating or resuming the local plan stub and bounded repository map. Next: Gather Supplies discovers owner decisions.");
    expect(r.body).toContain("The selected agent is inspecting the repository to discover unresolved owner questions. Next: your answers become the validated plan specification.");
    expect(r.body).toContain("The selected agent is producing design.md and SEIT evidence. Next: optional Recon tests one material assumption before implementation drafting.");
    expect(r.body).toContain("The selected agent is testing one material assumption before implementation drafting.");
    expect(r.body).toContain("Explorer is executing the approved slices with the recorded review cadence.");
    expect(r.body).toContain("Expedition is coordinating approved parallel lanes and their review cadence.");
    expect(r.body).toContain("Surveyor is reviewing the integrated uncommitted diff without modifying it.");
    expect(r.body).toContain('"Last real activity: "');
    expect(r.body).toContain("renderActivityTrail(body.activityTrail)");
    expect(r.body).toContain("activity.sequence <= waitActivitySequence");
    expect(r.body).toContain("waitActivitySequence = activity.sequence");
    expect(r.body).not.toContain('recordTrail("Agent session started for "');
    expect(r.body).toContain('recordTrail("Repository snapshot: "');
    expect(r.body).toContain("@keyframes wait-trail");
    expect(r.body).toContain('name="review-cadence" value="phase" checked');
    expect(r.body).toContain("Each phase <b>(recommended)</b>");
    expect(r.body).toContain('id="cleanup-worktrees" type="checkbox" checked');
    expect(r.body).toContain("Only clean, proven-merged temporary lanes are removed.");
    expect(r.body).toContain('cleanupMergedWorktrees: document.getElementById("cleanup-worktrees").checked');
    expect(r.body).toContain('id="journey-retry" type="button" hidden>Retry');
    expect(r.body).toContain('id="recovery-report" hidden');
    expect(r.body).toContain('id="dismiss-recovery-report" type="button">Not now</button>');
    expect(r.body).toContain('https://github.com/alphazede/bearing/issues/new?title=');
    expect(r.body).toContain('https://github.com/alphazede/bearing/security/advisories/new');
    expect(r.body).toContain('window.open("https://github.com/alphazede/bearing/issues/new?title="');
    expect(r.body).toContain('document.getElementById("dismiss-recovery-report").addEventListener("click", function () { document.getElementById("recovery-report").hidden = true; });');
    expect(r.body).not.toContain('fetch("https://github.com/alphazede/bearing');
    expect(r.body).toContain('setStatus(phaseNames[stage] + " is working…", true)');
    // The browser stage maps live inside string-concatenated JS, so TypeScript
    // cannot check them. renderJourney does phaseNames[currentStage].toUpperCase(),
    // which throws on a missing key instead of failing gracefully. Assert the
    // property — every stage has an entry — rather than sampling one.
    for (const stage of RECORD_JOURNEY_CHECKPOINT_STAGES) {
      expect(r.body).toContain(`"${stage}": `);
      expect(r.body.match(new RegExp(`"${stage}": `, "g"))!.length).toBeGreaterThanOrEqual(2);
    }
    expect(r.body).toContain("This run reached its token budget before the phase completed. Retry after lowering reasoning with /model or raise the CLI budget.");
    expect(r.body).toContain("Your answers and planning files are saved. Bearing could not verify the generated implementation package.");
    expect(r.body).toContain('complete.firstElementChild.textContent = "Journey paused"');
    expect(r.body).toContain("Your questions are complete; the generated files need another validation pass.");
    expect(r.body).toContain('id="journey-action-back" type="button">← Back');
    expect(r.body).toContain('id="plan-review-panel" hidden');
    expect(r.body).toContain("Review your route");
    expect(r.body).toContain("The review HTML contains the complete planning package.");
    expect(r.body).toContain('id="request-plan-changes" type="button">Request changes');
    expect(r.body).toContain('id="approve-plan" class="primary" type="button">Approve route');
    expect(r.body).toContain("Execution can pause.");
    expect(r.body).toContain("what stopped, why, the recommended next step");
    expect(r.body).toContain("renderPlanReview(body)");
    expect(r.body).toContain('id="review-findings-panel" hidden');
    expect(r.body).toContain("finding.required");
    expect(r.body).toContain("finding.remedy");
    expect(r.body).toContain('approve.disabled = verdict !== "PASS"');
    expect(r.body).toContain('<p class="hero-help">New to Bearing?<button class="demo-link" id="view-demo" type="button">See how it works</button><button class="demo-link" id="view-glossary" type="button">Glossary</button></p>');
    expect(r.body).toContain('id="glossary-dialog"');
    expect(r.body).toContain("Contract-Driven Design defines interface behavior");
    expect(r.body).toContain("Security-Driven Design examines threats");
    expect(r.body).toContain('id="question-help" hidden');
    expect(r.body).toContain("function questionHelp(question)");
    expect(r.body).not.toContain('id="view-demo" type="button" hidden');
    expect(r.body).not.toContain("Live demo");
    expect(r.body).toContain('class="actions actions-end"><button class="primary" id="launch-bearing" disabled>Apply settings</button>');
    expect(r.body).not.toContain("Want a quick, token-free tour before you continue?");
    expect(r.body).not.toContain('id="planning-demo"');
    expect(r.body).toContain('id="demo-panel" hidden');
    expect(r.body).toContain("How Bearing works");
    expect(r.body).toContain("NO TOKENS");
    expect(r.body).toContain('id="demo-step" aria-live="polite">Step 1 of 4</span>');
    expect(r.body).toContain('<ol class="demo-progress" aria-label="Tutorial progress"><li aria-current="step">Why Bearing</li>');
    expect(r.body).toContain("Stay in control while agents do the work");
    expect(r.body).toContain("Bearing is a local control room");
    expect(r.body).not.toContain("Your work stays local");
    expect(r.body).toContain("<li><strong>Bearing runs locally:</strong> No Bearing account is required. A selected agent CLI may use an external provider under its own account, credentials, and data policy.</li>");
    expect(r.body).toContain("Before planning, it checks whether the source files are here");
    expect(r.body).toContain("Safe defaults are recorded as assumptions");
    expect(r.body).toContain("Come back to evidence, not just “done”");
    expect(r.body).toContain('currentRunId ? "Back to journey" : "Start journey"');
    expect(r.body).toContain('id="demo-explorer" type="button" aria-pressed="false"');
    expect(r.body).toContain('src="/assets/bearing-explorer-card.png"');
    expect(r.body).toContain('id="demo-expedition" type="button" aria-pressed="false"');
    expect(r.body).toContain('src="/assets/bearing-expedition-card.png"');
    expect(r.body).toContain("<b>Use when:</b>");
    expect(r.body).toContain("<b>Pros:</b>");
    expect(r.body).toContain("<b>Tradeoff:</b>");
    expect(r.body).toContain(".mode-grid{display:grid");
    expect(r.body).toContain(".panel,#repository-panel{background:rgba(15,16,17,.35)");
    expect(r.body).toContain("backdrop-filter:blur(6px)");
    expect(r.body).toContain("function chooseDemoMode(mode)");
    expect(r.body).toContain('if (demoStage === 2 && !demoMode) { chooseDemoMode("explorer")');
    expect(r.body).toContain("Explorer highlighted as the lower-token example. In a real run, you choose Explorer or Expedition.");
    expect(r.body).toContain('textContent = "Continue \\u2192"');
    expect(r.body).not.toContain('"recommendExecutionMode"');
    expect(r.body).not.toContain('"approveExecutionMode"');
    expect(r.body).not.toContain('"overrideExecutionMode"');
    expect(r.body).toContain('id="change-repository" type="button" hidden');
    expect(r.body).toContain('function toggleRepositoryChooser()');
    expect(r.body).toContain('function openWorkspacePicker() { closeSetupSheets(); chooseRepository("browse"); }');
    expect(r.body).toContain('changeRepository.addEventListener("click", openWorkspacePicker)');
    expect(r.body).toContain('document.getElementById("workspace-chip").addEventListener("click", openWorkspacePicker)');
    expect(r.body).toContain("payload.confirmNonGit = true");
    expect(r.body).toContain('code === "repository_not_git"');
    expect(r.body).toContain('function confirmNonGitRepository(candidate, choice) { if (candidate) { submitRepository({ path: candidate, confirmNonGit: true }');
    expect(r.body).toContain("var candidate = result.body.candidate; var rejected = payload.choice;");
    expect(r.body).toContain("confirmNonGitRepository(candidate, rejected)");
    expect(r.body).toContain("result.body.remedy");
    expect(r.body).toContain('fetch("/api/v1/repository/gitignore"');
    expect(r.body).toContain("result.body.gitignoreMissing");
    // Both owner consents are inline DOM affordances; a blocking modal stalls
    // automated and headless drivers. .gitignore is still only written on an
    // explicit confirm, and Bearing never creates one.
    expect(r.body).not.toContain("window.confirm");
    expect(r.body).toContain('<div class="blocker-note" id="repository-consent" role="status" aria-live="polite" hidden><strong id="repository-consent-message"></strong><div class="journey-actions"><button id="repository-consent-dismiss" type="button">Not now</button><button class="primary" id="repository-consent-confirm" type="button">Confirm</button></div></div>');
    expect(r.body).toContain("function askRepositoryConsent(message, confirmLabel, dismissLabel, onConfirm, onDismiss)");
    expect(r.body).toContain("repositoryConsentMessage.textContent = message");
    expect(r.body).toContain("repositoryConsentConfirm.focus()");
    expect(r.body).toContain('repositoryConsentConfirm.addEventListener("click", function () { answerRepositoryConsent(true); })');
    expect(r.body).toContain('repositoryConsentDismiss.addEventListener("click", function () { answerRepositoryConsent(false); })');
    expect(r.body).toContain('askRepositoryConsent(remedy, "Use for planning-only", "Choose another"');
    expect(r.body).toContain('askRepositoryConsent("`.bearing/` is not gitignored. Add it so planning state is never committed?", "Add .bearing/ to .gitignore", "Not now", addBearingGitignore');
    expect(r.body).toContain('function addBearingGitignore() { fetch("/api/v1/repository/gitignore"');
    expect(r.body).toContain('if (code === "repository_picker_unavailable") { browseAvailable = false; repositoryPanel.hidden = false;');
    expect(r.body).toContain('setStatus("Choose a workspace. Your current screen will stay open."');
    expect(r.body).toContain('document.getElementById("launch-bearing").disabled = false;');
    expect(r.body).toContain('history-button');
    expect(r.body).toContain('id="clear-history"');
    expect(r.body.match(/var hasSavedResult = !!\(entry\.stage && entry\.lastResult\)/g)).toHaveLength(2);
    expect(r.body).toContain('entry.status === "complete" && hasSavedResult ? "View completed evidence"');
    expect(r.body).toContain('setStatus(entry.status === "complete" ? "Opened completed journey evidence." : "Resumed the saved journey.", false)');
    expect(r.body).not.toContain('entry.status !== "complete"');
    expect(r.body).toContain('remove.textContent = "Delete"');
    expect(r.body).toContain('method: "DELETE"');
    expect(r.body).toContain("Generated files will stay in the repository.");
    expect(r.body).toContain('input.placeholder = "Steer this phase');
    expect(r.body).toContain('steer.textContent = "Steer"');
    expect(r.body).toContain('stop.textContent = "Stop"');
    expect(r.body).toContain('fetch("/api/v1/journey/control"');
    expect(r.body).toContain('"Git: " + body.changedFiles + " changed "');
    expect(r.body).toContain('fetch("/api/v1/git-diff?path="');
    expect(r.body).toContain('className = "diff-add"');
    expect(r.body).toContain('id="journey-question-box" hidden');
    expect(r.body).toContain('id="planning-answer-form" hidden');
    expect(r.body).toContain('<button class="primary" type="submit">Continue</button>');
    expect(r.body).toContain('classList.toggle("busy"');
    expect(r.body).toContain('@keyframes panel-in');
    expect(r.body).toContain('@keyframes compass-spin');
    expect(r.body).not.toContain('id="workflow-select"');
    expect(r.body).not.toContain('id="showcase"');
    expect(r.body).toContain('"/api/v1/journey"');
    expect(r.body).not.toContain('/launch');
    expect(r.body).not.toContain(cap);
    // If the fragment leaked into req.url the path check would 404; a 200 proves
    // the server only ever saw "/" on the initial GET.
    expect(r.body).not.toContain("Rejected");
    const scriptStart = r.body.indexOf("<script>"), scriptEnd = r.body.lastIndexOf("</script>");
    const script = scriptStart >= 0 && scriptEnd > scriptStart ? r.body.slice(scriptStart + "<script>".length, scriptEnd) : undefined;
    expect(script).toBeDefined();
    expect(() => new Function(script!)).not.toThrow();

    const image = await call(port, { method: "GET", path: "/assets/bearing-office.png" });
    expect(image.status).toBe(200);
    expect(image.headers["content-type"]).toBe("image/png");
    expect(Number(image.headers["content-length"])).toBeGreaterThan(2_000_000);
    expect(image.headers["cache-control"]).toBe("no-cache");
    expect(image.headers["x-content-type-options"]).toBe("nosniff");
    const titleMark = await call(port, { method: "GET", path: "/assets/bearing-title-mark.png" });
    expect(titleMark.status).toBe(200);
    expect(titleMark.headers["content-type"]).toBe("image/png");
    expect(Number(titleMark.headers["content-length"])).toBeGreaterThan(0);
    expect(titleMark.headers["cache-control"]).toBe("no-cache");
    expect(titleMark.headers["x-content-type-options"]).toBe("nosniff");
    const background = await call(port, { method: "GET", path: "/assets/bearing-expedition.png" });
    expect(background.status).toBe(200);
    expect(background.headers["content-type"]).toBe("image/png");
    expect(Number(background.headers["content-length"])).toBeGreaterThan(2_000_000);
    expect(background.headers["cache-control"]).toBe("no-cache");
    expect(background.headers["x-content-type-options"]).toBe("nosniff");
    for (const path of ["/assets/bearing-explorer-card.png", "/assets/bearing-expedition-card.png"]) {
      const card = await call(port, { method: "GET", path });
      expect(card.status).toBe(200);
      expect(card.headers["content-type"]).toBe("image/png");
      expect(Number(card.headers["content-length"])).toBeGreaterThan(1_000_000);
      expect(card.headers["cache-control"]).toBe("no-cache");
      expect(card.headers["x-content-type-options"]).toBe("nosniff");
    }
  });

  it("renders and drafts only semantically valid bounded recovery diagnostics", async () => {
    const { port } = await launch();
    const page = await call(port, { method: "GET", path: "/" });
    const start = page.body.indexOf("function renderRecoveryReport");
    const end = page.body.indexOf("function recordPlanReview", start);
    const renderer = start >= 0 && end > start ? page.body.slice(start, end) : "";
    expect(renderer).not.toBe("");

    type BrowserElement = {
      hidden: boolean;
      textContent: string;
      onclick?: () => void;
      after: (child: BrowserElement) => void;
    };
    const elements = new Map<string, BrowserElement>();
    for (const id of ["recovery-report", "journey-summary", "recovery-heading", "recovery-summary", "report-recovery-bug"]) {
      elements.set(id, { hidden: true, textContent: "", after: () => {} });
    }
    const opened: string[] = [];
    const renderRecoveryReport = new Function(
      "document",
      "window",
      `${renderer}; return renderRecoveryReport;`,
    )(
      { getElementById: (id: string) => elements.get(id)! },
      { open: (url: string) => { opened.push(url); } },
    ) as (recovery: Record<string, unknown>) => void;
    const root = "/private/repository-root";
    const secret = "agent-secret-payload";
    const invalid = {
      status: "stopped",
      stage: "repository-fit",
      failureClass: "agent_receipt_or_artifact_validation",
      code: "fit_malformed",
      retryLevel: "simplify",
      version: "0.1.5",
      fitDiagnostic: { check: "receipt_ok", field: "detail", repository: root, payload: secret },
    };
    renderRecoveryReport(invalid);
    const summary = elements.get("recovery-summary")!;
    expect(summary.textContent).not.toContain("Repository fit check:");
    elements.get("report-recovery-bug")!.onclick!();
    const invalidDraft = new URL(opened.at(-1)!).searchParams.get("body")!;
    expect(invalidDraft).not.toContain("Repository fit check:");
    expect(invalidDraft).not.toContain("receipt_ok");
    expect(invalidDraft).not.toContain("detail");
    expect(invalidDraft).not.toContain(root);
    expect(invalidDraft).not.toContain(secret);

    const valid = {
      ...invalid,
      fitDiagnostic: { check: "assumption_repository", field: "repository", repository: root, payload: secret },
    };
    renderRecoveryReport(valid);
    expect(summary.textContent).toContain("Repository fit check: assumption_repository; field: repository.");
    elements.get("report-recovery-bug")!.onclick!();
    const validDraft = new URL(opened.at(-1)!).searchParams.get("body")!;
    expect(validDraft).toContain("Repository fit check: assumption_repository");
    expect(validDraft).toContain("Repository fit field: repository");
    expect(validDraft).not.toContain(root);
    expect(validDraft).not.toContain(secret);
  });

  it("surfaces every verification layer and the resolved review cadence for the selected run", async () => {
    const { port } = await launch();
    const r = await call(port, { method: "GET", path: "/" });

    expect(r.body).toContain('id="verification-panel" hidden aria-labelledby="verification-heading"');
    expect(r.body).toContain('id="verification-heading">Verification evidence</h2>');
    expect(r.body).toContain("READ ONLY");
    for (const layer of ["validator", "grader", "park-ranger"]) {
      expect(r.body).toContain(`id="verification-${layer}"`);
    }
    expect(r.body).toContain('var verificationLayers = ["validator", "grader", "park-ranger"]');
    expect(r.body).toContain("function renderVerificationProjection(layer, body)");
    expect(r.body).toContain("entry.verdict");
    expect(r.body).toContain("entry.stage");
    expect(r.body).toContain("entry.status");
    expect(r.body).toContain("entry.rubricVersion");
    expect(r.body).toContain("entry.findingCount");
    expect(r.body).toContain("function renderReviewCadence(body)");
    expect(r.body).toContain("body.declaredCadence");
    expect(r.body).toContain("var cadence = body.resolvedCadence");
    expect(r.body).toContain("cadence.cadence");
    expect(r.body).toContain("cadence.tightened");
    expect(r.body).toContain("cadence.reasons");
    expect(r.body).toContain("body.requiredGates");
    expect(r.body).toContain("loadVerificationProjections(currentRunId)");
    expect(r.body).toContain("var verificationLoadGeneration = 0");
    expect(r.body).toContain("var generation = ++verificationLoadGeneration");
    expect(r.body.match(/generation !== verificationLoadGeneration/g)).toHaveLength(2);
    expect(r.body).toContain('selectedRepositoryPath = result.body.repositoryPath || ""; currentRunId = ""; clearVerificationProjections(); syncShellSummary()');
  });

  it("uses only secret-blind GETs and renders typed projection failures instead of raw responses", async () => {
    const { port, cap } = await launch();
    const cookie = await exchangeCookie(port, cap);
    const cookieValue = cookie.split("=")[1]!;
    const r = await call(port, { method: "GET", path: "/" });
    const start = r.body.indexOf("function readProjection(path)");
    const end = r.body.indexOf("function renderArtifactList", start);
    const projectionClient = start >= 0 && end > start ? r.body.slice(start, end) : "";

    expect(projectionClient).not.toBe("");
    expect(projectionClient).toContain('fetch(path, { credentials: "same-origin" })');
    expect(projectionClient).not.toContain("method:");
    expect(projectionClient).not.toContain("document.cookie");
    expect(projectionClient).not.toContain("location.hash");
    expect(projectionClient).not.toContain("capability");
    expect(projectionClient).toContain("function renderProjectionFailure(target, failure)");
    expect(projectionClient).toContain('"projection_unavailable"');
    expect(projectionClient).toContain("body.code");
    expect(projectionClient).toContain("body.remedy");
    expect(projectionClient).not.toContain("target.textContent = text");
    expect(r.body).not.toContain(cap);
    expect(r.body).not.toContain(cookieValue);

    const failureClient = projectionClient.slice(0, projectionClient.indexOf("function renderVerificationProjection"));
    const element = (tagName: string): {
      tagName: string;
      className: string;
      textContent: string;
      children: unknown[];
      append: (...children: unknown[]) => void;
      appendChild: (child: unknown) => unknown;
      replaceChildren: (...children: unknown[]) => void;
    } => ({
      tagName,
      className: "",
      textContent: "",
      children: [],
      append(...children: unknown[]) { this.children.push(...children); },
      appendChild(child: unknown) { this.children.push(child); return child; },
      replaceChildren(...children: unknown[]) { this.children = children; },
    });
    let requested: { path: string; options: Record<string, unknown> } | undefined;
    let fetchResponse = { ok: false, text: async () => "Rejected" };
    const browserFetch = async (path: string, options: Record<string, unknown>) => {
      requested = { path, options };
      return fetchResponse;
    };
    const runtime = new Function(
      "fetch",
      "document",
      `${failureClient}; return { readProjection, renderProjectionFailure };`,
    )(browserFetch, { createElement: element }) as {
      readProjection: (path: string) => Promise<{ ok: false; code: string; remedy: string }>;
      renderProjectionFailure: (target: ReturnType<typeof element>, failure: { code: string; remedy: string }) => void;
    };
    const failure = await runtime.readProjection("/api/v1/runs/run-1/verification/validator");
    expect(requested).toEqual({
      path: "/api/v1/runs/run-1/verification/validator",
      options: { credentials: "same-origin" },
    });
    expect(failure).toEqual({
      ok: false,
      code: "projection_unavailable",
      remedy: "This verification projection is unavailable.",
    });
    const target = element("div");
    runtime.renderProjectionFailure(target, failure);
    expect(JSON.stringify(target)).toContain("projection_unavailable");
    expect(JSON.stringify(target)).not.toContain("Rejected");
    expect(JSON.stringify(target)).not.toContain(cap);
    expect(JSON.stringify(target)).not.toContain(cookieValue);

    fetchResponse = { ok: true, text: async () => "not JSON" };
    expect(await runtime.readProjection("/api/v1/runs/run-1/review-cadence")).toEqual({
      ok: false,
      code: "projection_unavailable",
      remedy: "This verification projection is unavailable.",
    });
    fetchResponse = { ok: true, text: async () => "{}" };
    expect(await runtime.readProjection("/api/v1/runs/run-1/verification/validator")).toEqual({
      ok: false,
      code: "projection_unavailable",
      remedy: "This verification projection is unavailable.",
    });
  });

  it("authenticates before protected route selection and returns 404 only after authentication", async () => {
    const { port, cap } = await launch();
    for (const path of ["/api/v1/routes", "/api/v1/workflows", "/api/v1/workflows/example/report", "/api/v1/workflows/example", "/api/v1/runs/example"]) {
      expect((await call(port, { method: "GET", path })).status).toBe(401);
    }
    const cookie = await exchangeCookie(port, cap);
    expect((await call(port, { method: "GET", path: "/api/v1/nope", headers: { cookie } })).status).toBe(404);
  });
});

describe("GET run execution contract and planning state", () => {
  const contractPath = "/api/v1/runs/run-1/execution-contract/1.7";
  const statePath = "/api/v1/runs/run-1/planning-state";

  it("requires authentication, Host, Origin, and a selected repository", async () => {
    const { port, cap } = await launch();
    for (const path of [contractPath, statePath]) {
      expect((await call(port, { method: "GET", path })).status).toBe(401);
    }
    const cookie = await exchangeCookie(port, cap);
    for (const path of [contractPath, statePath]) {
      const noRepository = await call(port, { method: "GET", path, headers: { cookie } });
      expect(noRepository.status).toBe(409);
      expect(JSON.parse(noRepository.body)).toEqual({
        status: "blocked",
        code: "repository_not_selected",
        remedy: expect.any(String),
      });
      expect((await call(port, { method: "GET", path, headers: { host: "evil.example", cookie } })).status).toBe(421);
      expect((await call(port, { method: "GET", path, headers: { origin: "https://evil.example", cookie } })).status).toBe(403);
    }
  });

  it("refuses a self-attested execution contract without ledger-backed owner approval", async () => {
    const { port, cap } = await launch();
    const cookie = await exchangeCookie(port, cap);
    const root = await tempRepo();
    await selectRepository(port, cookie, root);
    await seedRun(root, "run-1", "docs/plans/approved");
    await mkdir(join(root, "docs/plans/approved"), { recursive: true });
    await writeFile(join(root, "docs/plans/approved/execution-contract.json"), JSON.stringify(approvedContract("run-1")));

    const response = await call(port, { method: "GET", path: contractPath, headers: { cookie } });
    expect(response.status).toBe(422);
    expect(JSON.parse(response.body)).toEqual({
      status: "blocked",
      code: "owner_approval_unverified",
      remedy: expect.any(String),
    });
  });

  it("returns the approved contract, derived Focus envelope, and ledger-derived planning state without leaking local secrets", async () => {
    const { port, cap } = await launch();
    const cookie = await exchangeCookie(port, cap);
    const root = await tempRepo();
    await selectRepository(port, cookie, root);
    const store = await seedRun(root, "run-1", "docs/plans/approved");
    await mkdir(join(root, "docs/plans/approved"), { recursive: true });
    const approved = await recordContractApproval(store, approvedContract("run-1"));
    await writeFile(join(root, "docs/plans/approved/execution-contract.json"), JSON.stringify(approved));

    const contract = await call(port, { method: "GET", path: contractPath, headers: { cookie } });
    expect(contract.status).toBe(200);
    expect(JSON.parse(contract.body)).toMatchObject({
      contract: { schemaVersion: 1, runId: "run-1", contractId: "contract-run-1" },
      focusEnvelope: { version: 1, role: "crewmate", allowedPaths: ["src/server/local-session.ts"], seitCommandIds: ["CMD-TEST-ALL"] },
      advisories: [],
    });

    const state = await call(port, { method: "GET", path: statePath, headers: { cookie } });
    expect(state.status).toBe(200);
    expect(JSON.parse(state.body)).toEqual({ runId: "run-1", planningState: "REQUIREMENTS_READY" });
    for (const response of [contract, state]) {
      expect(response.body).not.toContain(cap);
      expect(response.body).not.toContain(cookie.split("=")[1]);
      expect(response.body).not.toContain(root);
    }
  });

  it("accepts contract-hash approval from the durable owner-answer chain", async () => {
    const { port, cap } = await launch();
    const cookie = await exchangeCookie(port, cap);
    const root = await tempRepo();
    await selectRepository(port, cookie, root);
    const store = await seedRun(root, "run-1", "docs/plans/approved");
    await mkdir(join(root, "docs/plans/approved"), { recursive: true });
    const approved = await recordOwnerContractApproval(store, approvedContract("run-1"));
    await writeFile(join(root, "docs/plans/approved/execution-contract.json"), JSON.stringify(approved));

    const response = await call(port, { method: "GET", path: contractPath, headers: { cookie } });
    expect(response.status).toBe(200);
  });

  it("returns typed failures for unknown runs, absent or malformed contracts, and unknown slices", async () => {
    const { port, cap } = await launch();
    const cookie = await exchangeCookie(port, cap);
    const root = await tempRepo();
    await selectRepository(port, cookie, root);
    const store = await seedRun(root, "run-1", "docs/plans/approved");
    await mkdir(join(root, "docs/plans/approved"), { recursive: true });

    const cases: { response: Resp; code: string }[] = [];
    cases.push({ response: await call(port, { method: "GET", path: "/api/v1/runs/missing/planning-state", headers: { cookie } }), code: "run_not_found" });
    cases.push({ response: await call(port, { method: "GET", path: contractPath, headers: { cookie } }), code: "execution_contract_unavailable" });
    await writeFile(join(root, "docs/plans/approved/execution-contract.json"), "{not json");
    cases.push({ response: await call(port, { method: "GET", path: contractPath, headers: { cookie } }), code: "execution_contract_malformed" });
    const approved = await recordContractApproval(store, approvedContract("run-1"));
    await writeFile(join(root, "docs/plans/approved/execution-contract.json"), JSON.stringify(approved));
    cases.push({ response: await call(port, { method: "GET", path: "/api/v1/runs/run-1/execution-contract/9.9", headers: { cookie } }), code: "unknown_slice" });

    for (const { response, code } of cases) {
      expect(response.status).not.toBe(500);
      expect(JSON.parse(response.body)).toEqual({ status: "blocked", code, remedy: expect.any(String) });
      expect(response.body).not.toContain(cap);
      expect(response.body).not.toContain(root);
    }
  });

  it("rejects an absolute plan directory without returning the repository path", async () => {
    const { port, cap } = await launch();
    const cookie = await exchangeCookie(port, cap);
    const root = await tempRepo();
    const absolutePlanDirectory = join(root, "docs/plans/approved");
    await selectRepository(port, cookie, root);
    await seedRun(root, "run-1", absolutePlanDirectory);
    await mkdir(absolutePlanDirectory, { recursive: true });
    await writeFile(join(absolutePlanDirectory, "execution-contract.json"), JSON.stringify(approvedContract("run-1", { planDirectory: absolutePlanDirectory })));

    const response = await call(port, { method: "GET", path: contractPath, headers: { cookie } });
    expect(response.status).toBe(422);
    expect(JSON.parse(response.body)).toEqual({ status: "blocked", code: "execution_contract_malformed", remedy: expect.any(String) });
    expect(response.body).not.toContain(root);
  });

  it("returns a typed failure when a valid contract cannot fit the bounded response", async () => {
    const { port, cap } = await launch();
    const cookie = await exchangeCookie(port, cap);
    const root = await tempRepo();
    await selectRepository(port, cookie, root);
    const store = await seedRun(root, "run-1", "docs/plans/approved");
    await mkdir(join(root, "docs/plans/approved"), { recursive: true });
    const paths = (prefix: string) => Array.from({ length: 128 }, (_, index) => `src/${prefix}-${index}-${"a".repeat(2_800)}.ts`);
    const first = approvedContract("run-1").slices[0];
    const contract = await recordContractApproval(store, approvedContract("run-1", {
      slices: [
        { ...first, writeSet: paths("first") },
        { ...first, sliceId: "1.8", writeSet: paths("second") },
      ],
    }));
    const serialized = JSON.stringify(contract);
    expect(Buffer.byteLength(serialized)).toBeGreaterThan(640 * 1024);
    expect(Buffer.byteLength(serialized)).toBeLessThan(2 * 1024 * 1024);
    await writeFile(join(root, "docs/plans/approved/execution-contract.json"), serialized);

    const response = await call(port, { method: "GET", path: contractPath, headers: { cookie } });
    expect(response.status).toBe(413);
    expect(JSON.parse(response.body)).toEqual({ status: "blocked", code: "execution_contract_response_too_large", remedy: expect.any(String) });
  });
});

describe("POST run verification report ingestion", () => {
  const pathFor = (runId: string, layer: "grader" | "park-ranger") => `/api/v1/runs/${runId}/verification/${layer}`;

  it("enforces authentication, strict Origin, repository selection, run existence, and ledger-backed owner approval", async () => {
    const { port, cap } = await launch();
    const body = JSON.stringify({});
    const unauthenticated = await call(port, {
      method: "POST",
      path: pathFor("run-1", "grader"),
      headers: sessionHeaders(port),
      body,
    });
    expect(unauthenticated.status).toBe(401);

    const cookie = await exchangeCookie(port, cap);
    const cookieValue = cookie.split("=")[1];
    const badOrigin = await call(port, {
      method: "POST",
      path: pathFor("run-1", "grader"),
      headers: sessionHeaders(port, { cookie, origin: "https://evil.example" }),
      body,
    });
    expect(badOrigin.status).toBe(403);

    const noRepository = await call(port, {
      method: "POST",
      path: pathFor("run-1", "grader"),
      headers: sessionHeaders(port, { cookie }),
      body,
    });
    expect(noRepository.status).toBe(409);
    expect(JSON.parse(noRepository.body)).toEqual({
      status: "blocked",
      code: "repository_not_selected",
      remedy: expect.any(String),
    });

    const root = await tempRepo();
    await selectRepository(port, cookie, root);
    const unknownRun = await call(port, {
      method: "POST",
      path: pathFor("missing", "grader"),
      headers: sessionHeaders(port, { cookie }),
      body,
    });
    expect(unknownRun.status).toBe(404);
    expect(JSON.parse(unknownRun.body)).toEqual({ status: "blocked", code: "run_not_found", remedy: expect.any(String) });

    const store = await seedRun(root, "run-1", "docs/plans/approved");
    await mkdir(join(root, "docs/plans/approved"), { recursive: true });
    await writeFile(join(root, "docs/plans/approved/execution-contract.json"), JSON.stringify(approvedContract("run-1")));
    const unapproved = await call(port, {
      method: "POST",
      path: pathFor("run-1", "grader"),
      headers: sessionHeaders(port, { cookie }),
      body,
    });
    expect(unapproved.status).toBe(422);
    expect(JSON.parse(unapproved.body)).toEqual({
      status: "blocked",
      code: "owner_approval_unverified",
      remedy: expect.any(String),
    });

    const recordedApproval = await recordContractApproval(store, approvedContract("run-1"));
    const changedContract = approvedContract("run-1", { objective: "A different contract body" });
    const mismatchedContract = {
      ...changedContract,
      ownerApproval: { ...changedContract.ownerApproval, recordId: recordedApproval.ownerApproval.recordId },
    };
    await writeFile(join(root, "docs/plans/approved/execution-contract.json"), JSON.stringify(mismatchedContract));
    const unmatchedApproval = await call(port, {
      method: "POST",
      path: pathFor("run-1", "grader"),
      headers: sessionHeaders(port, { cookie }),
      body,
    });
    expect(unmatchedApproval.status).toBe(422);
    expect(JSON.parse(unmatchedApproval.body)).toEqual({
      status: "blocked",
      code: "owner_approval_unverified",
      remedy: expect.any(String),
    });

    for (const response of [unauthenticated, badOrigin, noRepository, unknownRun, unapproved, unmatchedApproval]) {
      expect(response.body).not.toContain(cap);
      expect(response.body).not.toContain(cookieValue);
      expect(response.body).not.toContain(root);
    }
  });

  it("accepts a valid grader report and exposes its recomputed projection", async () => {
    const { port, cap } = await launch();
    const cookie = await exchangeCookie(port, cap);
    const cookieValue = cookie.split("=")[1];
    const root = await tempRepo();
    await selectRepository(port, cookie, root);
    const store = await seedRun(root, "run-1", "docs/plans/approved");
    await mkdir(join(root, "docs/plans/approved"), { recursive: true });
    const approved = await recordContractApproval(store, approvedContract("run-1"));
    await advanceJourneyStage(store, "run-1", "draft-implementation", "waiting");
    await writeFile(join(root, "docs/plans/approved/execution-contract.json"), JSON.stringify(approved));
    const before = await store.load("run-1");
    if (!before.journeyCheckpoint) throw new Error("journey checkpoint missing");
    const { eventId: _eventId, ...beforePayload } = before.journeyCheckpoint;

    const ingested = await call(port, {
      method: "POST",
      path: pathFor("run-1", "grader"),
      headers: sessionHeaders(port, { cookie }),
      body: JSON.stringify(graderReport(approved.contentHash)),
    });
    expect(ingested.status).toBe(200);
    expect(JSON.parse(ingested.body)).toMatchObject({
      status: "recorded",
      runId: "run-1",
      verification: { layer: "grader", verdict: "acceptable", rubricVersion: "1" },
    });

    const checkpoint = (await store.load("run-1")).events.at(-1);
    expect(checkpoint?.payload).toEqual({
      ...beforePayload,
      verification: { layer: "grader", verdict: "acceptable", rubricVersion: "1" },
    });
    expect(isVerificationCheckpointPayload(checkpoint?.payload.verification)).toBe(true);

    const projection = await call(port, {
      method: "GET",
      path: pathFor("run-1", "grader"),
      headers: { cookie },
    });
    expect(projection.status).toBe(200);
    expect(JSON.parse(projection.body)).toMatchObject({
      runId: "run-1",
      layer: "grader",
      entries: [{ stage: "draft-implementation", status: "waiting", verdict: "acceptable", rubricVersion: "1" }],
    });
    expect(JSON.parse(projection.body).entries).toHaveLength(1);
    for (const response of [ingested, projection]) {
      expect(response.body).not.toContain(cap);
      expect(response.body).not.toContain(cookieValue);
      expect(response.body).not.toContain(root);
    }
  });

  it("refuses a grader report scoped to a slice absent from the approved contract", async () => {
    const { port, cap } = await launch();
    const cookie = await exchangeCookie(port, cap);
    const root = await tempRepo();
    await selectRepository(port, cookie, root);
    const store = await seedRun(root, "run-1", "docs/plans/approved");
    await mkdir(join(root, "docs/plans/approved"), { recursive: true });
    const approved = await recordContractApproval(store, approvedContract("run-1"));
    await writeFile(join(root, "docs/plans/approved/execution-contract.json"), JSON.stringify(approved));
    const before = await store.load("run-1");

    const refused = await call(port, {
      method: "POST",
      path: pathFor("run-1", "grader"),
      headers: sessionHeaders(port, { cookie }),
      body: JSON.stringify({
        ...graderReport(approved.contentHash),
        scope: { kind: "slice", id: "missing" },
      }),
    });

    expect(refused.status).toBe(422);
    expect(JSON.parse(refused.body)).toEqual({
      status: "blocked",
      code: "malformed",
      remedy: expect.any(String),
    });
    const after = await store.load("run-1");
    expect(after.revision).toBe(before.revision);
    expect(after.events).toEqual(before.events);
  });

  it("preserves the resumable journey checkpoint when a grader report is recorded", async () => {
    const runner = new CheckpointRunner();
    const { port, cap } = await launchHandler(new RepositoryBootstrap(), {
      processRunner: runner,
      verification: { verify: async () => true },
    });
    const cookie = await exchangeCookie(port, cap);
    const root = await tempRepo();
    await selectRepository(port, cookie, root);
    expect((await call(port, {
      method: "POST",
      path: "/api/v1/readiness",
      headers: sessionHeaders(port, { cookie }),
      body: JSON.stringify({ provider: "codex", model: "*", reasoning: "medium" }),
    })).status).toBe(200);
    const runId = "resumable-verification";
    const planDirectory = "docs/plans/approved";
    const store = await seedRun(root, runId, planDirectory);
    await mkdir(join(root, planDirectory), { recursive: true });
    const approved = await recordContractApproval(store, approvedContract(runId));
    await writeFile(join(root, planDirectory, "execution-contract.json"), JSON.stringify(approved));
    const durable = await store.load(runId);
    const resumable = await store.apply({
      schemaVersion: 1,
      commandId: "resumable-before-verification",
      runId,
      expectedRevision: durable.revision,
      type: "recordJourneyCheckpoint",
      payload: {
        ...fitCheckpointPayload(root, planDirectory),
        stage: "gather-supplies",
        status: "waiting",
        planDirectory,
        lastResultJson: JSON.stringify({ status: "action", summary: "Ready to resume.", artifacts: [], tokens: 1 }),
        qaJson: "[]",
        gatherQuestionsDiscovered: true,
        selectionProvider: "codex",
        selectionModel: "*",
        selectionReasoning: "medium",
      },
      session: { sessionId: "test-bearing", actor: "bearing" },
      correlationId: "resumable-before-verification",
    });
    if (!resumable.ok) throw new Error(resumable.reason);

    const ingested = await call(port, {
      method: "POST",
      path: pathFor(runId, "grader"),
      headers: sessionHeaders(port, { cookie }),
      body: JSON.stringify(graderReport(approved.contentHash)),
    });
    expect(ingested.status).toBe(200);
    expect((await store.load(runId)).journeyCheckpoint).toMatchObject({
      stage: "gather-supplies",
      status: "waiting",
      planDirectory,
      resolvedPlanDirectory: planDirectory,
      lastResultJson: expect.any(String),
      qaJson: "[]",
      gatherQuestionsDiscovered: true,
      selectionProvider: "codex",
      selectionModel: "*",
      selectionReasoning: "medium",
      verification: { layer: "grader", verdict: "acceptable", rubricVersion: "1" },
    });

    expect((await call(port, {
      method: "GET",
      path: `/api/v1/journey/${runId}/status`,
      headers: { cookie },
    })).status).toBe(200);
    const resumed = await call(port, {
      method: "POST",
      path: "/api/v1/journey",
      headers: sessionHeaders(port, { cookie }),
      body: JSON.stringify({ runId, stage: "gather-supplies", workGoal: "Complete the approved work" }),
    });
    expect(resumed.status).toBe(200);
    expect(JSON.parse(resumed.body)).toMatchObject({
      status: "action",
      artifacts: [`${planDirectory}/plan-spec.md`],
    });
  });

  it("deduplicates a retried verification report into one ledger event", async () => {
    const { port, cap } = await launch();
    const cookie = await exchangeCookie(port, cap);
    const root = await tempRepo();
    await selectRepository(port, cookie, root);
    const store = await seedRun(root, "run-1", "docs/plans/approved");
    await mkdir(join(root, "docs/plans/approved"), { recursive: true });
    const approved = await recordContractApproval(store, approvedContract("run-1"));
    await writeFile(join(root, "docs/plans/approved/execution-contract.json"), JSON.stringify(approved));
    const request = {
      method: "POST",
      path: pathFor("run-1", "grader"),
      headers: sessionHeaders(port, { cookie }),
      body: JSON.stringify(graderReport(approved.contentHash)),
    };

    const first = await call(port, request);
    const retry = await call(port, request);

    expect(first.status).toBe(200);
    expect(retry.status).toBe(200);
    expect(JSON.parse(retry.body).eventId).toBe(JSON.parse(first.body).eventId);
    const events = (await store.load("run-1")).events.filter((event) =>
      event.type === "journeyCheckpointRecorded"
      && isVerificationCheckpointPayload(event.payload.verification)
      && event.payload.verification.layer === "grader");
    expect(events).toHaveLength(1);
  });

  it("rejects mismatched verdicts and authority-bearing keys without appending anything", async () => {
    const { port, cap } = await launch();
    const cookie = await exchangeCookie(port, cap);
    const cookieValue = cookie.split("=")[1];
    const root = await tempRepo();
    await selectRepository(port, cookie, root);
    const store = await seedRun(root, "run-1", "docs/plans/approved");
    await mkdir(join(root, "docs/plans/approved"), { recursive: true });
    const approved = await recordContractApproval(store, approvedContract("run-1"));
    await writeFile(join(root, "docs/plans/approved/execution-contract.json"), JSON.stringify(approved));
    const before = await store.load("run-1");

    const mismatched = await call(port, {
      method: "POST",
      path: pathFor("run-1", "grader"),
      headers: sessionHeaders(port, { cookie }),
      body: JSON.stringify(graderReport(approved.contentHash, 4, "weak")),
    });
    expect(mismatched.status).toBe(422);
    expect(JSON.parse(mismatched.body)).toEqual({ status: "blocked", code: "verdict_mismatch", remedy: expect.any(String) });

    const forbidden = await Promise.all([
      { approved: true },
      { transition: "merge" },
      { mergeDecision: "approve" },
    ].map((extra) => call(port, {
      method: "POST",
      path: pathFor("run-1", "grader"),
      headers: sessionHeaders(port, { cookie }),
      body: JSON.stringify({ ...graderReport(approved.contentHash), ...extra }),
    })));
    for (const response of forbidden) {
      expect(response.status).toBe(422);
      expect(JSON.parse(response.body)).toEqual({ status: "blocked", code: "unexpected_key", remedy: expect.any(String) });
    }

    const after = await store.load("run-1");
    expect(after.revision).toBe(before.revision);
    expect(after.events).toEqual(before.events);
    for (const response of [mismatched, ...forbidden]) {
      expect(response.body).not.toContain(cap);
      expect(response.body).not.toContain(cookieValue);
      expect(response.body).not.toContain(root);
    }
  });

  it("rejects an oversized report with a typed failure and no ledger write", async () => {
    const { port, cap } = await launch();
    const cookie = await exchangeCookie(port, cap);
    const cookieValue = cookie.split("=")[1];
    const root = await tempRepo();
    await selectRepository(port, cookie, root);
    const store = await seedRun(root, "run-1", "docs/plans/approved");
    await mkdir(join(root, "docs/plans/approved"), { recursive: true });
    const approved = await recordContractApproval(store, approvedContract("run-1"));
    await writeFile(join(root, "docs/plans/approved/execution-contract.json"), JSON.stringify(approved));
    const before = await store.load("run-1");

    const response = await call(port, {
      method: "POST",
      path: pathFor("run-1", "grader"),
      headers: sessionHeaders(port, { cookie }),
      body: JSON.stringify({ ...graderReport(approved.contentHash), padding: "x".repeat(1024 * 1024) }),
    });
    expect(response.status).toBe(413);
    expect(JSON.parse(response.body)).toEqual({
      status: "blocked",
      code: "verification_report_too_large",
      remedy: expect.any(String),
    });
    const after = await store.load("run-1");
    expect(after.revision).toBe(before.revision);
    expect(after.events).toEqual(before.events);
    expect(response.body).not.toContain(cap);
    expect(response.body).not.toContain(cookieValue);
    expect(response.body).not.toContain(root);
  });

  it("accepts a Park Ranger report and exposes its synthesized non-empty projection", async () => {
    const { port, cap } = await launch();
    const cookie = await exchangeCookie(port, cap);
    const cookieValue = cookie.split("=")[1];
    const root = await tempRepo();
    await selectRepository(port, cookie, root);
    const store = await seedRun(root, "run-1", "docs/plans/approved");
    await mkdir(join(root, "docs/plans/approved"), { recursive: true });
    const approved = await recordContractApproval(store, approvedContract("run-1"));
    await advanceJourneyStage(store, "run-1", "draft-implementation", "waiting");
    await writeFile(join(root, "docs/plans/approved/execution-contract.json"), JSON.stringify(approved));

    const ingested = await call(port, {
      method: "POST",
      path: pathFor("run-1", "park-ranger"),
      headers: sessionHeaders(port, { cookie }),
      body: JSON.stringify(parkRangerReport()),
    });
    expect(ingested.status).toBe(200);
    expect(JSON.parse(ingested.body)).toMatchObject({
      status: "recorded",
      runId: "run-1",
      verification: { layer: "park-ranger", verdict: "repair-required", findingCount: 1 },
    });

    const projection = await call(port, {
      method: "GET",
      path: pathFor("run-1", "park-ranger"),
      headers: { cookie },
    });
    expect(projection.status).toBe(200);
    expect(JSON.parse(projection.body)).toMatchObject({
      runId: "run-1",
      layer: "park-ranger",
      entries: [{ stage: "draft-implementation", status: "waiting", verdict: "repair-required", findingCount: 1 }],
    });
    expect(JSON.parse(projection.body).entries).toHaveLength(1);
    for (const response of [ingested, projection]) {
      expect(response.body).not.toContain(cap);
      expect(response.body).not.toContain(cookieValue);
      expect(response.body).not.toContain(root);
    }
  });

  it("keeps a reachable P0 blocker when two independent lens reports confirm it", async () => {
    const { port, cap } = await launch();
    const cookie = await exchangeCookie(port, cap);
    const root = await tempRepo();
    await selectRepository(port, cookie, root);
    const store = await seedRun(root, "run-1", "docs/plans/approved");
    await mkdir(join(root, "docs/plans/approved"), { recursive: true });
    const approved = await recordContractApproval(store, approvedContract("run-1"));
    await writeFile(join(root, "docs/plans/approved/execution-contract.json"), JSON.stringify(approved));
    const reports = [
      parkRangerReport({
        lens: "correctness",
        sessionId: "park-ranger-correctness",
        priority: "P0",
        code: "verification-boundary-bypass",
      }),
      parkRangerReport({
        lens: "security",
        sessionId: "park-ranger-security",
        priority: "P0",
        code: "verification-boundary-bypass",
      }),
    ];

    const ingested = await call(port, {
      method: "POST",
      path: pathFor("run-1", "park-ranger"),
      headers: sessionHeaders(port, { cookie }),
      body: JSON.stringify(reports),
    });

    expect(ingested.status).toBe(200);
    expect(JSON.parse(ingested.body)).toMatchObject({
      verification: { layer: "park-ranger", verdict: "block", findingCount: 1 },
    });
  });

  it("refuses a grader report from an implementer provider session", async () => {
    const { port, cap } = await launch();
    const cookie = await exchangeCookie(port, cap);
    const root = await tempRepo();
    await selectRepository(port, cookie, root);
    const store = await seedRun(root, "run-1", "docs/plans/approved");
    await mkdir(join(root, "docs/plans/approved"), { recursive: true });
    const approved = await recordContractApproval(store, approvedContract("run-1"));
    await writeFile(join(root, "docs/plans/approved/execution-contract.json"), JSON.stringify(approved));
    const implementerSessionId = "019f8d4e-a637-7e71-8c76-af9d7ec91adf";
    const durable = await store.load("run-1");
    const implementation = await store.apply({
      schemaVersion: 1,
      commandId: "grader-implementer-session",
      runId: "run-1",
      expectedRevision: durable.revision,
      type: "recordJourneyCheckpoint",
      payload: {
        stage: "execute-explorer",
        status: "waiting",
        artifacts: [],
        planDirectory: "docs/plans/approved",
        providerSessionId: implementerSessionId,
      },
      session: { sessionId: "test-bearing", actor: "bearing" },
      correlationId: "grader-implementer-session",
    });
    if (!implementation.ok) throw new Error(implementation.reason);
    const before = await store.load("run-1");

    const refused = await call(port, {
      method: "POST",
      path: pathFor("run-1", "grader"),
      headers: sessionHeaders(port, { cookie }),
      body: JSON.stringify({
        ...graderReport(approved.contentHash),
        graderSessionId: implementerSessionId,
      }),
    });

    expect(refused.status).toBe(422);
    expect(JSON.parse(refused.body)).toEqual({
      status: "blocked",
      code: "self_certification",
      remedy: expect.any(String),
    });
    const after = await store.load("run-1");
    expect(after.revision).toBe(before.revision);
    expect(after.events).toEqual(before.events);
  });

  it("refuses a Park Ranger report from an implementer provider session", async () => {
    const { port, cap } = await launch();
    const cookie = await exchangeCookie(port, cap);
    const root = await tempRepo();
    await selectRepository(port, cookie, root);
    const store = await seedRun(root, "run-1", "docs/plans/approved");
    await mkdir(join(root, "docs/plans/approved"), { recursive: true });
    const approved = await recordContractApproval(store, approvedContract("run-1"));
    await writeFile(join(root, "docs/plans/approved/execution-contract.json"), JSON.stringify(approved));
    const implementerSessionId = "019f8d4e-a637-7e71-8c76-af9d7ec91adf";
    const durable = await store.load("run-1");
    const implementation = await store.apply({
      schemaVersion: 1,
      commandId: "implementer-session",
      runId: "run-1",
      expectedRevision: durable.revision,
      type: "recordJourneyCheckpoint",
      payload: {
        stage: "execute-explorer",
        status: "waiting",
        artifacts: [],
        planDirectory: "docs/plans/approved",
        providerSessionId: implementerSessionId,
      },
      session: { sessionId: "test-bearing", actor: "bearing" },
      correlationId: "implementer-session",
    });
    if (!implementation.ok) throw new Error(implementation.reason);
    const before = await store.load("run-1");

    const refused = await call(port, {
      method: "POST",
      path: pathFor("run-1", "park-ranger"),
      headers: sessionHeaders(port, { cookie }),
      body: JSON.stringify(parkRangerReport({ sessionId: implementerSessionId })),
    });

    expect(refused.status).toBe(422);
    expect(JSON.parse(refused.body)).toEqual({
      status: "blocked",
      code: "self_certification",
      remedy: expect.any(String),
    });
    const after = await store.load("run-1");
    expect(after.revision).toBe(before.revision);
    expect(after.events).toEqual(before.events);
  });

  it("requires Park Ranger to adjudicate the durable execution readiness claim", async () => {
    const { port, cap } = await launch();
    const cookie = await exchangeCookie(port, cap);
    const root = await tempRepo();
    await selectRepository(port, cookie, root);
    const store = await seedRun(root, "run-1", "docs/plans/approved");
    await mkdir(join(root, "docs/plans/approved"), { recursive: true });
    const approved = await recordContractApproval(store, approvedContract("run-1"));
    await writeFile(join(root, "docs/plans/approved/execution-contract.json"), JSON.stringify(approved));
    const claim = {
      text: "Implementation is merge-ready.",
      sliceIds: approved.slices.map(({ sliceId }) => sliceId),
    };
    const durable = await store.load("run-1");
    const completion = await store.apply({
      schemaVersion: 1,
      commandId: "validator-completion",
      runId: "run-1",
      expectedRevision: durable.revision,
      type: "recordJourneyCheckpoint",
      payload: {
        stage: "execute-explorer",
        status: "waiting",
        artifacts: [],
        planDirectory: "docs/plans/approved",
        lastResultJson: JSON.stringify({
          status: "action",
          summary: claim.text,
          artifacts: [],
          tokens: 1,
          verification: { verdict: "PASS", reasons: [], escalation: "none" },
        }),
        verification: { layer: "validator", verdict: "PASS", findingCount: 0 },
      },
      session: { sessionId: "test-bearing", actor: "bearing" },
      correlationId: "validator-completion",
    });
    if (!completion.ok) throw new Error(completion.reason);
    const before = await store.load("run-1");

    const refused = await call(port, {
      method: "POST",
      path: pathFor("run-1", "park-ranger"),
      headers: sessionHeaders(port, { cookie }),
      body: JSON.stringify(parkRangerReport()),
    });
    expect(refused.status).toBe(422);
    expect(JSON.parse(refused.body)).toEqual({
      status: "blocked",
      code: "claim_unadjudicated",
      remedy: expect.any(String),
    });
    expect((await store.load("run-1")).revision).toBe(before.revision);

    const recorded = await call(port, {
      method: "POST",
      path: pathFor("run-1", "park-ranger"),
      headers: sessionHeaders(port, { cookie }),
      body: JSON.stringify(parkRangerReport({
        adjudications: [{ claim, verdict: "supported", reasons: [] }],
      })),
    });
    expect(recorded.status).toBe(200);
  });
});

describe("GET run verification projections and review cadence", () => {
  const pathsFor = (runId: string): readonly string[] => [
    `/api/v1/runs/${runId}/verification/validator`,
    `/api/v1/runs/${runId}/verification/grader`,
    `/api/v1/runs/${runId}/verification/park-ranger`,
    `/api/v1/runs/${runId}/review-cadence`,
  ];

  it("requires authentication, Host, Origin, and a selected repository for every projection", async () => {
    const { port, cap } = await launch();
    const paths = pathsFor("run-1");
    for (const path of paths) {
      const unauthenticated = await call(port, { method: "GET", path });
      expect(unauthenticated.status).toBe(401);
      expect(unauthenticated.body).not.toContain(cap);
    }
    const cookie = await exchangeCookie(port, cap);
    const cookieValue = cookie.split("=")[1];
    for (const path of paths) {
      const noRepository = await call(port, { method: "GET", path, headers: { cookie } });
      expect(noRepository.status).toBe(409);
      expect(JSON.parse(noRepository.body)).toEqual({
        status: "blocked",
        code: "repository_not_selected",
        remedy: expect.any(String),
      });
      const badHost = await call(port, { method: "GET", path, headers: { host: "evil.example", cookie } });
      expect(badHost.status).toBe(421);
      const badOrigin = await call(port, { method: "GET", path, headers: { origin: "https://evil.example", cookie } });
      expect(badOrigin.status).toBe(403);
      for (const response of [noRepository, badHost, badOrigin]) {
        expect(response.body).not.toContain(cap);
        expect(response.body).not.toContain(cookieValue);
      }
    }
  });

  it("returns reconstructed layer entries and contract-derived cadence without local secrets", async () => {
    const { port, cap } = await launch();
    const cookie = await exchangeCookie(port, cap);
    const cookieValue = cookie.split("=")[1];
    const root = await tempRepo();
    await selectRepository(port, cookie, root);
    const store = await seedRun(root, "run-1", "docs/plans/approved");
    const validator = await recordVerificationCheckpoint(store, "run-1", { layer: "validator", verdict: "PASS" });
    const grader = await recordVerificationCheckpoint(store, "run-1", { layer: "grader", verdict: "acceptable", rubricVersion: "1" });
    const parkRanger = await recordVerificationCheckpoint(store, "run-1", { layer: "park-ranger", verdict: "repair-required", findingCount: 2 });
    await mkdir(join(root, "docs/plans/approved"), { recursive: true });
    const approved = await recordContractApproval(store, approvedContract("run-1", { reviewCadence: "per-phase" }));
    await writeFile(join(root, "docs/plans/approved/execution-contract.json"), JSON.stringify(approved));

    const responses = await Promise.all(pathsFor("run-1").map((path) => call(port, { method: "GET", path, headers: { cookie } })));
    expect(responses.map(({ status }) => status)).toEqual([200, 200, 200, 200]);
    expect(JSON.parse(responses[0].body)).toEqual({
      runId: "run-1",
      layer: "validator",
      entries: [{ ...validator, stage: "review", status: "complete", verdict: "PASS" }],
    });
    expect(JSON.parse(responses[1].body)).toEqual({
      runId: "run-1",
      layer: "grader",
      entries: [{ ...grader, stage: "review", status: "complete", verdict: "acceptable", rubricVersion: "1" }],
    });
    expect(JSON.parse(responses[2].body)).toEqual({
      runId: "run-1",
      layer: "park-ranger",
      entries: [{ ...parkRanger, stage: "review", status: "complete", verdict: "repair-required", findingCount: 2 }],
    });
    expect(JSON.parse(responses[3].body)).toEqual({
      runId: "run-1",
      declaredCadence: "per-phase",
      resolvedCadence: { cadence: "per-phase", tightened: false, reasons: [] },
      requiredGates: {
        slice: ["validator"],
        phase: ["validator", "park-ranger", "grader"],
        completion: ["validator", "park-ranger", "grader", "surveyor"],
      },
    });
    for (const response of responses) {
      expect(response.body).not.toContain(cap);
      expect(response.body).not.toContain(cookieValue);
      expect(response.body).not.toContain(root);
    }
  });

  it("keeps the approved cadence contract available after a verification checkpoint without a plan directory", async () => {
    const { port, cap } = await launch();
    const cookie = await exchangeCookie(port, cap);
    const root = await tempRepo();
    await selectRepository(port, cookie, root);
    const store = await seedRun(root, "run-1", "docs/plans/approved");
    await mkdir(join(root, "docs/plans/approved"), { recursive: true });
    const approved = await recordContractApproval(store, approvedContract("run-1", { reviewCadence: "per-phase" }));
    await writeFile(join(root, "docs/plans/approved/execution-contract.json"), JSON.stringify(approved));
    await recordVerificationCheckpoint(store, "run-1", { layer: "validator", verdict: "PASS" });

    const response = await call(port, { method: "GET", path: pathsFor("run-1")[3], headers: { cookie } });

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({
      runId: "run-1",
      declaredCadence: "per-phase",
      resolvedCadence: { cadence: "per-phase" },
    });
  });

  it("records a legal validator checkpoint from real execution and exposes it without losing cadence", async () => {
    const runner = new CheckpointRunner();
    const { port, cap } = await launchHandler(new RepositoryBootstrap(), {
      processRunner: runner,
      verification: { verify: async () => true },
    });
    const cookie = await exchangeCookie(port, cap);
    const root = await tempRepo();
    await new Promise<void>((resolve, reject) => execFile("git", ["init", "-q"], { cwd: root }, (error) => error ? reject(error) : resolve()));
    await selectRepository(port, cookie, root);
    expect((await call(port, {
      method: "POST",
      path: "/api/v1/readiness",
      headers: sessionHeaders(port, { cookie }),
      body: JSON.stringify({ provider: "codex", model: "*", reasoning: "medium" }),
    })).status).toBe(200);
    const runId = "executed-validator-run";
    const planDirectory = `docs/plans/${runId}`;
    const store = await seedRun(root, runId);
    for (const stage of ["set-bearings", "gather-supplies", "map-route", "recon", "draft-implementation"] as const) {
      const response = await call(port, {
        method: "POST",
        path: "/api/v1/journey",
        headers: sessionHeaders(port, { cookie }),
        body: JSON.stringify({ runId, stage, workGoal: "Complete the approved work" }),
      });
      expect(response.status).toBe(200);
      expect(JSON.parse(response.body).status).toBe("action");
    }
    await recordPlanningApproval(store, runId);
    const contract = await recordContractApproval(store, approvedContract(runId, {
      planDirectory,
      reviewCadence: "per-phase",
    }));
    await writeFile(join(root, planDirectory, "execution-contract.json"), JSON.stringify(contract));

    const execution = await call(port, {
      method: "POST",
      path: "/api/v1/journey",
      headers: sessionHeaders(port, { cookie }),
      body: JSON.stringify({
        runId,
        stage: "execute-explorer",
        workGoal: "Complete the approved work",
        executionMode: "explorer",
        reviewCadence: "phase",
      }),
    });
    expect(execution.status).toBe(200);
    expect(JSON.parse(execution.body), execution.body).toMatchObject({
      status: "action",
      verification: { verdict: "PASS", reasons: [], escalation: "none" },
    });

    const checkpoint = (await store.load(runId)).events
      .filter((event) => event.type === "journeyCheckpointRecorded" && event.payload.stage === "execute-explorer")
      .at(-1);
    expect(checkpoint?.payload.verification).toEqual({ layer: "validator", verdict: "PASS", findingCount: 0 });
    expect(checkpoint?.payload.requirementRefs).toEqual(["AC-1.3"]);
    expect(isVerificationCheckpointPayload(checkpoint?.payload.verification)).toBe(true);

    const verification = await call(port, {
      method: "GET",
      path: `/api/v1/runs/${runId}/verification/validator`,
      headers: { cookie },
    });
    expect(verification.status).toBe(200);
    expect(JSON.parse(verification.body)).toMatchObject({
      runId,
      layer: "validator",
      entries: [{ stage: "execute-explorer", verdict: "PASS", findingCount: 0 }],
    });
    expect(JSON.parse(verification.body).entries).toHaveLength(1);

    const review = await call(port, {
      method: "POST",
      path: "/api/v1/journey",
      headers: sessionHeaders(port, { cookie }),
      body: JSON.stringify({ runId, stage: "review", workGoal: "Complete the approved work" }),
    });
    expect(review.status).toBe(200);
    const afterReview = await call(port, {
      method: "GET",
      path: `/api/v1/runs/${runId}/verification/validator`,
      headers: { cookie },
    });
    expect(JSON.parse(afterReview.body).entries).toEqual([
      expect.objectContaining({ stage: "execute-explorer", status: "waiting", verdict: "PASS", findingCount: 0 }),
    ]);

    const cadence = await call(port, {
      method: "GET",
      path: `/api/v1/runs/${runId}/review-cadence`,
      headers: { cookie },
    });
    expect(cadence.status).toBe(200);
    expect(JSON.parse(cadence.body)).toMatchObject({
      runId,
      declaredCadence: "per-phase",
      resolvedCadence: { cadence: "per-phase" },
    });
  });

  it("returns typed failures for an unknown run and refuses a layer-invalid checkpoint before append", async () => {
    const { port, cap } = await launch();
    const cookie = await exchangeCookie(port, cap);
    const root = await tempRepo();
    await selectRepository(port, cookie, root);
    for (const path of pathsFor("missing")) {
      const response = await call(port, { method: "GET", path, headers: { cookie } });
      expect(response.status).toBe(404);
      expect(JSON.parse(response.body)).toEqual({ status: "blocked", code: "run_not_found", remedy: expect.any(String) });
    }

    const store = await seedRun(root, "run-1", "docs/plans/approved");
    const before = await store.load("run-1");
    const recorded = await store.apply({
      schemaVersion: 1,
      commandId: "invalid-grader-verdict",
      runId: "run-1",
      expectedRevision: before.revision,
      type: "recordJourneyCheckpoint",
      payload: {
        stage: "review",
        status: "complete",
        artifacts: [],
        verification: { layer: "grader", verdict: "PASS" },
      },
      session: { sessionId: "test-bearing", actor: "bearing" },
      correlationId: "invalid-grader-verdict",
    } as CommandEnvelopeV1);
    expect(recorded.ok).toBe(false);
    if (recorded.ok) throw new Error("invalid verification checkpoint was appended");
    expect(recorded.reason).toBe("malformed_command");
    const after = await store.load("run-1");
    expect(after.revision).toBe(before.revision);
    expect(after.events).toEqual(before.events);

    const grader = await call(port, { method: "GET", path: pathsFor("run-1")[1], headers: { cookie } });
    expect(grader.status).toBe(200);
    expect(JSON.parse(grader.body)).toEqual({ runId: "run-1", layer: "grader", entries: [] });
    expect(grader.body).not.toContain(cap);
    expect(grader.body).not.toContain(cookie.split("=")[1]);
    expect(grader.body).not.toContain(root);
  });

  it("refuses a self-attested cadence contract without ledger-backed owner approval", async () => {
    const { port, cap } = await launch();
    const cookie = await exchangeCookie(port, cap);
    const root = await tempRepo();
    await selectRepository(port, cookie, root);
    await seedRun(root, "run-1", "docs/plans/approved");
    await mkdir(join(root, "docs/plans/approved"), { recursive: true });
    await writeFile(join(root, "docs/plans/approved/execution-contract.json"), JSON.stringify(approvedContract("run-1")));

    const response = await call(port, { method: "GET", path: pathsFor("run-1")[3], headers: { cookie } });
    expect(response.status).toBe(422);
    expect(JSON.parse(response.body)).toEqual({
      status: "blocked",
      code: "owner_approval_unverified",
      remedy: expect.any(String),
    });
    expect(response.body).not.toContain(cap);
    expect(response.body).not.toContain(cookie.split("=")[1]);
    expect(response.body).not.toContain(root);
  });

  it("rejects every unsupported write method on every projection without mutating the selected repository", async () => {
    const { port, cap } = await launch();
    const cookie = await exchangeCookie(port, cap);
    const root = await tempRepo();
    await selectRepository(port, cookie, root);
    await seedRun(root, "run-1", "docs/plans/approved");
    const before = await treeSnapshot(root);

    for (const path of pathsFor("run-1")) {
      const methods = path.endsWith("/grader") || path.endsWith("/park-ranger")
        ? ["PUT", "PATCH", "DELETE"] as const
        : ["POST", "PUT", "PATCH", "DELETE"] as const;
      for (const method of methods) {
        const response = await call(port, {
          method,
          path,
          headers: { cookie },
        });
        expect(response.status).toBe(404);
        expect(response.body).not.toContain(cap);
        expect(response.body).not.toContain(cookie.split("=")[1]);
      }
    }
    expect(await treeSnapshot(root)).toEqual(before);
  });
});

describe("Phase 5 local runtime wiring", () => {
  it("admits a same-stage retry after the owner stops the active phase", async () => {
    let started!: () => void;
    let release!: () => void;
    const runnerStarted = new Promise<void>((resolve) => { started = resolve; });
    const runnerReleased = new Promise<void>((resolve) => { release = resolve; });
    class OwnerStopRunner extends CheckpointRunner {
      private blocking = true;
      override async run(invocation: ProcessInvocation): Promise<ProcessResult> {
        if (this.blocking && invocation.stdin.includes("Stage: map-route")) {
          this.blocking = false;
          started();
          await runnerReleased;
        }
        return super.run(invocation);
      }
      cancel(): void { release(); }
    }

    const root = await tempRepo();
    const runner = new OwnerStopRunner();
    const { port, cookie } = await readyJourneyHandler(root, runner);
    const runId = "owner-stop-retry";
    const store = await seedRun(root, runId);
    await advanceJourneyStage(store, runId, "set-bearings", "waiting");
    await advanceJourneyStage(store, runId, "gather-supplies", "waiting");
    expect((await store.load(runId)).journeyCheckpoint).toMatchObject({ stage: "gather-supplies", status: "waiting" });
    await mkdir(join(root, `docs/plans/${runId}`), { recursive: true });
    await writeFile(join(root, `docs/plans/${runId}/plan-spec.md`), planFixture);
    const request = {
      method: "POST",
      path: "/api/v1/journey",
      headers: sessionHeaders(port, { cookie }),
      body: JSON.stringify({ runId, stage: "map-route", workGoal: "Complete the approved work" }),
    };

    const pending = call(port, request);
    await runnerStarted;
    const control = await call(port, {
      method: "POST",
      path: "/api/v1/journey/control",
      headers: sessionHeaders(port, { cookie }),
      body: JSON.stringify({ runId, action: "stop" }),
    });
    const stopped = await pending;

    expect(control.status, control.body).toBe(200);
    expect(JSON.parse(control.body)).toEqual({ status: "accepted", action: "stop" });
    expect(JSON.parse(stopped.body)).toMatchObject({ status: "failure", code: "cancelled" });
    expect(runner.calls).toHaveLength(1);

    const retried = await call(port, request);

    expect(retried.status, retried.body).toBe(200);
    expect(JSON.parse(retried.body)).toMatchObject({ status: "action", summary: "Route mapped." });
    expect(JSON.parse(retried.body)).not.toHaveProperty("retryRefusal");
    expect(runner.calls).toHaveLength(2);
  });

  it("still refuses a same-stage retry after an unwarranted agent failure", async () => {
    const root = await tempRepo();
    const runner = new MissingResultRunner();
    const { port, cookie } = await readyJourneyHandler(root, runner);
    const runId = "agent-failure-retry";
    const store = await seedRun(root, runId);
    await advanceJourneyStage(store, runId, "set-bearings", "waiting");
    expect((await store.load(runId)).journeyCheckpoint).toMatchObject({ stage: "set-bearings", status: "waiting" });
    await mkdir(join(root, `docs/plans/${runId}`), { recursive: true });
    const request = {
      method: "POST",
      path: "/api/v1/journey",
      headers: sessionHeaders(port, { cookie }),
      body: JSON.stringify({ runId, stage: "gather-supplies", workGoal: "Complete the approved work" }),
    };

    const failed = await call(port, request);
    expect(JSON.parse(failed.body)).toMatchObject({ status: "failure", code: "result_missing" });
    expect(runner.calls).toHaveLength(3);

    const refused = await call(port, request);

    expect(JSON.parse(refused.body)).toMatchObject({
      status: "failure",
      code: "result_missing",
      retryRefusal: "retry_requires_warrant",
    });
    expect(runner.calls).toHaveLength(3);
  });

  it("reports only the bounded repository-fit diagnostic through recovery and the redacted issue draft", async () => {
    const root = await tempRepo();
    const secret = "agent-secret-payload";
    const malformedReceipt = `BEARING_RESULT ${JSON.stringify({
      kind: "fit",
      ok: true,
      assumption: {
        repository: `${root}/${secret}`,
        planDirectory: "docs/plans/proposed",
        rationale: secret,
        evidence: [{ kind: "manifest", path: `${secret}/package.json`, detail: secret }],
      },
      question: "Confirm the proposed plan directory.",
    })}`;
    const runner = new SyntheticRunner(undefined, Array.from({ length: 3 }, () => ({
      exitCode: 0,
      events: [{ type: "item.completed" as const, data: { content: malformedReceipt } }],
      usage: { tokens: 1 },
    })));
    const { port, cookie } = await readyJourneyHandler(root, runner);
    await seedRun(root, "redacted-fit-diagnostic");
    await mkdir(join(root, "docs/plans/redacted-fit-diagnostic"), { recursive: true });

    const response = await call(port, {
      method: "POST",
      path: "/api/v1/journey",
      headers: sessionHeaders(port, { cookie }),
      body: JSON.stringify({ runId: "redacted-fit-diagnostic", stage: "repository-fit", workGoal: "Inspect the selected repository" }),
    });
    const result = JSON.parse(response.body);
    expect(result).toMatchObject({
      status: "failure",
      code: "fit_malformed",
      fitDiagnostic: { check: "assumption_repository", field: "repository" },
      recovery: {
        status: "stopped",
        code: "fit_malformed",
        fitDiagnostic: { check: "assumption_repository", field: "repository" },
      },
    });
    expect(JSON.stringify(result)).not.toContain(root);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(runner.calls).toHaveLength(3);

    const page = await call(port, { method: "GET", path: "/", headers: { cookie } });
    expect(page.body).toContain('fitDiagnostic.check');
    expect(page.body).toContain('fitDiagnostic.field');
    expect(page.body).toContain('Repository fit check: ');
    expect(page.body).toContain('Repository fit field: ');
    expect(page.body).not.toContain(root);
    expect(page.body).not.toContain(secret);
  });

  it("requires a warrant when the observed failure checkpoint could not be persisted", async () => {
    const root = await tempRepo();
    const runner = new MissingResultRunner();
    const { port, cookie } = await readyJourneyHandler(root, runner);
    const runId = "unpersisted-agent-failure-retry";
    const store = await seedRun(root, runId);
    expect((await call(port, {
      method: "POST",
      path: "/api/v1/journey",
      headers: sessionHeaders(port, { cookie }),
      body: JSON.stringify({ runId, stage: "set-bearings", workGoal: "Complete the approved work" }),
    })).status).toBe(200);
    const originalApply = BearingStore.prototype.apply;
    let rejectFailedCheckpoint = true;
    const apply = vi.spyOn(BearingStore.prototype, "apply").mockImplementation(async function (this: BearingStore, command) {
      if (
        rejectFailedCheckpoint
        && command.type === "recordJourneyCheckpoint"
        && command.payload.status === "failed"
      ) {
        rejectFailedCheckpoint = false;
        throw new Error("simulated final checkpoint persistence failure");
      }
      return originalApply.call(this, command);
    });
    const request = {
      method: "POST",
      path: "/api/v1/journey",
      headers: sessionHeaders(port, { cookie }),
      body: JSON.stringify({ runId, stage: "gather-supplies", workGoal: "Complete the approved work" }),
    };

    try {
      const failed = await call(port, request);
      expect(failed.status, failed.body).toBe(503);
      expect(runner.calls).toHaveLength(3);
      const unpersisted = (await store.load(runId)).journeyCheckpoint;
      expect(unpersisted).toMatchObject({ stage: "gather-supplies", status: "running" });
      expect(unpersisted).not.toHaveProperty("lastResultJson");

      const refused = await call(port, request);

      expect(refused.status, refused.body).toBe(200);
      expect(JSON.parse(refused.body)).toMatchObject({
        status: "failure",
        code: "result_missing",
        retryRefusal: "retry_requires_warrant",
      });
      expect(runner.calls).toHaveLength(3);
    } finally {
      apply.mockRestore();
    }
  });

  it("keeps first-time forward stage progression warrant-free", async () => {
    const root = await tempRepo();
    const runner = new CheckpointRunner();
    const { port, cookie } = await readyJourneyHandler(root, runner);
    const runId = "forward-stage-progression";
    await seedRun(root, runId);
    const request = (stage: "set-bearings" | "gather-supplies") => ({
      method: "POST",
      path: "/api/v1/journey",
      headers: sessionHeaders(port, { cookie }),
      body: JSON.stringify({ runId, stage, workGoal: "Complete the approved work" }),
    });

    const setBearings = await call(port, request("set-bearings"));
    expect(setBearings.status, setBearings.body).toBe(200);
    expect(JSON.parse(setBearings.body)).toMatchObject({ status: "action", summary: "Bearings set locally." });
    expect(runner.calls).toHaveLength(0);

    const gathered = await call(port, request("gather-supplies"));
    expect(gathered.status, gathered.body).toBe(200);
    expect(JSON.parse(gathered.body)).toMatchObject({ status: "action", summary: "Requirements ready." });
    expect(JSON.parse(gathered.body)).not.toHaveProperty("retryRefusal");
    expect(runner.calls).toHaveLength(2);
  });

  it("refuses a return to a failed stage after an intermediate stage hop", async () => {
    const root = await tempRepo();
    const runner = new MissingResultRunner();
    const { port, cookie } = await readyJourneyHandler(root, runner);
    const runId = "stage-hop-failure-retry";
    await seedRun(root, runId);
    const request = (stage: "set-bearings" | "gather-supplies") => ({
      method: "POST",
      path: "/api/v1/journey",
      headers: sessionHeaders(port, { cookie }),
      body: JSON.stringify({ runId, stage, workGoal: "Complete the approved work" }),
    });

    const setBearings = await call(port, request("set-bearings"));
    expect(setBearings.status, setBearings.body).toBe(200);
    expect(JSON.parse(setBearings.body)).toMatchObject({ status: "action", summary: "Bearings set locally." });
    expect(runner.calls).toHaveLength(0);

    const failed = await call(port, request("gather-supplies"));
    expect(JSON.parse(failed.body)).toMatchObject({ status: "failure", code: "result_missing" });
    expect(runner.calls).toHaveLength(3);

    const hopped = await call(port, request("set-bearings"));
    expect(hopped.status, hopped.body).toBe(200);
    expect(JSON.parse(hopped.body)).toMatchObject({ status: "action", summary: "Bearings resumed locally." });
    expect(runner.calls).toHaveLength(3);

    const refused = await call(port, request("gather-supplies"));
    expect(JSON.parse(refused.body)).toMatchObject({
      status: "failure",
      code: "result_missing",
      retryRefusal: "retry_requires_warrant",
    });
    expect(runner.calls).toHaveLength(3);
  });

  it("persists scrubbed activity and warranted retry history, then refuses an unwarranted retry after restart", async () => {
    const root = await tempRepo();
    const runner = new MissingResultRunner();
    const { port, cookie } = await readyJourneyHandler(root, runner);
    const store = await seedRun(root, "runtime-retry");
    await advanceJourneyStage(store, "runtime-retry", "set-bearings", "waiting");
    expect((await store.load("runtime-retry")).journeyCheckpoint).toMatchObject({ stage: "set-bearings", status: "waiting" });
    await mkdir(join(root, "docs/plans/runtime-retry"), { recursive: true });
    const request = {
      method: "POST",
      path: "/api/v1/journey",
      headers: sessionHeaders(port, { cookie }),
      body: JSON.stringify({ runId: "runtime-retry", stage: "gather-supplies", workGoal: "Complete the approved work" }),
    };

    const failed = await call(port, request);

    expect(JSON.parse(failed.body)).toMatchObject({ status: "failure", code: "result_missing" });
    expect(runner.calls).toHaveLength(3);
    let checkpoint = (await store.load("runtime-retry")).journeyCheckpoint;
    expect(checkpoint?.runtimeStateJson).toBeTypeOf("string");
    expect(checkpoint?.runtimeStateJson).not.toContain("unscrubbed-value");
    let runtime = parseRuntimeState(checkpoint!.runtimeStateJson!);
    expect(runtime.ok).toBe(true);
    if (!runtime.ok) throw new Error(runtime.reason);
    expect(runtime.value.trace).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "tool.completed", tool: "shell" }),
    ]));
    expect(runtime.value.trace.every((entry) => entry.status !== "token=unscrubbed-value")).toBe(true);
    expect(runtime.value.retry.map(({ warrant, outcome }) => ({ warrant, outcome }))).toEqual([
      { warrant: "new_hypothesis", outcome: "admitted" },
      { warrant: "changed_strategy", outcome: "admitted" },
    ]);
    expect(runtime.value.concurrency).toMatchObject({ admittedLanes: ["gather-supplies"], cap: 1, controller: "explorer" });

    await closeLatestServer();
    const resumedRunner = new MissingResultRunner();
    const resumed = await readyJourneyHandler(root, resumedRunner);
    const history = await call(resumed.port, { method: "GET", path: "/api/v1/history", headers: { cookie: resumed.cookie } });
    expect(history.status).toBe(200);
    expect(JSON.parse(history.body).history).toEqual(expect.arrayContaining([
      expect.objectContaining({ runId: "runtime-retry", retryHistoryLength: 2 }),
    ]));

    const refused = await call(resumed.port, {
      ...request,
      headers: sessionHeaders(resumed.port, { cookie: resumed.cookie }),
    });

    expect(JSON.parse(refused.body)).toMatchObject({
      status: "failure",
      code: "result_missing",
      retryRefusal: "retry_requires_warrant",
    });
    expect(resumedRunner.calls).toHaveLength(0);
    checkpoint = (await store.load("runtime-retry")).journeyCheckpoint;
    runtime = parseRuntimeState(checkpoint!.runtimeStateJson!);
    expect(runtime.ok).toBe(true);
    if (!runtime.ok) throw new Error(runtime.reason);
    expect(runtime.value.retry.at(-1)).toMatchObject({ warrant: null, outcome: "retry_requires_warrant" });
  });

  it("clears a dead provider session and preserves the continuity-lost disclosure across restart", async () => {
    const root = await tempRepo();
    const runner = new UnavailableSessionRunner();
    const { port, cookie } = await readyJourneyHandler(root, runner);
    const store = await seedRun(root, "lost-session");
    await advanceJourneyStage(store, "lost-session", "set-bearings", "waiting");
    expect((await store.load("lost-session")).journeyCheckpoint).toMatchObject({ stage: "set-bearings", status: "waiting" });
    await mkdir(join(root, "docs/plans/lost-session"), { recursive: true });

    const first = await call(port, {
      method: "POST",
      path: "/api/v1/journey",
      headers: sessionHeaders(port, { cookie }),
      body: JSON.stringify({ runId: "lost-session", stage: "gather-supplies", workGoal: "Complete the approved work" }),
    });
    expect(JSON.parse(first.body)).toMatchObject({ status: "question", question: "Continue?" });
    expect((await store.load("lost-session")).journeyCheckpoint?.providerSessionId).toBe("019f8d4e-a637-7e71-8c76-af9d7ec91adf");
    await recordPendingAnswer(store, "lost-session", "Continue", "continue");

    const unavailable = await call(port, {
      method: "POST",
      path: "/api/v1/journey",
      headers: sessionHeaders(port, { cookie }),
      body: JSON.stringify({ runId: "lost-session", stage: "gather-supplies", workGoal: "Complete the approved work", answer: "Continue" }),
    });

    expect(unavailable.status, unavailable.body).toBe(200);
    expect(JSON.parse(unavailable.body)).toMatchObject({
      status: "failure",
      code: "session_unavailable",
      continuityLost: true,
      continuityDisclosure: expect.stringContaining("prior provider conversation is unavailable"),
    });
    let checkpoint = (await store.load("lost-session")).journeyCheckpoint;
    expect(checkpoint).not.toHaveProperty("providerSessionId");
    let runtime = parseRuntimeState(checkpoint!.runtimeStateJson!);
    expect(runtime).toMatchObject({ ok: true, value: { sessionContinuity: "lost" } });

    await closeLatestServer();
    const resumed = await readyJourneyHandler(root, new CheckpointRunner());
    const history = await call(resumed.port, { method: "GET", path: "/api/v1/history", headers: { cookie: resumed.cookie } });
    expect(JSON.parse(history.body).history).toEqual(expect.arrayContaining([
      expect.objectContaining({
        runId: "lost-session",
        continuityLost: true,
        continuityDisclosure: expect.stringContaining("context may need to be supplied again"),
      }),
    ]));
    const status = await call(resumed.port, {
      method: "GET",
      path: "/api/v1/journey/lost-session/status",
      headers: { cookie: resumed.cookie },
    });
    expect(JSON.parse(status.body).run).toMatchObject({
      continuityLost: true,
      continuityDisclosure: expect.stringContaining("prior provider conversation is unavailable"),
    });
    checkpoint = (await store.load("lost-session")).journeyCheckpoint;
    runtime = parseRuntimeState(checkpoint!.runtimeStateJson!);
    expect(runtime).toMatchObject({ ok: true, value: { sessionContinuity: "lost" } });
  });

  it("surfaces Focus drift and forwards an explicit owner amendment confirmation with its warrant", async () => {
    const root = await tempRepo();
    await new Promise<void>((resolve, reject) => execFile("git", ["init", "-q"], { cwd: root }, (error) => error ? reject(error) : resolve()));
    const runner = new FocusAmendmentRunner();
    const { port, cookie } = await readyJourneyHandler(root, runner);
    const runId = "focus-amendment";
    const planDirectory = `docs/plans/${runId}`;
    const store = await seedRun(root, runId);
    for (const stage of ["set-bearings", "gather-supplies", "map-route", "recon", "draft-implementation"] as const) {
      const response = await call(port, {
        method: "POST",
        path: "/api/v1/journey",
        headers: sessionHeaders(port, { cookie }),
        body: JSON.stringify({ runId, stage, workGoal: "Complete the approved work" }),
      });
      expect(response.status).toBe(200);
    }
    await recordPlanningApproval(store, runId);

    const drift = await call(port, {
      method: "POST",
      path: "/api/v1/journey",
      headers: sessionHeaders(port, { cookie }),
      body: JSON.stringify({
        runId,
        stage: "execute-explorer",
        workGoal: "Complete the approved work",
        executionMode: "explorer",
        reviewCadence: "phase",
      }),
    });

    expect(JSON.parse(drift.body)).toMatchObject({
      status: "failure",
      code: "focus_amendment_required",
      focusDrift: { changedPlanSources: ["implementation.md"] },
      amendmentPrompt: expect.stringContaining("Confirm the Focus amendment"),
    });
    expect(runner.executionCalls).toBe(1);

    const sourceNames = ["plan-spec.md", "design.md", "seit.md", "implementation.md"] as const;
    const sourceContents = await Promise.all(sourceNames.map((name) => readFile(join(root, planDirectory, name), "utf8")));
    await writeFile(
      join(root, planDirectory, "review.html"),
      renderPlanningReview(sourceNames.map((name, index) => [name, sourceContents[index]!])),
    );
    const verdict = await currentPlanningVerdict(root, planDirectory);
    expect(verdict?.verdict).toBe("PASS");
    let durable = await store.load(runId);
    const validationCheckpoint = await store.apply({
      schemaVersion: 1,
      commandId: "checkpoint-focus-amendment-validation",
      runId,
      expectedRevision: durable.revision,
      type: "recordJourneyCheckpoint",
      payload: {
        stage: "draft-implementation",
        status: "waiting",
        artifacts: [],
        planDirectory,
        lastResultJson: JSON.stringify({
          status: "action",
          summary: "Amended planning package validated.",
          artifacts: [],
          tokens: 0,
          planningValidation: verdict,
        }),
      },
      session: { sessionId: "test-bearing", actor: "bearing" },
      correlationId: "checkpoint-focus-amendment-validation",
    });
    if (!validationCheckpoint.ok) throw new Error(validationCheckpoint.reason);
    await recordPlanningApproval(store, runId, "amendment");
    expect((await currentPlanningVerdict(root, planDirectory))?.checkedContentHash).toBe(verdict?.checkedContentHash);

    const confirmed = await call(port, {
      method: "POST",
      path: "/api/v1/journey",
      headers: sessionHeaders(port, { cookie }),
      body: JSON.stringify({
        runId,
        stage: "execute-explorer",
        workGoal: "Complete the approved work",
        executionMode: "explorer",
        reviewCadence: "phase",
        focusAmendmentConfirmed: true,
      }),
    });

    expect(confirmed.status, confirmed.body).toBe(200);
    expect(JSON.parse(confirmed.body).status, confirmed.body).toBe("action");
    expect(JSON.parse(confirmed.body)).toMatchObject({ status: "action", summary: "Execution complete." });
    expect(runner.executionCalls).toBe(2);
    durable = await store.load(runId);
    const runtime = parseRuntimeState(durable.journeyCheckpoint!.runtimeStateJson!);
    expect(runtime.ok).toBe(true);
    if (!runtime.ok) throw new Error(runtime.reason);
    expect(runtime.value.retry).toEqual(expect.arrayContaining([
      expect.objectContaining({ warrant: "approved_amendment", outcome: "admitted" }),
    ]));
  });

  it("restores an escalation target from the persisted retry outcome", async () => {
    const root = await tempRepo();
    await readyJourneyHandler(root, new CheckpointRunner());
    await closeLatestServer();
    const store = await seedRun(root, "escalated-retry");
    const durable = await store.load("escalated-retry");
    const fingerprint = "a".repeat(64);
    const recorded = await store.apply({
      schemaVersion: 1,
      commandId: "checkpoint-escalated-retry",
      runId: "escalated-retry",
      expectedRevision: durable.revision,
      type: "recordJourneyCheckpoint",
      payload: {
        ...fitCheckpointPayload(root, "docs/plans/escalated-retry"),
        stage: "map-route",
        status: "failed",
        lastResultJson: JSON.stringify({ status: "failure", code: "result_missing", tokens: 0 }),
        runtimeStateJson: JSON.stringify({
          version: 1,
          trace: [],
          retry: [
            { fingerprint, warrant: "new_hypothesis", reasoningTier: "medium", outcome: "admitted" },
            { fingerprint, warrant: "changed_strategy", reasoningTier: "medium", outcome: "admitted" },
            { fingerprint, warrant: "new_evidence", reasoningTier: "medium", outcome: "admitted" },
            { fingerprint, warrant: "changed_strategy", reasoningTier: "medium", outcome: "escalation_required" },
          ],
          sessionContinuity: "intact",
        }),
      },
      session: { sessionId: "test-bearing", actor: "bearing" },
      correlationId: "checkpoint-escalated-retry",
    });
    if (!recorded.ok) throw new Error(recorded.reason);
    const { port, cookie } = await readyJourneyHandler(root, new CheckpointRunner());

    const history = await call(port, { method: "GET", path: "/api/v1/history", headers: { cookie } });

    expect(JSON.parse(history.body).history).toEqual(expect.arrayContaining([
      expect.objectContaining({
        runId: "escalated-retry",
        escalationTarget: "trail-boss",
        retryHistoryLength: 4,
      }),
    ]));
  });
});

describe("planning-state checkpoint integration", () => {
  it("keeps the journey endpoint bound and rejects every write-capable stage before fit without invoking the runner", async () => {
    const runner = new CheckpointRunner();
    const { port, cap } = await launchHandler(new RepositoryBootstrap(), {
      processRunner: runner,
      verification: { verify: async () => true },
    });
    const body = JSON.stringify({ runId: "fit-required", stage: "set-bearings", workGoal: "Do not write yet" });
    expect((await call(port, {
      method: "POST",
      path: "/api/v1/journey",
      headers: sessionHeaders(port),
      body,
    })).status).toBe(401);
    const cookie = await exchangeCookie(port, cap);
    expect((await call(port, {
      method: "POST",
      path: "/api/v1/journey",
      headers: sessionHeaders(port, { cookie, origin: "https://evil.example" }),
      body,
    })).status).toBe(403);
    expect((await call(port, {
      method: "POST",
      path: "/api/v1/journey",
      headers: sessionHeaders(port, { cookie }),
      body,
    })).status).toBe(409);

    const root = await tempRepo();
    await selectRepository(port, cookie, root);
    expect((await call(port, {
      method: "POST",
      path: "/api/v1/readiness",
      headers: sessionHeaders(port, { cookie }),
      body: JSON.stringify({ provider: "codex", model: "*", reasoning: "medium" }),
    })).status).toBe(200);
    const store = new BearingStore(root);
    const attempts = [
      { runId: "fit-required", stage: "set-bearings" },
      { runId: "map-fit-required", stage: "map-route" },
      { runId: "draft-fit-required", stage: "draft-implementation" },
      { runId: "declined-fit-required", stage: "map-route", declined: true },
    ] as const;
    for (const { runId, ...attempt } of attempts) {
      const created = await store.apply({
        schemaVersion: 1,
        commandId: `create-${runId}`,
        runId,
        expectedRevision: 0,
        type: "createWorkRequest",
        payload: { title: "Do not write yet", goal: "Do not write yet" },
        session: { sessionId: "test-owner", actor: "owner" },
        correlationId: `create-${runId}`,
      });
      if (!created.ok) throw new Error(created.reason);
      if ("declined" in attempt) {
        const checkpoint = await store.apply({
          schemaVersion: 1,
          commandId: `decline-${runId}`,
          runId,
          expectedRevision: created.state.revision,
          type: "recordJourneyCheckpoint",
          payload: { stage: "repository-fit", status: "stopped", artifacts: [], repositoryFitDecision: { outcome: "declined" } },
          session: { sessionId: "test-bearing", actor: "bearing" },
          correlationId: `decline-${runId}`,
        });
        if (!checkpoint.ok) throw new Error(checkpoint.reason);
      }
    }
    const before = await treeSnapshot(root);

    const rejected: Resp[] = [];
    for (const attempt of attempts) {
      rejected.push(await call(port, {
        method: "POST",
        path: "/api/v1/journey",
        headers: sessionHeaders(port, { cookie }),
        body: JSON.stringify({ runId: attempt.runId, stage: attempt.stage, workGoal: "Do not write yet" }),
      }));
    }
    expect(rejected.map(({ status }) => status)).toEqual([409, 409, 409, 409]);
    for (const response of rejected) {
      expect(JSON.parse(response.body)).toEqual({ status: "failure", code: "input_invalid", tokens: 0 });
    }
    expect(await treeSnapshot(root)).toEqual(before);
    expect(runner.calls).toHaveLength(0);
  });

  it("resumes a pre-fit-schema checkpoint that already has a valid plan directory", async () => {
    const runner = new CheckpointRunner();
    const { port, cap } = await launchHandler(new RepositoryBootstrap(), {
      processRunner: runner,
      verification: { verify: async () => true },
    });
    const cookie = await exchangeCookie(port, cap);
    const root = await tempRepo();
    await selectRepository(port, cookie, root);
    expect((await call(port, {
      method: "POST",
      path: "/api/v1/readiness",
      headers: sessionHeaders(port, { cookie }),
      body: JSON.stringify({ provider: "codex", model: "*", reasoning: "medium" }),
    })).status).toBe(200);
    const store = new BearingStore(root);
    const runId = "legacy-plan-directory";
    const planDirectory = "docs/plans/legacy-plan-directory";
    const created = await store.apply({
      schemaVersion: 1,
      commandId: `create-${runId}`,
      runId,
      expectedRevision: 0,
      type: "createWorkRequest",
      payload: { title: "Resume legacy plan", goal: "Resume legacy plan" },
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
        stage: "gather-supplies",
        status: "waiting",
        artifacts: [],
        planDirectory,
        selectionProvider: "codex",
        selectionModel: "*",
        selectionReasoning: "medium",
      },
      session: { sessionId: "test-bearing", actor: "bearing" },
      correlationId: `checkpoint-${runId}`,
    });
    if (!checkpoint.ok) throw new Error(checkpoint.reason);
    await mkdir(join(root, planDirectory), { recursive: true });
    expect((await call(port, { method: "GET", path: "/api/v1/history", headers: { cookie } })).status).toBe(200);

    const resumed = await call(port, {
      method: "POST",
      path: "/api/v1/journey",
      headers: sessionHeaders(port, { cookie }),
      body: JSON.stringify({ runId, stage: "gather-supplies", workGoal: "Resume legacy plan" }),
    });

    expect(resumed.status).toBe(200);
    expect(JSON.parse(resumed.body)).toMatchObject({ status: "action", artifacts: [`${planDirectory}/plan-spec.md`] });
    expect(runner.calls.length).toBeGreaterThan(0);
  });

  it("records the fit decision before Set Bearings and creates only the confirmed path", async () => {
    const root = await tempRepo();
    const planDirectory = "docs/plans/server-spine/confirmed";
    const question = "Use the selected repository and proposed plan directory?";
    const runner = new SyntheticRunner(undefined, [{
      exitCode: 0,
      events: [{
        type: "item.completed",
        data: {
          content: `BEARING_RESULT ${JSON.stringify({
            kind: "fit",
            ok: true,
            assumption: {
              repository: root,
              planDirectory,
              rationale: "The selected repository contains the requested server.",
              evidence: [{ kind: "manifest", path: "package.json", detail: "The package manifest identifies the server project." }],
            },
            question,
          })}`,
        },
      }],
      usage: { tokens: 1 },
    }]);
    const { port, cap } = await launchHandler(new RepositoryBootstrap(), {
      processRunner: runner,
      verification: { verify: async () => true },
    });
    const cookie = await exchangeCookie(port, cap);
    await selectRepository(port, cookie, root);
    expect((await call(port, {
      method: "POST",
      path: "/api/v1/readiness",
      headers: sessionHeaders(port, { cookie }),
      body: JSON.stringify({ provider: "codex", model: "*", reasoning: "medium" }),
    })).status).toBe(200);
    const store = new BearingStore(root);
    const created = await store.apply({
      schemaVersion: 1,
      commandId: "create-fit-flow",
      runId: "fit-flow",
      expectedRevision: 0,
      type: "createWorkRequest",
      payload: { title: "Build the server spine", goal: "Build the server spine" },
      session: { sessionId: "test-owner", actor: "owner" },
      correlationId: "create-fit-flow",
    });
    if (!created.ok) throw new Error(created.reason);

    const proposed = await call(port, {
      method: "POST",
      path: "/api/v1/journey",
      headers: sessionHeaders(port, { cookie }),
      body: JSON.stringify({ runId: "fit-flow", stage: "repository-fit", workGoal: "Build the server spine" }),
    });
    expect(JSON.parse(proposed.body)).toMatchObject({
      status: "question",
      question,
      fitAssumption: { repository: root, planDirectory },
    });

    let durable = await store.load("fit-flow");
    if (!durable.pendingDecision) throw new Error("fit decision missing");
    const answered = await store.apply({
      schemaVersion: 1,
      commandId: "answer-fit-flow",
      runId: "fit-flow",
      expectedRevision: durable.revision,
      type: "recordOwnerAnswer",
      payload: { decisionId: durable.pendingDecision.decisionId, answer: "Confirm" },
      session: { sessionId: "test-owner", actor: "owner" },
      correlationId: "answer-fit-flow",
    });
    if (!answered.ok) throw new Error(answered.reason);
    const confirmed = await call(port, {
      method: "POST",
      path: "/api/v1/journey",
      headers: sessionHeaders(port, { cookie }),
      body: JSON.stringify({ runId: "fit-flow", stage: "repository-fit", workGoal: "Build the server spine", answer: "Confirm" }),
    });
    expect(JSON.parse(confirmed.body)).toMatchObject({ status: "action", artifacts: [], tokens: 0 });

    durable = await store.load("fit-flow");
    expect(durable.journeyCheckpoint).toMatchObject({
      stage: "repository-fit",
      repositoryFitDecision: { outcome: "confirmed", repository: root, planDirectory },
      resolvedPlanDirectory: planDirectory,
      planDirectory,
    });
    expect(JSON.parse((await call(port, {
      method: "GET",
      path: "/api/v1/runs/fit-flow/planning-state",
      headers: { cookie },
    })).body)).toEqual({ runId: "fit-flow", planningState: "DRAFT" });

    const setBearings = await call(port, {
      method: "POST",
      path: "/api/v1/journey",
      headers: sessionHeaders(port, { cookie }),
      body: JSON.stringify({ runId: "fit-flow", stage: "set-bearings", workGoal: "Build the server spine" }),
    });
    expect(JSON.parse(setBearings.body)).toMatchObject({
      status: "action",
      artifacts: [`${planDirectory}/prompts/repository-map.md`, `${planDirectory}/plan-spec.md`],
      tokens: 0,
    });
    expect(await readFile(join(root, planDirectory, "plan-spec.md"), "utf8")).toContain("type: plan-spec");
    expect(runner.calls).toHaveLength(1);
  });

  it("presents duplicate consolidation without writing and applies it only after the recorded owner decision", async () => {
    const root = await tempRepo();
    await mkdir(join(root, "docs/plans/one/shared"), { recursive: true });
    await mkdir(join(root, "docs/plans/two/shared"), { recursive: true });
    await writeFile(join(root, "docs/plans/one/shared/kept.md"), "canonical");
    await writeFile(join(root, "docs/plans/two/shared/copied.md"), "source");
    const { port, cookie, store } = await beginFitFlow(root, "ambiguous-fit");
    await recordPendingAnswer(store, "ambiguous-fit", "shared", "bare");
    const before = await treeSnapshot(join(root, "docs/plans"));

    const ambiguous = await call(port, {
      method: "POST",
      path: "/api/v1/journey",
      headers: sessionHeaders(port, { cookie }),
      body: JSON.stringify({ runId: "ambiguous-fit", stage: "repository-fit", workGoal: "Resume shared", answer: "shared" }),
    });

    expect(JSON.parse(ambiguous.body)).toMatchObject({ status: "question", tokens: 0 });
    expect(ambiguous.body).toContain("docs/plans/one/shared");
    expect(ambiguous.body).toContain("docs/plans/two/shared");
    expect(await treeSnapshot(join(root, "docs/plans"))).toEqual(before);
    let durable = await store.load("ambiguous-fit");
    expect(durable.journeyCheckpoint).not.toHaveProperty("repositoryFitDecision");
    expect(durable.journeyCheckpoint).not.toHaveProperty("resolvedPlanDirectory");

    await recordPendingAnswer(store, "ambiguous-fit", "docs/plans/one/shared", "canonical");
    const recommendation = await call(port, {
      method: "POST",
      path: "/api/v1/journey",
      headers: sessionHeaders(port, { cookie }),
      body: JSON.stringify({ runId: "ambiguous-fit", stage: "repository-fit", workGoal: "Resume shared", answer: "docs/plans/one/shared" }),
    });
    expect(JSON.parse(recommendation.body)).toMatchObject({
      status: "question",
      consolidation: {
        ok: true,
        canonical: "docs/plans/one/shared",
        sources: ["docs/plans/two/shared"],
        entries: [{ action: "copy", source: "docs/plans/two/shared/copied.md", destination: "docs/plans/one/shared/copied.md" }],
      },
    });
    expect(await treeSnapshot(join(root, "docs/plans"))).toEqual(before);

    const unrecorded = await call(port, {
      method: "POST",
      path: "/api/v1/journey",
      headers: sessionHeaders(port, { cookie }),
      body: JSON.stringify({ runId: "ambiguous-fit", stage: "repository-fit", workGoal: "Resume shared", answer: "Approve consolidation" }),
    });
    expect(unrecorded.status).toBe(409);
    expect(await treeSnapshot(join(root, "docs/plans"))).toEqual(before);

    await recordPendingAnswer(store, "ambiguous-fit", "Approve consolidation", "approve");
    const applied = await call(port, {
      method: "POST",
      path: "/api/v1/journey",
      headers: sessionHeaders(port, { cookie }),
      body: JSON.stringify({ runId: "ambiguous-fit", stage: "repository-fit", workGoal: "Resume shared", answer: "Approve consolidation" }),
    });
    expect(JSON.parse(applied.body)).toMatchObject({
      status: "action",
      consolidation: {
        ok: true,
        copied: ["docs/plans/one/shared/copied.md"],
        sources: ["docs/plans/two/shared"],
      },
    });
    expect(await readFile(join(root, "docs/plans/one/shared/copied.md"), "utf8")).toBe("source");
    expect(await readFile(join(root, "docs/plans/two/shared/copied.md"), "utf8")).toBe("source");
    durable = await store.load("ambiguous-fit");
    expect(durable.journeyCheckpoint).toMatchObject({
      repositoryFitDecision: { outcome: "redirected", planDirectory: "docs/plans/one/shared" },
      resolvedPlanDirectory: "docs/plans/one/shared",
    });
  });

  it("keeps a failed consolidation approval answerable for retry", async () => {
    const root = await tempRepo();
    const canonical = join(root, "docs/plans/one/shared");
    const source = join(root, "docs/plans/two/shared");
    await mkdir(canonical, { recursive: true });
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "copied.md"), "source");
    const { port, cookie, store } = await beginFitFlow(root, "retry-fit");
    const request = (answer: string) => call(port, {
      method: "POST",
      path: "/api/v1/journey",
      headers: sessionHeaders(port, { cookie }),
      body: JSON.stringify({ runId: "retry-fit", stage: "repository-fit", workGoal: "Resume shared", answer }),
    });
    await recordPendingAnswer(store, "retry-fit", "shared", "bare");
    await request("shared");
    await recordPendingAnswer(store, "retry-fit", "docs/plans/one/shared", "canonical");
    await request("docs/plans/one/shared");
    await recordPendingAnswer(store, "retry-fit", "Approve consolidation", "approve");
    await rm(source, { recursive: true });

    const failed = await request("Approve consolidation");
    expect(failed.status).toBe(422);
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "copied.md"), "source");
    const retried = await request("Approve consolidation");

    expect(retried.status).toBe(200);
    expect(JSON.parse(retried.body)).toMatchObject({ status: "action" });
    expect(await readFile(join(canonical, "copied.md"), "utf8")).toBe("source");
  });

  it("refuses consolidation when approved source content changes", async () => {
    const root = await tempRepo();
    const canonical = join(root, "docs/plans/one/shared");
    const source = join(root, "docs/plans/two/shared");
    await mkdir(canonical, { recursive: true });
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "copied.md"), "approved source");
    const { port, cookie, store } = await beginFitFlow(root, "content-bound-fit");
    const request = (answer: string) => call(port, {
      method: "POST",
      path: "/api/v1/journey",
      headers: sessionHeaders(port, { cookie }),
      body: JSON.stringify({ runId: "content-bound-fit", stage: "repository-fit", workGoal: "Resume shared", answer }),
    });
    await recordPendingAnswer(store, "content-bound-fit", "shared", "bare");
    await request("shared");
    await recordPendingAnswer(store, "content-bound-fit", "docs/plans/one/shared", "canonical");
    const recommendation = await request("docs/plans/one/shared");
    await recordPendingAnswer(store, "content-bound-fit", "Approve consolidation", "approve");
    await writeFile(join(source, "copied.md"), "changed after approval question");
    const before = await treeSnapshot(join(root, "docs/plans"));

    const refused = await request("Approve consolidation");

    expect(JSON.parse(recommendation.body).consolidation.sourceContentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.parse(refused.body)).toMatchObject({ status: "question" });
    expect(await treeSnapshot(join(root, "docs/plans"))).toEqual(before);
    await expect(access(join(canonical, "copied.md"))).rejects.toBeDefined();
  });

  it("returns a typed consolidation conflict and leaves every byte unchanged", async () => {
    const root = await tempRepo();
    await mkdir(join(root, "docs/plans/one/shared"), { recursive: true });
    await mkdir(join(root, "docs/plans/two/shared"), { recursive: true });
    await writeFile(join(root, "docs/plans/one/shared/conflict.md"), "canonical");
    await writeFile(join(root, "docs/plans/two/shared/conflict.md"), "source");
    const { port, cookie, store } = await beginFitFlow(root, "conflict-fit");
    await recordPendingAnswer(store, "conflict-fit", "shared", "bare");
    await call(port, {
      method: "POST",
      path: "/api/v1/journey",
      headers: sessionHeaders(port, { cookie }),
      body: JSON.stringify({ runId: "conflict-fit", stage: "repository-fit", workGoal: "Resume shared", answer: "shared" }),
    });
    await recordPendingAnswer(store, "conflict-fit", "docs/plans/one/shared", "canonical");
    const before = await treeSnapshot(join(root, "docs/plans"));

    const conflict = await call(port, {
      method: "POST",
      path: "/api/v1/journey",
      headers: sessionHeaders(port, { cookie }),
      body: JSON.stringify({ runId: "conflict-fit", stage: "repository-fit", workGoal: "Resume shared", answer: "docs/plans/one/shared" }),
    });

    expect(JSON.parse(conflict.body)).toMatchObject({
      status: "question",
      consolidation: {
        ok: false,
        reason: "consolidation_conflict",
        canonical: "docs/plans/one/shared",
        sources: ["docs/plans/two/shared"],
        entries: [{ action: "conflict", source: "docs/plans/two/shared/conflict.md", destination: "docs/plans/one/shared/conflict.md" }],
      },
    });
    expect(await treeSnapshot(join(root, "docs/plans"))).toEqual(before);
    expect(await readFile(join(root, "docs/plans/two/shared/conflict.md"), "utf8")).toBe("source");
  });

  it("uses the confirmed resolved path instead of a stale artifact-derived plan directory", async () => {
    const runner = new CheckpointRunner();
    const { port, cap } = await launchHandler(new RepositoryBootstrap(), {
      processRunner: runner,
      verification: { verify: async () => true },
    });
    const cookie = await exchangeCookie(port, cap);
    const root = await tempRepo();
    await selectRepository(port, cookie, root);
    expect((await call(port, {
      method: "POST",
      path: "/api/v1/readiness",
      headers: sessionHeaders(port, { cookie }),
      body: JSON.stringify({ provider: "codex", model: "*", reasoning: "medium" }),
    })).status).toBe(200);
    const store = new BearingStore(root);
    const created = await store.apply({
      schemaVersion: 1,
      commandId: "create-authoritative-path",
      runId: "authoritative-path",
      expectedRevision: 0,
      type: "createWorkRequest",
      payload: { title: "Use the decision", goal: "Use the decision" },
      session: { sessionId: "test-owner", actor: "owner" },
      correlationId: "create-authoritative-path",
    });
    if (!created.ok) throw new Error(created.reason);
    const confirmedPath = "docs/plans/authoritative-path";
    const staleArtifactPath = "docs/plans/stale-artifact-path";
    const checkpoint = await store.apply({
      schemaVersion: 1,
      commandId: "fit-authoritative-path",
      runId: "authoritative-path",
      expectedRevision: created.state.revision,
      type: "recordJourneyCheckpoint",
      payload: { ...fitCheckpointPayload(root, confirmedPath), planDirectory: staleArtifactPath },
      session: { sessionId: "test-bearing", actor: "bearing" },
      correlationId: "fit-authoritative-path",
    });
    if (!checkpoint.ok) throw new Error(checkpoint.reason);

    const response = await call(port, {
      method: "POST",
      path: "/api/v1/journey",
      headers: sessionHeaders(port, { cookie }),
      body: JSON.stringify({ runId: "authoritative-path", stage: "set-bearings", workGoal: "Use the decision" }),
    });

    expect(JSON.parse(response.body)).toMatchObject({
      status: "action",
      artifacts: expect.arrayContaining([`${confirmedPath}/plan-spec.md`]),
    });
    expect(await readFile(join(root, confirmedPath, "plan-spec.md"), "utf8")).toContain("type: plan-spec");
    await expect(access(join(root, staleArtifactPath))).rejects.toBeDefined();
    expect((await store.load("authoritative-path")).journeyCheckpoint?.planDirectory).toBe(confirmedPath);
  });

  it("resumes a legacy provider-native checkpoint at the equivalent abstract reasoning tier", async () => {
    const thread = "019f8d4e-a637-7e71-8c76-af9d7ec91adf";
    const runner = new CheckpointRunner();
    const { port, cap } = await launchHandler(new RepositoryBootstrap(), {
      processRunner: runner,
      verification: { verify: async () => true },
    });
    const cookie = await exchangeCookie(port, cap);
    const root = await tempRepo();
    await selectRepository(port, cookie, root);
    const store = await seedRun(root, "restored-session");
    await mkdir(join(root, "docs/plans/restored-session"), { recursive: true });
    const durable = await store.load("restored-session");
    const checkpoint = await store.apply({
      schemaVersion: 1,
      commandId: "checkpoint-restored-session",
      runId: "restored-session",
      expectedRevision: durable.revision,
      type: "recordJourneyCheckpoint",
      payload: { stage: "gather-supplies", status: "waiting", artifacts: [], selectionProvider: "codex", selectionModel: "*", selectionReasoning: "xhigh", providerSessionId: thread },
      session: { sessionId: "test-bearing", actor: "bearing" },
      correlationId: "checkpoint-restored-session",
    });
    if (!checkpoint.ok) {
      throw new Error(checkpoint.reason);
    }
    const readiness = await call(port, {
      method: "POST",
      path: "/api/v1/readiness",
      headers: sessionHeaders(port, { cookie }),
      body: JSON.stringify({ provider: "codex", model: "*", reasoning: "xhigh" }),
    });
    expect(readiness.status).toBe(200);
    expect((await call(port, { method: "GET", path: "/api/v1/history", headers: { cookie } })).status).toBe(200);

    const resumed = await call(port, {
      method: "POST",
      path: "/api/v1/journey",
      headers: sessionHeaders(port, { cookie }),
      body: JSON.stringify({ runId: "restored-session", stage: "gather-supplies", workGoal: "Complete the approved work" }),
    });

    expect(resumed.status).toBe(200);
    expect(runner.calls.length).toBeGreaterThan(0);
    for (const invocation of runner.calls) {
      expect(invocation.args).toEqual(expect.arrayContaining(["exec", "resume", thread]));
      expect(invocation.args).toContain('model_reasoning_effort="medium"');
      expect(invocation.args).not.toContain('model_reasoning_effort="xhigh"');
    }
    expect((await store.load("restored-session")).journeyCheckpoint).toMatchObject({ selectionReasoning: "very-high", providerSessionId: thread });
  });

  it("derives the browser planning progression through Recon without falsifying waiting stage status", async () => {
    const runner = new CheckpointRunner();
    const { port, cap } = await launchHandler(new RepositoryBootstrap(), {
      processRunner: runner,
      verification: { verify: async () => true },
    });
    const cookie = await exchangeCookie(port, cap);
    const root = await tempRepo();
    await selectRepository(port, cookie, root);
    const readiness = await call(port, {
      method: "POST",
      path: "/api/v1/readiness",
      headers: sessionHeaders(port, { cookie }),
      body: JSON.stringify({ provider: "codex", model: "*", reasoning: "medium" }),
    });
    expect(readiness.status).toBe(200);
    expect(JSON.parse(readiness.body).status).toBe("ready");
    const store = await seedRun(root, "checkpoint-run");

    const setBearings = await call(port, {
      method: "POST",
      path: "/api/v1/journey",
      headers: sessionHeaders(port, { cookie }),
      body: JSON.stringify({ runId: "checkpoint-run", stage: "set-bearings", workGoal: "Complete the approved work" }),
    });
    expect(setBearings.status).toBe(200);
    const afterSetBearings = await store.load("checkpoint-run");
    const setBearingsCheckpoint = afterSetBearings.events.filter((event) => event.type === "journeyCheckpointRecorded" && event.payload.stage === "set-bearings").at(-1);
    expect(setBearingsCheckpoint?.payload.status).toBe("waiting");
    expect(setBearingsCheckpoint?.payload).not.toHaveProperty("planningState");
    expect(setBearingsCheckpoint?.payload).not.toHaveProperty("planningFailure");

    const gathered = await call(port, {
      method: "POST",
      path: "/api/v1/journey",
      headers: sessionHeaders(port, { cookie }),
      body: JSON.stringify({ runId: "checkpoint-run", stage: "gather-supplies", workGoal: "Complete the approved work" }),
    });
    expect(gathered.status).toBe(200);
    expect(JSON.parse(gathered.body).status).toBe("action");
    expect(JSON.parse((await call(port, { method: "GET", path: "/api/v1/runs/checkpoint-run/planning-state", headers: { cookie } })).body)).toEqual({ runId: "checkpoint-run", planningState: "REQUIREMENTS_READY" });

    const mapped = await call(port, {
      method: "POST",
      path: "/api/v1/journey",
      headers: sessionHeaders(port, { cookie }),
      body: JSON.stringify({ runId: "checkpoint-run", stage: "map-route", workGoal: "Complete the approved work" }),
    });
    expect(mapped.status).toBe(200);
    expect(JSON.parse(mapped.body).status).toBe("action");
    expect(JSON.parse((await call(port, { method: "GET", path: "/api/v1/runs/checkpoint-run/planning-state", headers: { cookie } })).body)).toEqual({ runId: "checkpoint-run", planningState: "ARCHITECTURE_READY" });

    const reconned = await call(port, {
      method: "POST",
      path: "/api/v1/journey",
      headers: sessionHeaders(port, { cookie }),
      body: JSON.stringify({ runId: "checkpoint-run", stage: "recon", workGoal: "Complete the approved work" }),
    });
    expect(reconned.status).toBe(200);
    expect(JSON.parse(reconned.body)).toMatchObject({ status: "action", recon: { state: "RECON_READY" } });
    expect(JSON.parse((await call(port, { method: "GET", path: "/api/v1/runs/checkpoint-run/planning-state", headers: { cookie } })).body)).toEqual({ runId: "checkpoint-run", planningState: "RECON_READY" });

    const drafted = await call(port, {
      method: "POST",
      path: "/api/v1/journey",
      headers: sessionHeaders(port, { cookie }),
      body: JSON.stringify({ runId: "checkpoint-run", stage: "draft-implementation", workGoal: "Complete the approved work" }),
    });
    expect(drafted.status).toBe(200);
    expect(JSON.parse(drafted.body).status).toBe("action");
    expect(JSON.parse((await call(port, { method: "GET", path: "/api/v1/runs/checkpoint-run/planning-state", headers: { cookie } })).body)).toEqual({ runId: "checkpoint-run", planningState: "PLANNING_VALIDATED" });

    const checkpointDiagnostic = {
      code: "checkpoint_planning_transition_refused",
      reason: "illegal_transition",
      remedy: "The checkpoint was saved without changing durable planning state; continue from the authoritative journey result.",
    };
    const refused = await call(port, {
      method: "POST",
      path: "/api/v1/journey",
      headers: sessionHeaders(port, { cookie }),
      body: JSON.stringify({ runId: "checkpoint-run", stage: "gather-supplies", workGoal: "Complete the approved work", reviewChange: "Add a rollback acceptance check" }),
    });
    expect(refused.status).toBe(200);
    expect(JSON.parse(refused.body)).toMatchObject({ status: "action", checkpointDiagnostic });
    expect(JSON.parse((await call(port, { method: "GET", path: "/api/v1/journey/checkpoint-run/status", headers: { cookie } })).body).run.lastResult).toMatchObject({ status: "action", checkpointDiagnostic });
    expect(JSON.parse((await call(port, { method: "GET", path: "/api/v1/runs/checkpoint-run/planning-state", headers: { cookie } })).body)).toEqual({ runId: "checkpoint-run", planningState: "PLANNING_VALIDATED" });

    const afterMap = await store.load("checkpoint-run");
    const recommended = await store.apply({
      schemaVersion: 1,
      commandId: "recommend-checkpoint-run",
      runId: "checkpoint-run",
      expectedRevision: afterMap.revision,
      type: "recommendExecutionMode",
      payload: { workItems: 1, maxCrewmatesPerExplorer: 1, perAgentTokenEstimate: 1000 },
      session: { sessionId: "test-owner", actor: "owner" },
      correlationId: "recommend-checkpoint-run",
    });
    if (!recommended.ok) throw new Error(recommended.reason);
    const recommendation = recommended.events.find((event) => event.type === "executionModeRecommended");
    if (!recommendation) throw new Error("recommendation event missing");
    const approved = await store.apply({
      schemaVersion: 1,
      commandId: "approve-checkpoint-run",
      runId: "checkpoint-run",
      expectedRevision: recommended.state.revision,
      type: "approveExecutionMode",
      payload: { recommendationEventId: recommendation.eventId },
      session: { sessionId: "test-owner", actor: "owner" },
      correlationId: "approve-checkpoint-run",
    });
    if (!approved.ok) throw new Error(approved.reason);
    expect(JSON.parse((await call(port, { method: "GET", path: "/api/v1/runs/checkpoint-run/planning-state", headers: { cookie } })).body)).toEqual({ runId: "checkpoint-run", planningState: "PLANNING_VALIDATED" });

    const decisionId = "review-checkpoint-run";
    const reviewRequired = await store.apply({
      schemaVersion: 1,
      commandId: "require-review-checkpoint-run",
      runId: "checkpoint-run",
      expectedRevision: approved.state.revision,
      type: "requireDecision",
      payload: { decisionId, question: PLAN_REVIEW_QUESTION, consequential: true },
      session: { sessionId: "test-bearing", actor: "bearing" },
      correlationId: "require-review-checkpoint-run",
    });
    if (!reviewRequired.ok) throw new Error(reviewRequired.reason);
    const reviewApproved = await store.apply({
      schemaVersion: 1,
      commandId: "approve-review-checkpoint-run",
      runId: "checkpoint-run",
      expectedRevision: reviewRequired.state.revision,
      type: "recordOwnerAnswer",
      payload: { decisionId, answer: PLAN_REVIEW_APPROVAL },
      session: { sessionId: "test-owner", actor: "owner" },
      correlationId: "approve-review-checkpoint-run",
    });
    if (!reviewApproved.ok) throw new Error(reviewApproved.reason);
    expect(JSON.parse((await call(port, { method: "GET", path: "/api/v1/runs/checkpoint-run/planning-state", headers: { cookie } })).body)).toEqual({ runId: "checkpoint-run", planningState: "OWNER_APPROVED" });

    const durable = await store.load("checkpoint-run");
    for (const [stage, planningState] of [
      ["gather-supplies", "REQUIREMENTS_READY"],
      ["map-route", "ARCHITECTURE_READY"],
      ["recon", "RECON_READY"],
      ["draft-implementation", "PLANNING_VALIDATED"],
    ] as const) {
      const checkpoints = durable.events.filter((event) => event.type === "journeyCheckpointRecorded" && event.payload.stage === stage);
      const transitionCheckpoints = checkpoints.filter((event) => event.payload.planningState === planningState);
      expect(transitionCheckpoints).toHaveLength(1);
      expect(transitionCheckpoints[0]?.payload.status).toBe("waiting");
      expect(transitionCheckpoints[0]?.payload).not.toHaveProperty("planningFailure");
    }
    const gatherCheckpoints = durable.events.filter((event) => event.type === "journeyCheckpointRecorded" && event.payload.stage === "gather-supplies");
    const trailingGatherCheckpoint = gatherCheckpoints.at(-1);
    expect(trailingGatherCheckpoint?.payload.status).toBe("waiting");
    expect(trailingGatherCheckpoint?.payload).not.toHaveProperty("planningState");
    expect(trailingGatherCheckpoint?.payload).not.toHaveProperty("planningFailure");
    expect(JSON.parse(String(trailingGatherCheckpoint?.payload.lastResultJson))).toMatchObject({ status: "action", checkpointDiagnostic });
  });

  it("stops at the Recon owner gate instead of admitting drafting", async () => {
    const runner = new CheckpointRunner(undefined, undefined, true);
    const { port, cap } = await launchHandler(new RepositoryBootstrap(), {
      processRunner: runner,
      verification: { verify: async () => true },
    });
    const cookie = await exchangeCookie(port, cap);
    const root = await tempRepo();
    await selectRepository(port, cookie, root);
    expect((await call(port, {
      method: "POST",
      path: "/api/v1/readiness",
      headers: sessionHeaders(port, { cookie }),
      body: JSON.stringify({ provider: "codex", model: "*", reasoning: "medium" }),
    })).status).toBe(200);
    await seedRun(root, "recon-owner-gate");

    for (const stage of ["set-bearings", "gather-supplies", "map-route"] as const) {
      const response = await call(port, {
        method: "POST",
        path: "/api/v1/journey",
        headers: sessionHeaders(port, { cookie }),
        body: JSON.stringify({ runId: "recon-owner-gate", stage, workGoal: "Complete the approved work" }),
      });
      expect(response.status).toBe(200);
    }
    const recon = await call(port, {
      method: "POST",
      path: "/api/v1/journey",
      headers: sessionHeaders(port, { cookie }),
      body: JSON.stringify({ runId: "recon-owner-gate", stage: "recon", workGoal: "Complete the approved work" }),
    });
    expect(recon.status).toBe(200);
    expect(JSON.parse(recon.body)).toMatchObject({ status: "action", recon: { state: "OWNER_DECISION_REQUIRED" } });
    expect(JSON.parse((await call(port, { method: "GET", path: "/api/v1/runs/recon-owner-gate/planning-state", headers: { cookie } })).body)).toEqual({
      runId: "recon-owner-gate",
      planningState: "OWNER_DECISION_REQUIRED",
    });

    const callsBeforeRemediation = runner.calls.length;
    const remediation = await call(port, {
      method: "POST",
      path: "/api/v1/journey",
      headers: sessionHeaders(port, { cookie }),
      body: JSON.stringify({ runId: "recon-owner-gate", stage: "map-route", workGoal: "Complete the approved work" }),
    });
    expect(remediation.status, remediation.body).toBe(200);
    expect(runner.calls).toHaveLength(callsBeforeRemediation + 1);

    const callsBeforeDraft = runner.calls.length;
    const blocked = await call(port, {
      method: "POST",
      path: "/api/v1/journey",
      headers: sessionHeaders(port, { cookie }),
      body: JSON.stringify({ runId: "recon-owner-gate", stage: "draft-implementation", workGoal: "Complete the approved work" }),
    });
    expect(blocked.status).toBe(409);
    expect(runner.calls).toHaveLength(callsBeforeDraft);
  });

  it("blocks drafting after Recon stops but accepts a successful Recon retry", async () => {
    const runner = new CheckpointRunner();
    runner.recommendRecon("stop");
    const { port, cap } = await launchHandler(new RepositoryBootstrap(), {
      processRunner: runner,
      verification: { verify: async () => true },
    });
    const cookie = await exchangeCookie(port, cap);
    const root = await tempRepo();
    await selectRepository(port, cookie, root);
    expect((await call(port, {
      method: "POST",
      path: "/api/v1/readiness",
      headers: sessionHeaders(port, { cookie }),
      body: JSON.stringify({ provider: "codex", model: "*", reasoning: "medium" }),
    })).status).toBe(200);
    await seedRun(root, "recon-stop-retry");

    for (const stage of ["set-bearings", "gather-supplies", "map-route"] as const) {
      expect((await call(port, {
        method: "POST",
        path: "/api/v1/journey",
        headers: sessionHeaders(port, { cookie }),
        body: JSON.stringify({ runId: "recon-stop-retry", stage, workGoal: "Complete the approved work" }),
      })).status).toBe(200);
    }
    const stopped = await call(port, {
      method: "POST",
      path: "/api/v1/journey",
      headers: sessionHeaders(port, { cookie }),
      body: JSON.stringify({ runId: "recon-stop-retry", stage: "recon", workGoal: "Complete the approved work" }),
    });
    const stoppedBody = JSON.parse(stopped.body);
    const callsBeforeDraft = runner.calls.length;

    const blockedDraft = await call(port, {
      method: "POST",
      path: "/api/v1/journey",
      headers: sessionHeaders(port, { cookie }),
      body: JSON.stringify({ runId: "recon-stop-retry", stage: "draft-implementation", workGoal: "Complete the approved work" }),
    });
    const stateAfterDraft = JSON.parse((await call(port, {
      method: "GET",
      path: "/api/v1/runs/recon-stop-retry/planning-state",
      headers: { cookie },
    })).body);

    runner.recommendRecon("proceed");
    const retried = await call(port, {
      method: "POST",
      path: "/api/v1/journey",
      headers: sessionHeaders(port, { cookie }),
      body: JSON.stringify({ runId: "recon-stop-retry", stage: "recon", workGoal: "Complete the approved work" }),
    });
    const retriedBody = JSON.parse(retried.body);

    expect({
      stoppedStatus: stopped.status,
      stoppedState: stoppedBody.recon?.state,
      blockedDraftStatus: blockedDraft.status,
      stateAfterDraft,
      retriedStatus: retried.status,
      retriedState: retriedBody.recon?.state,
    }).toEqual({
      stoppedStatus: 200,
      stoppedState: "RECON_FAILED",
      blockedDraftStatus: 409,
      stateAfterDraft: { runId: "recon-stop-retry", planningState: "RECON_FAILED" },
      retriedStatus: 200,
      retriedState: "RECON_READY",
    });
    expect(runner.calls).toHaveLength(callsBeforeDraft + 1);
  });

  it("admits request changes back to Gather Supplies while a non-PASS planning failure is recorded", async () => {
    const root = await tempRepo();
    const runner = new CheckpointRunner(undefined, "amendment");
    const { port, cookie } = await readyJourneyHandler(root, runner);
    const runId = "request-changes-after-non-pass";
    const store = await seedRun(root, runId);
    const request = (
      stage: "set-bearings" | "gather-supplies" | "map-route" | "recon" | "draft-implementation",
      reviewChange?: string,
    ) => ({
      method: "POST",
      path: "/api/v1/journey",
      headers: sessionHeaders(port, { cookie }),
      body: JSON.stringify({ runId, stage, workGoal: "Complete the approved work", ...(reviewChange ? { reviewChange } : {}) }),
    });

    for (const stage of ["set-bearings", "gather-supplies", "map-route", "recon", "draft-implementation"] as const) {
      expect((await call(port, request(stage))).status).toBe(200);
    }
    expect((await store.load(runId)).journeyCheckpoint).toMatchObject({
      stage: "draft-implementation",
      planningFailure: "MISSING_VALIDATION",
    });
    const callsBeforeRemediation = runner.calls.length;

    const remediation = await call(port, request("gather-supplies", "Add the missing negative validation case."));

    expect(remediation.status, remediation.body).toBe(200);
    expect(runner.calls).toHaveLength(callsBeforeRemediation + 1);
  });

  it("refuses forward drafting from a failed planning state before invoking the agent", async () => {
    const root = await tempRepo();
    const runner = new CheckpointRunner("map-route");
    const { port, cookie } = await readyJourneyHandler(root, runner);
    const runId = "forward-draft-after-planning-failure";
    const store = await seedRun(root, runId);
    const request = (stage: "set-bearings" | "gather-supplies" | "map-route" | "draft-implementation") => ({
      method: "POST",
      path: "/api/v1/journey",
      headers: sessionHeaders(port, { cookie }),
      body: JSON.stringify({ runId, stage, workGoal: "Complete the approved work" }),
    });

    for (const stage of ["set-bearings", "gather-supplies", "map-route"] as const) {
      expect((await call(port, request(stage))).status).toBe(200);
    }
    expect((await store.load(runId)).journeyCheckpoint?.planningFailure).toBe("DESIGN_CONFLICT");
    const callsBeforeDraft = runner.calls.length;

    const drafted = await call(port, request("draft-implementation"));

    expect(drafted.status, drafted.body).toBe(409);
    expect(runner.calls).toHaveLength(callsBeforeDraft);
  });

  it("keeps identical creating requests behind both failed-planning gates after the first refusal", async () => {
    const root = await tempRepo();
    const runner = new CheckpointRunner();
    const { port, cookie } = await readyJourneyHandler(root, runner);
    const cases = [
      {
        runId: "creating-derived-failure",
        target: "recon" as const,
        checkpoint: {
          stage: "gather-supplies" as const,
          status: "failed" as const,
          artifacts: [],
          planningFailure: "REQUIREMENTS_GAP" as const,
        },
      },
      {
        runId: "creating-recon-stop",
        target: "draft-implementation" as const,
        checkpoint: {
          stage: "recon" as const,
          status: "waiting" as const,
          artifacts: [],
          lastResultJson: JSON.stringify({
            status: "action",
            summary: "Recon stopped.",
            artifacts: [],
            tokens: 0,
            recon: { state: "RECON_FAILED" },
          }),
        },
      },
    ];

    for (const { runId, target, checkpoint } of cases) {
      const store = await seedRun(root, runId);
      const durable = await store.load(runId);
      const commandId = `creating-refusal-${runId}`;
      const recorded = await store.apply({
        schemaVersion: 1,
        commandId,
        runId,
        expectedRevision: durable.revision,
        type: "recordJourneyCheckpoint",
        payload: checkpoint,
        session: { sessionId: "test-bearing", actor: "bearing" },
        correlationId: commandId,
      });
      if (!recorded.ok) throw new Error(recorded.reason);
      const request = {
        method: "POST",
        path: "/api/v1/journey",
        headers: sessionHeaders(port, { cookie }),
        body: JSON.stringify({ runId, stage: target, workGoal: "Complete the approved work" }),
      };
      const callsBefore = runner.calls.length;

      const first = await call(port, request);
      const repeated = await call(port, request);

      expect(first.status, `${runId} first: ${first.body}`).toBe(409);
      expect(repeated.status, `${runId} repeated: ${repeated.body}`).toBe(409);
      expect(runner.calls, `${runId} invoked the agent`).toHaveLength(callsBefore);
    }
  });

  it("refuses Gather Supplies to Map Route while a later Recon stop remains live", async () => {
    const root = await tempRepo();
    const runner = new CheckpointRunner();
    const { port, cookie } = await readyJourneyHandler(root, runner);
    const runId = "live-recon-stop-gather-to-map";
    await seedRun(root, runId);
    const request = (stage: JourneyStage) => ({
      method: "POST",
      path: "/api/v1/journey",
      headers: sessionHeaders(port, { cookie }),
      body: JSON.stringify({ runId, stage, workGoal: "Complete the approved work" }),
    });

    for (const stage of ["set-bearings", "gather-supplies", "map-route", "recon"] as const) {
      expect((await call(port, request(stage))).status).toBe(200);
    }
    runner.recommendRecon("stop");
    const stopped = await call(port, request("recon"));
    expect(stopped.status, stopped.body).toBe(200);
    expect(JSON.parse(stopped.body)).toMatchObject({ status: "action", recon: { state: "RECON_FAILED" } });
    expect((await call(port, request("gather-supplies"))).status).toBe(200);
    const callsBeforeMap = runner.calls.length;

    const mapped = await call(port, request("map-route"));

    expect(mapped.status, mapped.body).toBe(409);
    expect(runner.calls).toHaveLength(callsBeforeMap);
  });

  it("enforces a durable Recon stop before direct drafting on a fresh service and store", async () => {
    const root = await tempRepo();
    const runId = "fresh-service-durable-recon-stop";
    const initialRunner = new CheckpointRunner();
    const initial = await readyJourneyHandler(root, initialRunner);
    const initialStore = await seedRun(root, runId);
    const request = (
      port: string,
      cookie: string,
      stage: "set-bearings" | "gather-supplies" | "map-route" | "recon" | "draft-implementation",
    ) => ({
      method: "POST",
      path: "/api/v1/journey",
      headers: sessionHeaders(port, { cookie }),
      body: JSON.stringify({ runId, stage, workGoal: "Complete the approved work" }),
    });

    for (const stage of ["set-bearings", "gather-supplies", "map-route", "recon"] as const) {
      expect((await call(initial.port, request(initial.port, initial.cookie, stage))).status).toBe(200);
    }
    initialRunner.recommendRecon("stop");
    const stopped = await call(initial.port, request(initial.port, initial.cookie, "recon"));
    expect(stopped.status, stopped.body).toBe(200);
    expect(JSON.parse(stopped.body)).toMatchObject({ status: "action", recon: { state: "RECON_FAILED" } });
    const stoppedCheckpoint = (await initialStore.load(runId)).journeyCheckpoint;
    expect(stoppedCheckpoint).not.toHaveProperty("planningFailure");
    expect(JSON.parse(stoppedCheckpoint?.lastResultJson ?? "{}")).toMatchObject({
      status: "action",
      recon: { state: "RECON_FAILED" },
    });

    await closeLatestServer();
    const resumedRunner = new CheckpointRunner();
    const resumed = await readyJourneyHandler(root, resumedRunner);
    const resumedStore = new BearingStore(root);
    expect((await resumedStore.load(runId)).journeyCheckpoint).not.toHaveProperty("planningFailure");

    const drafted = await call(resumed.port, request(resumed.port, resumed.cookie, "draft-implementation"));

    expect(drafted.status, drafted.body).toBe(409);
    expect(resumedRunner.calls).toHaveLength(0);
  });

  it("keeps ordinary legal forward planning progression unaffected", async () => {
    const root = await tempRepo();
    const runner = new CheckpointRunner();
    const { port, cookie } = await readyJourneyHandler(root, runner);
    const runId = "ordinary-legal-forward-progression";
    await seedRun(root, runId);
    const request = (stage: "set-bearings" | "gather-supplies" | "map-route" | "recon" | "draft-implementation") => ({
      method: "POST",
      path: "/api/v1/journey",
      headers: sessionHeaders(port, { cookie }),
      body: JSON.stringify({ runId, stage, workGoal: "Complete the approved work" }),
    });

    for (const stage of ["set-bearings", "gather-supplies", "map-route", "recon", "draft-implementation"] as const) {
      const progressed = await call(port, request(stage));
      expect(progressed.status, `${stage}: ${progressed.body}`).toBe(200);
    }
    expect(runner.calls).toHaveLength(5);
  });

  it("keeps a Recon stop active when a later Recon retry fails before a successful retry", async () => {
    const root = await tempRepo();
    const runner = new CheckpointRunner();
    const { port, cookie } = await readyJourneyHandler(root, runner);
    const runId = "recon-stop-then-adapter-failure";
    const store = await seedRun(root, runId);
    const request = (stage: JourneyStage) => ({
      method: "POST",
      path: "/api/v1/journey",
      headers: sessionHeaders(port, { cookie }),
      body: JSON.stringify({ runId, stage, workGoal: "Complete the approved work" }),
    });

    for (const stage of ["set-bearings", "gather-supplies", "map-route", "recon"] as const) {
      expect((await call(port, request(stage))).status).toBe(200);
    }
    runner.recommendRecon("stop");
    const stopped = await call(port, request("recon"));
    expect(JSON.parse(stopped.body)).toMatchObject({ status: "action", recon: { state: "RECON_FAILED" } });

    runner.failAdapterAt("recon");
    const failedRetry = await call(port, request("recon"));
    expect(JSON.parse(failedRetry.body)).toMatchObject({ status: "failure", code: "adapter_failed" });
    expect((await store.load(runId)).journeyCheckpoint).not.toHaveProperty("planningFailure");
    const callsBeforeDraft = runner.calls.length;

    const drafted = await call(port, request("draft-implementation"));

    expect(drafted.status, drafted.body).toBe(409);
    expect(runner.calls).toHaveLength(callsBeforeDraft);
  });

  it("enforces the derived DESIGN_CONFLICT after a failed backward remediation", async () => {
    const root = await tempRepo();
    const runner = new CheckpointRunner("map-route");
    const { port, cookie } = await readyJourneyHandler(root, runner);
    const runId = "design-conflict-failed-backward-remediation";
    const store = await seedRun(root, runId);
    const request = (stage: JourneyStage) => ({
      method: "POST",
      path: "/api/v1/journey",
      headers: sessionHeaders(port, { cookie }),
      body: JSON.stringify({ runId, stage, workGoal: "Complete the approved work" }),
    });

    for (const stage of ["set-bearings", "gather-supplies", "map-route"] as const) {
      expect((await call(port, request(stage))).status).toBe(200);
    }
    expect(JSON.parse((await call(port, {
      method: "GET",
      path: `/api/v1/runs/${runId}/planning-state`,
      headers: { cookie },
    })).body)).toEqual({ runId, planningState: "DESIGN_CONFLICT" });

    runner.failAdapterAt("gather-supplies");
    const callsBeforeRemediation = runner.calls.length;
    const remediation = await call(port, request("gather-supplies"));
    expect(remediation.status, remediation.body).toBe(200);
    expect(JSON.parse(remediation.body)).toMatchObject({ status: "failure", code: "adapter_failed" });
    expect(runner.calls.length).toBeGreaterThan(callsBeforeRemediation);
    expect((await store.load(runId)).journeyCheckpoint).not.toHaveProperty("planningFailure");
    expect(JSON.parse((await call(port, {
      method: "GET",
      path: `/api/v1/runs/${runId}/planning-state`,
      headers: { cookie },
    })).body)).toEqual({ runId, planningState: "DESIGN_CONFLICT" });
    const callsBeforeDraft = runner.calls.length;

    const drafted = await call(port, request("draft-implementation"));

    expect(drafted.status, drafted.body).toBe(409);
    expect(runner.calls).toHaveLength(callsBeforeDraft);
  });

  it.each([
    {
      failureStage: "gather-supplies" as const,
      setupStages: ["set-bearings", "gather-supplies"] as const,
      planningState: "REQUIREMENTS_GAP" as const,
    },
    {
      failureStage: "map-route" as const,
      setupStages: ["set-bearings", "gather-supplies", "map-route"] as const,
      planningState: "DESIGN_CONFLICT" as const,
    },
  ])("refuses $failureStage -> recon from $planningState before invoking the agent", async ({ failureStage, setupStages, planningState }) => {
    const root = await tempRepo();
    const runner = new CheckpointRunner(failureStage);
    const { port, cookie } = await readyJourneyHandler(root, runner);
    const runId = `failed-${failureStage}-to-recon`;
    await seedRun(root, runId);
    const request = (stage: JourneyStage) => ({
      method: "POST",
      path: "/api/v1/journey",
      headers: sessionHeaders(port, { cookie }),
      body: JSON.stringify({ runId, stage, workGoal: "Complete the approved work" }),
    });

    for (const stage of setupStages) expect((await call(port, request(stage))).status).toBe(200);
    expect(JSON.parse((await call(port, {
      method: "GET",
      path: `/api/v1/runs/${runId}/planning-state`,
      headers: { cookie },
    })).body)).toEqual({ runId, planningState });
    const callsBeforeRecon = runner.calls.length;

    const recon = await call(port, request("recon"));

    expect(recon.status, recon.body).toBe(409);
    expect(runner.calls).toHaveLength(callsBeforeRecon);
  });

  it("preserves ordinary progression and backward remediation while closing the next failed-state escape", async () => {
    const root = await tempRepo();
    const runner = new CheckpointRunner();
    const { port, cookie } = await readyJourneyHandler(root, runner);
    const request = (runId: string, stage: JourneyStage) => ({
      method: "POST",
      path: "/api/v1/journey",
      headers: sessionHeaders(port, { cookie }),
      body: JSON.stringify({ runId, stage, workGoal: "Complete the approved work" }),
    });

    const ordinaryRunId = "new-ordinary-forward-proof";
    await seedRun(root, ordinaryRunId);
    for (const stage of ["set-bearings", "gather-supplies", "map-route", "recon", "draft-implementation"] as const) {
      const progressed = await call(port, request(ordinaryRunId, stage));
      expect(progressed.status, `${stage}: ${progressed.body}`).toBe(200);
    }

    runner.failAt("map-route");
    const remediationRunId = "new-backward-remediation-proof";
    await seedRun(root, remediationRunId);
    for (const stage of ["set-bearings", "gather-supplies", "map-route"] as const) {
      expect((await call(port, request(remediationRunId, stage))).status).toBe(200);
    }
    const callsBeforeRemediation = runner.calls.length;
    const remediation = await call(port, request(remediationRunId, "gather-supplies"));
    expect(remediation.status, remediation.body).toBe(200);
    expect(runner.calls.length).toBeGreaterThan(callsBeforeRemediation);
    const callsBeforeEscape = runner.calls.length;

    const escaped = await call(port, request(remediationRunId, "recon"));

    expect(escaped.status, escaped.body).toBe(409);
    expect(runner.calls).toHaveLength(callsBeforeEscape);
  });

  it("checks all 81 ordered stage pairs against a durable failed planning state", async () => {
    const root = await tempRepo();
    const runner = new CheckpointRunner();
    const { port, cookie } = await readyJourneyHandler(root, runner);
    const failureByStage = {
      "repository-fit": "REQUIREMENTS_GAP",
      "set-bearings": "REQUIREMENTS_GAP",
      "gather-supplies": "REQUIREMENTS_GAP",
      "map-route": "DESIGN_CONFLICT",
      recon: "RECON_FAILED",
      "draft-implementation": "MISSING_VALIDATION",
      "execute-explorer": "UNSAFE_PARALLELISM",
      "execute-expedition": "UNSAFE_PARALLELISM",
      review: "OWNER_DECISION_REQUIRED",
    } as const satisfies Readonly<Record<JourneyStage, PlanningState>>;
    const signalByStage = {
      "repository-fit": undefined,
      "set-bearings": undefined,
      "gather-supplies": "requirementsReady",
      "map-route": "architectureReady",
      recon: "reconReady",
      "draft-implementation": "executionPlanReady",
      "execute-explorer": undefined,
      "execute-expedition": undefined,
      review: undefined,
    } as const satisfies Readonly<Record<JourneyStage, PlanningSignal | undefined>>;
    let refused = 0;
    let admitted = 0;
    let legitimate = 0;
    let containedByOtherGate = 0;
    let activeReconOrderedPairs = 0;
    let reconStopArmRefusals = 0;

    for (const [fromIndex, from] of RECORD_JOURNEY_CHECKPOINT_STAGES.entries()) {
      for (const [toIndex, to] of RECORD_JOURNEY_CHECKPOINT_STAGES.entries()) {
        const runId = `failed-pair-${fromIndex}-${toIndex}`;
        const store = await seedRun(root, runId);
        const durable = await store.load(runId);
        const commandId = `failed-pair-checkpoint-${fromIndex}-${toIndex}`;
        const checkpoint = await store.apply({
          schemaVersion: 1,
          commandId,
          runId,
          expectedRevision: durable.revision,
          type: "recordJourneyCheckpoint",
          payload: {
            stage: from,
            status: "failed",
            artifacts: [],
            planningFailure: failureByStage[from],
          },
          session: { sessionId: "test-bearing", actor: "bearing" },
          correlationId: commandId,
        });
        if (!checkpoint.ok) throw new Error(checkpoint.reason);
        const callsBefore = runner.calls.length;
        const response = await call(port, {
          method: "POST",
          path: "/api/v1/journey",
          headers: sessionHeaders(port, { cookie }),
          body: JSON.stringify({ runId, stage: to, workGoal: "Complete the approved work" }),
        });
        const movingForward = toIndex > fromIndex;
        const signal = signalByStage[to];
        const legitimateRemediation = !movingForward
          || signal !== undefined && next(failureByStage[from], signal) !== "illegal_transition";
        const invoked = runner.calls.length > callsBefore;
        const requestAdmitted = response.status !== 409 || invoked;

        if (legitimateRemediation) {
          legitimate += 1;
          if (requestAdmitted) admitted += 1;
          else containedByOtherGate += 1;
        } else {
          refused += 1;
          expect(response.status, `${from} -> ${to}: ${response.body}`).toBe(409);
          expect(runner.calls, `${from} -> ${to} invoked the agent`).toHaveLength(callsBefore);
        }
        if (requestAdmitted) expect(legitimateRemediation, `${from} -> ${to} escaped`).toBe(true);
      }
    }

    const gatherIndex = RECORD_JOURNEY_CHECKPOINT_STAGES.indexOf("gather-supplies");
    const reconIndex = RECORD_JOURNEY_CHECKPOINT_STAGES.indexOf("recon");
    for (const [toIndex, to] of RECORD_JOURNEY_CHECKPOINT_STAGES.entries()) {
      const runId = `active-recon-pair-${toIndex}`;
      const store = await seedRun(root, runId);
      let durable = await store.load(runId);
      const stopId = `active-recon-stop-${toIndex}`;
      const stopped = await store.apply({
        schemaVersion: 1,
        commandId: stopId,
        runId,
        expectedRevision: durable.revision,
        type: "recordJourneyCheckpoint",
        payload: {
          stage: "recon",
          status: "waiting",
          artifacts: [],
          lastResultJson: JSON.stringify({
            status: "action",
            summary: "Recon stopped.",
            artifacts: [],
            tokens: 0,
            recon: { state: "RECON_FAILED" },
          }),
        },
        session: { sessionId: "test-bearing", actor: "bearing" },
        correlationId: stopId,
      });
      if (!stopped.ok) throw new Error(stopped.reason);
      durable = await store.load(runId);
      const remediationId = `active-recon-remediation-${toIndex}`;
      const remediated = await store.apply({
        schemaVersion: 1,
        commandId: remediationId,
        runId,
        expectedRevision: durable.revision,
        type: "recordJourneyCheckpoint",
        payload: {
          stage: "gather-supplies",
          status: "waiting",
          artifacts: [],
        },
        session: { sessionId: "test-bearing", actor: "bearing" },
        correlationId: remediationId,
      });
      if (!remediated.ok) throw new Error(remediated.reason);
      const callsBefore = runner.calls.length;
      const response = await call(port, {
        method: "POST",
        path: "/api/v1/journey",
        headers: sessionHeaders(port, { cookie }),
        body: JSON.stringify({ runId, stage: to, workGoal: "Complete the approved work" }),
      });
      const movingForward = toIndex > gatherIndex;
      const signal = signalByStage[to];
      const derivedFailureBlocks = movingForward
        && (signal === undefined || next("RECON_FAILED", signal) === "illegal_transition");
      const reconStopBlocks = movingForward && toIndex > reconIndex;
      const shouldRefuse = derivedFailureBlocks || reconStopBlocks;
      activeReconOrderedPairs += 1;
      if (reconStopBlocks) reconStopArmRefusals += 1;
      if (shouldRefuse) {
        expect(response.status, `live Recon stop gather-supplies -> ${to}: ${response.body}`).toBe(409);
        expect(runner.calls, `live Recon stop gather-supplies -> ${to} invoked the agent`).toHaveLength(callsBefore);
      }
    }

    const coverage = {
      stageOrder: RECORD_JOURNEY_CHECKPOINT_STAGES,
      stages: RECORD_JOURNEY_CHECKPOINT_STAGES.length,
      orderedPairs: RECORD_JOURNEY_CHECKPOINT_STAGES.length ** 2,
      refusedIllegalPairs: refused,
      legitimateRemediationPairs: legitimate,
      admittedRemediations: admitted,
      containedByOtherGate,
      activeReconOrderedPairs,
      reconStopArmRefusals,
    };
    console.info("FAILED_PLANNING_STAGE_PAIR_COVERAGE", JSON.stringify(coverage));
    expect(coverage).toMatchObject({
      stages: 9,
      orderedPairs: 81,
      activeReconOrderedPairs: 9,
      reconStopArmRefusals: 4,
    });
    expect(refused + legitimate).toBe(coverage.orderedPairs);
    expect(admitted + containedByOtherGate).toBe(legitimate);
    expect(refused).toBeGreaterThan(0);
  }, 30_000);

  it("refuses drafting when a Recon stop is observed from RECON_READY", async () => {
    const root = await tempRepo();
    const runner = new CheckpointRunner();
    const { port, cookie } = await readyJourneyHandler(root, runner);
    const runId = "recon-ready-stop";
    await seedRun(root, runId);
    const request = (stage: "set-bearings" | "gather-supplies" | "map-route" | "recon" | "draft-implementation") => ({
      method: "POST",
      path: "/api/v1/journey",
      headers: sessionHeaders(port, { cookie }),
      body: JSON.stringify({ runId, stage, workGoal: "Complete the approved work" }),
    });

    for (const stage of ["set-bearings", "gather-supplies", "map-route", "recon"] as const) {
      expect((await call(port, request(stage))).status).toBe(200);
    }
    expect(JSON.parse((await call(port, {
      method: "GET",
      path: `/api/v1/runs/${runId}/planning-state`,
      headers: { cookie },
    })).body)).toEqual({ runId, planningState: "RECON_READY" });

    runner.recommendRecon("stop");
    const stopped = await call(port, request("recon"));
    expect(stopped.status, stopped.body).toBe(200);
    expect(JSON.parse(stopped.body)).toMatchObject({ status: "action", recon: { state: "RECON_FAILED" } });
    expect(JSON.parse((await call(port, {
      method: "GET",
      path: `/api/v1/runs/${runId}/planning-state`,
      headers: { cookie },
    })).body)).toEqual({ runId, planningState: "RECON_FAILED" });
    const callsBeforeDraft = runner.calls.length;

    const blockedDraft = await call(port, request("draft-implementation"));

    expect(blockedDraft.status, blockedDraft.body).toBe(409);
    expect(runner.calls).toHaveLength(callsBeforeDraft);
    expect(JSON.parse((await call(port, {
      method: "GET",
      path: `/api/v1/runs/${runId}/planning-state`,
      headers: { cookie },
    })).body)).toEqual({ runId, planningState: "RECON_FAILED" });

    runner.recommendRecon("proceed");
    expect((await call(port, request("recon"))).status).toBe(200);
    expect((await call(port, request("draft-implementation"))).status).toBe(200);
    expect(runner.calls).toHaveLength(callsBeforeDraft + 2);
  });

  it("keeps a durable Recon failure fail-closed across a fresh service restart", async () => {
    const root = await tempRepo();
    const runId = "durable-recon-stop-restart";
    const initialRunner = new CheckpointRunner();
    initialRunner.recommendRecon("stop");
    const initial = await readyJourneyHandler(root, initialRunner);
    const initialStore = await seedRun(root, runId);
    const request = (port: string, cookie: string, stage: "set-bearings" | "gather-supplies" | "map-route" | "recon" | "draft-implementation") => ({
      method: "POST",
      path: "/api/v1/journey",
      headers: sessionHeaders(port, { cookie }),
      body: JSON.stringify({ runId, stage, workGoal: "Complete the approved work" }),
    });

    for (const stage of ["set-bearings", "gather-supplies", "map-route"] as const) {
      expect((await call(initial.port, request(initial.port, initial.cookie, stage))).status).toBe(200);
    }
    const stopped = await call(initial.port, request(initial.port, initial.cookie, "recon"));
    expect(JSON.parse(stopped.body)).toMatchObject({ status: "action", recon: { state: "RECON_FAILED" } });
    expect((await initialStore.load(runId)).journeyCheckpoint?.planningFailure).toBe("RECON_FAILED");

    await closeLatestServer();
    const resumedRunner = new CheckpointRunner();
    const resumed = await readyJourneyHandler(root, resumedRunner);
    const resumedStore = new BearingStore(root);
    await rename(join(root, ".git"), join(root, ".git-unavailable"));

    const skipped = await call(resumed.port, request(resumed.port, resumed.cookie, "recon"));
    expect(skipped.status, skipped.body).toBe(200);
    expect(JSON.parse(skipped.body)).toMatchObject({ status: "action", recon: { state: "SKIPPED" } });
    expect((await resumedStore.load(runId)).journeyCheckpoint?.planningFailure).toBe("RECON_FAILED");

    const blockedDraft = await call(resumed.port, request(resumed.port, resumed.cookie, "draft-implementation"));
    expect(blockedDraft.status, blockedDraft.body).toBe(409);
    expect(resumedRunner.calls).toHaveLength(0);

    await rename(join(root, ".git-unavailable"), join(root, ".git"));
    const recoveredRecon = await call(resumed.port, request(resumed.port, resumed.cookie, "recon"));
    expect(recoveredRecon.status, recoveredRecon.body).toBe(200);
    expect(JSON.parse(recoveredRecon.body)).toMatchObject({ status: "action", recon: { state: "RECON_READY" } });
    expect(JSON.parse((await call(resumed.port, {
      method: "GET",
      path: `/api/v1/runs/${runId}/planning-state`,
      headers: { cookie: resumed.cookie },
    })).body)).toEqual({ runId, planningState: "RECON_READY" });

    const drafted = await call(resumed.port, request(resumed.port, resumed.cookie, "draft-implementation"));
    expect(drafted.status, drafted.body).toBe(200);
    expect(JSON.parse((await call(resumed.port, {
      method: "GET",
      path: `/api/v1/runs/${runId}/planning-state`,
      headers: { cookie: resumed.cookie },
    })).body)).toEqual({ runId, planningState: "PLANNING_VALIDATED" });
  });

  it("refuses an illegal draft from DESIGN_CONFLICT before invoking the agent", async () => {
    const root = await tempRepo();
    const runner = new CheckpointRunner("map-route");
    const { port, cookie } = await readyJourneyHandler(root, runner);
    const runId = "retained-illegal-transition";
    const store = await seedRun(root, runId);
    const request = (stage: "set-bearings" | "gather-supplies" | "map-route" | "draft-implementation") => ({
      method: "POST",
      path: "/api/v1/journey",
      headers: sessionHeaders(port, { cookie }),
      body: JSON.stringify({ runId, stage, workGoal: "Complete the approved work" }),
    });

    for (const stage of ["set-bearings", "gather-supplies"] as const) {
      expect((await call(port, request(stage))).status).toBe(200);
    }
    expect(JSON.parse((await call(port, request("map-route"))).body)).toMatchObject({
      status: "failure",
      code: "artifact_invalid",
    });
    expect((await store.load(runId)).journeyCheckpoint?.planningFailure).toBe("DESIGN_CONFLICT");
    const callsBeforeDraft = runner.calls.length;

    const drafted = await call(port, request("draft-implementation"));

    expect(drafted.status, drafted.body).toBe(409);
    expect(runner.calls).toHaveLength(callsBeforeDraft);
    expect((await store.load(runId)).journeyCheckpoint).toMatchObject({
      stage: "map-route",
      planningFailure: "DESIGN_CONFLICT",
    });
  });

  it("keeps legal forward progress admitted while refusing an illegal failure transition", async () => {
    const root = await tempRepo();
    const runner = new CheckpointRunner();
    const { port, cookie } = await readyJourneyHandler(root, runner);
    const request = (runId: string, stage: "set-bearings" | "gather-supplies" | "map-route" | "draft-implementation") => ({
      method: "POST",
      path: "/api/v1/journey",
      headers: sessionHeaders(port, { cookie }),
      body: JSON.stringify({ runId, stage, workGoal: "Complete the approved work" }),
    });

    const legalRunId = "legal-forward-progress";
    await seedRun(root, legalRunId);
    for (const stage of ["set-bearings", "gather-supplies", "map-route"] as const) {
      const progressed = await call(port, request(legalRunId, stage));
      expect(progressed.status, progressed.body).toBe(200);
    }

    runner.failAt("map-route");
    const failedRunId = "illegal-failure-transition";
    await seedRun(root, failedRunId);
    for (const stage of ["set-bearings", "gather-supplies", "map-route"] as const) {
      expect((await call(port, request(failedRunId, stage))).status).toBe(200);
    }
    const callsBeforeRefusal = runner.calls.length;
    expect((await call(port, request(failedRunId, "draft-implementation"))).status).toBe(409);
    expect(runner.calls).toHaveLength(callsBeforeRefusal);
  });

  it("persists and replays a non-PASS planning verdict from a waiting browser checkpoint", async () => {
    const runner = new CheckpointRunner(undefined, "amendment");
    const { port, cap } = await launchHandler(new RepositoryBootstrap(), {
      processRunner: runner,
      verification: { verify: async () => true },
    });
    const cookie = await exchangeCookie(port, cap);
    const root = await tempRepo();
    await selectRepository(port, cookie, root);
    expect((await call(port, {
      method: "POST",
      path: "/api/v1/readiness",
      headers: sessionHeaders(port, { cookie }),
      body: JSON.stringify({ provider: "codex", model: "*", reasoning: "medium" }),
    })).status).toBe(200);
    const store = await seedRun(root, "amendment-run");

    for (const stage of ["set-bearings", "gather-supplies"] as const) {
      expect((await call(port, {
        method: "POST",
        path: "/api/v1/journey",
        headers: sessionHeaders(port, { cookie }),
        body: JSON.stringify({ runId: "amendment-run", stage, workGoal: "Complete the approved work" }),
      })).status).toBe(200);
    }
    expect((await call(port, {
      method: "POST",
      path: "/api/v1/journey",
      headers: sessionHeaders(port, { cookie }),
      body: JSON.stringify({ runId: "amendment-run", stage: "map-route", workGoal: "Complete the approved work" }),
    })).status).toBe(200);
    expect((await call(port, {
      method: "POST",
      path: "/api/v1/journey",
      headers: sessionHeaders(port, { cookie }),
      body: JSON.stringify({ runId: "amendment-run", stage: "recon", workGoal: "Complete the approved work" }),
    })).status).toBe(200);
    const drafted = await call(port, {
      method: "POST",
      path: "/api/v1/journey",
      headers: sessionHeaders(port, { cookie }),
      body: JSON.stringify({ runId: "amendment-run", stage: "draft-implementation", workGoal: "Complete the approved work" }),
    });

    expect(JSON.parse(drafted.body)).toMatchObject({
      status: "action",
      planningValidation: {
        verdict: "NEEDS_AMENDMENT",
        findings: [{ code: "validation_missing" }],
      },
    });
    const checkpoint = (await store.load("amendment-run")).events
      .filter((event) => event.type === "journeyCheckpointRecorded" && event.payload.stage === "draft-implementation")
      .at(-1);
    expect(checkpoint?.payload).toMatchObject({ status: "waiting", planningFailure: "MISSING_VALIDATION" });
    expect(JSON.parse((await call(port, {
      method: "GET",
      path: "/api/v1/runs/amendment-run/planning-state",
      headers: { cookie },
    })).body)).toEqual({ runId: "amendment-run", planningState: "MISSING_VALIDATION" });
  });

  it("blocks direct approval of non-PASS and stale plans before invoking execution", async () => {
    for (const scenario of ["non-pass", "stale"] as const) {
      const runner = new CheckpointRunner(undefined, scenario === "non-pass" ? "amendment" : undefined);
      const { port, cap } = await launchHandler(new RepositoryBootstrap(), {
        processRunner: runner,
        verification: { verify: async () => true },
      });
      const cookie = await exchangeCookie(port, cap);
      const root = await tempRepo();
      await selectRepository(port, cookie, root);
      expect((await call(port, {
        method: "POST",
        path: "/api/v1/readiness",
        headers: sessionHeaders(port, { cookie }),
        body: JSON.stringify({ provider: "codex", model: "*", reasoning: "medium" }),
      })).status).toBe(200);
      const runId = `server-validation-${scenario}`;
      const store = await seedRun(root, runId);
      for (const stage of ["set-bearings", "gather-supplies", "map-route", "recon", "draft-implementation"] as const) {
        expect((await call(port, {
          method: "POST",
          path: "/api/v1/journey",
          headers: sessionHeaders(port, { cookie }),
          body: JSON.stringify({ runId, stage, workGoal: "Complete the approved work" }),
        })).status).toBe(200);
      }
      await recordPlanningApproval(store, runId);
      if (scenario === "stale") {
        const path = join(root, `docs/plans/${runId}/plan-spec.md`);
        await writeFile(path, `${await readFile(path, "utf8")}\n`);
      }
      const callsBeforeExecution = runner.calls.length;

      const execution = await call(port, {
        method: "POST",
        path: "/api/v1/journey",
        headers: sessionHeaders(port, { cookie }),
        body: JSON.stringify({
          runId,
          stage: "execute-explorer",
          workGoal: "Complete the approved work",
          executionMode: "explorer",
          reviewCadence: "phase",
        }),
      });

      expect(execution.status, scenario).toBe(409);
      expect(runner.calls, scenario).toHaveLength(callsBeforeExecution);
    }
  });

  it("records and derives a typed planning failure from a failed HTTP stage", async () => {
    const runner = new CheckpointRunner("gather-supplies");
    const { port, cap } = await launchHandler(new RepositoryBootstrap(), {
      processRunner: runner,
      verification: { verify: async () => true },
    });
    const cookie = await exchangeCookie(port, cap);
    const root = await tempRepo();
    await selectRepository(port, cookie, root);
    const readiness = await call(port, {
      method: "POST",
      path: "/api/v1/readiness",
      headers: sessionHeaders(port, { cookie }),
      body: JSON.stringify({ provider: "codex", model: "*", reasoning: "medium" }),
    });
    expect(readiness.status).toBe(200);
    const store = await seedRun(root, "failed-run");
    expect((await call(port, {
      method: "POST",
      path: "/api/v1/journey",
      headers: sessionHeaders(port, { cookie }),
      body: JSON.stringify({ runId: "failed-run", stage: "set-bearings", workGoal: "Complete the approved work" }),
    })).status).toBe(200);

    const failed = await call(port, {
      method: "POST",
      path: "/api/v1/journey",
      headers: sessionHeaders(port, { cookie }),
      body: JSON.stringify({ runId: "failed-run", stage: "gather-supplies", workGoal: "Complete the approved work" }),
    });
    expect(failed.status).toBe(200);
    expect(JSON.parse(failed.body)).toMatchObject({ status: "failure", code: "artifact_invalid" });
    const durable = await store.load("failed-run");
    const checkpoint = durable.events.filter((event) => event.type === "journeyCheckpointRecorded" && event.payload.stage === "gather-supplies").at(-1);
    expect(checkpoint?.payload).toMatchObject({ status: "failed", planningFailure: "REQUIREMENTS_GAP" });
    const state = await call(port, { method: "GET", path: "/api/v1/runs/failed-run/planning-state", headers: { cookie } });
    expect(JSON.parse(state.body)).toEqual({ runId: "failed-run", planningState: "REQUIREMENTS_GAP" });
  });

  it("records a failed implementation draft as missing validation", async () => {
    const runner = new CheckpointRunner("draft-implementation");
    const { port, cap } = await launchHandler(new RepositoryBootstrap(), {
      processRunner: runner,
      verification: { verify: async () => true },
    });
    const cookie = await exchangeCookie(port, cap);
    const root = await tempRepo();
    await selectRepository(port, cookie, root);
    expect((await call(port, {
      method: "POST",
      path: "/api/v1/readiness",
      headers: sessionHeaders(port, { cookie }),
      body: JSON.stringify({ provider: "codex", model: "*", reasoning: "medium" }),
    })).status).toBe(200);
    const store = await seedRun(root, "composite-draft-failed-run");

    for (const stage of ["set-bearings", "gather-supplies"] as const) {
      expect((await call(port, {
        method: "POST",
        path: "/api/v1/journey",
        headers: sessionHeaders(port, { cookie }),
        body: JSON.stringify({ runId: "composite-draft-failed-run", stage, workGoal: "Complete the approved work" }),
      })).status).toBe(200);
    }

    for (const stage of ["map-route", "recon"] as const) {
      expect((await call(port, {
        method: "POST",
        path: "/api/v1/journey",
        headers: sessionHeaders(port, { cookie }),
        body: JSON.stringify({ runId: "composite-draft-failed-run", stage, workGoal: "Complete the approved work" }),
      })).status).toBe(200);
    }
    const failed = await call(port, {
      method: "POST",
      path: "/api/v1/journey",
      headers: sessionHeaders(port, { cookie }),
      body: JSON.stringify({ runId: "composite-draft-failed-run", stage: "draft-implementation", workGoal: "Complete the approved work" }),
    });
    expect(JSON.parse(failed.body)).toMatchObject({ status: "failure", code: "artifact_invalid" });

    const durable = await store.load("composite-draft-failed-run");
    const checkpoint = durable.events.filter((event) => event.type === "journeyCheckpointRecorded" && event.payload.stage === "draft-implementation").at(-1);
    expect(checkpoint?.payload).toMatchObject({ status: "failed", planningFailure: "MISSING_VALIDATION" });
    const state = await call(port, { method: "GET", path: "/api/v1/runs/composite-draft-failed-run/planning-state", headers: { cookie } });
    expect(JSON.parse(state.body)).toEqual({ runId: "composite-draft-failed-run", planningState: "MISSING_VALIDATION" });
  });

  it("records a draft failure from a persisted architecture-ready checkpoint", async () => {
    const runner = new CheckpointRunner();
    const { port, cap } = await launchHandler(new RepositoryBootstrap(), {
      processRunner: runner,
      verification: { verify: async () => true },
    });
    const cookie = await exchangeCookie(port, cap);
    const root = await tempRepo();
    await selectRepository(port, cookie, root);
    expect((await call(port, {
      method: "POST",
      path: "/api/v1/readiness",
      headers: sessionHeaders(port, { cookie }),
      body: JSON.stringify({ provider: "codex", model: "*", reasoning: "medium" }),
    })).status).toBe(200);
    const store = await seedRun(root, "draft-failed-run");

    for (const stage of ["set-bearings", "gather-supplies"] as const) {
      const response = await call(port, {
        method: "POST",
        path: "/api/v1/journey",
        headers: sessionHeaders(port, { cookie }),
        body: JSON.stringify({ runId: "draft-failed-run", stage, workGoal: "Complete the approved work" }),
      });
      expect(response.status).toBe(200);
      expect(JSON.parse(response.body)).toMatchObject({ status: "action" });
    }
    const beforeDraft = await store.load("draft-failed-run");
    const { eventId: _eventId, ...beforeDraftCheckpoint } = beforeDraft.journeyCheckpoint!;
    const architecture = await store.apply({
      schemaVersion: 1,
      commandId: "architecture-draft-failed-run",
      runId: "draft-failed-run",
      expectedRevision: beforeDraft.revision,
      type: "recordJourneyCheckpoint",
      payload: { ...beforeDraftCheckpoint, stage: "map-route", status: "complete", artifacts: [], planningState: "ARCHITECTURE_READY" },
      session: { sessionId: "test-bearing", actor: "bearing" },
      correlationId: "architecture-draft-failed-run",
    });
    if (!architecture.ok) throw new Error(architecture.reason);
    await advanceJourneyStage(store, "draft-failed-run", "recon", "complete");
    expect((await store.load("draft-failed-run")).journeyCheckpoint).toMatchObject({ stage: "recon", status: "complete", planningState: "ARCHITECTURE_READY" });
    await closeLatestServer();
    const resumed = await readyJourneyHandler(root, runner);
    const restored = await call(resumed.port, {
      method: "GET",
      path: "/api/v1/journey/draft-failed-run/status",
      headers: { cookie: resumed.cookie },
    });
    expect(JSON.parse(restored.body).run).toMatchObject({ stage: "recon", status: "complete" });
    runner.failAt("draft-implementation");
    const failed = await call(resumed.port, {
      method: "POST",
      path: "/api/v1/journey",
      headers: sessionHeaders(resumed.port, { cookie: resumed.cookie }),
      body: JSON.stringify({ runId: "draft-failed-run", stage: "draft-implementation", workGoal: "Complete the approved work" }),
    });

    expect(failed.status, failed.body).toBe(200);
    expect(JSON.parse(failed.body)).toMatchObject({ status: "failure", code: "artifact_invalid" });
    const durable = await store.load("draft-failed-run");
    const checkpoint = durable.events.filter((event) => event.type === "journeyCheckpointRecorded" && event.payload.stage === "draft-implementation").at(-1);
    expect(checkpoint?.payload).toMatchObject({ status: "failed", planningFailure: "MISSING_VALIDATION" });
    const state = await call(resumed.port, { method: "GET", path: "/api/v1/runs/draft-failed-run/planning-state", headers: { cookie: resumed.cookie } });
    expect(JSON.parse(state.body)).toEqual({ runId: "draft-failed-run", planningState: "MISSING_VALIDATION" });
  });
});

describe("POST /api/v1/repository", () => {
  it("requires Host, Origin, and the established session cookie", async () => {
    const { port, cap } = await launch();
    const cookie = await exchangeCookie(port, cap);
    const root = await tempRepo();

    const badHost = await call(port, {
      method: "POST",
      path: "/api/v1/repository",
      headers: sessionHeaders(port, { host: "evil.example", cookie }),
      body: JSON.stringify({ path: root }),
    });
    expect(badHost.status).toBe(421);

    const badOrigin = await call(port, {
      method: "POST",
      path: "/api/v1/repository",
      headers: sessionHeaders(port, { origin: "https://evil.example", cookie }),
      body: JSON.stringify({ path: root }),
    });
    expect(badOrigin.status).toBe(403);

    const noCookie = await call(port, {
      method: "POST",
      path: "/api/v1/repository",
      headers: sessionHeaders(port),
      body: JSON.stringify({ path: root }),
    });
    expect(noCookie.status).toBe(401);

    const badCookie = await call(port, {
      method: "POST",
      path: "/api/v1/repository",
      headers: sessionHeaders(port, { cookie: `${SESSION_COOKIE_NAME}=${"0".repeat(64)}` }),
      body: JSON.stringify({ path: root }),
    });
    expect(badCookie.status).toBe(401);

    for (const duplicate of [
      `${cookie}; ${SESSION_COOKIE_NAME}=${"0".repeat(64)}`,
      `${SESSION_COOKIE_NAME}=${"0".repeat(64)}; ${cookie}`,
    ]) {
      const duplicateCookie = await call(port, {
        method: "POST",
        path: "/api/v1/repository",
        headers: sessionHeaders(port, { cookie: duplicate }),
        body: JSON.stringify({ path: root }),
      });
      expect(duplicateCookie.status).toBe(401);
    }
  });

  it("requires an exact JSON media type and accepts parameters", async () => {
    const { port, cap } = await launch();
    const cookie = await exchangeCookie(port, cap);
    const root = await tempRepo();

    for (const contentType of [undefined, "text/plain", "application/json;"]) {
      const headers = sessionHeaders(port, { cookie });
      if (contentType === undefined) delete headers["content-type"];
      else headers["content-type"] = contentType;
      const r = await call(port, {
        method: "POST",
        path: "/api/v1/repository",
        headers,
        body: JSON.stringify({ path: root }),
      });
      expect(r.status).toBe(415);
    }

    const accepted = await call(port, {
      method: "POST",
      path: "/api/v1/repository",
      headers: sessionHeaders(port, {
        cookie,
        "content-type": 'Application/JSON; charset="utf-8"',
      }),
      body: JSON.stringify({ path: root }),
    });
    expect(accepted.status).toBe(200);
  });

  it("initializes and resumes through the authenticated route", async () => {
    const { port, cap } = await launch();
    const cookie = await exchangeCookie(port, cap);
    const root = await tempRepo();
    await writeFile(join(root, ".gitignore"), ".bearing/\n");

    const initialized = await call(port, {
      method: "POST",
      path: "/api/v1/repository",
      headers: sessionHeaders(port, { cookie }),
      body: JSON.stringify({ path: root }),
    });
    expect(initialized.status).toBe(200);
    expect(JSON.parse(initialized.body)).toMatchObject({
      status: "initialized",
      repositoryPath: root,
      disclosure: `Bearing writes durable planning state to ${root}/.bearing/ (gitignored).`,
      gitignoreMissing: false,
    });
    expect(await readFile(join(root, ".bearing", "workspace.json"), "utf8")).toContain(root);

    const resumed = await call(port, {
      method: "POST",
      path: "/api/v1/repository",
      headers: sessionHeaders(port, { cookie }),
      body: JSON.stringify({ path: root }),
    });
    expect(resumed.status).toBe(200);
    expect(JSON.parse(resumed.body)).toMatchObject({ status: "resumed", repositoryPath: root });
    expect(resumed.body).not.toContain(cookie);
    expect(resumed.body).not.toContain(cap);

    const nextRoot = await tempRepo();
    const switched = await call(port, {
      method: "POST",
      path: "/api/v1/repository",
      headers: sessionHeaders(port, { cookie }),
      body: JSON.stringify({ path: nextRoot }),
    });
    expect(switched.status).toBe(200);
    expect(JSON.parse(switched.body)).toMatchObject({ status: "initialized", repositoryPath: nextRoot });
    expect(await readFile(join(nextRoot, ".bearing", "workspace.json"), "utf8")).toContain(nextRoot);
  });

  it("rejects malformed, oversized, and invalid repository requests before mutation", async () => {
    const { port, cap } = await launch();
    const cookie = await exchangeCookie(port, cap);
    const root = await tempRepo();
    const file = join(root, "file");
    await writeFile(file, "");

    const malformed = await call(port, {
      method: "POST",
      path: "/api/v1/repository",
      headers: sessionHeaders(port, { cookie }),
      body: "{bad",
    });
    expect(malformed.status).toBe(400);

    const extraKey = await call(port, {
      method: "POST",
      path: "/api/v1/repository",
      headers: sessionHeaders(port, { cookie }),
      body: JSON.stringify({ path: root, ignored: true }),
    });
    expect(extraKey.status).toBe(400);

    const oversized = await call(port, {
      method: "POST",
      path: "/api/v1/repository",
      headers: sessionHeaders(port, { cookie }),
      body: JSON.stringify({ path: "x".repeat(9 * 1024) }),
    });
    expect(oversized.status).toBe(413);

    const relative = await call(port, {
      method: "POST",
      path: "/api/v1/repository",
      headers: sessionHeaders(port, { cookie }),
      body: JSON.stringify({ path: "relative" }),
    });
    expect(relative.status).toBe(400);

    const notDirectory = await call(port, {
      method: "POST",
      path: "/api/v1/repository",
      headers: sessionHeaders(port, { cookie }),
      body: JSON.stringify({ path: file }),
    });
    expect(notDirectory.status).toBe(400);
  });

  it("requires typed non-git confirmation and preserves exact-key validation", async () => {
    const { port, cap } = await launch();
    const cookie = await exchangeCookie(port, cap);
    const root = await tempDirectory();

    const blocked = await call(port, {
      method: "POST",
      path: "/api/v1/repository",
      headers: sessionHeaders(port, { cookie }),
      body: JSON.stringify({ path: root }),
    });
    expect(blocked.status).toBe(422);
    expect(JSON.parse(blocked.body)).toMatchObject({
      status: "blocked",
      code: "repository_not_git",
      remedy: expect.any(String),
    });

    for (const body of [
      { path: root, confirmNonGit: false },
      { path: root, confirmNonGit: true, extra: true },
    ]) {
      expect((await call(port, {
        method: "POST",
        path: "/api/v1/repository",
        headers: sessionHeaders(port, { cookie }),
        body: JSON.stringify(body),
      })).status).toBe(400);
    }

    const confirmed = await call(port, {
      method: "POST",
      path: "/api/v1/repository",
      headers: sessionHeaders(port, { cookie }),
      body: JSON.stringify({ path: root, confirmNonGit: true }),
    });
    expect(confirmed.status).toBe(200);
    expect(JSON.parse(confirmed.body)).toMatchObject({
      status: "initialized",
      repositoryPath: root,
      disclosure: expect.stringContaining(`${root}/.bearing/`),
      gitignoreMissing: false,
    });
  });

  it("maps containment and genuine unexpected bootstrap failures to typed JSON", async () => {
    class ContainsAgentBootstrap extends RepositoryBootstrap {
      override async choose(): Promise<BootstrapResult> {
        return { ok: false, reason: "repository_contains_agent" };
      }
    }
    class UnexpectedBootstrap extends RepositoryBootstrap {
      override async choose(): Promise<BootstrapResult> {
        throw new Error("unexpected");
      }
    }
    const root = await tempRepo();

    const contained = await launchHandler(new ContainsAgentBootstrap());
    const containedCookie = await exchangeCookie(contained.port, contained.cap);
    const blocked = await call(contained.port, {
      method: "POST",
      path: "/api/v1/repository",
      headers: sessionHeaders(contained.port, { cookie: containedCookie }),
      body: JSON.stringify({ path: root }),
    });
    expect(blocked.status).toBe(422);
    expect(JSON.parse(blocked.body)).toMatchObject({
      status: "blocked",
      code: "repository_contains_agent",
      remedy: expect.any(String),
    });

    const unexpected = await launchHandler(new UnexpectedBootstrap());
    const unexpectedCookie = await exchangeCookie(unexpected.port, unexpected.cap);
    const failed = await call(unexpected.port, {
      method: "POST",
      path: "/api/v1/repository",
      headers: sessionHeaders(unexpected.port, { cookie: unexpectedCookie }),
      body: JSON.stringify({ path: root }),
    });
    expect(failed.status).toBe(500);
    expect(JSON.parse(failed.body)).toEqual({
      status: "error",
      code: "internal_error",
      remedy: "Unexpected error. Try again.",
    });
  });

  it("returns the resolved candidate so a browse confirmation never re-opens the picker", async () => {
    const root = await realpath(await tempDirectory());
    let resolveCalls = 0;
    const { port, cap } = await launchHandler(new RepositoryBootstrap(), {
      repositoryChoice: {
        options: async () => ({
          platform: "linux" as const,
          current: { path: root, source: "cwd" as const, isGitRoot: false },
          browse: { available: true, picker: "zenity" as const },
        }),
        resolve: async () => {
          resolveCalls += 1;
          return { result: "selected" as const, candidate: root, source: "picker" as const, picker: "zenity" as const };
        },
      },
    });
    const cookie = await exchangeCookie(port, cap);

    const blocked = await call(port, {
      method: "POST",
      path: "/api/v1/repository",
      headers: sessionHeaders(port, { cookie }),
      body: JSON.stringify({ choice: "browse" }),
    });
    expect(blocked.status).toBe(422);
    expect(JSON.parse(blocked.body)).toEqual({
      status: "blocked",
      code: "repository_not_git",
      remedy: "Not a Git repo — confirm to use for planning, or pick a repo.",
      candidate: root,
    });
    expect(resolveCalls).toBe(1);

    const confirmed = await call(port, {
      method: "POST",
      path: "/api/v1/repository",
      headers: sessionHeaders(port, { cookie }),
      body: JSON.stringify({ path: JSON.parse(blocked.body).candidate, confirmNonGit: true }),
    });
    expect(confirmed.status).toBe(200);
    expect(JSON.parse(confirmed.body)).toMatchObject({ status: "initialized", repositoryPath: root });
    expect(resolveCalls).toBe(1);
  });

  it("omits the candidate from repository failures that are not a non-git rejection", async () => {
    const { port, cap } = await launch();
    const cookie = await exchangeCookie(port, cap);
    const notDirectory = await call(port, {
      method: "POST",
      path: "/api/v1/repository",
      headers: sessionHeaders(port, { cookie }),
      body: JSON.stringify({ path: join(await tempDirectory(), "absent") }),
    });
    expect(notDirectory.status).toBe(400);
    expect(JSON.parse(notDirectory.body)).toEqual({
      status: "blocked",
      code: "repository_unavailable",
      remedy: "The repository is unavailable. Choose an accessible directory.",
    });
  });

  it("bootstraps with the choice service's agent-executable realpaths", async () => {
    const root = await tempRepo();
    const unavailable = { unavailable: "launch_cwd_unavailable" as const };
    const { port, cap } = await launchHandler(new RepositoryBootstrap(), {
      repositoryChoice: {
        options: async () => unavailable,
        resolve: async () => unavailable,
        agentExecutableRealpaths: () => [join(root, "bin", "codex")],
      },
    });
    const cookie = await exchangeCookie(port, cap);

    const blocked = await call(port, {
      method: "POST",
      path: "/api/v1/repository",
      headers: sessionHeaders(port, { cookie }),
      body: JSON.stringify({ path: root }),
    });
    expect(blocked.status).toBe(422);
    expect(JSON.parse(blocked.body)).toMatchObject({
      status: "blocked",
      code: "repository_contains_agent",
      remedy: expect.any(String),
    });
    await expect(access(join(root, ".bearing"))).rejects.toBeDefined();
  });

  it("returns launch-cwd-unavailable from choice and options as 409, never 500", async () => {
    const unavailable = { unavailable: "launch_cwd_unavailable" as const };
    const { port, cap } = await launchHandler(new RepositoryBootstrap(), {
      repositoryChoice: {
        options: async () => unavailable,
        resolve: async () => unavailable,
      },
    });
    const cookie = await exchangeCookie(port, cap);

    const options = await call(port, {
      method: "GET",
      path: "/api/v1/repository-options",
      headers: { cookie },
    });
    expect(options.status).toBe(409);
    expect(JSON.parse(options.body)).toMatchObject({
      status: "blocked",
      code: "launch_cwd_unavailable",
      remedy: expect.any(String),
    });

    const selected = await call(port, {
      method: "POST",
      path: "/api/v1/repository",
      headers: sessionHeaders(port, { cookie }),
      body: JSON.stringify({ choice: "current" }),
    });
    expect(selected.status).toBe(409);
    expect(JSON.parse(selected.body)).toMatchObject({
      status: "blocked",
      code: "launch_cwd_unavailable",
      remedy: expect.any(String),
    });
  });
});

describe("POST /api/v1/repository/gitignore", () => {
  it("appends once with explicit consent and refuses missing files and non-git repositories", async () => {
    const { port, cap } = await launch();
    const cookie = await exchangeCookie(port, cap);
    const root = await tempRepo();
    await writeFile(join(root, ".gitignore"), "dist/\n");

    const initialized = await call(port, {
      method: "POST",
      path: "/api/v1/repository",
      headers: sessionHeaders(port, { cookie }),
      body: JSON.stringify({ path: root }),
    });
    expect(JSON.parse(initialized.body)).toMatchObject({ status: "initialized", gitignoreMissing: true });

    for (const expected of ["dist/\n.bearing/\n", "dist/\n.bearing/\n"]) {
      const response = await call(port, {
        method: "POST",
        path: "/api/v1/repository/gitignore",
        headers: sessionHeaders(port, { cookie }),
        body: "{}",
      });
      expect(response.status).toBe(200);
      expect(JSON.parse(response.body)).toEqual({ status: "ok", gitignored: true });
      expect(await readFile(join(root, ".gitignore"), "utf8")).toBe(expected);
    }

    const missing = await tempRepo();
    expect((await call(port, {
      method: "POST",
      path: "/api/v1/repository",
      headers: sessionHeaders(port, { cookie }),
      body: JSON.stringify({ path: missing }),
    })).status).toBe(200);
    const noFile = await call(port, {
      method: "POST",
      path: "/api/v1/repository/gitignore",
      headers: sessionHeaders(port, { cookie }),
      body: "{}",
    });
    expect(noFile.status).toBe(409);
    expect(JSON.parse(noFile.body)).toMatchObject({ status: "blocked", code: "gitignore_missing", remedy: expect.any(String) });
    await expect(access(join(missing, ".gitignore"))).rejects.toBeDefined();

    const nonGit = await tempDirectory();
    expect((await call(port, {
      method: "POST",
      path: "/api/v1/repository",
      headers: sessionHeaders(port, { cookie }),
      body: JSON.stringify({ path: nonGit, confirmNonGit: true }),
    })).status).toBe(200);
    const notGit = await call(port, {
      method: "POST",
      path: "/api/v1/repository/gitignore",
      headers: sessionHeaders(port, { cookie }),
      body: "{}",
    });
    expect(notGit.status).toBe(422);
    expect(JSON.parse(notGit.body)).toMatchObject({ status: "blocked", code: "repository_not_git", remedy: expect.any(String) });
    await expect(access(join(nonGit, ".gitignore"))).rejects.toBeDefined();
  });

  it("treats a bare .bearing ignore line as already ignored and never appends a duplicate", async () => {
    const { port, cap } = await launch();
    const cookie = await exchangeCookie(port, cap);
    const root = await tempRepo();
    await writeFile(join(root, ".gitignore"), "dist/\n.bearing\n");

    const initialized = await call(port, {
      method: "POST",
      path: "/api/v1/repository",
      headers: sessionHeaders(port, { cookie }),
      body: JSON.stringify({ path: root }),
    });
    expect(JSON.parse(initialized.body)).toMatchObject({ status: "initialized", gitignoreMissing: false });

    const response = await call(port, {
      method: "POST",
      path: "/api/v1/repository/gitignore",
      headers: sessionHeaders(port, { cookie }),
      body: "{}",
    });
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ status: "ok", gitignored: true });
    expect(await readFile(join(root, ".gitignore"), "utf8")).toBe("dist/\n.bearing\n");
  });

  it("keeps the repository mutation guards on the consent endpoint", async () => {
    const { port, cap } = await launch();
    const cookie = await exchangeCookie(port, cap);

    expect((await call(port, {
      method: "POST",
      path: "/api/v1/repository/gitignore",
      headers: sessionHeaders(port),
      body: "{}",
    })).status).toBe(401);
    expect((await call(port, {
      method: "POST",
      path: "/api/v1/repository/gitignore",
      headers: sessionHeaders(port, { cookie, origin: "https://evil.example" }),
      body: "{}",
    })).status).toBe(403);
    expect((await call(port, {
      method: "POST",
      path: "/api/v1/repository/gitignore",
      headers: sessionHeaders(port, { cookie, "content-type": "text/plain" }),
      body: "{}",
    })).status).toBe(415);
    expect((await call(port, {
      method: "POST",
      path: "/api/v1/repository/gitignore",
      headers: sessionHeaders(port, { cookie }),
      body: JSON.stringify({ extra: true }),
    })).status).toBe(400);
  });
});

describe("POST /api/v1/owner", () => {
  it("persists an exact validated name and returns it on the next repository session", async () => {
    const first = await launch();
    const firstCookie = await exchangeCookie(first.port, first.cap);
    const root = await tempRepo();

    expect((await call(first.port, {
      method: "POST",
      path: "/api/v1/owner",
      headers: sessionHeaders(first.port, { origin: "https://evil.example", cookie: firstCookie }),
      body: JSON.stringify({ name: "Smokie" }),
    })).status).toBe(403);
    expect((await call(first.port, {
      method: "POST",
      path: "/api/v1/owner",
      headers: sessionHeaders(first.port),
      body: JSON.stringify({ name: "Smokie" }),
    })).status).toBe(401);

    const beforeRepository = await call(first.port, {
      method: "POST",
      path: "/api/v1/owner",
      headers: sessionHeaders(first.port, { cookie: firstCookie }),
      body: JSON.stringify({ name: "Smokie" }),
    });
    expect(beforeRepository.status).toBe(409);

    expect((await call(first.port, {
      method: "POST",
      path: "/api/v1/repository",
      headers: sessionHeaders(first.port, { cookie: firstCookie }),
      body: JSON.stringify({ path: root }),
    })).status).toBe(200);

    for (const body of [{ name: "" }, { name: " Smokie " }, { name: "bad\nname" }, { name: "Smokie", extra: true }]) {
      expect((await call(first.port, {
        method: "POST",
        path: "/api/v1/owner",
        headers: sessionHeaders(first.port, { cookie: firstCookie }),
        body: JSON.stringify(body),
      })).status).toBe(400);
    }

    const saved = await call(first.port, {
      method: "POST",
      path: "/api/v1/owner",
      headers: sessionHeaders(first.port, { cookie: firstCookie }),
      body: JSON.stringify({ name: "Smokie" }),
    });
    expect(saved.status).toBe(200);
    expect(JSON.parse(saved.body)).toMatchObject({ name: "Smokie", greeting: expect.stringContaining("Smokie") });
    expect(JSON.parse(await readFile(join(root, ".bearing", "owner.json"), "utf8"))).toEqual({ name: "Smokie" });

    const second = await launch();
    const secondCookie = await exchangeCookie(second.port, second.cap);
    const resumed = await call(second.port, {
      method: "POST",
      path: "/api/v1/repository",
      headers: sessionHeaders(second.port, { cookie: secondCookie }),
      body: JSON.stringify({ path: root }),
    });
    expect(resumed.status).toBe(200);
    expect(JSON.parse(resumed.body)).toMatchObject({ status: "resumed", ownerName: "Smokie", greeting: expect.stringContaining("Smokie") });
  });
});

describe("POST /api/v1/session rejection matrix", () => {
  it("requires exactly the capability key", async () => {
    const { port, cap } = await launch();
    const r = await call(port, {
      method: "POST",
      path: "/api/v1/session",
      headers: sessionHeaders(port),
      body: JSON.stringify({ capability: cap, ignored: true }),
    });
    expect(r.status).toBe(400);
  });
  it("rejects a wrong Host (DNS-rebinding guard)", async () => {
    const { port, cap } = await launch();
    const r = await call(port, {
      method: "POST",
      path: "/api/v1/session",
      headers: sessionHeaders(port, { host: "evil.example" }),
      body: JSON.stringify({ capability: cap }),
    });
    expect(r.status).toBe(421);
    expect(r.body).not.toContain(cap);
  });

  it("rejects a missing Origin", async () => {
    const { port, cap } = await launch();
    const r = await call(port, {
      method: "POST",
      path: "/api/v1/session",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ capability: cap }),
    });
    expect(r.status).toBe(403);
  });

  it("rejects a cross-site Origin", async () => {
    const { port, cap } = await launch();
    const r = await call(port, {
      method: "POST",
      path: "/api/v1/session",
      headers: sessionHeaders(port, { origin: "https://evil.example" }),
      body: JSON.stringify({ capability: cap }),
    });
    expect(r.status).toBe(403);
  });

  it("rejects a wrong capability without consuming it", async () => {
    const { port, cap } = await launch();
    const r1 = await call(port, {
      method: "POST",
      path: "/api/v1/session",
      headers: sessionHeaders(port),
      body: JSON.stringify({ capability: "0".repeat(64) }),
    });
    expect(r1.status).toBe(403);
    // the real capability still exchanges after a failed attempt
    const r2 = await call(port, {
      method: "POST",
      path: "/api/v1/session",
      headers: sessionHeaders(port),
      body: JSON.stringify({ capability: cap }),
    });
    expect(r2.status).toBe(200);
  });

  it("exchanges once, sets a strict cookie, and rejects replay", async () => {
    const { port, cap } = await launch();
    const r = await call(port, {
      method: "POST",
      path: "/api/v1/session",
      headers: sessionHeaders(port),
      body: JSON.stringify({ capability: cap }),
    });
    expect(r.status).toBe(200);
    const sc = r.headers["set-cookie"];
    expect(Array.isArray(sc)).toBe(true);
    const cookie = (sc as string[])[0];
    expect(cookie).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Path=/");
    expect(cookie).not.toContain("Secure"); // plain loopback HTTP
    expect(r.body).not.toContain(cap); // capability never echoed, even on success

    const authenticatedReplay = await call(port, {
      method: "POST",
      path: "/api/v1/session",
      headers: sessionHeaders(port, { cookie: cookie.split(";")[0] }),
      body: JSON.stringify({ capability: cap }),
    });
    expect(authenticatedReplay.status).toBe(200);
    expect(authenticatedReplay.headers["set-cookie"]).toBeUndefined();

    const replay = await call(port, {
      method: "POST",
      path: "/api/v1/session",
      headers: sessionHeaders(port),
      body: JSON.stringify({ capability: cap }),
    });
    expect(replay.status).toBe(403);
  });

  it("rejects oversized and malformed bodies", async () => {
    const { port } = await launch();
    const big = await call(port, {
      method: "POST",
      path: "/api/v1/session",
      headers: sessionHeaders(port),
      body: "x".repeat(9 * 1024),
    });
    expect(big.status).toBe(413);

    const bad = await call(port, {
      method: "POST",
      path: "/api/v1/session",
      headers: sessionHeaders(port),
      body: "{not json",
    });
    expect(bad.status).toBe(400);

    const missing = await call(port, {
      method: "POST",
      path: "/api/v1/session",
      headers: sessionHeaders(port),
      body: JSON.stringify({ nope: true }),
    });
    expect(missing.status).toBe(400);
  });

  it("requires an exact JSON media type before consuming the capability", async () => {
    const { port, cap } = await launch();

    for (const contentType of [undefined, "text/plain", "application/json;"]) {
      const headers = sessionHeaders(port);
      if (contentType === undefined) delete headers["content-type"];
      else headers["content-type"] = contentType;
      const r = await call(port, {
        method: "POST",
        path: "/api/v1/session",
        headers,
        body: JSON.stringify({ capability: cap }),
      });
      expect(r.status).toBe(415);
    }

    const accepted = await call(port, {
      method: "POST",
      path: "/api/v1/session",
      headers: sessionHeaders(port, {
        "content-type": "Application/JSON; Charset=UTF-8",
      }),
      body: JSON.stringify({ capability: cap }),
    });
    expect(accepted.status).toBe(200);
  });
});

describe("createRequestHandler host binding", () => {
  it("binds Host checks to the host the service was constructed with", () => {
    // ponytail: a direct handler test proves Host binding without spinning a socket.
    const service = new LocalSessionService("127.0.0.1:7");
    const handler = createRequestHandler(service);
    const calls: { status: number }[] = [];
    const res = {
      writeHead(status: number) {
        calls.push({ status });
      },
      end() {},
    } as unknown as import("node:http").ServerResponse;
    handler({ method: "GET", url: "/", headers: { host: "127.0.0.1:8" } } as never, res);
    expect(calls[0]?.status).toBe(421);
  });
});
