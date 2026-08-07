import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { createServer, request as httpRequest } from "node:http";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { ProcessInvocation, ProcessResult, ProcessRunner } from "../src/adapters/adapters.js";
import { RepositoryBootstrap } from "../src/repository/bootstrap.js";
import { LocalSessionService, createRequestHandler } from "../src/server/local-session.js";
import { BearingStore } from "../src/store/bearing-store.js";

const servers: Server[] = [];
const roots: string[] = [];
afterEach(async () => {
  while (servers.length) {
    const server = servers.pop()!;
    await new Promise<void>((resolve) => server.close(() => resolve()));
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

function sessionHeaders(port: string, extra: Record<string, string> = {}): Record<string, string> {
  return { origin: `http://127.0.0.1:${port}`, "content-type": "application/json", ...extra };
}

async function tempRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "bearing-session-"));
  roots.push(root);
  // A real (empty) repository: `git rev-parse` must succeed so stages that
  // snapshot Git state see an available snapshot.
  await new Promise<void>((resolve, reject) => {
    execFile("git", ["init", "-q"], { cwd: root }, (error) => (error ? reject(error) : resolve()));
  });
  return root;
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

async function readyJourneyHandler(
  root: string,
  runner: ProcessRunner,
): Promise<{ port: string; cookie: string }> {
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

async function seedRun(root: string, runId: string, planDirectory: string): Promise<BearingStore> {
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
  const checkpoint = await store.apply({
    schemaVersion: 1,
    commandId: `fit-${runId}`,
    runId,
    expectedRevision: created.state.revision,
    type: "recordJourneyCheckpoint",
    payload: fitCheckpointPayload(root, planDirectory),
    session: { sessionId: "test-bearing", actor: "bearing" },
    correlationId: `fit-${runId}`,
  });
  if (!checkpoint.ok) throw new Error(checkpoint.reason);
  return store;
}

async function recordPlanningApproval(store: BearingStore, runId: string): Promise<void> {
  let durable = await store.load(runId);
  const decisionId = `plan-review-${runId}`;
  const required = await store.apply({
    schemaVersion: 1,
    commandId: `require-plan-review-${runId}`,
    runId,
    expectedRevision: durable.revision,
    type: "requireDecision",
    payload: { decisionId, question: "Approve the complete planning package before implementation?", consequential: true },
    session: { sessionId: "test-owner", actor: "owner" },
    correlationId: `require-plan-review-${runId}`,
  });
  if (!required.ok) throw new Error(required.reason);
  durable = await store.load(runId);
  const approved = await store.apply({
    schemaVersion: 1,
    commandId: `approve-plan-review-${runId}`,
    runId,
    expectedRevision: durable.revision,
    type: "recordOwnerAnswer",
    payload: { decisionId, answer: "Approved for execution-mode selection" },
    session: { sessionId: "test-owner", actor: "owner" },
    correlationId: `approve-plan-review-${runId}`,
  });
  if (!approved.ok) throw new Error(approved.reason);
}

const planFixture = "---\ntype: plan-spec\nstatus: complete\n---\n\n## Acceptance criteria\n\n- **AC-1** — Bounded work is complete.\n\n## Risks and open questions\n\n- **RISK-1** — Invalid output fails closed.\n\n## Entry criteria\n\nApproved scope.\n\n## Exit criteria\n\nAll evidence passes.\n\n## Rollback or repair\n\nRepair the bounded slice.\n\n## Accountable controller\n\nNavigator.\n";
const designFixture = "---\ntype: design\nstatus: complete\n---\n\n## Use Cases and Communication Flows\n\nComplete flow.\n\n## Interface Option Check\n\ninterface_options: not needed - fixture\n\n## OOPDSA Implementation Design\n\n- **DES-1** — Use the existing boundary.\n- **CONTRACT-1** — Reject invalid output.\n";
const seitFixture = "---\ntype: seit\nstatus: complete\n---\n\n## Required Commands\n\n- **CMD-UNIT** — `pnpm test`\n\n## Traceability Matrix\n\n| SEIT row ID | Acceptance/risk ID | Design/contract ID | Boundary/test layer | Positive case | Negative/failure case | Command/procedure ID | Evidence |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n| SEIT-1 | AC-1 | DES-1, CONTRACT-1 | unit | valid output passes | invalid output fails closed | CMD-UNIT | test report |\n| SEIT-2 | RISK-1 | CONTRACT-1 | unit | valid output remains bounded | invalid output is rejected | CMD-UNIT | test report |\n\n## Cross-cutting Checks\n\nComplete checks.\n";
const implementationFixture = "---\ntype: implementation\nstatus: complete\nplan_spec: ./plan-spec.md\ndesign: ./design.md\nseit: ./seit.md\n---\n\n# Implementation\n\n## Phase 1 — Build\n\n### Slice 1.1 — Work\n\n**Goal.** Complete bounded work.\n\n**Requirement IDs.** AC-1\n\n**Design IDs.** DES-1, CONTRACT-1\n\n**SEIT proof rows.** SEIT-1\n\n**Type.** /tdd\n\n**Design lenses.** CDD\n\n**Implementation role.** Backend Engineer\n\n**Agent model route.** Codex agent default\n\n**Agent reasoning level.** medium.\n\n**Ponytail mode.** full\n\n**Review path.** native review\n\n### 1.1 execution manifest\n\n**Write set.** `src/work.ts` only.\n\n**Command IDs.** CMD-UNIT\n\n**Stop condition.** Stop if focused validation fails.\n\n**Human decision.** None.\n";
// Wave 1: Slice 1.1 (writes src/work.ts). Wave 2: Slice 1.2 (writes src/follow-up.ts).
// 1.2 is a later-wave slice, so 1.1 is its declared prerequisite.
const multiSliceImplementationFixture = `${implementationFixture}\n## Dependencies\n\n- Wave 1: Slice 1.1.\n- Wave 2: Slice 1.2.\n\n### Slice 1.2 — Follow-up\n\n**Goal.** Complete the selected follow-up work.\n\n**Requirement IDs.** AC-1\n\n**Design IDs.** DES-1, CONTRACT-1\n\n**SEIT proof rows.** SEIT-1\n\n**Type.** /tdd\n\n**Design lenses.** CDD\n\n**Implementation role.** Backend Engineer\n\n**Agent model route.** Codex agent default\n\n**Agent reasoning level.** medium.\n\n**Ponytail mode.** full\n\n**Review path.** native review\n\n### 1.2 execution manifest\n\n**Write set.** \`src/follow-up.ts\` only.\n\n**Command IDs.** CMD-UNIT\n\n**Stop condition.** Stop if focused validation fails.\n\n**Human decision.** None.\n`;
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

const FINAL_QA_PENDING = '<section id="bearing-final-qa" data-status="pending"><h2>Actual implementation and QA</h2><p>Pending implementation and validation.</p></section>';

/**
 * Slice-aware Expedition runner: planning stages mirror the standard guided
 * fixture; the Expedition write dispatch writes the selected slice's file
 * (src/work.ts for 1.1, src/follow-up.ts for 1.2) so validation evidence
 * matches each slice's envelope write set.
 */
class SliceAwareGuidedRunner implements ProcessRunner {
  readonly calls: ProcessInvocation[] = [];
  executableAvailable(): boolean { return true; }
  async verify(): Promise<boolean> { return true; }
  async run(invocation: ProcessInvocation): Promise<ProcessResult> {
    this.calls.push(invocation);
    const planDirectory = /Validated plan directory: "([^"]+)"/.exec(invocation.stdin)?.[1] ?? "docs/plans/issue-129-dependency-slice";
    if (invocation.stdin.includes("Stage: execute-expedition")) {
      // The coordinated-Expedition coordinator dispatch is read-only and asks for handoff
      // approval; only the subsequent authorized dispatch performs the product write.
      if (invocation.args.includes("--allow-subagents") || invocation.args.some((arg) => arg.includes("read-only"))) {
        return { exitCode: 0, events: [{ type: "item.completed", data: { content: 'BEARING_RESULT {"kind":"question","question":"Selected-slice handoff ready."}' } }], usage: { tokens: 1 } };
      }
      const sliceOne = invocation.stdin.includes('"remainingSlices":["1.1"]');
      const writePath = sliceOne ? "src/work.ts" : "src/follow-up.ts";
      const reviewPath = join(invocation.cwd, planDirectory, "review.html");
      const review = await readFile(reviewPath, "utf8");
      await mkdir(join(invocation.cwd, "src"), { recursive: true });
      // Slice 1.1 replaces the pending final-QA baseline. When slice 1.2 runs, that baseline is
      // already complete, so it rewrites the evidence paragraph instead — the completion contract
      // requires review.html to actually change on every slice run.
      const updatedReview = sliceOne
        ? review.replace(
          FINAL_QA_PENDING,
          `<section id="bearing-final-qa" data-status="complete"><h2>Actual implementation and QA</h2><p>Planned versus actual: ${writePath} changed exactly as planned.</p><p>Validation evidence: CMD-UNIT passed.</p></section>`,
        )
        : review.replace(
          "<p>Planned versus actual: src/work.ts changed exactly as planned.</p>",
          `<p>Planned versus actual: ${writePath} changed exactly as planned.</p>`,
        );
      await Promise.all([
        writeFile(join(invocation.cwd, writePath), sliceOne ? "export const complete = true;\n" : "export const followUp = true;\n"),
        writeFile(reviewPath, updatedReview),
      ]);
      const content = `BEARING_RESULT ${JSON.stringify({
        kind: "action",
        summary: "Selected guided slice complete.",
        artifacts: [writePath, `${planDirectory}/review.html`],
        evidence: [{ commandId: "CMD-UNIT", status: "passed", summary: "focused tests passed" }],
      })}`;
      return { exitCode: 0, events: [{ type: "item.completed", data: { content } }], usage: { tokens: 1 } };
    }
    if (invocation.stdin.includes("Stage: map-route")) {
      await Promise.all([
        writeFile(join(invocation.cwd, planDirectory, "design.md"), designFixture),
        writeFile(join(invocation.cwd, planDirectory, "seit.md"), seitFixture),
      ]);
      const content = `BEARING_RESULT {"kind":"action","summary":"Route mapped.","artifacts":["${planDirectory}/design.md","${planDirectory}/seit.md"]}`;
      return { exitCode: 0, events: [{ type: "item.completed", data: { content } }], usage: { tokens: 1 } };
    }
    if (invocation.stdin.includes("Stage: recon")) {
      await mkdir(join(invocation.cwd, "tmp"), { recursive: true });
      await writeFile(join(invocation.cwd, "tmp/recon.json"), "{}\n");
      const content = `BEARING_RESULT ${JSON.stringify({ kind: "recon", summary: "Recon completed.", artifacts: ["tmp/recon.json"], brief: reconBrief, report: reconReport })}`;
      return { exitCode: 0, events: [{ type: "item.completed", data: { content } }], usage: { tokens: 1 } };
    }
    if (invocation.stdin.includes("Stage: draft-implementation")) {
      await writeFile(join(invocation.cwd, planDirectory, "implementation.md"), multiSliceImplementationFixture);
      const content = `BEARING_RESULT {"kind":"action","summary":"Implementation drafted.","artifacts":["${planDirectory}/implementation.md"]}`;
      return { exitCode: 0, events: [{ type: "item.completed", data: { content } }], usage: { tokens: 1 } };
    }
    await writeFile(join(invocation.cwd, planDirectory, "plan-spec.md"), planFixture);
    const content = `BEARING_RESULT {"kind":"action","summary":"Requirements ready.","artifacts":["${planDirectory}/plan-spec.md"]}`;
    return { exitCode: 0, events: [{ type: "item.completed", data: { content } }], usage: { tokens: 1 } };
  }
}

describe("issue 129 — Expedition dependency admission", () => {
  it("refuses a slice with incomplete prerequisite slices, then admits it once the prerequisite validates", async () => {
    const root = await tempRepo();
    const runner = new SliceAwareGuidedRunner();
    const { port, cookie } = await readyJourneyHandler(root, runner);
    const runId = "issue-129-dependency-slice";
    const planDirectory = `docs/plans/${runId}`;
    const store = await seedRun(root, runId, planDirectory);
    for (const stage of ["set-bearings", "gather-supplies", "map-route", "recon", "draft-implementation"] as const) {
      const response = await call(port, {
        method: "POST",
        path: "/api/v1/journey",
        headers: sessionHeaders(port, { cookie }),
        body: JSON.stringify({ runId, stage, workGoal: "Complete the approved work" }),
      });
      expect(response.status, response.body).toBe(200);
    }
    await recordPlanningApproval(store, runId);

    // 1.2 is a Wave-2 slice whose Wave-1 prerequisite (1.1) has never been validated,
    // so admitting it would let the Expedition reach terminal success with slices
    // unimplemented. Execution must be refused before any adapter dispatch.
    const refused = await call(port, {
      method: "POST",
      path: "/api/v1/journey",
      headers: sessionHeaders(port, { cookie }),
      body: JSON.stringify({
        runId,
        stage: "execute-expedition",
        workGoal: "Complete the approved work",
        executionMode: "expedition",
        reviewCadence: "slice",
        currentSlice: "1.2",
      }),
    });
    expect(refused.status, refused.body).toBe(409);
    expect(JSON.parse(refused.body)).toMatchObject({ status: "failure", code: "dependency_refused" });
    // The refusal must not have launched any adapter run or persisted a slice selection.
    expect(runner.calls.filter((invocation) => invocation.stdin.includes("Stage: execute-expedition"))).toHaveLength(0);
    const statusAfterRefusal = await call(port, { method: "GET", path: `/api/v1/journey/${runId}/status`, headers: { cookie } });
    expect(JSON.parse(statusAfterRefusal.body).run.currentSlice).toBeUndefined();

    // Control: the Wave-1 slice has no prerequisites and executes normally.
    const first = await call(port, {
      method: "POST",
      path: "/api/v1/journey",
      headers: sessionHeaders(port, { cookie }),
      body: JSON.stringify({
        runId,
        stage: "execute-expedition",
        workGoal: "Complete the approved work",
        executionMode: "expedition",
        reviewCadence: "slice",
        currentSlice: "1.1",
      }),
    });
    expect(first.status, first.body).toBe(200);
    expect(JSON.parse(first.body)).toMatchObject({
      status: "action",
      summary: "Selected guided slice complete.",
      selectedScope: { currentSlice: "1.1", remainingSlices: ["1.1"] },
    });

    // With 1.1 validated, 1.2's declared prerequisite is satisfied and it executes.
    const second = await call(port, {
      method: "POST",
      path: "/api/v1/journey",
      headers: sessionHeaders(port, { cookie }),
      body: JSON.stringify({
        runId,
        stage: "execute-expedition",
        workGoal: "Complete the approved work",
        executionMode: "expedition",
        reviewCadence: "slice",
        currentSlice: "1.2",
      }),
    });
    expect(second.status, second.body).toBe(200);
    expect(JSON.parse(second.body)).toMatchObject({
      status: "action",
      summary: "Selected guided slice complete.",
      selectedScope: { currentSlice: "1.2", remainingSlices: ["1.2"] },
    });

    // Both slices really executed their write dispatch (coordinator dispatches excluded).
    const writeDispatches = runner.calls.filter(
      (invocation) => invocation.stdin.includes("Stage: execute-expedition")
        && !invocation.args.includes("--allow-subagents")
        && !invocation.args.some((arg) => arg.includes("read-only")),
    );
    expect(writeDispatches.map((invocation) => invocation.stdin.match(/"remainingSlices":\["([^"]+)"\]/)?.[1])).toEqual(["1.1", "1.2"]);
  });
});
