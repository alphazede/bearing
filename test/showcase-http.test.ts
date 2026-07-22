import { createServer, request, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalSessionService, SESSION_COOKIE_NAME, createRequestHandler } from "../src/server/local-session.js";

const servers: Server[] = [];
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function launch() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen({ host: "127.0.0.1", port: 0 }, resolve));
  servers.push(server);
  const address = server.address(); if (!address || typeof address === "string") throw new Error("missing address");
  const port = String(address.port);
  const session = new LocalSessionService(`127.0.0.1:${port}`);
  server.on("request", createRequestHandler(session));
  return { port, session };
}

function call(port: string, path: string, cookie?: string, method = "GET", body?: string) {
  return new Promise<{ status: number; body: string; headers: Record<string, string | string[] | undefined> }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers: { ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { origin: `http://127.0.0.1:${port}`, "content-type": "application/json" }) } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8"), headers: res.headers }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

async function onboard(port: string, session: LocalSessionService): Promise<string> {
  const exchanged = session.exchange(session.capability); if (!exchanged.ok) throw new Error("exchange failed");
  const cookie = `${SESSION_COOKIE_NAME}=${exchanged.cookieValue}`;
  const root = await mkdtemp(join(tmpdir(), "bearing-showcase-")); roots.push(root);
  expect((await call(port, "/api/v1/repository", cookie, "POST", JSON.stringify({ path: root }))).status).toBe(200);
  return cookie;
}

describe("native browser showcase HTTP", () => {
  it("keeps catalog and selected projections authenticated and onboarding-bound", async () => {
    const { port, session } = await launch();
    expect((await call(port, "/api/v1/workflows")).status).toBe(401);
    const exchanged = session.exchange(session.capability); if (!exchanged.ok) throw new Error("exchange failed");
    const cookie = `${SESSION_COOKIE_NAME}=${exchanged.cookieValue}`;
    expect((await call(port, "/api/v1/workflows", cookie)).status).toBe(409);
    const root = await mkdtemp(join(tmpdir(), "bearing-showcase-")); roots.push(root);
    await call(port, "/api/v1/repository", cookie, "POST", JSON.stringify({ path: root }));
    const catalog = await call(port, "/api/v1/workflows", cookie);
    expect(catalog.status).toBe(200);
    expect(JSON.parse(catalog.body).workflows).toHaveLength(3);
    const selected = await call(port, "/api/v1/workflows/workflow.launch-readiness.v1", cookie);
    expect(selected.status).toBe(200);
    expect(selected.body.length).toBeLessThanOrEqual(64 * 1024);
    expect(selected.headers["cache-control"]).toBe("no-store");
  });

  it("bounds IDs and fails closed for unknown, malformed, query-bearing, and body routes", async () => {
    const { port, session } = await launch(); const cookie = await onboard(port, session);
    for (const path of [
      "/api/v1/workflows/workflow.unknown.v1",
      `/api/v1/workflows/${"x".repeat(65)}`,
      "/api/v1/workflows/workflow%2Flaunch-readiness.v1",
      "/api/v1/workflows/workflow.launch-readiness.v1?extra=true",
    ]) expect((await call(port, path, cookie)).status).toBe(404);
    expect((await call(port, "/api/v1/workflows/workflow.launch-readiness.v1", cookie, "POST", "{}")).status).toBe(404);
  });

  it("serializes only bounded public-safe projections for every workflow", async () => {
    const { port, session } = await launch(); const cookie = await onboard(port, session);
    for (const id of ["workflow.engineering-import.v1", "workflow.launch-readiness.v1", "workflow.due-diligence.v1"]) {
      const response = await call(port, `/api/v1/workflows/${id}`, cookie);
      expect(response.status).toBe(200);
      expect(response.body.length).toBeLessThanOrEqual(64 * 1024);
      expect(response.body).not.toMatch(/(?:providerOutput|cookieValue|bearing_session|private key|\/home\/|\\Users\\)/i);
      expect(JSON.parse(response.body)).toMatchObject({ id, executionPolicy: { deterministic: true, providers: "disabled" } });
    }
  });

  it("serves an authenticated self-contained public-safe report for opening or saving", async () => {
    const { port, session } = await launch(); const cookie = await onboard(port, session);
    expect((await call(port, "/api/v1/workflows/workflow.launch-readiness.v1/report")).status).toBe(401);
    const response = await call(port, "/api/v1/workflows/workflow.launch-readiness.v1/report", cookie);
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(response.headers["content-disposition"]).toMatch(/^inline; filename="workflow\.launch-readiness\.v1-evidence\.html"$/);
    expect(response.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.body.length).toBeLessThanOrEqual(128 * 1024);
    expect(response.body).toContain("Independent Resurvey passed");
    expect(response.body).not.toMatch(/<script|(?:src|href)=["']https?:|\/home\/|file:\/\//i);
  });

  it("keeps showcase endpoints available without putting demo choices in onboarding", async () => {
    const { port } = await launch(); const page = await call(port, "/");
    expect(page.body).toContain("<main>");
    expect(page.body).toContain('id="status" role="status" aria-live="polite"');
    expect(page.body).toContain('id="change-repository"');
    expect(page.body).toContain('aria-label="Current workspace and agent settings"');
    expect(page.body).toContain('id="work-goal"');
    expect(page.body).not.toContain('id="workflow-select"');
    expect(page.body).not.toContain('aria-labelledby="showcase-heading"');
    expect(page.body).toContain("focus-visible");
    expect(page.body).toContain("prefers-reduced-motion:reduce");
    expect(page.body).toContain("@keyframes panel-in");
    expect(page.body).toContain(".textContent =");
    expect(page.body).not.toMatch(/\.innerHTML\s*=|insertAdjacentHTML|document\.write/);
    expect(page.body).not.toContain("/launch");
  });
});
