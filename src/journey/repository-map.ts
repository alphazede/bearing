import { lstat, mkdir, readdir, realpath, writeFile } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { planDirectoryValid } from "./plan-directory.js";

const MAX_DEPTH = 4;
const MAX_PATHS = 200;
const OMITTED = new Set([".git", ".bearing", "node_modules", "vendor", "dist", "build", "out", "coverage", ".next", ".cache"]);
const SENSITIVE = /(^|[._-])(env|secret|credential|token|password|private)([._-]|$)/i;

export function inside(root: string, path: string): boolean {
  const relation = relative(root, path);
  return relation !== "" && !relation.startsWith("..") && !isAbsolute(relation);
}

export async function containedDirectory(root: string, directory: string): Promise<string | undefined> {
  try {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) return undefined;
    const canonical = await realpath(directory);
    return inside(root, canonical) ? canonical : undefined;
  } catch { return undefined; }
}

async function artifactSafe(root: string, artifact: string, allowMissing = false): Promise<boolean> {
  try {
    const info = await lstat(artifact);
    if (!info.isFile() || info.isSymbolicLink()) return false;
    return inside(root, await realpath(artifact));
  } catch (error: unknown) {
    return allowMissing && error instanceof Error && "code" in error && error.code === "ENOENT";
  }
}

function slug(value: string): string {
  const normalized = value.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-").replaceAll(/^-+|-+$/g, "");
  return (normalized || "plan").slice(0, 72).replaceAll(/-+$/g, "") || "plan";
}

export async function inventory(root: string): Promise<readonly string[]> {
  const paths: string[] = [];
  const visit = async (directory: string, prefix: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH || paths.length >= MAX_PATHS) return;
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (paths.length >= MAX_PATHS || OMITTED.has(entry.name) || SENSITIVE.test(entry.name) || entry.isSymbolicLink()) continue;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      paths.push(entry.isDirectory() ? `${path}/` : path);
      if (entry.isDirectory()) await visit(resolve(directory, entry.name), path, depth + 1);
    }
  };
  await visit(root, "", 0);
  return paths;
}

function mapText(repository: string, paths: readonly string[]): string {
  return [
    "---",
    "type: repository-map",
    `repository: ${basename(repository)}`,
    "scope: bounded-path-inventory",
    "---",
    "",
    "# Repository map",
    "",
    "This is a bounded path inventory generated for this journey. It contains no file contents; verify live state only when this map is insufficient.",
    "",
    "## Paths",
    ...paths.map((path) => `- \`${path}\``),
    ...(paths.length === MAX_PATHS ? ["- _(inventory capped at 200 paths)_"] : []),
    "",
  ].join("\n");
}

export interface BearingsWorkspace {
  readonly directory: string;
  readonly artifacts: readonly string[];
  readonly resumed: boolean;
}

/** Creates or resumes one confirmed plan workspace and its reusable bounded map. */
export async function setBearingsWorkspace(repository: string, goal: string, existingDirectory?: string): Promise<BearingsWorkspace | undefined> {
  if (!existingDirectory || !planDirectoryValid(existingDirectory)) return undefined;
  const plans = resolve(repository, "docs/plans");
  await mkdir(plans, { recursive: true });
  if (!inside(repository, await realpath(plans))) return undefined;

  let directory = plans;
  let resumed = true;
  for (const segment of existingDirectory.slice("docs/plans/".length).split("/")) {
    const candidate = resolve(directory, segment);
    const existing = await containedDirectory(repository, candidate);
    if (existing) {
      directory = existing;
      continue;
    }
    resumed = false;
    try { await mkdir(candidate); }
    catch (error: unknown) { if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error; }
    const created = await containedDirectory(repository, candidate);
    if (!created) return undefined;
    directory = created;
  }
  const relativeDirectory = relative(repository, directory).replaceAll("\\", "/");
  const planSpec = resolve(directory, "plan-spec.md");
  const canonicalDirectory = await containedDirectory(repository, directory);
  if (!canonicalDirectory || !await artifactSafe(canonicalDirectory, planSpec, true)) return undefined;
  const prompts = resolve(directory, "prompts");
  try { await mkdir(prompts); }
  catch (error: unknown) { if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error; }
  if (!canonicalDirectory || !await containedDirectory(canonicalDirectory, prompts)) return undefined;
  const map = resolve(prompts, "repository-map.md");
  if (!await artifactSafe(canonicalDirectory, map, true)) return undefined;
  try {
    await writeFile(planSpec, `---\ntype: plan-spec\nname: ${slug(goal)}\nstatus: pre-grill-draft\ndate: ${new Date().toISOString().slice(0, 10)}\napplies_to: ${slug(basename(repository))}\n---\n`, { flag: "wx" });
  } catch (error: unknown) { if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error; }
  try { await writeFile(map, mapText(repository, await inventory(repository)), { flag: "wx" }); }
  catch (error: unknown) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
  }
  if (!await artifactSafe(canonicalDirectory, planSpec) || !await artifactSafe(canonicalDirectory, map)) return undefined;
  return { directory: relativeDirectory, artifacts: [`${relativeDirectory}/prompts/repository-map.md`, `${relativeDirectory}/plan-spec.md`], resumed };
}
