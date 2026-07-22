import { describe, expect, it } from "vitest";
import { resolveContext, withContext, type ContextPort } from "../src/context/context.js";
import type { RoleProjection } from "../src/profile/profile.js";

describe("context boundary", () => {
  it("makes no retrieval call in off mode", async () => {
    let calls = 0;
    const port: ContextPort = { retrieve: async () => { calls += 1; return []; } };
    expect(await resolveContext("off", "query", port)).toEqual({ requested: "off", effective: "off", sources: [], warningCodes: [] });
    expect(calls).toBe(0);
  });

  it("bounds optional evidence and degrades truthfully when unavailable", async () => {
    const port: ContextPort = { retrieve: async () => Array.from({ length: 20 }, (_, index) => ({ id: `id-${index}`, title: "t".repeat(700), excerpt: "e".repeat(700) })) };
    const evidence = await resolveContext("evidence-only", "q".repeat(700), port);
    expect(evidence).toMatchObject({ requested: "evidence-only", effective: "evidence-only", warningCodes: [] });
    expect(evidence.sources).toHaveLength(16);
    expect(evidence.sources[0].title).toHaveLength(512);
    expect(evidence.sources[0].excerpt).toHaveLength(512);
    expect(await resolveContext("rag-assisted", "q")).toEqual({ requested: "rag-assisted", effective: "off", sources: [], warningCodes: ["context_unavailable"] });
  });

  it("redacts credentials in every bounded source string", async () => {
    const port: ContextPort = { retrieve: async () => [{ id: "Bearer hunter2", title: "token=abc", excerpt: "sk-abcdefghijklmnopqrstuvwxyz" }] };
    const result = await resolveContext("evidence-only", "q", port);
    expect(JSON.stringify(result)).not.toMatch(/hunter2|abc|sk-abcdefghijklmnopqrstuvwxyz/);
  });

  it("cannot enlarge authority, tools, isolation, or limits", () => {
    const role = { context: "off", authority: { read: true, write: false, network: false, workspace: true, externalAction: false }, toolAllow: ["read"], toolDeny: ["shell"], isolationRequested: "required", limits: { timeoutMs: 1, maxTurns: 1, maxTools: 1, maxRetries: 1, maxConcurrency: 1, maxDelegation: 1, tokenBudget: 1 } } as RoleProjection;
    const changed = withContext(role, "rag-assisted");
    expect(changed.context).toBe("rag-assisted");
    expect(changed.authority).toBe(role.authority);
    expect(changed.toolAllow).toBe(role.toolAllow);
    expect(changed.isolationRequested).toBe("required");
    expect(changed.limits).toBe(role.limits);
  });
});
