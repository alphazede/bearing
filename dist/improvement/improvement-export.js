import { constants, link, open, realpath, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, posix, relative, resolve, win32 } from "node:path";
const MAX_ITEMS = 256;
const MAX_TOKEN = 128;
const MAX_TEXT = 4_096;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const DIGEST = /(?:^|[^a-f0-9])[a-f0-9]{64}(?:$|[^a-f0-9])/i;
const ISO_TIMESTAMP = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z\b/;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i;
const LOCAL_IDENTIFIER = /\b(?:run|slice|session|fingerprint|path)(?:id|ref)?[:=_-][A-Za-z0-9][A-Za-z0-9._:-]*\b/i;
const SURFACES = new Set([
    "reasoning-default",
    "review-cadence",
    "test-depth",
    "concurrency-cap",
    "planning-template",
    "skill-guidance",
]);
const TEST_KINDS = new Set([
    "unit",
    "integration",
    "structural",
    "regression",
]);
function record(value) {
    if (typeof value !== "object" || value === null || Array.isArray(value))
        return false;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
        return false;
    return Object.values(Object.getOwnPropertyDescriptors(value))
        .every((descriptor) => Object.hasOwn(descriptor, "value"));
}
function exactKeys(value, required) {
    if (!record(value))
        return false;
    return required.every((key) => Object.hasOwn(value, key))
        && Object.keys(value).every((key) => required.includes(key));
}
function boundedArray(value) {
    return Array.isArray(value) && value.length <= MAX_ITEMS;
}
function safeText(value, max = MAX_TEXT) {
    return typeof value === "string"
        && value.length > 0
        && value.length <= max
        && value === value.trim()
        && !/[\u0000-\u001f\u007f]/.test(value)
        && !DIGEST.test(value)
        && !ISO_TIMESTAMP.test(value)
        && !UUID.test(value)
        && !LOCAL_IDENTIFIER.test(value)
        && !/[\\/]/.test(value);
}
function token(value) {
    return safeText(value, MAX_TOKEN) && TOKEN.test(value);
}
function policyAtom(value) {
    return typeof value === "boolean"
        || (typeof value === "number" && Number.isSafeInteger(value) && Math.abs(value) <= 1_000_000)
        || token(value);
}
function contributionPolicyValue(value) {
    if (!exactKeys(value, ["surface", "target", "from", "to", "verdict"]))
        return false;
    return typeof value.surface === "string"
        && SURFACES.has(value.surface)
        && token(value.target)
        && policyAtom(value.from)
        && policyAtom(value.to)
        && value.from !== value.to
        && value.verdict === "retain";
}
function benchmarkCase(value) {
    if (!exactKeys(value, ["name", "scenario", "expectedOutcome"]))
        return false;
    return token(value.name)
        && safeText(value.scenario)
        && (value.expectedOutcome === "pass" || value.expectedOutcome === "fail");
}
function contributionTestCase(value) {
    if (!exactKeys(value, ["name", "kind", "expectedOutcome"]))
        return false;
    return token(value.name)
        && typeof value.kind === "string"
        && TEST_KINDS.has(value.kind)
        && (value.expectedOutcome === "pass" || value.expectedOutcome === "fail");
}
function ownerWorkflowNote(value) {
    if (!exactKeys(value, ["authoredBy", "note"]))
        return false;
    return value.authoredBy === "owner" && safeText(value.note);
}
/** Refuses any contribution value outside the deliberately small public allowlist. */
export function assertContributionBundle(value) {
    if (!exactKeys(value, [
        "schemaVersion",
        "policyValues",
        "benchmarkCases",
        "testCases",
        "workflowNotes",
    ])
        || value.schemaVersion !== 1
        || !boundedArray(value.policyValues)
        || !value.policyValues.every(contributionPolicyValue)
        || !boundedArray(value.benchmarkCases)
        || !value.benchmarkCases.every(benchmarkCase)
        || !boundedArray(value.testCases)
        || !value.testCases.every(contributionTestCase)
        || !boundedArray(value.workflowNotes)
        || !value.workflowNotes.every(ownerWorkflowNote)) {
        throw new Error("export_shape_invalid");
    }
}
function safeDestination(value) {
    return typeof value === "string"
        && value.length > 0
        && value.length <= 1_024
        && value === value.trim()
        && !/[\u0000-\u001f\u007f*<>\\]/.test(value)
        && !isAbsolute(value)
        && !win32.isAbsolute(value)
        && posix.normalize(value) === value
        && value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}
function contained(root, candidate) {
    const relation = relative(root, candidate);
    return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
}
/** Writes one validated bundle to a new, owner-named file and performs no other I/O. */
export async function exportContributionBundle(input) {
    let serialized;
    try {
        assertContributionBundle(input.bundle);
        serialized = `${JSON.stringify(input.bundle, null, 2)}\n`;
    }
    catch {
        return { ok: false, reason: "export_shape_invalid" };
    }
    if (!safeDestination(input.destination)) {
        return { ok: false, reason: "destination_invalid" };
    }
    let repositoryRoot;
    let destinationParent;
    try {
        repositoryRoot = await realpath(input.repositoryRoot);
        const lexicalDestination = resolve(repositoryRoot, input.destination);
        if (!contained(repositoryRoot, lexicalDestination)) {
            return { ok: false, reason: "destination_invalid" };
        }
        destinationParent = await realpath(dirname(lexicalDestination));
    }
    catch {
        return { ok: false, reason: "export_failed" };
    }
    if (!contained(repositoryRoot, destinationParent)) {
        return { ok: false, reason: "destination_invalid" };
    }
    // Bind every remaining step to the exact directory just verified above.
    // Opening by pathname with O_DIRECTORY | O_NOFOLLOW fails closed (instead of
    // silently following a symlink) if anything replaced destinationParent
    // between the containment check and this call. Once open, the held
    // descriptor is immune to later renames or symlink swaps of that pathname:
    // every subsequent path below is expressed relative to this descriptor via
    // the Linux /proc/self/fd magic-link, so nothing re-resolves the original
    // pathname the way the previous implementation did.
    let directory;
    try {
        directory = await open(destinationParent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    }
    catch {
        return { ok: false, reason: "destination_invalid" };
    }
    try {
        const boundParent = `/proc/self/fd/${directory.fd}`;
        const finalName = basename(input.destination);
        const tempName = `.${finalName}.${process.pid}-${process.hrtime.bigint()}.tmp`;
        const tempPath = `${boundParent}/${tempName}`;
        let file;
        try {
            file = await open(tempPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        }
        catch {
            return { ok: false, reason: "export_failed" };
        }
        try {
            try {
                await file.writeFile(serialized, "utf8");
                await file.sync();
            }
            finally {
                await file.close();
            }
            // link() atomically creates the final name only if it does not already
            // exist (EEXIST otherwise), preserving the original no-overwrite
            // guarantee; rename() would silently replace an existing export.
            await link(tempPath, `${boundParent}/${finalName}`);
            return { ok: true, destination: input.destination };
        }
        catch {
            return { ok: false, reason: "export_failed" };
        }
        finally {
            await unlink(tempPath).catch(() => { });
        }
    }
    finally {
        await directory.close();
    }
}
