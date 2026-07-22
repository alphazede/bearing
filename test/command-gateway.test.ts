import { mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { run, type LauncherDeps } from "../src/cli.js";
import { BearingStore } from "../src/store/bearing-store.js";

const servers: Server[] = [];
const roots: string[] = [];

afterEach(async () => {
  while (servers.length) {
    await new Promise<void>((resolve) => servers.pop()!.close(() => resolve()));
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

interface Response {
  status: number;
  body: string;
}

function call(
  port: string,
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port: Number(port), method, path, headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => resolve({
          status: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString("utf8"),
        }));
      },
    );
    req.on("error", reject);
    if (body !== undefined) req.end(body);
    else req.end();
  });
}

async function launch() {
  const output: string[] = [];
  const deps: Required<LauncherDeps> = {
    openBrowser: () => {},
    stdout: { write: (value) => (output.push(value), true) },
    stderr: { write: () => true },
    exit: () => { throw new Error("unexpected exit"); },
  };
  const server = await run(["start", "--no-open"], deps);
  if (!server) throw new Error("server did not start");
  servers.push(server);
  const url = new URL(output.join(""));
  const headers = { origin: url.origin, "content-type": "application/json" };
  const exchange = await new Promise<string>((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port: Number(url.port),
        method: "POST",
        path: "/api/v1/session",
        headers,
      },
      (res) => {
        const cookie = res.headers["set-cookie"]?.[0];
        if (cookie) resolve(cookie.split(";")[0]);
        else reject(new Error("session cookie missing"));
      },
    );
    req.on("error", reject);
    req.end(JSON.stringify({ capability: url.hash.slice(5) }));
  });
  return { port: url.port, headers, cookie: exchange };
}

function command(runId: string, revision = 0, actor = "owner") {
  return {
    schemaVersion: 1,
    commandId: `command-${revision}`,
    runId,
    expectedRevision: revision,
    session: { sessionId: "forged", actor },
    correlationId: `correlation-${revision}`,
    type: "createWorkRequest",
    payload: { title: "Title", goal: "Goal" },
  };
}

describe("command gateway", () => {
  it("keeps commands closed until repository selection", async () => {
    const { port, headers, cookie } = await launch();
    const response = await call(
      port,
      "POST",
      "/api/v1/runs/run/commands",
      { ...headers, cookie },
      JSON.stringify(command("run")),
    );
    expect(response).toEqual({ status: 409, body: "Rejected" });
  });

  it("rejects every malformed or unauthenticated raw request without mutation", async () => {
    const { port, headers, cookie } = await launch();
    const root = await mkdtemp(join(tmpdir(), "bearing-gateway-"));
    roots.push(root);
    expect((await call(
      port,
      "POST",
      "/api/v1/repository",
      { ...headers, cookie },
      JSON.stringify({ path: root }),
    )).status).toBe(200);

    const path = "/api/v1/runs/run/commands";
    const validHeaders = { ...headers, cookie };
    const validBody = JSON.stringify(command("run"));
    const withoutOrigin = { "content-type": "application/json", cookie };
    const withoutCookie = { ...headers };
    const future = { ...command("run"), schemaVersion: 2 };
    const mismatch = command("another-run");
    const forged = command("run", 0, "agent");
    const cases: Array<[string, Record<string, string>, string]> = [
      ["wrong Host", { ...validHeaders, host: "evil.invalid" }, validBody],
      ["missing Origin", withoutOrigin, validBody],
      ["wrong Origin", { ...validHeaders, origin: "http://evil.invalid" }, validBody],
      ["missing cookie", withoutCookie, validBody],
      ["duplicate cookie", { ...validHeaders, cookie: `${cookie}; ${cookie}` }, validBody],
      ["wrong cookie", { ...validHeaders, cookie: "bearing_session=wrong" }, validBody],
      ["wrong media type", { ...validHeaders, "content-type": "text/plain" }, validBody],
      ["malformed JSON", validHeaders, "{"],
      ["oversized body", validHeaders, "x".repeat(8 * 1024 + 1)],
      ["future schema", validHeaders, JSON.stringify(future)],
      ["URL/envelope run mismatch", validHeaders, JSON.stringify(mismatch)],
      ["forged agent actor", validHeaders, JSON.stringify(forged)],
    ];

    const store = new BearingStore(root);
    for (const [label, requestHeaders, body] of cases) {
      const response = await call(port, "POST", path, requestHeaders, body);
      expect(response.status < 200 || response.status >= 300, label).toBe(true);
      expect(response.body, label).toBe("Rejected");
      expect((await store.load("run")).revision, label).toBe(0);
    }
  });

  it("durably accepts once, then rejects stale and conflicting duplicate commands", async () => {
    const { port, headers, cookie } = await launch();
    const root = await mkdtemp(join(tmpdir(), "bearing-gateway-"));
    roots.push(root);
    const authenticated = { ...headers, cookie };
    expect((await call(
      port,
      "POST",
      "/api/v1/repository",
      authenticated,
      JSON.stringify({ path: root }),
    )).status).toBe(200);

    const path = "/api/v1/runs/run/commands";
    const accepted = command("run");
    expect((await call(port, "POST", path, authenticated, JSON.stringify(accepted))).status).toBe(200);
    const store = new BearingStore(root);
    expect((await store.load("run")).revision).toBe(1);

    const stale = { ...command("run"), commandId: "stale" };
    const conflict = { ...accepted, payload: { title: "Changed", goal: "Goal" } };
    for (const [label, body] of [["stale revision", stale], ["conflicting duplicate", conflict]] as const) {
      const response = await call(port, "POST", path, authenticated, JSON.stringify(body));
      expect(response.status, label).toBe(409);
      expect(response.body, label).toBe("Rejected");
      expect((await store.load("run")).revision, label).toBe(1);
    }
  });

  it("projects only authenticated durable recommendation state", async () => {
    const { port, headers, cookie } = await launch();
    expect((await call(port, "GET", "/api/v1/runs/run", headers)).status).toBe(401);
    expect((await call(port, "GET", "/api/v1/runs/run", { ...headers, cookie, host: "evil.invalid" })).status).toBe(421);
    expect((await call(port, "GET", "/api/v1/runs/run", { ...headers, cookie })).status).toBe(409);

    const root = await mkdtemp(join(tmpdir(), "bearing-projection-"));
    roots.push(root);
    const authenticated = { ...headers, cookie };
    expect((await call(port, "POST", "/api/v1/repository", authenticated, JSON.stringify({ path: root }))).status).toBe(200);

    const response = await call(port, "GET", "/api/v1/runs/run", authenticated);
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ runId: "run", revision: 0, workRequestCreated: false, pendingDecision: null, answersRecorded: 0, recommendation: null, approval: null });
    expect(response.body).not.toContain(cookie);
    expect(response.body).not.toContain("capability");
    expect(response.body).not.toContain("provider");
    expect(response.body).not.toContain("transcript");
  });

  it("accepts the browser's exact create, recommend, approve, and override envelopes without launching", async () => {
    const { port, headers, cookie } = await launch();
    const root = await mkdtemp(join(tmpdir(), "bearing-browser-"));
    roots.push(root);
    const authenticated = { ...headers, cookie };
    expect((await call(port, "POST", "/api/v1/repository", authenticated, JSON.stringify({ path: root }))).status).toBe(200);

    const post = (runId: string, body: object) => call(port, "POST", `/api/v1/runs/${runId}/commands`, authenticated, JSON.stringify(body));
    const envelope = (runId: string, commandId: string, expectedRevision: number, type: string, payload: object) => ({
      schemaVersion: 1,
      commandId,
      runId,
      expectedRevision,
      session: { sessionId: "browser", actor: "owner" },
      correlationId: commandId,
      type,
      payload,
    });

    expect((await post("decision-run", envelope("decision-run", "create-decision", 0, "createWorkRequest", { title: "Browser work", goal: "Answer questions" }))).status).toBe(200);
    expect((await post("decision-run", envelope("decision-run", "ask", 1, "requireDecision", { decisionId: "docs", question: "Any reference docs?", consequential: true }))).status).toBe(200);
    let decisionState = JSON.parse((await call(port, "GET", "/api/v1/runs/decision-run", authenticated)).body);
    expect(decisionState).toMatchObject({ revision: 2, pendingDecision: { decisionId: "docs", question: "Any reference docs?" }, answersRecorded: 0 });
    expect((await post("decision-run", envelope("decision-run", "answer", 2, "recordOwnerAnswer", { decisionId: "docs", answer: "None" }))).status).toBe(200);
    decisionState = JSON.parse((await call(port, "GET", "/api/v1/runs/decision-run", authenticated)).body);
    expect(decisionState).toMatchObject({ revision: 3, pendingDecision: null, answersRecorded: 1 });

    expect((await post("approve-run", envelope("approve-run", "create-approve", 0, "createWorkRequest", { title: "Browser work", goal: "Recommend a mode" }))).status).toBe(200);
    expect((await post("approve-run", envelope("approve-run", "recommend-approve", 1, "recommendExecutionMode", { workItems: 2, maxCrewmatesPerExplorer: 3, perAgentTokenEstimate: 1000 }))).status).toBe(200);
    let state = JSON.parse((await call(port, "GET", "/api/v1/runs/approve-run", authenticated)).body);
    expect(state).toMatchObject({ revision: 2, workRequestCreated: true, recommendation: { recommendedMode: "explorer", estimatedAgents: 3, estimatedTokens: 3000, tradeoffs: { tokens: expect.any(String), coordination: expect.any(String) }, launchAuthorized: false }, approval: null });
    expect((await post("approve-run", envelope("approve-run", "approve", 2, "approveExecutionMode", { recommendationEventId: state.recommendation.eventId }))).status).toBe(200);
    state = JSON.parse((await call(port, "GET", "/api/v1/runs/approve-run", authenticated)).body);
    expect(state.approval).toMatchObject({ kind: "owner-approval", selectedMode: "explorer" });

    expect((await post("override-run", envelope("override-run", "create-override", 0, "createWorkRequest", { title: "Browser work", goal: "Override a mode" }))).status).toBe(200);
    expect((await post("override-run", envelope("override-run", "recommend-override", 1, "recommendExecutionMode", { workItems: 5, maxCrewmatesPerExplorer: 2, perAgentTokenEstimate: 1000 }))).status).toBe(200);
    state = JSON.parse((await call(port, "GET", "/api/v1/runs/override-run", authenticated)).body);
    expect(state.recommendation.recommendedMode).toBe("expedition");
    expect((await post("override-run", envelope("override-run", "override", 2, "overrideExecutionMode", { recommendationEventId: state.recommendation.eventId, selectedMode: "explorer" }))).status).toBe(200);
    state = JSON.parse((await call(port, "GET", "/api/v1/runs/override-run", authenticated)).body);
    expect(state.approval).toMatchObject({ kind: "owner-override", selectedMode: "explorer" });

    const store = new BearingStore(root);
    expect((await store.load("approve-run")).events.map((event) => event.type)).toEqual(["workRequestCreated", "executionModeRecommended", "executionModeApproved"]);
    expect((await store.load("override-run")).events.map((event) => event.type)).toEqual(["workRequestCreated", "executionModeRecommended", "executionModeOverridden"]);
  });

  it("rejects recommendation estimates outside the browser bounds", async () => {
    const { port, headers, cookie } = await launch();
    const root = await mkdtemp(join(tmpdir(), "bearing-bounds-"));
    roots.push(root);
    const authenticated = { ...headers, cookie };
    await call(port, "POST", "/api/v1/repository", authenticated, JSON.stringify({ path: root }));
    await call(port, "POST", "/api/v1/runs/run/commands", authenticated, JSON.stringify(command("run")));
    const recommend = { ...command("run", 1), commandId: "recommend", correlationId: "recommend", type: "recommendExecutionMode", payload: { workItems: 65, maxCrewmatesPerExplorer: 16, perAgentTokenEstimate: 100_000 } };
    expect((await call(port, "POST", "/api/v1/runs/run/commands", authenticated, JSON.stringify(recommend))).status).toBe(400);
    expect((await new BearingStore(root).load("run")).revision).toBe(1);
  });
});
