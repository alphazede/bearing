import { EventEmitter } from "node:events";
import { access, mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
import type { IncomingMessage, ServerResponse, Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { run, type LauncherDeps } from "../src/cli.js";
import type { EventEnvelopeV1 } from "../src/contracts/run.js";
import { LocalSessionService } from "../src/server/local-session.js";
import { SseProjection } from "../src/server/sse.js";
import { BearingStore } from "../src/store/bearing-store.js";

const servers: Server[] = [];
const roots: string[] = [];

afterEach(async () => {
  while (servers.length) {
    await new Promise<void>((resolve) => servers.pop()!.close(() => resolve()));
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function event(runId: string, sequence: number): EventEnvelopeV1 {
  return {
    schemaVersion: 1,
    eventId: `${runId}-${sequence}`,
    runId,
    sequence,
    recordedAt: "2026-07-19T12:00:00.000Z",
    type: "workRequestCreated",
    actor: "owner",
    sessionId: "session",
    correlationId: "correlation",
    causationId: "command",
    commandContentHash: "0".repeat(64),
    payload: { sequence },
    evidenceRefs: [],
    previousHash: "",
    hash: "0".repeat(64),
  };
}

function authenticatedSession() {
  const session = new LocalSessionService("127.0.0.1:5000");
  const exchanged = session.exchange(session.capability);
  if (!exchanged.ok) throw new Error("session exchange failed");
  const req = new EventEmitter() as EventEmitter & { headers: Record<string, string> };
  req.headers = {
    origin: "http://127.0.0.1:5000",
    cookie: `bearing_session=${exchanged.cookieValue}`,
  };
  return { session, req: req as unknown as IncomingMessage };
}

function fakeResponse(writeResult: (chunk: string) => boolean = () => true) {
  const writes: string[] = [];
  const headers: number[] = [];
  let ended = false;
  const emitter = new EventEmitter();
  const response = Object.assign(emitter, {
    writeHead: (status: number) => (headers.push(status), response),
    write: (chunk: string) => {
      writes.push(chunk);
      return writeResult(chunk);
    },
    end: () => {
      ended = true;
      return response;
    },
  });
  return {
    res: response as unknown as ServerResponse,
    writes,
    headers,
    ended: () => ended,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("SSE projection unit", () => {
  it("isolates replay and live delivery by run id", async () => {
    const target = [event("target", 1), event("target", 2)];
    const other = [event("other", 1), event("other", 2)];
    const { session, req } = authenticatedSession();
    const response = fakeResponse();
    const projection = new SseProjection(
      { load: async () => ({ events: [other[0], target[0]] }) },
      session,
    );

    projection.handle(req, response.res, "target");
    await flush();
    projection.publish([other[1], target[1]]);

    const output = response.writes.join("");
    expect([...output.matchAll(/^id: (\d+)$/gm)].map((match) => Number(match[1]))).toEqual([1, 2]);
    expect(output).not.toContain('"runId":"other"');
    expect(output).toContain('"runId":"target"');
  });

  it("closes the load/register/load window without gaps or duplicates", async () => {
    const first = event("run", 1);
    const acceptedDuringSetup = event("run", 2);
    const secondLoad = deferred<{ events: readonly EventEnvelopeV1[] }>();
    const secondLoadStarted = deferred<void>();
    let loads = 0;
    const { session, req } = authenticatedSession();
    const response = fakeResponse();
    const projection = new SseProjection({
      load: async () => {
        loads += 1;
        if (loads === 1) return { events: [first] };
        secondLoadStarted.resolve();
        return secondLoad.promise;
      },
    }, session);

    projection.handle(req, response.res, "run");
    await secondLoadStarted.promise;
    expect(response.headers).toEqual([]);
    projection.publish([acceptedDuringSetup]);
    secondLoad.resolve({ events: [first, acceptedDuringSetup] });
    await flush();

    const ids = [...response.writes.join("").matchAll(/^id: (\d+)$/gm)]
      .map((match) => Number(match[1]));
    expect(ids).toEqual([1, 2]);
    expect(response.headers).toEqual([200]);
  });

  it("returns a generic 503 when the second load fails before headers", async () => {
    const secondLoad = deferred<{ events: readonly EventEnvelopeV1[] }>();
    let loads = 0;
    const { session, req } = authenticatedSession();
    const response = fakeResponse();
    const projection = new SseProjection({
      load: async () => ++loads === 1 ? { events: [] } : secondLoad.promise,
    }, session);

    projection.handle(req, response.res, "run");
    await flush();
    expect(response.headers).toEqual([]);
    secondLoad.reject(new Error("unavailable"));
    await flush();
    expect(response.headers).toEqual([503]);
    expect(response.ended()).toBe(true);
  });

  it("disconnects only a capped slow client and keeps publish synchronous", async () => {
    const { session, req: slowReq } = authenticatedSession();
    const slow = fakeResponse(() => false);
    const healthy = fakeResponse();
    const healthyEmitter = new EventEmitter() as EventEmitter & { headers: IncomingMessage["headers"] };
    healthyEmitter.headers = { ...slowReq.headers };
    const healthyReq = healthyEmitter as unknown as IncomingMessage;
    const projection = new SseProjection({ load: async () => ({ events: [] }) }, session, 2);

    projection.handle(slowReq, slow.res, "run");
    projection.handle(healthyReq, healthy.res, "run");
    await flush();

    for (let sequence = 1; sequence <= 4; sequence += 1) {
      expect(projection.publish([event("run", sequence)])).toBeUndefined();
    }
    expect(slow.ended()).toBe(true);
    expect(healthy.ended()).toBe(false);
    expect([...healthy.writes.join("").matchAll(/^id: (\d+)$/gm)]
      .map((match) => Number(match[1]))).toEqual([1, 2, 3, 4]);

    projection.publish([event("run", 5)]);
    expect(healthy.writes.join("")).toContain("id: 5");
  });
});

interface Response {
  status: number;
  body: string;
}

function call(
  port: string,
  method: string,
  path: string,
  headers: Record<string, string>,
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
    req.end(body);
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
  const cookie = await new Promise<string>((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port: Number(url.port),
        method: "POST",
        path: "/api/v1/session",
        headers,
      },
      (res) => {
        const value = res.headers["set-cookie"]?.[0];
        if (value) resolve(value.split(";")[0]);
        else reject(new Error("session cookie missing"));
      },
    );
    req.on("error", reject);
    req.end(JSON.stringify({ capability: url.hash.slice(5) }));
  });
  return { port: url.port, headers, cookie };
}

function command(type: "createWorkRequest" | "requireDecision", revision: number) {
  const base = {
    schemaVersion: 1,
    commandId: `command-${revision}`,
    runId: "run",
    expectedRevision: revision,
    session: { sessionId: "browser", actor: "owner" },
    correlationId: `correlation-${revision}`,
  };
  return type === "createWorkRequest"
    ? { ...base, type, payload: { title: "Title", goal: "Goal" } }
    : {
        ...base,
        type,
        payload: { decisionId: "decision-1", question: "Proceed?", consequential: true },
      };
}

function readSse(
  port: string,
  path: string,
  headers: Record<string, string>,
  until: (text: string) => boolean,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port: Number(port), path, headers },
      (res) => {
        expect(res.statusCode).toBe(200);
        let text = "";
        res.on("data", (chunk: Buffer) => {
          text += chunk.toString("utf8");
          if (until(text)) {
            resolve(text);
            req.destroy();
          }
        });
      },
    );
    req.on("error", (error) => {
      if (!req.destroyed) reject(error);
    });
    req.end();
  });
}

describe("SSE raw HTTP boundary", () => {
  it("rejects unavailable, unauthenticated, malformed, and invalid-run requests", async () => {
    const { port, headers, cookie } = await launch();
    const valid = { origin: headers.origin, cookie };
    expect(await call(port, "GET", "/api/v1/runs/run/events", valid)).toEqual({
      status: 409,
      body: "Rejected",
    });

    const root = await mkdtemp(join(tmpdir(), "bearing-sse-"));
    roots.push(root);
    expect((await call(
      port,
      "POST",
      "/api/v1/repository",
      { ...headers, cookie },
      JSON.stringify({ path: root }),
    )).status).toBe(200);

    const cases: Array<[string, Record<string, string>]> = [
      ["wrong Host", { ...valid, host: "evil.invalid" }],
      ["missing Origin", { cookie }],
      ["wrong Origin", { ...valid, origin: "http://evil.invalid" }],
      ["missing cookie", { origin: headers.origin }],
      ["duplicate cookie", { ...valid, cookie: `${cookie}; ${cookie}` }],
      ["wrong cookie", { ...valid, cookie: "bearing_session=wrong" }],
      ["negative Last-Event-ID", { ...valid, "last-event-id": "-1" }],
      ["fractional Last-Event-ID", { ...valid, "last-event-id": "1.5" }],
      ["unsafe Last-Event-ID", { ...valid, "last-event-id": "9007199254740992" }],
      ["duplicate Last-Event-ID", { ...valid, "last-event-id": "1, 2" }],
    ];
    for (const [label, requestHeaders] of cases) {
      const response = await call(port, "GET", "/api/v1/runs/run/events", requestHeaders);
      expect(response.status, label).toBeGreaterThanOrEqual(400);
      expect(response.body, label).toBe("Rejected");
    }

    for (const runPath of ["bad.run", "x".repeat(129)]) {
      const response = await call(port, "GET", `/api/v1/runs/${runPath}/events`, valid);
      expect(response).toEqual({ status: 404, body: "Rejected" });
      await expect(access(join(root, ".bearing", "runs", runPath))).rejects.toBeDefined();
    }
    expect((await new BearingStore(root).load("run")).revision).toBe(0);
  });

  it("replays and reconnects in order without mutating a pending decision", async () => {
    const { port, headers, cookie } = await launch();
    const authenticated = { ...headers, cookie };
    const root = await mkdtemp(join(tmpdir(), "bearing-sse-"));
    roots.push(root);
    expect((await call(
      port,
      "POST",
      "/api/v1/repository",
      authenticated,
      JSON.stringify({ path: root }),
    )).status).toBe(200);

    const commandPath = "/api/v1/runs/run/commands";
    expect((await call(port, "POST", commandPath, authenticated, JSON.stringify(command("createWorkRequest", 0)))).status).toBe(200);
    expect((await call(port, "POST", commandPath, authenticated, JSON.stringify(command("requireDecision", 1)))).status).toBe(200);
    const store = new BearingStore(root);
    const before = await store.load("run");
    expect(before.revision).toBe(2);
    expect(before.pendingDecision).toEqual({ decisionId: "decision-1", question: "Proceed?" });

    const eventPath = "/api/v1/runs/run/events";
    const sseHeaders = { origin: headers.origin, cookie };
    const initial = await readSse(port, eventPath, sseHeaders, (text) => text.includes("id: 2"));
    expect([...initial.matchAll(/^id: (\d+)$/gm)].map((match) => Number(match[1]))).toEqual([1, 2]);
    expect((await store.load("run")).revision).toBe(2);

    const resumed = await readSse(
      port,
      eventPath,
      { ...sseHeaders, "last-event-id": "1" },
      (text) => text.includes("id: 2"),
    );
    expect([...resumed.matchAll(/^id: (\d+)$/gm)].map((match) => Number(match[1]))).toEqual([2]);
    const after = await store.load("run");
    expect(after.revision).toBe(2);
    expect(after.pendingDecision).toEqual(before.pendingDecision);
  });
});
