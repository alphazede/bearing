import { accessSync, constants, readFileSync, realpathSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Resolves an executable name to its canonical path using absolute `PATH`
 * entries only. Shared by repository choice (picker availability) and
 * repository bootstrap (agent-directory refusal); the process runner keeps its
 * own stricter spawn guard, which additionally rejects binaries inside the
 * selected repository.
 */
export function resolveExecutable(executable: string): string | undefined {
  for (const directory of (process.env.PATH ?? "").split(delimiter).filter(isAbsolute)) {
    try {
      const candidate = join(directory, executable);
      accessSync(candidate, constants.X_OK);
      return realpathSync(candidate);
    } catch { /* try next absolute PATH entry */ }
  }
  return undefined;
}

const CANONICAL_BEARING_PACKAGE_NAME = "@alphazede/bearing";

export interface BearingCliIdentity {
  readonly path: string;
  readonly version: string;
}

type BearingCliResolutionReason =
  | "path_unavailable"
  | "path_provenance_unverified"
  | "runtime_version_mismatch"
  | "path_preferred";

export interface BearingCliResolution {
  readonly source: "bundled" | "path";
  readonly path: string;
  readonly version: string;
  readonly reason: BearingCliResolutionReason;
  readonly bundled: BearingCliIdentity;
  readonly pathCandidate?: BearingCliIdentity;
}

function readPackageIdentity(packageJsonPath: string): { readonly name: string; readonly version: string } | undefined {
  try {
    const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { readonly name?: unknown; readonly version?: unknown };
    if (typeof parsed.name !== "string" || typeof parsed.version !== "string") return undefined;
    return { name: parsed.name, version: parsed.version };
  } catch {
    return undefined;
  }
}

const SEMVER_REGEX = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/;

interface SemVer {
  readonly major: string;
  readonly minor: string;
  readonly patch: string;
  readonly prerelease: readonly string[] | undefined;
}

function isValidNumericIdentifier(s: string): boolean {
  // A numeric identifier is "0" or a sequence starting with 1-9 (no leading zero).
  return s === "0" || /^[1-9]\d*$/.test(s);
}

function isValidPrereleaseIdentifier(s: string): boolean {
  if (s.length === 0) return false;
  if (/^[0-9]+$/.test(s)) {
    // Purely numeric: must satisfy numeric-identifier rules (no leading zero except bare 0).
    return isValidNumericIdentifier(s);
  }
  // Alphanumeric (contains non-digit): only allowed chars; leading zeros on digit parts are OK.
  return /^[0-9A-Za-z-]+$/.test(s);
}

function isValidBuildIdentifier(s: string): boolean {
  // Build metadata identifiers: [0-9A-Za-z-]+ ; leading zeros allowed even for digit sequences.
  return s.length > 0 && /^[0-9A-Za-z-]+$/.test(s);
}

function parseSemver(version: string): SemVer | undefined {
  if (typeof version !== "string") return undefined;
  const match = SEMVER_REGEX.exec(version);
  if (!match) return undefined;
  const majorStr = match[1];
  const minorStr = match[2];
  const patchStr = match[3];
  const preRaw = match[4];
  const buildRaw = match[5];

  if (!isValidNumericIdentifier(majorStr) || !isValidNumericIdentifier(minorStr) || !isValidNumericIdentifier(patchStr)) {
    return undefined;
  }

  let prerelease: readonly string[] | undefined = undefined;
  if (preRaw !== undefined) {
    if (preRaw.length === 0 || preRaw.startsWith(".") || preRaw.endsWith(".")) return undefined;
    const parts = preRaw.split(".");
    if (parts.some((p) => p.length === 0)) return undefined;
    for (const p of parts) {
      if (!isValidPrereleaseIdentifier(p)) return undefined;
    }
    prerelease = parts;
  }

  if (buildRaw !== undefined) {
    if (buildRaw.length === 0 || buildRaw.startsWith(".") || buildRaw.endsWith(".")) return undefined;
    const parts = buildRaw.split(".");
    if (parts.some((p) => p.length === 0 || !isValidBuildIdentifier(p))) return undefined;
    // Valid build metadata is parsed and stripped; it does not affect precedence (§10).
  }

  return {
    major: majorStr,
    minor: minorStr,
    patch: patchStr,
    prerelease,
  };
}

/**
 * Compare two prerelease identifier lists per SemVer 2.0.0 §11:
 * -1 = a < b, 0 = a === b, 1 = a > b.
 */
function comparePrereleaseIdentifiers(a: readonly string[], b: readonly string[]): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const aNum = /^\d+$/.test(a[i]);
    const bNum = /^\d+$/.test(b[i]);
    if (aNum && bNum) {
      // Compare as unsigned-integer digit strings without converting to Number, so
      // precision is never lost beyond Number.MAX_SAFE_INTEGER: a longer digit
      // string is always the larger unsigned integer, and equal-length digit
      // strings compare correctly by ASCII/codepoint order.
      if (a[i].length !== b[i].length) return a[i].length < b[i].length ? -1 : 1;
      if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
    } else if (aNum !== bNum) {
      // Numeric identifiers always have lower precedence than non-numeric.
      return aNum ? -1 : 1;
    } else {
      // Both non-numeric: compare lexically (ASCII).
      if (a[i] < b[i]) return -1;
      if (a[i] > b[i]) return 1;
    }
  }
  // All shared identifiers equal; fewer identifiers = lower precedence.
  if (a.length < b.length) return -1;
  if (a.length > b.length) return 1;
  return 0;
}

function compareNumericIdentifiers(a: string, b: string): number {
  // Compare numeric identifiers by digit-string length then lexical order.
  // Never use Number, parseInt, or BigInt for magnitude. Same rule as prerelease numeric ids.
  if (a.length !== b.length) return a.length < b.length ? -1 : 1;
  if (a !== b) return a < b ? -1 : 1;
  return 0;
}

/**
 * Full SemVer 2.0.0 §11 precedence. -1 if a < b, 0 equal (build metadata differences yield 0),
 * 1 if a > b. Core and numeric prerelease use length-then-lexical; build metadata ignored.
 */
function compareSemver(a: SemVer, b: SemVer): number {
  let r = compareNumericIdentifiers(a.major, b.major);
  if (r !== 0) return r;
  r = compareNumericIdentifiers(a.minor, b.minor);
  if (r !== 0) return r;
  r = compareNumericIdentifiers(a.patch, b.patch);
  if (r !== 0) return r;

  const aPre = a.prerelease;
  const bPre = b.prerelease;
  if (aPre === undefined && bPre === undefined) return 0;
  if (aPre === undefined) return 1; // stable outranks prerelease
  if (bPre === undefined) return -1;
  return comparePrereleaseIdentifiers(aPre, bPre);
}

/** Permissive, non-throwing SemVer comparison per 2.0.0; invalid candidate reads as older (fail-closed policy unchanged). */
function isOlderVersion(candidate: string, baseline: string): boolean {
  const c = parseSemver(candidate);
  if (!c) return true;
  const b = parseSemver(baseline);
  if (!b) return true;

  return compareSemver(c, b) < 0;
}

/** Identifies this running module's own CLI entry and package version -- the "bundled" release. */
function bundledCliIdentity(): BearingCliIdentity {
  const selfUrl = import.meta.url;
  const extension = selfUrl.endsWith(".ts") ? ".ts" : ".js";
  const cliPath = fileURLToPath(new URL(`../cli${extension}`, selfUrl));
  const packageJsonPath = fileURLToPath(new URL("../../package.json", selfUrl));
  const identity = readPackageIdentity(packageJsonPath);
  return { path: cliPath, version: identity?.version ?? "0.0.0" };
}

/**
 * Resolves which Bearing CLI the guided skill and headless CLI should run:
 * the release bundled with the active plugin, or a `bearing` executable on
 * `PATH`. Prefers `PATH` only once its canonical provenance (the
 * `@alphazede/bearing` package identity, read statically from the
 * `package.json` shipped next to it -- never by executing the candidate) and
 * version (>= bundled) are both proven; otherwise it fails closed to the
 * verified bundled CLI and reports why. See issue 71: a stale PATH install
 * must never silently shadow a newer bundled release.
 */
export function resolveBearingCli(deps: {
  readonly bundled?: BearingCliIdentity;
  readonly resolvePath?: (executable: string) => string | undefined;
} = {}): BearingCliResolution {
  const bundled = deps.bundled ?? bundledCliIdentity();
  const resolvePath = deps.resolvePath ?? resolveExecutable;
  const pathCliPath = resolvePath("bearing");
  if (!pathCliPath) {
    return { source: "bundled", path: bundled.path, version: bundled.version, reason: "path_unavailable", bundled };
  }
  // Real npm layout mirrors this repository's own: `<pkgRoot>/dist/cli.js` next to `<pkgRoot>/package.json`.
  const packageJsonPath = join(dirname(dirname(pathCliPath)), "package.json");
  const identity = readPackageIdentity(packageJsonPath);
  if (!identity || identity.name !== CANONICAL_BEARING_PACKAGE_NAME) {
    return {
      source: "bundled",
      path: bundled.path,
      version: bundled.version,
      reason: "path_provenance_unverified",
      bundled,
      pathCandidate: { path: pathCliPath, version: identity?.version ?? "unknown" },
    };
  }
  const pathCandidate: BearingCliIdentity = { path: pathCliPath, version: identity.version };
  if (isOlderVersion(pathCandidate.version, bundled.version)) {
    return { source: "bundled", path: bundled.path, version: bundled.version, reason: "runtime_version_mismatch", bundled, pathCandidate };
  }
  return { source: "path", path: pathCandidate.path, version: pathCandidate.version, reason: "path_preferred", bundled, pathCandidate };
}
