import { createServer, request, type Server } from "node:http";
import { execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalSessionService, SESSION_COOKIE_NAME, createRequestHandler } from "../src/server/local-session.js";
import { SyntheticRunner, type ProcessRunner } from "../src/adapters/adapters.js";

const servers: Server[] = [];
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function launch(available = true) {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen({ host: "127.0.0.1", port: 0 }, resolve));
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing address");
  const port = String(address.port);
  const session = new LocalSessionService(`127.0.0.1:${port}`);
  let inspections = 0;
  let verifications = 0;
  server.on("request", createRequestHandler(session, undefined, {
    routeInspection: { executableAvailable: () => { inspections += 1; return available; } },
    verification: { verify: async () => { verifications += 1; return false; } },
  }));
  return { port, session, counts: () => ({ inspections, verifications }) };
}

function call(port: string, method: string, path: string, body?: unknown, cookie?: string, extraHeaders: Record<string, string> = {}) {
  return new Promise<{ status: number; body: string; headers: Record<string, string | string[] | undefined> }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers: { ...(body === undefined ? {} : { origin: `http://127.0.0.1:${port}`, "content-type": "application/json" }), ...(cookie ? { cookie } : {}), ...extraHeaders } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8"), headers: res.headers }));
    });
    req.on("error", reject);
    if (body !== undefined) req.end(JSON.stringify(body)); else req.end();
  });
}

async function launchChoice(repositoryChoice: NonNullable<Parameters<typeof createRequestHandler>[2]>["repositoryChoice"]) {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen({ host: "127.0.0.1", port: 0 }, resolve));
  servers.push(server);
  const address = server.address(); if (!address || typeof address === "string") throw new Error("missing address");
  const port = String(address.port);
  const session = new LocalSessionService(`127.0.0.1:${port}`);
  server.on("request", createRequestHandler(session, undefined, { repositoryChoice }));
  return { port, session };
}

async function authenticate(port: string, session: LocalSessionService): Promise<string> {
  const exchanged = session.exchange(session.capability);
  if (!exchanged.ok) throw new Error("exchange failed");
  return `${SESSION_COOKIE_NAME}=${exchanged.cookieValue}`;
}

async function postOwnerCommand(port: string, cookie: string, runId: string, type: string, payload: Record<string, unknown>): Promise<void> {
  const state = JSON.parse((await call(port, "GET", `/api/v1/runs/${runId}`, undefined, cookie)).body) as { revision: number };
  const id = `test-${state.revision}-${type}`;
  const response = await call(port, "POST", `/api/v1/runs/${runId}/commands`, { schemaVersion: 1, commandId: id, runId, expectedRevision: state.revision, session: { sessionId: "test", actor: "owner" }, correlationId: id, type, payload }, cookie);
  expect(response.status).toBe(200);
}

async function recordPlanningApproval(port: string, cookie: string, runId: string): Promise<void> {
  const decisionId = "planning-package-review";
  await postOwnerCommand(port, cookie, runId, "requireDecision", { decisionId, question: "Approve the complete planning package before implementation?", consequential: true });
  await postOwnerCommand(port, cookie, runId, "recordOwnerAnswer", { decisionId, answer: "Approved for execution-mode selection" });
}

describe("repository-first onboarding HTTP", () => {
  it("lists changed files and serves authenticated red-green diff data", async () => {
    const root = await mkdtemp(join(tmpdir(), "bearing-git-diff-")); roots.push(root);
    execFileSync("git", ["init", "-q"], { cwd: root });
    await writeFile(join(root, "tracked.txt"), "before\n");
    execFileSync("git", ["add", "tracked.txt"], { cwd: root });
    execFileSync("git", ["-c", "user.name=Bearing Test", "-c", "user.email=bearing@example.invalid", "commit", "-qm", "baseline"], { cwd: root });
    await writeFile(join(root, "tracked.txt"), "after\n");
    await writeFile(join(root, "new.txt"), "new line\n");
    const server = createServer(); await new Promise<void>((resolve) => server.listen({ host: "127.0.0.1", port: 0 }, resolve)); servers.push(server);
    const address = server.address(); if (!address || typeof address === "string") throw new Error("missing address");
    const port = String(address.port), session = new LocalSessionService(`127.0.0.1:${port}`), cookie = await authenticate(port, session);
    server.on("request", createRequestHandler(session));
    await call(port, "POST", "/api/v1/repository", { path: root }, cookie);
    const status = JSON.parse((await call(port, "GET", "/api/v1/history", undefined, cookie)).body);
    expect(status.changedFiles).toBeGreaterThanOrEqual(2);
    expect(status.gitChanges).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "tracked.txt", additions: 1, deletions: 1 }),
      expect.objectContaining({ path: "new.txt", status: "??", additions: null, deletions: null }),
    ]));
    expect((await call(port, "GET", "/api/v1/git-diff?path=tracked.txt")).status).toBe(401);
    const tracked = await call(port, "GET", "/api/v1/git-diff?path=tracked.txt", undefined, cookie);
    expect(tracked.status).toBe(200);
    expect(JSON.parse(tracked.body).diff).toMatch(/-before[\s\S]*\+after/);
    const added = await call(port, "GET", "/api/v1/git-diff?path=new.txt", undefined, cookie);
    expect(JSON.parse(added.body).diff).toContain("+new line");
    expect((await call(port, "GET", "/api/v1/git-diff?path=..%2Fsecret", undefined, cookie)).status).toBe(404);
  });

  it("deletes selected or all repository history without deleting generated files", async () => {
    const root = await mkdtemp(join(tmpdir(), "bearing-history-delete-")); roots.push(root);
    const artifact = join(root, "docs", "plans", "keep.md");
    await mkdir(join(root, "docs", "plans"), { recursive: true });
    await writeFile(artifact, "keep\n");
    const server = createServer(); await new Promise<void>((resolve) => server.listen({ host: "127.0.0.1", port: 0 }, resolve)); servers.push(server);
    const address = server.address(); if (!address || typeof address === "string") throw new Error("missing address");
    const port = String(address.port), session = new LocalSessionService(`127.0.0.1:${port}`), cookie = await authenticate(port, session), origin = `http://127.0.0.1:${port}`;
    server.on("request", createRequestHandler(session));
    await call(port, "POST", "/api/v1/repository", { path: root }, cookie);
    await postOwnerCommand(port, cookie, "history-one", "createWorkRequest", { title: "One", goal: "One" });
    await postOwnerCommand(port, cookie, "history-two", "createWorkRequest", { title: "Two", goal: "Two" });

    expect((await call(port, "DELETE", "/api/v1/history/history-one", undefined, undefined, { origin })).status).toBe(401);
    expect((await call(port, "DELETE", "/api/v1/history/history-one", undefined, cookie, { origin: "https://evil.example" })).status).toBe(403);
    expect((await call(port, "DELETE", "/api/v1/history/history-one", undefined, cookie, { origin })).status).toBe(200);
    expect(JSON.parse((await call(port, "GET", "/api/v1/history", undefined, cookie)).body).history.map((entry: { runId: string }) => entry.runId)).toEqual(["history-two"]);
    await access(artifact);

    expect((await call(port, "DELETE", "/api/v1/history", undefined, cookie, { origin })).status).toBe(200);
    expect(JSON.parse((await call(port, "GET", "/api/v1/history", undefined, cookie)).body).history).toEqual([]);
    await access(artifact);
  });

  it("serves authenticated repository options and rejects cross-origin reads", async () => {
    const root = await mkdtemp(join(tmpdir(), "bearing-options-")); roots.push(root);
    const choice = { options: async () => ({ platform: "linux" as const, linuxDistro: "Test Linux", current: { path: root, source: "cwd" as const }, browse: { available: false } }), resolve: async () => ({ result: "selected" as const, candidate: root, source: "cwd" as const }) };
    const { port, session } = await launchChoice(choice); const cookie = await authenticate(port, session);
    expect((await call(port, "GET", "/api/v1/repository-options")).status).toBe(401);
    expect((await call(port, "GET", "/api/v1/repository-options", undefined, cookie, { origin: "https://evil.example" })).status).toBe(403);
    const response = await call(port, "GET", "/api/v1/repository-options", undefined, cookie);
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ platform: "linux", linuxDistro: "Test Linux", current: { path: root, source: "cwd" }, browse: { available: false } });
  });

  it("accepts repository reselection without restarting onboarding", async () => {
    const root = await mkdtemp(join(tmpdir(), "bearing-current-")); roots.push(root); let resolutions = 0;
    const choice = { options: async () => ({ platform: "linux" as const, current: { path: root, source: "cwd" as const }, browse: { available: false } }), resolve: async () => { resolutions += 1; return { result: "selected" as const, candidate: root, source: "cwd" as const }; } };
    const { port, session } = await launchChoice(choice); const cookie = await authenticate(port, session);
    expect((await call(port, "POST", "/api/v1/repository", { choice: "current" }, cookie)).status).toBe(200);
    const repeated = await call(port, "POST", "/api/v1/repository", { choice: "browse" }, cookie);
    expect(repeated.status).toBe(200);
    expect(JSON.parse(repeated.body).status).toBe("resumed");
    expect(resolutions).toBe(2);
  });

  it("returns stable recoverable picker outcomes without repository mutation", async () => {
    for (const result of ["cancelled", "unavailable", "timeout", "invalid"] as const) {
      const root = await mkdtemp(join(tmpdir(), `bearing-${result}-`)); roots.push(root);
      const choice = { options: async () => ({ platform: "linux" as const, current: { path: root, source: "cwd" as const }, browse: { available: true, picker: "zenity" as const } }), resolve: async () => ({ result, picker: "zenity" as const }) };
      const { port, session } = await launchChoice(choice); const cookie = await authenticate(port, session);
      const response = await call(port, "POST", "/api/v1/repository", { choice: "browse" }, cookie);
      expect(response.status).toBe(409);
      expect(JSON.parse(response.body)).toEqual({ status: "blocked", code: `repository_picker_${result}` });
      await expect(access(join(root, ".bearing"))).rejects.toBeDefined();
    }
  });

  it("validates picker output through RepositoryBootstrap and rejects malformed choice bodies", async () => {
    const root = await mkdtemp(join(tmpdir(), "bearing-hostile-picker-")); roots.push(root); const file = join(root, "not-a-directory"); await writeFile(file, "x");
    const choice = { options: async () => ({ platform: "linux" as const, current: { path: root, source: "cwd" as const }, browse: { available: true, picker: "zenity" as const } }), resolve: async () => ({ result: "selected" as const, candidate: file, source: "picker" as const, picker: "zenity" as const }) };
    const { port, session } = await launchChoice(choice); const cookie = await authenticate(port, session);
    expect((await call(port, "POST", "/api/v1/repository", { choice: "browse" }, cookie)).status).toBe(400);
    await expect(access(join(root, ".bearing"))).rejects.toBeDefined();

    const next = await launchChoice(choice); const nextCookie = await authenticate(next.port, next.session);
    for (const body of [{ choice: "recent" }, { choice: "current", path: root }, { choice: "current", extra: true }]) {
      expect((await call(next.port, "POST", "/api/v1/repository", body, nextCookie)).status).toBe(422);
    }
    expect((await call(next.port, "POST", "/api/v1/repository", { choice: "current" })).status).toBe(401);
    expect((await call(next.port, "POST", "/api/v1/repository", { choice: "current" }, nextCookie, { origin: "https://evil.example" })).status).toBe(403);
  });

  it("requires repository and authentication before passive inspection/readiness", async () => {
    const { port, session, counts } = await launch();
    const cookie = await authenticate(port, session);
    expect((await call(port, "POST", "/api/v1/readiness", { provider: "codex", model: "gpt-5.6-terra", reasoning: "medium" })).status).toBe(401);
    expect((await call(port, "GET", "/api/v1/routes", undefined, cookie)).status).toBe(409);
    expect((await call(port, "POST", "/api/v1/readiness", { provider: "codex", model: "gpt-5.6-terra", reasoning: "medium" }, cookie)).status).toBe(409);
    expect(counts()).toEqual({ inspections: 0, verifications: 0 });

    const root = await mkdtemp(join(tmpdir(), "bearing-onboarding-"));
    roots.push(root);
    expect((await call(port, "POST", "/api/v1/repository", { path: root }, cookie)).status).toBe(200);
    expect((await call(port, "GET", "/api/v1/routes")).status).toBe(401);
    const routes = await call(port, "GET", "/api/v1/routes", undefined, cookie);
    expect(routes.status).toBe(200);
    expect(JSON.parse(routes.body).routes).toHaveLength(6);
    expect(counts()).toEqual({ inspections: 6, verifications: 0 });

    expect((await call(port, "POST", "/api/v1/readiness", { provider: "codex", model: "gpt-5.6-terra", reasoning: "medium" })).status).toBe(401);
    const readiness = await call(port, "POST", "/api/v1/readiness", { provider: "codex", model: "gpt-5.6-terra", reasoning: "medium" }, cookie);
    expect(readiness.status).toBe(200);
    expect(JSON.parse(readiness.body)).toMatchObject({ status: "detected", detected: true, verified: false });
    expect(counts()).toEqual({ inspections: 7, verifications: 1 });
    expect(readiness.body.length).toBeLessThan(16_384);
  });

  it("discovers one selected route on demand and reuses its cached choices", async () => {
    const root = await mkdtemp(join(tmpdir(), "bearing-route-models-")); roots.push(root);
    const server = createServer(); await new Promise<void>((resolve) => server.listen({ host: "127.0.0.1", port: 0 }, resolve)); servers.push(server);
    const address = server.address(); if (!address || typeof address === "string") throw new Error("missing address");
    const port = String(address.port), session = new LocalSessionService(`127.0.0.1:${port}`), cookie = await authenticate(port, session);
    let modelOptions = 0;
    server.on("request", createRequestHandler(session, undefined, { routeInspection: {
      executableAvailable: () => true,
      modelOptions: () => { modelOptions += 1; return [{ model: "gpt-5.6-terra", label: "ignored", reasoningLevels: ["medium"], defaultReasoning: "medium" }]; },
    } }));
    expect((await call(port, "GET", "/api/v1/routes/codex/models", undefined, cookie)).status).toBe(409);
    await call(port, "POST", "/api/v1/repository", { path: root }, cookie);
    const routes = await call(port, "GET", "/api/v1/routes", undefined, cookie);
    expect(routes.status).toBe(200);
    expect(JSON.parse(routes.body).routes[0]).not.toHaveProperty("models");
    expect(modelOptions).toBe(0);
    expect((await call(port, "GET", "/api/v1/routes/codex/models")).status).toBe(401);
    expect((await call(port, "GET", "/api/v1/routes/codex/models?x=1", undefined, cookie)).status).toBe(404);
    expect((await call(port, "GET", "/api/v1/routes/CODEX/models", undefined, cookie)).status).toBe(404);
    expect((await call(port, "GET", "/api/v1/routes/unknown/models", undefined, cookie)).status).toBe(404);
    const models = await call(port, "GET", "/api/v1/routes/codex/models", undefined, cookie);
    expect(models.status).toBe(200);
    expect(JSON.parse(models.body).models).toEqual([{ model: "gpt-5.6-terra", label: "gpt-5.6-terra", reasoningLevels: ["medium"], defaultReasoning: "medium" }]);
    expect(modelOptions).toBe(1);
    expect((await call(port, "POST", "/api/v1/readiness", { provider: "codex", model: "gpt-5.6-terra", reasoning: "medium" }, cookie)).status).toBe(200);
    expect(modelOptions).toBe(1);
  });

  it("rejects malformed selection and returns the stable unavailable repair", async () => {
    const { port, session } = await launch(false);
    const cookie = await authenticate(port, session);
    const root = await mkdtemp(join(tmpdir(), "bearing-onboarding-"));
    roots.push(root);
    await call(port, "POST", "/api/v1/repository", { path: root }, cookie);
    const missing = await call(port, "POST", "/api/v1/readiness", {}, cookie);
    expect(missing.status).toBe(409);
    expect(JSON.parse(missing.body)).toMatchObject({ code: "selection_unavailable", repair: "choose_detected_route" });
    expect((await call(port, "POST", "/api/v1/readiness", { provider: "codex", model: "x", reasoning: "maximum" }, cookie)).status).toBe(400);
    const unavailable = await call(port, "POST", "/api/v1/readiness", { provider: "codex", model: "gpt-5.6-sol", reasoning: "medium" }, cookie);
    expect(unavailable.status).toBe(409);
    expect(JSON.parse(unavailable.body)).toEqual({ status: "blocked", detected: false, verified: false, code: "selection_unavailable", repair: "choose_detected_route" });
  });

  it("uses the injected adapter path and canonical selected repository for verification", async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen({ host: "127.0.0.1", port: 0 }, resolve));
    servers.push(server);
    const address = server.address(); if (!address || typeof address === "string") throw new Error("missing address");
    const port = String(address.port);
    const session = new LocalSessionService(`127.0.0.1:${port}`);
    const runner = new SyntheticRunner();
    server.on("request", createRequestHandler(session, undefined, { processRunner: runner }));
    const cookie = await authenticate(port, session);
    const root = await mkdtemp(join(tmpdir(), "bearing-onboarding-")); roots.push(root);
    const chosen = await call(port, "POST", "/api/v1/repository", { path: root }, cookie);
    const canonical = JSON.parse(chosen.body).repositoryPath as string;
    const readiness = await call(port, "POST", "/api/v1/readiness", { provider: "codex", model: "*", reasoning: "medium" }, cookie);
    expect(JSON.parse(readiness.body)).toMatchObject({ status: "ready", verified: true });
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]).toMatchObject({ executable: "codex", cwd: canonical });
    expect(runner.calls[0].args).not.toContain("-m");
    expect(runner.calls[0].args).toContain('model_reasoning_effort="medium"');
    expect(runner.calls[0].args).not.toContain(runner.calls[0].stdin);
    expect(runner.calls[0].stdin).toMatch(/readiness/i);
  });

  it("persists the verified route and drives the real journey through contained HTML evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "bearing-journey-")); roots.push(root);
    const planDirectory = `docs/plans/${new Date().toISOString().slice(0, 10)}-ship-bounded-evidence-without-losing-owner-control`;
    const implementation = "---\ntype: implementation\nstatus: draft\nplan_spec: ./plan-spec.md\ndesign: ./design.md\nseit: ./seit.md\n---\n\n# Implementation\n\n## Phase 1 — Build\n\n### Slice 1.1 — Deliver\n\n**Goal.** Deliver bounded evidence.\n\n**Requirement IDs.** AC-1\n\n**Design IDs.** DES-1, CONTRACT-1\n\n**SEIT proof rows.** SEIT-1\n\n**Type.** /tdd\n\n**Design lenses.** CDD\n\n**Implementation role.** Backend Engineer\n\n**Agent model route.** Codex agent default\n\n**Agent reasoning level.** low.\n\n**Ponytail mode.** full\n\n**Review path.** native review\n\n### 1.1 execution manifest\n\n**Write set.** `src/evidence.ts` only.\n\n**Command IDs.** CMD-UNIT\n\n**Stop condition.** Stop if focused validation fails.\n\n**Human decision.** None.";
    const planning = { "plan-spec.md": "---\ntype: plan-spec\nstatus: complete\n---\n\n## Acceptance criteria\n\n- **AC-1** — Deliver bounded evidence. Literal source text: href=\"./plan-spec.md\"\n\n## Risks and open questions\n\n- **RISK-1** — Invalid evidence must fail closed.\n", "design.md": "---\ntype: design\nstatus: complete\n---\n\n## Use Cases and Communication Flows\n\nComplete flow.\n\n## Interface Option Check\n\ninterface_options: not needed - fixture\n\n## OOPDSA Implementation Design\n\n- **DES-1** — Use the existing evidence boundary.\n- **CONTRACT-1** — Reject invalid evidence without writes.\n", "seit.md": "---\ntype: seit\nstatus: complete\n---\n\n## Required Commands\n\n- **CMD-UNIT** — `pnpm test`\n\n## Traceability Matrix\n\n| SEIT row ID | Acceptance/risk ID | Design/contract ID | Boundary/test layer | Positive case | Negative/failure case | Command/procedure ID | Evidence |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n| SEIT-1 | AC-1 | DES-1, CONTRACT-1 | unit | valid evidence passes | invalid evidence fails closed | CMD-UNIT | test report |\n\n## Cross-cutting Checks\n\nComplete checks.\n", "implementation.md": implementation } as const;
    const escaped = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
    const complete = (content?: string) => ({ exitCode: 0, events: [{ type: "complete", ...(content ? { data: { content } } : {}) }], usage: { tokens: 7 } });
    const action = (summary: string, artifacts: string[]) => `BEARING_RESULT ${JSON.stringify({ kind: "action", summary, artifacts })}`;
    const runner = new SyntheticRunner(undefined, [
      complete("agent output without a Bearing envelope"),
      complete('BEARING_RESULT {"kind":"questions","questions":["Which acceptance risk matters most?"]}'),
      complete(action("Supplies gathered", [`${planDirectory}/plan-spec.md`])),
      complete(action("Route and implementation drafted", [`${planDirectory}/design.md`, `${planDirectory}/seit.md`, `${planDirectory}/implementation.md`, `${planDirectory}/review.html`])),
      complete(action("Review changes gathered", [`${planDirectory}/plan-spec.md`])),
      complete(action("Route and implementation redrafted", [`${planDirectory}/design.md`, `${planDirectory}/seit.md`, `${planDirectory}/implementation.md`, `${planDirectory}/review.html`])),
      complete('BEARING_RESULT {"kind":"question","question":"May I replace the generated client?"}'),
      complete(action("Explorer completed bounded work", ["README.md", `${planDirectory}/review.html`])),
      complete("No findings."),
    ]);
    const processRunner: ProcessRunner = {
      executableAvailable: (executable) => runner.executableAvailable(executable),
      run: async (invocation) => {
        const result = await runner.run(invocation);
        if (JSON.stringify(result).includes("Explorer completed bounded work")) {
          const reviewPath = join(root, planDirectory, "review.html");
          const pending = '<section id="bearing-final-qa" data-status="pending"><h2>Actual implementation and QA</h2><p>Pending implementation and validation.</p></section>';
          const completeQa = '<section id="bearing-final-qa" data-status="complete"><h2>Actual implementation and QA</h2><p>Planned versus actual: README.md contains the bounded Explorer result.</p><p>Validation evidence: the focused browser journey completed successfully.</p></section>';
          const review = await readFile(reviewPath, "utf8");
          if (!review.includes(pending)) throw new Error("missing pending final-QA baseline");
          await Promise.all([
            writeFile(join(root, "README.md"), "# Explorer output\n"),
            writeFile(reviewPath, review.replace(pending, completeQa)),
          ]);
        }
        return result;
      },
      cancel: (runId) => runner.cancel(runId),
      attestIsolation: () => runner.attestIsolation(),
    };
    const server = createServer();
    await new Promise<void>((resolve) => server.listen({ host: "127.0.0.1", port: 0 }, resolve)); servers.push(server);
    const address = server.address(); if (!address || typeof address === "string") throw new Error("missing address");
    const port = String(address.port); const session = new LocalSessionService(`127.0.0.1:${port}`);
    server.on("request", createRequestHandler(session, undefined, { processRunner, verification: { verify: async () => true }, startupOverrides: { reasoning: "low" } }));
    const cookie = await authenticate(port, session);
    expect((await call(port, "POST", "/api/v1/repository", { path: root }, cookie)).status).toBe(200);
    expect(JSON.parse((await call(port, "POST", "/api/v1/readiness", { provider: "codex", model: "*", reasoning: "medium" }, cookie)).body)).toMatchObject({ status: "ready", verified: true });
    const runId = "browser-test"; const goal = "Ship bounded evidence\nwithout losing owner control";
    const journey = (stage: string, extra: Record<string, unknown> = {}) => call(port, "POST", "/api/v1/journey", { runId, stage, workGoal: goal, ...extra }, cookie);
    await postOwnerCommand(port, cookie, runId, "createWorkRequest", { title: goal, goal });
    expect(JSON.parse((await journey("set-bearings")).body)).toMatchObject({ status: "action", summary: "Bearings set locally.", tokens: 0 });
    for (const [name, content] of Object.entries(planning)) await writeFile(join(root, planDirectory, name), content);
    await writeFile(join(root, planDirectory, "review.html"), `<!doctype html><title>Evidence</title><nav><a class="source-link" data-kind="planning" href="./prompts/repository-map.md">repository-map.md</a>${Object.keys(planning).map((name) => `<a class="source-link" data-kind="planning" href="./${name}">${name}</a>`).join("")}<a href="../outside.md">Outside</a><a href="./missing.md">Missing</a><a href="./README.md">README</a><a href="/plan-spec.md">Absolute</a><a href="./plan-spec.md#source">Fragment</a><a href="./plan-spec.md?raw=1">Query</a><a href=./plan-spec.md>Unquoted</a><span href="./design.md">Not an anchor</span><!-- <a href="./plan-spec.md">Comment</a> --></nav>${Object.entries(planning).map(([name, content]) => `<h2>${name}</h2><pre>${escaped(content)}</pre>`).join("")}`);
    await writeFile(join(root, planDirectory, "prompts", "context.md"), "# Context");
    expect(JSON.parse((await journey("gather-supplies")).body)).toMatchObject({ status: "question", question: "Which acceptance risk matters most?", recovery: { status: "repaired", stage: "gather-supplies", failureClass: "agent_receipt_or_artifact_validation", code: "result_missing", retryLevel: "repair", version: "0.1.0" } });
    expect((await journey("map-route", { answer: "Data loss" })).status).toBe(409);
    const planningQuestion = JSON.parse((await call(port, "GET", `/api/v1/runs/${runId}`, undefined, cookie)).body).pendingDecision;
    expect(planningQuestion).toMatchObject({ question: "Which acceptance risk matters most?" });
    await postOwnerCommand(port, cookie, runId, "recordOwnerAnswer", { decisionId: planningQuestion.decisionId, answer: "Data loss" });
    expect(JSON.parse((await journey("gather-supplies", { answer: "Data loss" })).body)).toMatchObject({ status: "action" });
    expect(JSON.parse((await journey("map-route")).body)).toMatchObject({ status: "action", planningReview: { phases: 1, slices: 1, assignments: [{ slice: "Slice 1.1 — Deliver", role: "Backend Engineer", model: "Codex agent default", reasoning: "low" }] } });
    expect(JSON.parse((await journey("gather-supplies", { reviewChange: "Add a rollback acceptance check" })).body)).toMatchObject({ status: "action", summary: "Review changes gathered" });
    expect(JSON.parse((await journey("map-route")).body)).toMatchObject({ status: "action", summary: "Route and implementation redrafted" });
    expect((await journey("execute-explorer", { executionMode: "explorer", reviewCadence: "phase" })).status).toBe(409);
    await recordPlanningApproval(port, cookie, runId);
    expect(JSON.parse((await journey("execute-explorer", { executionMode: "explorer", reviewCadence: "phase", cleanupMergedWorktrees: true })).body)).toMatchObject({ status: "question", question: "May I replace the generated client?" });
    const executionQuestion = JSON.parse((await call(port, "GET", `/api/v1/runs/${runId}`, undefined, cookie)).body).pendingDecision;
    expect(executionQuestion).toMatchObject({ question: "May I replace the generated client?" });
    await postOwnerCommand(port, cookie, runId, "recordOwnerAnswer", { decisionId: executionQuestion.decisionId, answer: "Yes, keep the public API stable" });
    expect(JSON.parse((await journey("execute-explorer", { answer: "Yes, keep the public API stable" })).body)).toMatchObject({ status: "action" });
    expect(await readFile(join(root, "README.md"), "utf8")).toBe("# Explorer output\n");
    expect(await readFile(join(root, planDirectory, "review.html"), "utf8")).toContain('<section id="bearing-final-qa" data-status="complete">');
    const reviewed = JSON.parse((await journey("review")).body);
    expect(reviewed).toMatchObject({ status: "action", summary: "No findings." });
    const expectedArtifacts = [`${planDirectory}/prompts/repository-map.md`, `${planDirectory}/plan-spec.md`, `${planDirectory}/design.md`, `${planDirectory}/seit.md`, `${planDirectory}/implementation.md`, `${planDirectory}/review.html`, "README.md"];
    expect(reviewed.artifacts).toEqual(expectedArtifacts);
    expect(reviewed.artifactLinks.map((link: { path: string }) => link.path)).toEqual(expectedArtifacts);
    const htmlLink = reviewed.artifactLinks.find((link: { path: string }) => link.path.endsWith("review.html")).url as string;
    expect((await call(port, "GET", htmlLink)).status).toBe(401);
    const artifact = await call(port, "GET", htmlLink, undefined, cookie);
    expect(artifact.status).toBe(200);
    expect(artifact.body).toContain("<title>Bearing planning review</title>");
    expect(artifact.body).toContain(`<pre>${escaped(planning["plan-spec.md"])}</pre>`);
    const repositoryMapLink = reviewed.artifactLinks.find((link: { path: string }) => link.path.endsWith("/prompts/repository-map.md")).url as string;
    expect((await call(port, "GET", repositoryMapLink)).status).toBe(401);
    const repositoryMap = await call(port, "GET", repositoryMapLink, undefined, cookie);
    expect(repositoryMap.status).toBe(200);
    expect(repositoryMap.body).toBe(await readFile(join(root, planDirectory, "prompts", "repository-map.md"), "utf8"));
    for (const [name, expected] of Object.entries(planning)) {
      const markdownLink = reviewed.artifactLinks.find((link: { path: string }) => link.path.endsWith(`/${name}`)).url as string;
      expect(artifact.body).toContain(`href="${markdownLink}"`);
      expect((await call(port, "GET", markdownLink)).status).toBe(401);
      const markdown = await call(port, "GET", markdownLink, undefined, cookie);
      expect(markdown.status).toBe(200);
      expect(markdown.headers["content-type"]).toBe("text/plain; charset=utf-8");
      expect(markdown.body).toBe(expected);
    }
    expect(runner.calls.map((invocation) => invocation.stdin).join("\n")).toContain("Review cadence");
    expect(runner.calls.map((invocation) => invocation.stdin).join("\n")).toContain('"question":"Cleanup merged worktrees","answer":"on"');
    expect(runner.calls.map((invocation) => invocation.stdin).join("\n")).toContain("Clean eligible worktrees after each completed phase.");
    expect(runner.calls.map((invocation) => invocation.stdin).join("\n")).toContain("Add a rollback acceptance check");
    expect(runner.calls[1].stdin).toContain("repair only the receipt or required artifacts");
    expect(runner.calls.slice(0, -1).every((invocation) => invocation.args.includes('model_reasoning_effort="low"'))).toBe(true);
    expect(runner.calls.at(-1)?.args).toContain('sandbox_mode="read-only"');

    const outside = await mkdtemp(join(tmpdir(), "bearing-artifact-symlink-")); roots.push(outside);
    await writeFile(join(outside, "secret.md"), "must not be served\n");
    await rm(join(root, planDirectory, "implementation.md"));
    await symlink(join(outside, "secret.md"), join(root, planDirectory, "implementation.md"));
    const implementationLink = reviewed.artifactLinks.find((link: { path: string }) => link.path.endsWith("/implementation.md")).url as string;
    const swapped = await call(port, "GET", implementationLink, undefined, cookie);
    expect(swapped.status).toBe(404);
    expect(swapped.body).not.toContain("must not be served");
  });

  it("applies Gather Supplies immediately when discovery finds no material owner questions", async () => {
    const root = await mkdtemp(join(tmpdir(), "bearing-no-questions-")); roots.push(root);
    const planDirectory = `docs/plans/${new Date().toISOString().slice(0, 10)}-no-material-decisions`;
    const result = (content: string) => ({ exitCode: 0, events: [{ type: "complete", data: { content } }], usage: { tokens: 1 } });
    const runner = new SyntheticRunner(undefined, [
      result('BEARING_RESULT {"kind":"questions","questions":[]}'),
      result(`BEARING_RESULT ${JSON.stringify({ kind: "action", summary: "Supplies gathered without owner questions", artifacts: [`${planDirectory}/plan-spec.md`] })}`),
    ]);
    const server = createServer(); await new Promise<void>((resolve) => server.listen({ host: "127.0.0.1", port: 0 }, resolve)); servers.push(server);
    const address = server.address(); if (!address || typeof address === "string") throw new Error("missing address");
    const port = String(address.port), session = new LocalSessionService(`127.0.0.1:${port}`), cookie = await authenticate(port, session), runId = "browser-no-questions", goal = "No material decisions";
    server.on("request", createRequestHandler(session, undefined, { processRunner: runner, verification: { verify: async () => true } }));
    await call(port, "POST", "/api/v1/repository", { path: root }, cookie);
    await call(port, "POST", "/api/v1/readiness", { provider: "codex", model: "*", reasoning: "medium" }, cookie);
    await postOwnerCommand(port, cookie, runId, "createWorkRequest", { title: goal, goal });
    await call(port, "POST", "/api/v1/journey", { runId, stage: "set-bearings", workGoal: goal }, cookie);
    const response = JSON.parse((await call(port, "POST", "/api/v1/journey", { runId, stage: "gather-supplies", workGoal: goal }, cookie)).body);
    expect(response).toMatchObject({ status: "action", summary: "Supplies gathered without owner questions" });
    expect(runner.calls).toHaveLength(2);
    expect(runner.calls[1].stdin).toMatch(/All grilling questions are answered/i);
  });

  it("stops after one focused and one simplified repair of the same deterministic failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "bearing-repair-loop-")); roots.push(root);
    const failed = { exitCode: 0, events: [{ type: "complete", data: { content: "missing receipt" } }], usage: { tokens: 1 } };
    const runner = new SyntheticRunner(undefined, [failed, failed, failed]);
    const server = createServer(); await new Promise<void>((resolve) => server.listen({ host: "127.0.0.1", port: 0 }, resolve)); servers.push(server);
    const address = server.address(); if (!address || typeof address === "string") throw new Error("missing address");
    const port = String(address.port), session = new LocalSessionService(`127.0.0.1:${port}`), cookie = await authenticate(port, session), runId = "browser-repair-loop", goal = "Stop repeated failures";
    server.on("request", createRequestHandler(session, undefined, { processRunner: runner, verification: { verify: async () => true } }));
    await call(port, "POST", "/api/v1/repository", { path: root }, cookie);
    await call(port, "POST", "/api/v1/readiness", { provider: "codex", model: "*", reasoning: "medium" }, cookie);
    await postOwnerCommand(port, cookie, runId, "createWorkRequest", { title: goal, goal });
    await call(port, "POST", "/api/v1/journey", { runId, stage: "set-bearings", workGoal: goal }, cookie);
    const response = JSON.parse((await call(port, "POST", "/api/v1/journey", { runId, stage: "gather-supplies", workGoal: goal }, cookie)).body);
    expect(response).toMatchObject({ status: "failure", code: "result_missing", recovery: { status: "stopped", retryLevel: "simplify" } });
    expect(runner.calls).toHaveLength(3);
    expect(runner.calls[1].stdin).toContain("repair only the receipt or required artifacts");
    expect(runner.calls[2].stdin).toContain("simplest contract-preserving correction");
    const stopped = JSON.parse((await call(port, "POST", "/api/v1/journey", { runId, stage: "gather-supplies", workGoal: goal }, cookie)).body);
    expect(stopped.recovery).toMatchObject({ status: "stopped" });
    expect(runner.calls).toHaveLength(3);
    await call(port, "POST", "/api/v1/repository", { path: root }, cookie);
    await call(port, "GET", "/api/v1/history", undefined, cookie);
    await call(port, "POST", "/api/v1/readiness", { provider: "codex", model: "*", reasoning: "medium" }, cookie);
    const resumedStopped = JSON.parse((await call(port, "POST", "/api/v1/journey", { runId, stage: "gather-supplies", workGoal: goal }, cookie)).body);
    expect(resumedStopped.recovery).toMatchObject({ status: "stopped" });
    expect(runner.calls).toHaveLength(3);
  });

  it("does not automatically retry adapter or token-budget failures", async () => {
    for (const [code, failed] of [
      ["adapter_failed", { exitCode: 1, events: [], usage: { tokens: 1 } }],
      ["token_budget", { exitCode: 0, events: [], usage: { tokens: Number.MAX_SAFE_INTEGER + 1 } }],
    ] as const) {
      const root = await mkdtemp(join(tmpdir(), `bearing-no-retry-${code}-`)); roots.push(root);
      const runner = new SyntheticRunner(undefined, [failed]);
      const server = createServer(); await new Promise<void>((resolve) => server.listen({ host: "127.0.0.1", port: 0 }, resolve)); servers.push(server);
      const address = server.address(); if (!address || typeof address === "string") throw new Error("missing address");
      const port = String(address.port), session = new LocalSessionService(`127.0.0.1:${port}`), cookie = await authenticate(port, session), runId = `browser-no-retry-${code}`, goal = `Do not retry ${code}`;
      server.on("request", createRequestHandler(session, undefined, { processRunner: runner, verification: { verify: async () => true } }));
      await call(port, "POST", "/api/v1/repository", { path: root }, cookie);
      await call(port, "POST", "/api/v1/readiness", { provider: "codex", model: "*", reasoning: "medium" }, cookie);
      await postOwnerCommand(port, cookie, runId, "createWorkRequest", { title: goal, goal });
      await call(port, "POST", "/api/v1/journey", { runId, stage: "set-bearings", workGoal: goal }, cookie);
      const response = JSON.parse((await call(port, "POST", "/api/v1/journey", { runId, stage: "gather-supplies", workGoal: goal }, cookie)).body);
      expect(response).toMatchObject({ status: "failure", code });
      expect(response).not.toHaveProperty("recovery");
      expect(runner.calls).toHaveLength(1);
    }
  });

  it("collects a batch of grilling answers without restarting the agent between questions", async () => {
    const root = await mkdtemp(join(tmpdir(), "bearing-batched-grill-")); roots.push(root);
    const planDirectory = `docs/plans/${new Date().toISOString().slice(0, 10)}-plan-without-per-answer-lag`;
    const result = (content: string) => ({ exitCode: 0, events: [{ type: "complete", data: { content } }], usage: { tokens: 1 } });
    const questions = Array.from({ length: 3 }, (_, index) => `${index}: Planning question ${index + 1}`.padEnd(4095, "q") + "?");
    const runner = new SyntheticRunner(undefined, [
      result(`BEARING_RESULT ${JSON.stringify({ kind: "questions", questions })}`),
      result(`BEARING_RESULT ${JSON.stringify({ kind: "action", summary: "Route map written", artifacts: [`${planDirectory}/plan-spec.md`] })}`),
    ]);
    const server = createServer(); await new Promise<void>((resolve) => server.listen({ host: "127.0.0.1", port: 0 }, resolve)); servers.push(server);
    const address = server.address(); if (!address || typeof address === "string") throw new Error("missing address");
    const port = String(address.port), session = new LocalSessionService(`127.0.0.1:${port}`), cookie = await authenticate(port, session);
    server.on("request", createRequestHandler(session, undefined, { processRunner: runner, verification: { verify: async () => true } }));
    const runId = "browser-batch", goal = "Plan without per-answer lag";
    await call(port, "POST", "/api/v1/repository", { path: root }, cookie);
    await call(port, "POST", "/api/v1/readiness", { provider: "codex", model: "*", reasoning: "medium" }, cookie);
    await postOwnerCommand(port, cookie, runId, "createWorkRequest", { title: goal, goal });
    const journey = (extra: Record<string, unknown> = {}) => call(port, "POST", "/api/v1/journey", { runId, stage: "gather-supplies", workGoal: goal, ...extra }, cookie);
    expect(JSON.parse((await call(port, "POST", "/api/v1/journey", { runId, stage: "set-bearings", workGoal: goal }, cookie)).body)).toMatchObject({ status: "action", tokens: 0 });

    let response = JSON.parse((await journey()).body);
    expect(response).toMatchObject({ status: "question", question: questions[0] });
    expect(response.questions).toEqual(questions);
    expect(runner.calls).toHaveLength(1);
    const answers = questions.map((_, index) => `${index}:`.padEnd(4096, "x"));
    for (const answer of answers) {
      const pending = JSON.parse((await call(port, "GET", `/api/v1/runs/${runId}`, undefined, cookie)).body).pendingDecision;
      await postOwnerCommand(port, cookie, runId, "recordOwnerAnswer", { decisionId: pending.decisionId, answer });
      response = JSON.parse((await journey({ answer })).body);
      if (answer !== answers.at(-1)) expect(runner.calls).toHaveLength(1);
    }
    expect(response).toMatchObject({ status: "action", summary: "Route map written" });
    expect(runner.calls).toHaveLength(2);
    expect(runner.calls[1].stdin).toContain(`"question":"${questions[0]}","answer":"${answers[0]}"`);
    expect(runner.calls[1].stdin).toMatch(/All grilling questions are answered/i);
  });

  it("ends grilling early and writes from the answers collected so far", async () => {
    const root = await mkdtemp(join(tmpdir(), "bearing-end-grill-")); roots.push(root);
    const planDirectory = `docs/plans/${new Date().toISOString().slice(0, 10)}-stop-repetitive-planning-questions`;
    const result = (content: string) => ({ exitCode: 0, events: [{ type: "complete", data: { content } }], usage: { tokens: 1 } });
    const runner = new SyntheticRunner(undefined, [
      result(`BEARING_RESULT ${JSON.stringify({ kind: "questions", questions: ["Which users are in scope?", "Which compatibility boundary matters?", "What must be true at launch?"] })}`),
      result(`BEARING_RESULT ${JSON.stringify({ kind: "action", summary: "Route map written", artifacts: [`${planDirectory}/plan-spec.md`] })}`),
    ]);
    const server = createServer(); await new Promise<void>((resolve) => server.listen({ host: "127.0.0.1", port: 0 }, resolve)); servers.push(server);
    const address = server.address(); if (!address || typeof address === "string") throw new Error("missing address");
    const port = String(address.port), session = new LocalSessionService(`127.0.0.1:${port}`), cookie = await authenticate(port, session);
    server.on("request", createRequestHandler(session, undefined, { processRunner: runner, verification: { verify: async () => true } }));
    const runId = "browser-end-grill", goal = "Stop repetitive planning questions";
    await call(port, "POST", "/api/v1/repository", { path: root }, cookie);
    await call(port, "POST", "/api/v1/readiness", { provider: "codex", model: "*", reasoning: "medium" }, cookie);
    await postOwnerCommand(port, cookie, runId, "createWorkRequest", { title: goal, goal });
    const journey = (extra: Record<string, unknown> = {}) => call(port, "POST", "/api/v1/journey", { runId, stage: "gather-supplies", workGoal: goal, ...extra }, cookie);
    expect(JSON.parse((await call(port, "POST", "/api/v1/journey", { runId, stage: "set-bearings", workGoal: goal }, cookie)).body)).toMatchObject({ status: "action" });

    expect(JSON.parse((await journey()).body)).toMatchObject({ status: "question", question: "Which users are in scope?" });
    let pending = JSON.parse((await call(port, "GET", `/api/v1/runs/${runId}`, undefined, cookie)).body).pendingDecision;
    await postOwnerCommand(port, cookie, runId, "recordOwnerAnswer", { decisionId: pending.decisionId, answer: "Account owners" });
    expect(JSON.parse((await journey({ answer: "Account owners" })).body)).toMatchObject({ status: "question", question: "Which compatibility boundary matters?" });

    const earlyStop = "Skipped; owner ended questioning early. Use the answers collected so far and record reasonable assumptions.";
    pending = JSON.parse((await call(port, "GET", `/api/v1/runs/${runId}`, undefined, cookie)).body).pendingDecision;
    await postOwnerCommand(port, cookie, runId, "recordOwnerAnswer", { decisionId: pending.decisionId, answer: earlyStop });
    const completed = await journey({ answer: earlyStop, endQuestions: true });
    expect(completed.status).toBe(200);
    expect(JSON.parse(completed.body)).toMatchObject({ status: "action", summary: "Route map written" });
    expect(runner.calls).toHaveLength(2);
    expect(runner.calls[1].stdin).toContain('"question":"Which users are in scope?","answer":"Account owners"');
    expect(runner.calls[1].stdin).toContain(`"question":"Which compatibility boundary matters?","answer":"${earlyStop}"`);
    expect(runner.calls[1].stdin).not.toContain('"question":"What must be true at launch?","answer"');
    expect(JSON.parse((await call(port, "GET", `/api/v1/runs/${runId}`, undefined, cookie)).body).pendingDecision).toBeNull();
  });

  it("refuses repository changes while a real journey call is in flight", async () => {
    const root = await mkdtemp(join(tmpdir(), "bearing-busy-")); roots.push(root);
    await mkdir(join(root, "plans", "busy"), { recursive: true });
    await writeFile(join(root, "plans", "busy", "plan-spec.md"), "# Plan");
    let release!: (result: { cancelled: true }) => void, entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const held = new Promise<{ cancelled: true }>((resolve) => { release = resolve; });
    let calls = 0;
    const runner = { executableAvailable: () => true, run: async () => { calls += 1; entered(); return await held; }, cancel: () => release({ cancelled: true }) };
    const server = createServer(); await new Promise<void>((resolve) => server.listen({ host: "127.0.0.1", port: 0 }, resolve)); servers.push(server);
    const address = server.address(); if (!address || typeof address === "string") throw new Error("missing address");
    const port = String(address.port), session = new LocalSessionService(`127.0.0.1:${port}`);
    server.on("request", createRequestHandler(session, undefined, { processRunner: runner, verification: { verify: async () => true } }));
    const cookie = await authenticate(port, session);
    await call(port, "POST", "/api/v1/repository", { path: root }, cookie);
    await call(port, "POST", "/api/v1/readiness", { provider: "codex", model: "*", reasoning: "medium" }, cookie);
    await postOwnerCommand(port, cookie, "browser-busy", "createWorkRequest", { title: "Hold the route", goal: "Hold the route" });
    await call(port, "POST", "/api/v1/journey", { runId: "browser-busy", stage: "set-bearings", workGoal: "Hold the route" }, cookie);
    const running = call(port, "POST", "/api/v1/journey", { runId: "browser-busy", stage: "gather-supplies", workGoal: "Hold the route" }, cookie);
    await started;
    const history = JSON.parse((await call(port, "GET", "/api/v1/history", undefined, cookie)).body);
    expect(history.history).toEqual([expect.objectContaining({ runId: "browser-busy", goal: "Hold the route", status: "running", busy: true })]);
    expect((await call(port, "DELETE", "/api/v1/history/browser-busy", undefined, cookie, { origin: `http://127.0.0.1:${port}` })).status).toBe(409);
    expect((await call(port, "DELETE", "/api/v1/history", undefined, cookie, { origin: `http://127.0.0.1:${port}` })).status).toBe(409);
    const blocked = await call(port, "POST", "/api/v1/repository", { path: root }, cookie);
    expect(blocked.status).toBe(409);
    expect(JSON.parse(blocked.body)).toEqual({ status: "blocked", code: "journey_in_progress" });
    expect((await call(port, "POST", "/api/v1/journey/control", { runId: "browser-busy", action: "stop" }, cookie)).status).toBe(200);
    expect(JSON.parse((await running).body)).toMatchObject({ status: "failure", code: "cancelled" });
    expect(calls).toBe(1);
  });

  it("preserves an ambiguous stop result instead of advertising a safe retry", async () => {
    const root = await mkdtemp(join(tmpdir(), "bearing-stop-ambiguous-")); roots.push(root);
    let release!: (result: { unknownSideEffect: true }) => void, entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    let calls = 0;
    const runner = { executableAvailable: () => true, run: async () => { calls += 1; entered(); return await new Promise<{ unknownSideEffect: true }>((resolve) => { release = resolve; }); }, cancel: () => release({ unknownSideEffect: true }) };
    const server = createServer(); await new Promise<void>((resolve) => server.listen({ host: "127.0.0.1", port: 0 }, resolve)); servers.push(server);
    const address = server.address(); if (!address || typeof address === "string") throw new Error("missing address");
    const port = String(address.port), session = new LocalSessionService(`127.0.0.1:${port}`);
    server.on("request", createRequestHandler(session, undefined, { processRunner: runner, verification: { verify: async () => true } }));
    const cookie = await authenticate(port, session);
    await call(port, "POST", "/api/v1/repository", { path: root }, cookie);
    await call(port, "POST", "/api/v1/readiness", { provider: "codex", model: "*", reasoning: "medium" }, cookie);
    await postOwnerCommand(port, cookie, "browser-stop-ambiguous", "createWorkRequest", { title: "Do not hide partial writes", goal: "Do not hide partial writes" });
    await call(port, "POST", "/api/v1/journey", { runId: "browser-stop-ambiguous", stage: "set-bearings", workGoal: "Do not hide partial writes" }, cookie);
    const running = call(port, "POST", "/api/v1/journey", { runId: "browser-stop-ambiguous", stage: "gather-supplies", workGoal: "Do not hide partial writes" }, cookie);
    await started;
    expect((await call(port, "POST", "/api/v1/journey/control", { runId: "browser-stop-ambiguous", action: "stop" }, cookie)).status).toBe(200);
    expect(JSON.parse((await running).body)).toMatchObject({ status: "failure", code: "interrupted" });
    expect(calls).toBe(1);
  });

  it("restores a durable journey checkpoint after repository reselection", async () => {
    const root = await mkdtemp(join(tmpdir(), "bearing-resume-")); roots.push(root);
    const planDirectory = `docs/plans/${new Date().toISOString().slice(0, 10)}-resume-this-route`;
    const runner = new SyntheticRunner(undefined, [
      { exitCode: 0, events: [{ type: "complete", data: { content: 'BEARING_RESULT {"kind":"questions","questions":[]}' } }], usage: { tokens: 1 } },
      { exitCode: 0, events: [{ type: "complete", data: { content: `BEARING_RESULT ${JSON.stringify({ kind: "action", summary: "Supplies gathered", artifacts: [`${planDirectory}/plan-spec.md`] })}` } }], usage: { tokens: 1 } },
    ]);
    const server = createServer(); await new Promise<void>((resolve) => server.listen({ host: "127.0.0.1", port: 0 }, resolve)); servers.push(server);
    const address = server.address(); if (!address || typeof address === "string") throw new Error("missing address");
    const port = String(address.port), session = new LocalSessionService(`127.0.0.1:${port}`);
    server.on("request", createRequestHandler(session, undefined, { processRunner: runner, verification: { verify: async () => true } }));
    const cookie = await authenticate(port, session), runId = "browser-resume", goal = "Resume this route";
    await call(port, "POST", "/api/v1/repository", { path: root }, cookie);
    await call(port, "POST", "/api/v1/readiness", { provider: "codex", model: "*", reasoning: "medium" }, cookie);
    await postOwnerCommand(port, cookie, runId, "createWorkRequest", { title: goal, goal });
    expect(JSON.parse((await call(port, "POST", "/api/v1/journey", { runId, stage: "set-bearings", workGoal: goal }, cookie)).body)).toMatchObject({ status: "action", summary: "Bearings set locally.", tokens: 0 });
    await call(port, "POST", "/api/v1/repository", { path: root }, cookie);
    const history = JSON.parse((await call(port, "GET", "/api/v1/history", undefined, cookie)).body);
    expect(history.history).toEqual([expect.objectContaining({ runId, stage: "set-bearings", status: "waiting", busy: false, artifacts: expect.arrayContaining([expect.stringMatching(/\/plan-spec\.md$/), expect.stringMatching(/\/prompts\/repository-map\.md$/)]), lastResult: expect.objectContaining({ status: "action", summary: "Bearings set locally." }) })]);
    await call(port, "POST", "/api/v1/readiness", { provider: "codex", model: "*", reasoning: "medium" }, cookie);
    expect(JSON.parse((await call(port, "POST", "/api/v1/journey", { runId, stage: "gather-supplies", workGoal: goal }, cookie)).body)).toMatchObject({ status: "action", summary: "Supplies gathered" });
  });

  it("reconciles an answered checkpoint question before resuming", async () => {
    const root = await mkdtemp(join(tmpdir(), "bearing-answer-resume-")); roots.push(root);
    await mkdir(join(root, "plans", "answer"), { recursive: true });
    await writeFile(join(root, "plans", "answer", "plan-spec.md"), "# Answered plan\n");
    const result = (content: string) => ({ exitCode: 0, events: [{ type: "complete", data: { content } }], usage: { tokens: 1 } });
    const runner = new SyntheticRunner(undefined, [
      result('BEARING_RESULT {"kind":"questions","questions":["Which boundary matters?","Which fallback is acceptable?"]}'),
      result('BEARING_RESULT {"kind":"questions","questions":[]}'),
      result(`BEARING_RESULT ${JSON.stringify({ kind: "action", summary: "Supplies gathered", artifacts: [`docs/plans/${new Date().toISOString().slice(0, 10)}-resume-an-answered-question/plan-spec.md`] })}`),
    ]);
    const server = createServer(); await new Promise<void>((resolve) => server.listen({ host: "127.0.0.1", port: 0 }, resolve)); servers.push(server);
    const address = server.address(); if (!address || typeof address === "string") throw new Error("missing address");
    const port = String(address.port), session = new LocalSessionService(`127.0.0.1:${port}`);
    server.on("request", createRequestHandler(session, undefined, { processRunner: runner, verification: { verify: async () => true } }));
    const cookie = await authenticate(port, session), runId = "browser-answer-resume", goal = "Resume an answered question";
    await call(port, "POST", "/api/v1/repository", { path: root }, cookie);
    await call(port, "POST", "/api/v1/readiness", { provider: "codex", model: "*", reasoning: "medium" }, cookie);
    await postOwnerCommand(port, cookie, runId, "createWorkRequest", { title: goal, goal });
    await call(port, "POST", "/api/v1/journey", { runId, stage: "set-bearings", workGoal: goal }, cookie);
    expect(JSON.parse((await call(port, "POST", "/api/v1/journey", { runId, stage: "gather-supplies", workGoal: goal }, cookie)).body)).toMatchObject({ status: "question", question: "Which boundary matters?" });
    const pending = JSON.parse((await call(port, "GET", `/api/v1/runs/${runId}`, undefined, cookie)).body).pendingDecision;
    await postOwnerCommand(port, cookie, runId, "recordOwnerAnswer", { decisionId: pending.decisionId, answer: "The public API" });
    await call(port, "POST", "/api/v1/repository", { path: root }, cookie);
    const history = JSON.parse((await call(port, "GET", "/api/v1/history", undefined, cookie)).body);
    expect(history.history).toEqual([expect.objectContaining({ runId, status: "failed", lastResult: { status: "failure", code: "interrupted", tokens: 0 } })]);
    await call(port, "POST", "/api/v1/readiness", { provider: "codex", model: "*", reasoning: "medium" }, cookie);
    expect(JSON.parse((await call(port, "POST", "/api/v1/journey", { runId, stage: "gather-supplies", workGoal: goal }, cookie)).body)).toMatchObject({ status: "action", summary: "Supplies gathered" });
    expect(runner.calls.at(-1)?.stdin).toContain("The public API");
    expect(runner.calls.at(-1)?.stdin).toMatch(/All grilling questions are answered/i);
  });

  it("restores an unanswered question batch without losing its in-memory queue", async () => {
    const root = await mkdtemp(join(tmpdir(), "bearing-unanswered-resume-")); roots.push(root);
    await mkdir(join(root, "plans", "unanswered"), { recursive: true });
    await writeFile(join(root, "plans", "unanswered", "plan-spec.md"), "# Unanswered plan\n");
    const result = (content: string) => ({ exitCode: 0, events: [{ type: "complete", data: { content } }], usage: { tokens: 1 } });
    const runner = new SyntheticRunner(undefined, [
      result('BEARING_RESULT {"kind":"questions","questions":["First decision?","Second decision?"]}'),
    ]);
    const server = createServer(); await new Promise<void>((resolve) => server.listen({ host: "127.0.0.1", port: 0 }, resolve)); servers.push(server);
    const address = server.address(); if (!address || typeof address === "string") throw new Error("missing address");
    const port = String(address.port), session = new LocalSessionService(`127.0.0.1:${port}`);
    server.on("request", createRequestHandler(session, undefined, { processRunner: runner, verification: { verify: async () => true } }));
    const cookie = await authenticate(port, session), runId = "browser-unanswered-resume", goal = "Resume an unanswered batch";
    await call(port, "POST", "/api/v1/repository", { path: root }, cookie);
    await call(port, "POST", "/api/v1/readiness", { provider: "codex", model: "*", reasoning: "medium" }, cookie);
    await postOwnerCommand(port, cookie, runId, "createWorkRequest", { title: goal, goal });
    await call(port, "POST", "/api/v1/journey", { runId, stage: "set-bearings", workGoal: goal }, cookie);
    expect(JSON.parse((await call(port, "POST", "/api/v1/journey", { runId, stage: "gather-supplies", workGoal: goal }, cookie)).body)).toMatchObject({ status: "question", question: "First decision?" });
    await call(port, "POST", "/api/v1/repository", { path: root }, cookie);
    const history = JSON.parse((await call(port, "GET", "/api/v1/history", undefined, cookie)).body);
    expect(history.history).toEqual([expect.objectContaining({ runId, status: "waiting", lastResult: expect.objectContaining({ status: "question", question: "First decision?" }) })]);
    await call(port, "POST", "/api/v1/readiness", { provider: "codex", model: "*", reasoning: "medium" }, cookie);
    const pending = JSON.parse((await call(port, "GET", `/api/v1/runs/${runId}`, undefined, cookie)).body).pendingDecision;
    await postOwnerCommand(port, cookie, runId, "recordOwnerAnswer", { decisionId: pending.decisionId, answer: "First answer" });
    const resumed = await call(port, "POST", "/api/v1/journey", { runId, stage: "gather-supplies", workGoal: goal, answer: "First answer" }, cookie);
    expect(resumed.status, resumed.body).toBe(200);
    expect(JSON.parse(resumed.body)).toMatchObject({ status: "question", question: "Second decision?" });
    expect(runner.calls).toHaveLength(1);
  });

  it("rejects a restored journey when the newly selected model route differs", async () => {
    const root = await mkdtemp(join(tmpdir(), "bearing-route-lock-")); roots.push(root);
    const runner = new SyntheticRunner(undefined, [{ exitCode: 0, events: [{ type: "complete", data: { content: 'BEARING_RESULT {"kind":"action","summary":"Bearings saved","artifacts":[]}' } }], usage: { tokens: 1 } }]);
    const server = createServer(); await new Promise<void>((resolve) => server.listen({ host: "127.0.0.1", port: 0 }, resolve)); servers.push(server);
    const address = server.address(); if (!address || typeof address === "string") throw new Error("missing address");
    const port = String(address.port), session = new LocalSessionService(`127.0.0.1:${port}`);
    server.on("request", createRequestHandler(session, undefined, { processRunner: runner, verification: { verify: async () => true } }));
    const cookie = await authenticate(port, session), runId = "browser-route-lock", goal = "Keep the approved route";
    await call(port, "POST", "/api/v1/repository", { path: root }, cookie);
    await call(port, "POST", "/api/v1/readiness", { provider: "codex", model: "*", reasoning: "medium" }, cookie);
    await postOwnerCommand(port, cookie, runId, "createWorkRequest", { title: goal, goal });
    expect((await call(port, "POST", "/api/v1/journey", { runId, stage: "set-bearings", workGoal: goal }, cookie)).status).toBe(200);
    await call(port, "POST", "/api/v1/repository", { path: root }, cookie);
    await call(port, "GET", "/api/v1/history", undefined, cookie);
    await call(port, "POST", "/api/v1/readiness", { provider: "codex", model: "*", reasoning: "high" }, cookie);
    expect((await call(port, "POST", "/api/v1/journey", { runId, stage: "gather-supplies", workGoal: goal }, cookie)).status).toBe(409);
  });

  it("restores an explicitly requested checkpoint older than the bounded history list", async () => {
    const root = await mkdtemp(join(tmpdir(), "bearing-old-run-")); roots.push(root);
    await mkdir(join(root, "plans", "old"), { recursive: true });
    await writeFile(join(root, "plans", "old", "plan-spec.md"), "# Old run\n");
    const results = Array.from({ length: 9 }, (_, index) => ({ exitCode: 0, events: [{ type: "complete", data: { content: `BEARING_RESULT {"kind":"action","summary":"Run ${index}","artifacts":["plans/old/plan-spec.md"]}` } }], usage: { tokens: 1 } }));
    const runner = new SyntheticRunner(undefined, results);
    const server = createServer(); await new Promise<void>((resolve) => server.listen({ host: "127.0.0.1", port: 0 }, resolve)); servers.push(server);
    const address = server.address(); if (!address || typeof address === "string") throw new Error("missing address");
    const port = String(address.port), session = new LocalSessionService(`127.0.0.1:${port}`);
    server.on("request", createRequestHandler(session, undefined, { processRunner: runner, verification: { verify: async () => true } }));
    const cookie = await authenticate(port, session);
    await call(port, "POST", "/api/v1/repository", { path: root }, cookie);
    await call(port, "POST", "/api/v1/readiness", { provider: "codex", model: "*", reasoning: "medium" }, cookie);
    for (let index = 0; index < 9; index += 1) {
      const runId = `browser-old-${index}`, goal = `Remember run ${index}`;
      await postOwnerCommand(port, cookie, runId, "createWorkRequest", { title: goal, goal });
      expect((await call(port, "POST", "/api/v1/journey", { runId, stage: "set-bearings", workGoal: goal }, cookie)).status).toBe(200);
    }
    await call(port, "POST", "/api/v1/repository", { path: root }, cookie);
    await call(port, "POST", "/api/v1/readiness", { provider: "codex", model: "*", reasoning: "medium" }, cookie);
    const status = JSON.parse((await call(port, "GET", "/api/v1/journey/browser-old-0/status", undefined, cookie)).body);
    expect(status.run).toMatchObject({ runId: "browser-old-0", goal: "Remember run 0", stage: "set-bearings", status: "waiting" });
    expect(status.activityTrail).toHaveLength(3);
    expect(status.activityTrail.map((entry: { kind: string }) => entry.kind)).toEqual(["stage.started", "repository-map.started", "workspace.ready"]);
    expect(status.activityTrail.map((entry: { sequence: number }) => entry.sequence)).toEqual([1, 2, 3]);
    expect(status.activityTrail.every((entry: Record<string, unknown>) => Object.keys(entry).every((key) => ["sequence", "recordedAt", "kind", "status", "tool"].includes(key)))).toBe(true);
    expect(JSON.stringify(status.activityTrail)).not.toMatch(/Remember run|browser-old|plans|repositoryPath|prompt|args|stderr/i);
    const other = JSON.parse((await call(port, "GET", "/api/v1/journey/browser-old-8/status", undefined, cookie)).body);
    expect(other.activityTrail).toHaveLength(3);
    const listing = JSON.parse((await call(port, "GET", "/api/v1/history", undefined, cookie)).body);
    expect(listing).not.toHaveProperty("activityTrail");
    expect(listing.history.every((entry: Record<string, unknown>) => !("activityTrail" in entry))).toBe(true);
  });

  it("restarts a safely cancelled phase with owner steering", async () => {
    const root = await mkdtemp(join(tmpdir(), "bearing-steer-")); roots.push(root);
    await mkdir(join(root, "plans", "steer"), { recursive: true });
    await writeFile(join(root, "plans", "steer", "plan-spec.md"), "# Plan");
    let release!: (result: { cancelled: true }) => void, entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const calls: { stdin: string }[] = [];
    const runner = {
      executableAvailable: () => true,
      run: async (invocation: { stdin: string }) => {
        calls.push(invocation);
        if (calls.length === 1) { entered(); return await new Promise<{ cancelled: true }>((resolve) => { release = resolve; }); }
        return { exitCode: 0, events: [{ type: "complete", data: { content: 'BEARING_RESULT {"kind":"questions","questions":["Use the narrower API boundary?"]}' } }], usage: { tokens: 1 } };
      },
      cancel: () => release({ cancelled: true }),
    };
    const server = createServer(); await new Promise<void>((resolve) => server.listen({ host: "127.0.0.1", port: 0 }, resolve)); servers.push(server);
    const address = server.address(); if (!address || typeof address === "string") throw new Error("missing address");
    const port = String(address.port), session = new LocalSessionService(`127.0.0.1:${port}`);
    server.on("request", createRequestHandler(session, undefined, { processRunner: runner, verification: { verify: async () => true } }));
    const cookie = await authenticate(port, session);
    await call(port, "POST", "/api/v1/repository", { path: root }, cookie);
    await call(port, "POST", "/api/v1/readiness", { provider: "codex", model: "*", reasoning: "medium" }, cookie);
    await postOwnerCommand(port, cookie, "browser-steer", "createWorkRequest", { title: "Steer safely", goal: "Steer safely" });
    await call(port, "POST", "/api/v1/journey", { runId: "browser-steer", stage: "set-bearings", workGoal: "Steer safely" }, cookie);
    const running = call(port, "POST", "/api/v1/journey", { runId: "browser-steer", stage: "gather-supplies", workGoal: "Steer safely" }, cookie);
    await started;
    expect((await call(port, "POST", "/api/v1/journey/control", { runId: "browser-steer", action: "steer", instruction: "Use the narrower API boundary" }, cookie)).status).toBe(200);
    expect(JSON.parse((await running).body)).toMatchObject({ status: "question", question: "Use the narrower API boundary?" });
    expect(calls).toHaveLength(2);
    expect(calls[1].stdin).toContain("Owner steering during gather-supplies");
    expect(calls[1].stdin).toContain("Use the narrower API boundary");
  });

  it("does not replay a steered phase after ambiguous side effects", async () => {
    const root = await mkdtemp(join(tmpdir(), "bearing-steer-ambiguous-")); roots.push(root);
    let release!: (result: { unknownSideEffect: true }) => void, entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const calls: unknown[] = [];
    const runner = {
      executableAvailable: () => true,
      run: async (invocation: unknown) => {
        calls.push(invocation);
        if (calls.length === 1) { entered(); return await new Promise<{ unknownSideEffect: true }>((resolve) => { release = resolve; }); }
        return { exitCode: 0, events: [{ type: "complete", data: { content: 'BEARING_RESULT {"kind":"questions","questions":["Proceed with the steered boundary?"]}' } }], usage: { tokens: 1 } };
      },
      cancel: () => release({ unknownSideEffect: true }),
    };
    const server = createServer(); await new Promise<void>((resolve) => server.listen({ host: "127.0.0.1", port: 0 }, resolve)); servers.push(server);
    const address = server.address(); if (!address || typeof address === "string") throw new Error("missing address");
    const port = String(address.port), session = new LocalSessionService(`127.0.0.1:${port}`);
    server.on("request", createRequestHandler(session, undefined, { processRunner: runner, verification: { verify: async () => true } }));
    const cookie = await authenticate(port, session);
    await call(port, "POST", "/api/v1/repository", { path: root }, cookie);
    await call(port, "POST", "/api/v1/readiness", { provider: "codex", model: "*", reasoning: "medium" }, cookie);
    await postOwnerCommand(port, cookie, "browser-steer-ambiguous", "createWorkRequest", { title: "Do not duplicate writes", goal: "Do not duplicate writes" });
    await call(port, "POST", "/api/v1/journey", { runId: "browser-steer-ambiguous", stage: "set-bearings", workGoal: "Do not duplicate writes" }, cookie);
    const running = call(port, "POST", "/api/v1/journey", { runId: "browser-steer-ambiguous", stage: "gather-supplies", workGoal: "Do not duplicate writes" }, cookie);
    await started;
    await call(port, "POST", "/api/v1/journey/control", { runId: "browser-steer-ambiguous", action: "steer", instruction: "Change direction" }, cookie);
    expect(JSON.parse((await running).body)).toMatchObject({ status: "failure", code: "interrupted" });
    expect(calls).toHaveLength(1);
    const retry = JSON.parse((await call(port, "POST", "/api/v1/journey", { runId: "browser-steer-ambiguous", stage: "gather-supplies", workGoal: "Do not duplicate writes" }, cookie)).body);
    expect(retry).toMatchObject({ status: "question", question: "Proceed with the steered boundary?" });
    expect(calls).toHaveLength(2);
    expect((calls[1] as { stdin: string }).stdin).toContain("Owner steering during gather-supplies");
    expect((calls[1] as { stdin: string }).stdin).toContain("Change direction");
  });
});
