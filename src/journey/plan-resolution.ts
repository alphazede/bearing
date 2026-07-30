import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { planDirectoryValid } from "./plan-directory.js";
import { containedDirectory } from "./repository-map.js";

const MAX_DEPTH = 4;
const MAX_PATHS = 200;

export type PlanDirectoryResolution =
  | { readonly ok: true; readonly path: string; readonly exists: boolean }
  | { readonly ok: false; readonly reason: "plan_directory_invalid" }
  | { readonly ok: false; readonly reason: "plan_directory_absent"; readonly requested: string }
  | { readonly ok: false; readonly reason: "plan_directory_ambiguous"; readonly matches: readonly string[] };

export interface ConsolidationEntry {
  readonly action: "copy" | "skip" | "conflict";
  readonly source: string;
  readonly destination: string;
}

export type ConsolidationPlan =
  | {
    readonly ok: true;
    readonly canonical: string;
    readonly sources: readonly string[];
    readonly entries: readonly ConsolidationEntry[];
  }
  | {
    readonly ok: false;
    readonly reason: "consolidation_conflict";
    readonly canonical: string;
    readonly sources: readonly string[];
    readonly entries: readonly ConsolidationEntry[];
  };

export type ConsolidationResult =
  | {
    readonly ok: true;
    readonly copied: readonly string[];
    readonly skipped: readonly string[];
    readonly sources: readonly string[];
  }
  | {
    readonly ok: false;
    readonly reason: "consolidation_conflict";
    readonly sources: readonly string[];
  };

function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function repositoryPath(repository: string, path: string): string {
  return relative(repository, path).replaceAll("\\", "/");
}

interface PlanInventory {
  readonly paths: readonly string[];
  readonly complete: boolean;
}

interface PlanInventoryOptions {
  readonly maximumDepth?: number;
  readonly strictDepth?: boolean;
}

async function planInventory(
  root: string,
  { maximumDepth = MAX_DEPTH, strictDepth = true }: PlanInventoryOptions = {},
): Promise<PlanInventory> {
  const paths: string[] = [];
  let complete = true;
  const visit = async (directory: string, prefix: string, depth: number): Promise<void> => {
    if (depth > maximumDepth) {
      if (!strictDepth) return;
      const entries = await readdir(directory, { withFileTypes: true });
      if (entries.some((entry) => !entry.isSymbolicLink())) complete = false;
      return;
    }
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.isSymbolicLink()) continue;
      if (paths.length >= MAX_PATHS) {
        complete = false;
        return;
      }
      const candidate = resolve(directory, entry.name);
      const info = await lstat(candidate);
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (info.isDirectory() && !info.isSymbolicLink()) {
        const contained = await containedDirectory(root, candidate);
        if (!contained) continue;
        paths.push(`${path}/`);
        await visit(contained, path, depth + 1);
      } else if (info.isFile() && !info.isSymbolicLink()) {
        paths.push(path);
      }
    }
  };
  await visit(root, "", 0);
  return { paths, complete };
}

async function resolveFullPath(repository: string, path: string): Promise<PlanDirectoryResolution> {
  if (!planDirectoryValid(path)) return { ok: false, reason: "plan_directory_invalid" };
  const state = await directoryState(repository, repository, path);
  return state === "invalid"
    ? { ok: false, reason: "plan_directory_invalid" }
    : { ok: true, path, exists: state === "present" };
}

export async function resolvePlanDirectory(repository: string, request: string): Promise<PlanDirectoryResolution> {
  if (request.startsWith("docs/plans/")) return resolveFullPath(repository, request);

  const plans = resolve(repository, "docs/plans");
  const canonicalPlans = await containedDirectory(repository, plans);
  if (!canonicalPlans) {
    try { await lstat(plans); }
    catch (error: unknown) {
      if (missing(error)) return { ok: false, reason: "plan_directory_absent", requested: request };
      throw error;
    }
    return { ok: false, reason: "plan_directory_invalid" };
  }
  // A bare request can only match directories at these three relative depths.
  const inventory = await planInventory(canonicalPlans, { maximumDepth: 2, strictDepth: false });
  if (!inventory.complete) return { ok: false, reason: "plan_directory_invalid" };
  const matches = inventory.paths
    .filter((path) => path.endsWith("/"))
    .map((path) => path.slice(0, -1))
    .filter((path) => path.split("/").length <= 3 && basename(path) === request)
    .map((path) => `docs/plans/${path}`)
    .sort();
  if (matches.length === 0) return { ok: false, reason: "plan_directory_absent", requested: request };
  if (matches.length > 1) return { ok: false, reason: "plan_directory_ambiguous", matches };
  return resolveFullPath(repository, matches[0]);
}

async function requiredDirectory(repository: string, path: string): Promise<string> {
  if (!planDirectoryValid(path)) throw new Error("plan_directory_invalid");
  const directory = await containedDirectory(repository, resolve(repository, path));
  if (!directory) throw new Error("plan_directory_invalid");
  return directory;
}

async function directoryState(repository: string, root: string, path: string): Promise<"present" | "absent" | "invalid"> {
  let directory = root;
  let absent = false;
  for (const segment of path.split("/").filter((entry) => entry !== ".")) {
    const candidate = resolve(directory, segment);
    if (absent) {
      directory = candidate;
      continue;
    }
    const info = await lstat(candidate).catch((error: unknown) => {
      if (missing(error)) return undefined;
      throw error;
    });
    if (!info) {
      absent = true;
      directory = candidate;
      continue;
    }
    if (!info.isDirectory() || info.isSymbolicLink()) return "invalid";
    const contained = await containedDirectory(repository, candidate);
    if (contained) {
      directory = contained;
      continue;
    }
    return "invalid";
  }
  return absent ? "absent" : "present";
}

async function parentState(repository: string, root: string, path: string): Promise<"present" | "absent" | "invalid"> {
  return directoryState(repository, root, dirname(path));
}

export async function planConsolidation(
  repository: string,
  canonical: string,
  sources: readonly string[],
): Promise<ConsolidationPlan> {
  const canonicalDirectory = await requiredDirectory(repository, canonical);
  const expected = new Map<string, Buffer | undefined>();
  const entries: ConsolidationEntry[] = [];

  for (const source of sources) {
    const sourceDirectory = await requiredDirectory(repository, source);
    if (sourceDirectory === canonicalDirectory) throw new Error("plan_directory_invalid");
    const inventory = await planInventory(sourceDirectory);
    if (!inventory.complete) return { ok: false, reason: "consolidation_conflict", canonical, sources, entries };
    const paths = inventory.paths.filter((path) => !path.endsWith("/"));
    for (const path of paths) {
      const sourcePath = resolve(sourceDirectory, path);
      const sourceInfo = await lstat(sourcePath);
      if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) continue;
      const content = await readFile(sourcePath);
      const destinationPath = resolve(canonicalDirectory, path);
      const destination = repositoryPath(repository, destinationPath);
      let action: ConsolidationEntry["action"];

      if (expected.has(destination)) {
        const prior = expected.get(destination);
        action = prior?.equals(content) ? "skip" : "conflict";
      } else {
        const state = await parentState(repository, canonicalDirectory, path);
        if (state === "invalid") {
          expected.set(destination, undefined);
          action = "conflict";
        } else if (state === "absent") {
          expected.set(destination, content);
          action = "copy";
        } else {
          try {
            const info = await lstat(destinationPath);
            if (!info.isFile() || info.isSymbolicLink()) {
              expected.set(destination, undefined);
              action = "conflict";
            } else {
              const existing = await readFile(destinationPath);
              expected.set(destination, existing);
              action = existing.equals(content) ? "skip" : "conflict";
            }
          } catch (error: unknown) {
            if (!missing(error)) throw error;
            expected.set(destination, content);
            action = "copy";
          }
        }
      }
      entries.push({ action, source: repositoryPath(repository, sourcePath), destination });
    }
  }

  return entries.some(({ action }) => action === "conflict")
    ? { ok: false, reason: "consolidation_conflict", canonical, sources, entries }
    : { ok: true, canonical, sources, entries };
}

async function ensureParent(repository: string, canonical: string, path: string): Promise<string> {
  let directory = canonical;
  for (const segment of dirname(path).split("/").filter((entry) => entry !== ".")) {
    const candidate = resolve(directory, segment);
    const existing = await containedDirectory(repository, candidate);
    if (existing) {
      directory = existing;
      continue;
    }
    try { await mkdir(candidate); }
    catch (error: unknown) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
    }
    const created = await containedDirectory(repository, candidate);
    if (!created) throw new Error("plan_directory_invalid");
    directory = created;
  }
  return directory;
}

export async function applyConsolidation(repository: string, plan: ConsolidationPlan): Promise<ConsolidationResult> {
  if (!plan.ok) return { ok: false, reason: plan.reason, sources: plan.sources };
  const canonical = await requiredDirectory(repository, plan.canonical);
  const copied: string[] = [];
  const skipped = plan.entries.filter(({ action }) => action === "skip").map(({ destination }) => destination);

  for (const entry of plan.entries) {
    if (entry.action !== "copy") continue;
    const destination = resolve(repository, entry.destination);
    const relation = relative(canonical, destination);
    if (!relation || relation.startsWith("..") || isAbsolute(relation)) throw new Error("plan_directory_invalid");
    const source = resolve(repository, entry.source);
    const sourceParent = await containedDirectory(repository, dirname(source));
    const sourceInfo = await lstat(source);
    if (!sourceParent || !sourceInfo.isFile() || sourceInfo.isSymbolicLink()) throw new Error("plan_directory_invalid");
    const parent = await ensureParent(repository, canonical, relation);
    await writeFile(resolve(parent, basename(relation)), await readFile(source), { flag: "wx" });
    copied.push(entry.destination);
  }
  return { ok: true, copied, skipped, sources: plan.sources };
}
