import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { lstat, readFile, readlink, realpath } from "node:fs/promises";
import { isAbsolute, posix, relative, resolve } from "node:path";
import { promisify } from "node:util";
const exec = promisify(execFile);
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const MAX_ITEMS = 128;
const MAX_TEXT = 4096;
const SAFE_ID = /^(?:CMD|PROC)-[A-Z0-9][A-Z0-9.-]*$/;
const SLICE = /^###\s+Slice\s+(?<id>[A-Za-z]+\d+|\d+(?:\.\d+)+)\b.*$/gm;
const MANIFEST = /^###\s+(?<id>[A-Za-z]+\d+|\d+(?:\.\d+)+)\s+execution manifest\s*$/gmi;
function boundedText(value, max = MAX_TEXT) {
    return value.length > 0 && value.length <= max && value === value.trim() && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
}
function safePath(value) {
    return boundedText(value) && !isAbsolute(value) && posix.normalize(value) === value && !/[*<>\\]/.test(value) && value.split("/").every((part) => part && part !== "." && part !== "..");
}
function field(section, name) {
    const label = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`^\\*\\*${label}\\.\\*\\*\\s*(.+)$`, "mi").exec(section)?.[1]?.trim();
}
function sections(content, pattern) {
    const matches = [...content.matchAll(pattern)];
    const result = new Map();
    for (let index = 0; index < matches.length; index += 1) {
        const id = matches[index].groups?.id;
        if (!id || result.has(id))
            return undefined;
        result.set(id, content.slice(matches[index].index ?? 0, matches[index + 1]?.index ?? content.length));
    }
    return result;
}
async function source(root, path) {
    if (!safePath(path))
        return undefined;
    const candidate = resolve(root, path);
    const relation = relative(root, candidate);
    if (!relation || relation.startsWith("..") || isAbsolute(relation))
        return undefined;
    try {
        const canonical = await realpath(candidate);
        const canonicalRelation = relative(root, canonical);
        const stat = await lstat(candidate);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_SOURCE_BYTES || !canonicalRelation || canonicalRelation.startsWith("..") || isAbsolute(canonicalRelation))
            return undefined;
        const content = await readFile(canonical, "utf8");
        return Buffer.byteLength(content) <= MAX_SOURCE_BYTES ? content : undefined;
    }
    catch {
        return undefined;
    }
}
function commandIds(value) {
    return [...new Set([...value.matchAll(/\b(?:CMD|PROC)-[A-Z0-9][A-Z0-9.-]*\b/gi)].map((match) => match[0].toUpperCase()))];
}
function acceptance(plan, requirementIds) {
    for (const id of requirementIds) {
        const line = plan.split(/\r?\n/).find((candidate) => new RegExp(`\\b${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(candidate));
        if (line) {
            const value = line.replace(/^\s*[-*]\s*/, "").replace(/\*\*/g, "").trim();
            if (boundedText(value, 512))
                return value;
        }
    }
    return requirementIds[0];
}
function parseContract(plan, implementation, seit, currentSlice) {
    const sliceSections = sections(implementation, SLICE);
    const manifests = sections(implementation, MANIFEST);
    if (!sliceSections?.size || !manifests || sliceSections.size !== manifests.size || sliceSections.size > MAX_ITEMS)
        return undefined;
    if (currentSlice && (!sliceSections.has(currentSlice) || !manifests.has(currentSlice)))
        return undefined;
    const selectedSlices = currentSlice ? new Map([[currentSlice, sliceSections.get(currentSlice)]]) : sliceSections;
    const allowedPaths = [];
    const commands = [];
    const requirements = [];
    for (const [id, slice] of selectedSlices) {
        const manifest = manifests.get(id);
        const goal = field(slice, "Goal");
        const requirementField = field(slice, "Requirement IDs");
        const writeSet = manifest && field(manifest, "Write set");
        const commandField = manifest && field(manifest, "Command IDs");
        if (!goal || !requirementField || !writeSet || !commandField || !boundedText(goal, 512))
            return undefined;
        const paths = [...writeSet.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
        const noWrites = /\b(?:none|no writes?(?: required)?)\b/i.test(writeSet);
        if (noWrites && paths.length || !noWrites && (!/\bonly\b/i.test(writeSet) || !paths.length) || paths.some((path) => !safePath(path)) || new Set(paths).size !== paths.length)
            return undefined;
        const ids = commandIds(commandField);
        if (!ids.length || ids.some((command) => !SAFE_ID.test(command) || !new RegExp(`\\b${command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(seit)))
            return undefined;
        allowedPaths.push(...paths);
        commands.push(...ids);
        requirements.push(...[...requirementField.matchAll(/\b(?:AC|RISK)-[A-Z0-9][A-Z0-9.-]*\b/gi)].map((match) => match[0].toUpperCase()));
    }
    const uniquePaths = [...new Set(allowedPaths)].sort();
    const uniqueCommands = [...new Set(commands)].sort();
    if (!uniquePaths.length || uniquePaths.length > MAX_ITEMS || uniqueCommands.length > MAX_ITEMS)
        return undefined;
    const criterion = acceptance(plan, requirements);
    if (!criterion)
        return undefined;
    return {
        currentAcceptanceCriterion: criterion,
        allowedPaths: uniquePaths,
        requiredEvidence: uniqueCommands.map((id) => `${id}: passing command evidence`),
        seitCommandIds: uniqueCommands,
        remainingSlices: [...selectedSlices.keys()],
    };
}
async function fingerprint(root, path) {
    const candidate = resolve(root, path);
    try {
        const stat = await lstat(candidate);
        const hash = createHash("sha256");
        if (stat.isSymbolicLink())
            hash.update(`link:${await readlink(candidate)}`);
        else if (stat.isFile())
            await new Promise((resolveStream, rejectStream) => {
                const stream = createReadStream(candidate);
                stream.on("data", (chunk) => hash.update(chunk));
                stream.on("end", resolveStream);
                stream.on("error", rejectStream);
            });
        else
            hash.update(`type:${stat.mode}`);
        return `${stat.mode}:${stat.size}:${hash.digest("hex")}`;
    }
    catch {
        return "missing";
    }
}
async function gitHead(root) {
    try {
        const { stdout } = await exec("git", ["rev-parse", "--verify", "HEAD"], { cwd: root, encoding: "utf8" });
        const value = stdout.trim();
        return /^[0-9a-f]{40,64}$/i.test(value) ? value : undefined;
    }
    catch (error) {
        const failure = error;
        return failure.code === 128 && /needed a single revision|unknown revision|ambiguous argument 'HEAD'/i.test(failure.stderr ?? "") ? null : undefined;
    }
}
async function committedPaths(root, beforeHead, afterHead) {
    if (beforeHead === afterHead)
        return new Set();
    if (beforeHead !== null && afterHead === null)
        return undefined;
    try {
        const args = beforeHead === null
            ? ["ls-tree", "-r", "--name-only", "-z", afterHead]
            : ["diff", "--no-renames", "--name-only", "-z", beforeHead, afterHead];
        const { stdout } = await exec("git", args, { cwd: root, encoding: "buffer", maxBuffer: 16 * 1024 * 1024 });
        const paths = Buffer.from(stdout).toString("utf8").split("\0").filter(Boolean);
        return paths.every(safePath) ? new Set(paths) : undefined;
    }
    catch {
        return undefined;
    }
}
/** Snapshot Git-visible dirty paths and net committed paths from an optional baseline HEAD. */
export async function snapshotGitState(root, beforeHead) {
    try {
        const canonicalRoot = await realpath(root);
        const { stdout: top } = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: canonicalRoot, encoding: "utf8" });
        if (await realpath(top.trim()) !== canonicalRoot)
            return undefined;
        const head = await gitHead(canonicalRoot);
        if (head === undefined)
            return undefined;
        const committed = beforeHead === undefined ? new Set() : await committedPaths(canonicalRoot, beforeHead, head);
        if (!committed)
            return undefined;
        const { stdout } = await exec("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: canonicalRoot, encoding: "buffer", maxBuffer: 16 * 1024 * 1024 });
        const records = Buffer.from(stdout).toString("utf8").split("\0").filter(Boolean);
        const paths = [];
        for (let index = 0; index < records.length; index += 1) {
            const record = records[index];
            if (record.length < 4)
                return undefined;
            const status = record.slice(0, 2);
            const path = record.slice(3);
            if (!safePath(path))
                return undefined;
            if (!(status === "??" && path.startsWith(".bearing/")))
                paths.push(path);
            if (/[RC]/.test(status)) {
                const prior = records[++index];
                if (!prior || !safePath(prior))
                    return undefined;
                paths.push(prior);
            }
        }
        const unique = [...new Set([...paths, ...committed])].sort();
        return {
            head,
            paths: new Map(await Promise.all(unique.map(async (path) => [path, await fingerprint(canonicalRoot, path)]))),
            committedPaths: committed,
        };
    }
    catch {
        return undefined;
    }
}
export async function createFocusContext(input) {
    if (!safePath(input.planDirectory) || !boundedText(input.objective))
        return undefined;
    const planPath = posix.join(input.planDirectory, "plan-spec.md");
    const implementationPath = posix.join(input.planDirectory, "implementation.md");
    const seitPath = posix.join(input.planDirectory, "seit.md");
    const [plan, implementation, seit, snapshot] = await Promise.all([
        source(input.root, planPath), source(input.root, implementationPath), source(input.root, seitPath), snapshotGitState(input.root),
    ]);
    if (!plan || !implementation || !seit || !snapshot)
        return undefined;
    const contract = parseContract(plan, implementation, seit, input.currentSlice);
    const blocker = input.currentBlocker ?? "none";
    const gate = input.gateFailureFingerprint ?? "none";
    if (!contract || !boundedText(blocker) || !boundedText(gate, 512))
        return undefined;
    const reviewPath = posix.join(input.planDirectory, "review.html");
    return {
        envelope: {
            version: 1,
            role: input.role,
            immutableObjective: input.objective,
            ...contract,
            allowedPaths: [...new Set([...contract.allowedPaths, reviewPath])].sort(),
            currentBlocker: blocker,
            gateFailureFingerprint: gate,
            prohibition: "Do not perform unrelated work.",
        },
        reviewPath,
        beforeHead: snapshot.head,
        before: snapshot.paths,
    };
}
function validEvidence(required, evidence) {
    if (evidence.length !== required.length || evidence.length > MAX_ITEMS)
        return false;
    const seen = new Set();
    for (const item of evidence) {
        if (!item || typeof item !== "object" || !SAFE_ID.test(item.commandId) || seen.has(item.commandId) || item.status !== "passed" || !boundedText(item.summary, 512))
            return false;
        seen.add(item.commandId);
    }
    return required.every((id) => seen.has(id));
}
export async function validateFocusCompletion(context, root, artifacts, evidence) {
    const after = await snapshotGitState(root, context.beforeHead);
    if (!after)
        return { ok: false, reason: "git_state" };
    if (after.head !== context.beforeHead && after.committedPaths.size === 0)
        return { ok: false, reason: "git_state" };
    const changed = [...new Set([...context.before.keys(), ...after.paths.keys(), ...after.committedPaths])]
        .filter((path) => after.committedPaths.has(path) || context.before.get(path) !== after.paths.get(path))
        .sort();
    const allowed = new Set([...context.envelope.allowedPaths, context.reviewPath]);
    if (changed.some((path) => !allowed.has(path)))
        return { ok: false, reason: "path_outside_write_set" };
    if (changed.some((path) => !artifacts.includes(path)))
        return { ok: false, reason: "artifact_missing" };
    if (!validEvidence(context.envelope.seitCommandIds, evidence))
        return { ok: false, reason: "evidence_invalid" };
    if (!changed.some((path) => path !== context.reviewPath))
        return { ok: false, reason: "no_product_change" };
    return { ok: true, changedPaths: changed };
}
