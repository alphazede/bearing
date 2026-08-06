import { access, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertContributionBundle,
  exportContributionBundle,
  type ContributionBundle,
} from "../src/improvement/improvement-export.js";

// Deterministic TOCTOU harness state. Armed only by the race regression test
// below; a no-op passthrough for every other test in this file.
let raceArmed = false;
let raceContribPath: string | null = null;
let raceOutsidePath: string | null = null;

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    async realpath(path: Parameters<typeof actual.realpath>[0], options?: never) {
      const resolved = await actual.realpath(path, options);
      // Simulate a concurrent local process winning the race: the instant
      // the containment check resolves the real parent directory, swap that
      // exact path for a symlink pointing outside the repository, before the
      // export writer acts on the path it just verified.
      if (raceArmed && raceContribPath !== null && path === raceContribPath) {
        raceArmed = false;
        await actual.rm(raceContribPath, { recursive: true, force: true });
        await actual.symlink(raceOutsidePath as string, raceContribPath);
      }
      return resolved;
    },
  };
});

const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "bearing-improvement-export-"));
  roots.push(root);
  return root;
}

function bundle(): ContributionBundle {
  return {
    schemaVersion: 1,
    policyValues: [{
      surface: "review-cadence",
      target: "surveyor",
      from: "per-phase",
      to: "per-slice",
      verdict: "retain",
    }],
    benchmarkCases: [{
      name: "bounded-plan",
      scenario: "A plan contains one isolated implementation slice.",
      expectedOutcome: "pass",
    }],
    testCases: [{
      name: "unsafe-export-refusal",
      kind: "structural",
      expectedOutcome: "pass",
    }],
    workflowNotes: [{
      authoredBy: "owner",
      note: "Run focused export checks before independent review.",
    }],
  };
}

async function absent(path: string): Promise<boolean> {
  return access(path).then(() => false, () => true);
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("improvement contribution export", () => {
  it("asserts the allowlisted bundle and writes exactly one owner-named local file", async () => {
    const root = await temporaryRoot();
    await mkdir(join(root, "contrib"));
    const value = bundle();

    expect(() => assertContributionBundle(value)).not.toThrow();
    const result = await exportContributionBundle({
      repositoryRoot: root,
      destination: "contrib/improvement.json",
      bundle: value,
    });

    expect(result).toEqual({ ok: true, destination: "contrib/improvement.json" });
    expect(await readFile(join(root, "contrib/improvement.json"), "utf8"))
      .toBe(`${JSON.stringify(value, null, 2)}\n`);
  });

  it.each([
    ["run reference", { runRef: "a".repeat(64) }],
    ["slice reference", { sliceRef: "b".repeat(64) }],
    ["fingerprint reference", { fingerprintRef: "c".repeat(64) }],
    ["path references", { pathRefs: ["d".repeat(64)] }],
    ["run identifier", { runId: "private-run-1" }],
    ["timestamp", { recordedAt: "2026-07-26T12:00:00.000Z" }],
    ["provider session identifier", { providerSessionId: "9b3c924c-2fd8-4b61-a9e2-901e9af95cec" }],
    ["plan directory", { planDirectory: "private-plan" }],
    ["repository path", { repositoryPath: "private/repository" }],
  ])("refuses a bundle containing a %s before writing", async (_name, leaked) => {
    const root = await temporaryRoot();
    const destination = join(root, "improvement.json");
    const value = { ...bundle(), ...leaked };

    expect(() => assertContributionBundle(value)).toThrowError("export_shape_invalid");
    await expect(exportContributionBundle({
      repositoryRoot: root,
      destination: "improvement.json",
      bundle: value,
    })).resolves.toEqual({ ok: false, reason: "export_shape_invalid" });
    expect(await absent(destination)).toBe(true);
  });

  it.each([
    ["digest", "Owner note aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
    ["timestamp", "Owner note 2026-07-26T12:00:00.000Z"],
    ["session identifier", "Owner note 9b3c924c-2fd8-4b61-a9e2-901e9af95cec"],
    ["run identifier", "Owner note run-private-1"],
    ["absolute path", "Owner note /private/repository"],
    ["relative path", "Owner note private/repository"],
  ])("refuses a %s embedded in owner-authored text", (_name, note) => {
    const value = {
      ...bundle(),
      workflowNotes: [{ authoredBy: "owner", note }],
    };
    expect(() => assertContributionBundle(value)).toThrowError("export_shape_invalid");
  });

  it("requires allowlist keys to be own properties", () => {
    const inheritedSchema = Object.assign(Object.create({ schemaVersion: 1 }), {
      policyValues: [],
      benchmarkCases: [],
      testCases: [],
      workflowNotes: [],
    });

    expect(() => assertContributionBundle(inheritedSchema)).toThrowError("export_shape_invalid");
  });

  it.each([
    "/tmp/improvement.json",
    "../improvement.json",
    "nested/../../improvement.json",
    "nested\\..\\improvement.json",
    "C:\\private\\improvement.json",
    ".",
  ])("returns a truthy typed rejection for unsafe destination %s", async (destination) => {
    const root = await temporaryRoot();
    const result = await exportContributionBundle({
      repositoryRoot: root,
      destination,
      bundle: bundle(),
    });

    expect(result).toEqual({ ok: false, reason: "destination_invalid" });
    expect(result).toBeTruthy();
  });

  it("refuses a parent symlink that would escape the selected repository", async () => {
    const root = await temporaryRoot();
    const outside = await temporaryRoot();
    await symlink(outside, join(root, "contrib"));

    const result = await exportContributionBundle({
      repositoryRoot: root,
      destination: "contrib/improvement.json",
      bundle: bundle(),
    });

    expect(result).toEqual({ ok: false, reason: "destination_invalid" });
    expect(await absent(join(outside, "improvement.json"))).toBe(true);
  });

  it("refuses a write when the parent directory becomes a symlink between the containment check and the write (TOCTOU race)", async () => {
    const root = await temporaryRoot();
    const outside = await temporaryRoot();
    const contribPath = join(root, "contrib");
    await mkdir(contribPath);

    raceContribPath = contribPath;
    raceOutsidePath = outside;
    raceArmed = true;

    let result: unknown;
    try {
      result = await exportContributionBundle({
        repositoryRoot: root,
        destination: "contrib/improvement.json",
        bundle: bundle(),
      });
    } finally {
      raceArmed = false;
      raceContribPath = null;
      raceOutsidePath = null;
    }

    expect(result).toEqual({ ok: false, reason: "destination_invalid" });
    expect(await absent(join(outside, "improvement.json"))).toBe(true);
    expect(await readdir(outside)).toEqual([]);
  });

  it("fails closed rather than overwriting an existing file", async () => {
    const root = await temporaryRoot();
    const destination = join(root, "improvement.json");
    await writeFile(destination, "owner content\n", "utf8");

    const result = await exportContributionBundle({
      repositoryRoot: root,
      destination: "improvement.json",
      bundle: bundle(),
    });

    expect(result).toEqual({ ok: false, reason: "export_failed" });
    expect(await readFile(destination, "utf8")).toBe("owner content\n");
  });
});
