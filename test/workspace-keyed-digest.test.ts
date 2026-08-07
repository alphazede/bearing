import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { EventEnvelopeV1 } from "../src/contracts/run.js";
import { projectOutcomes } from "../src/improvement/outcome-projection.js";
import { workspaceKeyedDigest } from "../src/improvement/workspace-keyed-digest.js";

const DIGEST = /^[a-f0-9]{64}$/;
const RECORDED_AT = "2026-07-26T12:00:00.000Z";

function checkpoint(): EventEnvelopeV1 {
  return {
    schemaVersion: 1,
    eventId: "event-1",
    runId: "private-run-1",
    sequence: 1,
    recordedAt: RECORDED_AT,
    type: "journeyCheckpointRecorded",
    actor: "bearing",
    sessionId: "local-runtime",
    correlationId: "correlation-1",
    causationId: "command-1",
    commandContentHash: "0".repeat(64),
    payload: {
      stage: "execute-explorer",
      status: "failed",
      planningFailure: "REQUIREMENTS_GAP",
      artifacts: [],
    },
    evidenceRefs: [],
    previousHash: "",
    hash: "0".repeat(64),
  };
}

describe("workspace-keyed digest", () => {
  it("produces different refs for identical input in different workspaces", () => {
    const first = workspaceKeyedDigest("/workspace/alpha")("run-1");
    const second = workspaceKeyedDigest("/workspace/beta")("run-1");
    expect(first).toMatch(DIGEST);
    expect(second).toMatch(DIGEST);
    expect(first).not.toEqual(second);
  });

  it("stays stable within one workspace across calls and factory instances", () => {
    const factory = workspaceKeyedDigest("/workspace/alpha");
    expect(factory("run-1")).toEqual(factory("run-1"));
    expect(workspaceKeyedDigest("/workspace/alpha")("run-1"))
      .toEqual(workspaceKeyedDigest("/workspace/alpha")("run-1"));
  });

  it("cannot be recomputed from the plaintext alone", () => {
    const reference = workspaceKeyedDigest("/workspace/alpha")("run-1");
    const unkeyed = createHash("sha256").update("run-1").digest("hex");
    expect(reference).not.toEqual(unkeyed);
  });

  it("leaves no key material or absolute path in any projected record", () => {
    const workspace = "/private/workspace/alpha";
    const records = projectOutcomes({
      runId: "private-run-1",
      events: [checkpoint()],
      digest: workspaceKeyedDigest(workspace),
    });
    expect(records.length).toBeGreaterThan(0);
    const serialized = JSON.stringify(records);
    expect(serialized).not.toContain(workspace);
    expect(serialized).not.toContain("private-run-1");
    for (const record of records) {
      expect(record.runRef).toMatch(DIGEST);
      if (record.sliceRef !== undefined) expect(record.sliceRef).toMatch(DIGEST);
      if (record.fingerprintRef !== undefined) expect(record.fingerprintRef).toMatch(DIGEST);
    }
  });
});
