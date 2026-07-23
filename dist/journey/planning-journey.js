import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile, readdir, realpath } from "node:fs/promises";
import { isAbsolute, posix, relative, resolve } from "node:path";
import { BUILTIN_ROUTES, createAgentAdapter } from "../adapters/adapters.js";
import { createFocusContext, validateFocusCompletion } from "./focus-mode.js";
import { setBearingsWorkspace } from "./repository-map.js";
const STAGE_SKILLS = {
    "set-bearings": ["set-bearings"],
    "gather-supplies": ["gather-supplies"],
    "map-route": ["map-the-route"],
    "draft-implementation": ["map-the-route"],
    "execute-explorer": ["explorer", "crewmate", "surveyor"],
    "execute-expedition": ["navigator", "explorer", "crewmate", "surveyor"],
    review: ["surveyor"],
};
const STAGE_BOUNDARY = {
    "set-bearings": "Create or resume only the plan directory and plan-spec.md stub. Bearing may retain a bounded repository inventory as internal runtime evidence, but plan-local prompt persistence is not required. Do not grill, design, draft implementation.md, or implement the work.",
    "gather-supplies": "Use the complete owner Q&A and update only the validated plan specification. Do not run design, draft implementation.md, or implement the work. Return an action receipt whose artifacts include the validated plan-spec.md path.",
    "map-route": "Use the design substep of Map the Route. Before writing any design artifact, stop at its normal owner lens-approval question when lens approval is not already recorded in the prior owner Q&A. After approval, produce valid complete or amended design.md and seit.md, including stable DES/CONTRACT IDs, Use Cases and Communication Flows, Interface Option Check, OOPDSA Implementation Design, and the prospective SEIT Traceability Matrix. Bearing generates review.html deterministically from the current Markdown sources; do not write or summarize review.html. Stop at the design-and-SEIT validation checkpoint. Do not write implementation.md or execute implementation in this substep. A successful action receipt must include design.md and seit.md in the validated plan directory.",
    "draft-implementation": "Continue the implementation-drafting substep of Map the Route after the validated design and SEIT checkpoint. Draft implementation.md without executing any slice. Keep each slice reference-only with Goal, Requirement IDs, Design IDs, SEIT proof rows, Type, Design lenses, Implementation role, Agent model route, Agent reasoning level, Ponytail mode, and Review path. Requirement, design, and SEIT IDs must exist in their owning documents and each slice's referenced SEIT rows must map its requirement and design IDs. Ponytail mode must be exactly the standalone lowercase value `full` or `off`. Follow every slice with a matching `### <slice-id> execution manifest` containing Write set, Command IDs, Stop condition, and Human decision. Close each write set with `only` and exact backticked paths, or explicitly declare no writes. Command IDs must be defined in seit.md and mapped by the slice's SEIT proof rows. Declare contiguous Wave 1 through Wave N dependencies when there is more than one slice. Do not restate acceptance, design contracts, test cases, commands, evidence, or execution packet prose. Preserve per-slice assignments for execution; do not replace them with onboarding settings. The Review path must use the harness-native reviewer when available or the Surveyor fallback when unavailable. Bearing generates review.html deterministically from plan-spec.md, design.md, seit.md, and implementation.md; do not write or summarize it. A successful action receipt must include implementation.md.",
    "execute-explorer": "Execute the approved implementation plan with Explorer and honor each recorded slice model route, reasoning level, Ponytail mode, and review cadence. Do not overwrite slice assignments with onboarding settings. After implementation and validation, replace the one Bearing-owned `<section id=\"bearing-final-qa\" data-status=\"pending\">` baseline with exactly one `<section id=\"bearing-final-qa\" data-status=\"complete\">` containing non-empty `Planned versus actual: <evidence>` and `Validation evidence: <evidence>` text. Put each labeled value in its own attribute-free `<p>` and use plain text only: no nested HTML, markup, `<`, or `>` in either evidence value. Preserve every current embedded planning source and canonical source link. The action receipt must include review.html and every actual changed artifact. Return only paths that actually exist.",
    "execute-expedition": "Execute the approved implementation plan with Expedition and honor each recorded slice model route, reasoning level, Ponytail mode, and review cadence. Do not overwrite slice assignments with onboarding settings. After implementation and validation, replace the one Bearing-owned `<section id=\"bearing-final-qa\" data-status=\"pending\">` baseline with exactly one `<section id=\"bearing-final-qa\" data-status=\"complete\">` containing non-empty `Planned versus actual: <evidence>` and `Validation evidence: <evidence>` text. Put each labeled value in its own attribute-free `<p>` and use plain text only: no nested HTML, markup, `<`, or `>` in either evidence value. Preserve every current embedded planning source and canonical source link. The action receipt must include review.html and every actual changed artifact. Return only paths that actually exist.",
    review: "Perform a read-only review of the integrated uncommitted work. Do not modify files. Return existing evidence paths relevant to the review.",
};
function nextStage(stage) { return stage === "set-bearings" ? "gather-supplies" : stage === "gather-supplies" ? "map-route" : stage === "map-route" ? "draft-implementation" : stage === "draft-implementation" ? "execute" : "review"; }
const MAX_TEXT = 4096;
const MAX_QA = 64;
const MAX_GATHER_QUESTIONS = 3;
const MAX_ARTIFACTS = 32;
const MAX_ENVELOPE_BYTES = 512 * 1024;
const MAX_ESTIMATE_BASIS = 280;
const MAX_ACTIVITY_TRAIL = 20;
const SAFE_ACTIVITY_VALUE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const SECRET_ACTIVITY = /(?:\b(?:api[_ -]?key|secret|token|password|authorization)\s*[=:]\s*|\bBearer\s+|\bsk-[A-Za-z0-9_-]{8,}|\bAKIA[A-Z0-9]{16})[^\s,;]*/i;
function text(value, max = MAX_TEXT) {
    return typeof value === "string" && value.length > 0 && value.length <= max && value === value.trim() && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
}
function pathText(value) { return text(value) && !/[\\\r\n\t]/.test(value); }
function sameSelection(left, right) {
    return left.provider === right.provider && left.model === right.model && left.reasoning === right.reasoning;
}
async function containedPath(root, value, directoryOnly = false) {
    if (!pathText(value) || value === "." || isAbsolute(value) || posix.normalize(value) !== value)
        return undefined;
    const candidate = resolve(root, value);
    const lexical = relative(root, candidate);
    if (!lexical || lexical.startsWith("..") || isAbsolute(lexical))
        return undefined;
    try {
        const canonical = await realpath(candidate);
        const relation = relative(root, canonical);
        if (!relation || relation.startsWith("..") || isAbsolute(relation))
            return undefined;
        if (directoryOnly && !(await lstat(canonical)).isDirectory())
            return undefined;
        return value;
    }
    catch {
        return undefined;
    }
}
function validRequest(request) {
    if (!isAbsolute(request.repositoryPath) || !/^[A-Za-z0-9_-]{1,128}$/.test(request.runId) || !text(request.workGoal))
        return false;
    if (!(request.stage in STAGE_SKILLS) || !Array.isArray(request.priorOwnerQa) || request.priorOwnerQa.length > MAX_QA)
        return false;
    return (request.gatherMode === undefined || request.stage === "gather-supplies") &&
        (request.providerSessionId === undefined || /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(request.providerSessionId)) &&
        (request.reviewPrompt === undefined || text(request.reviewPrompt)) &&
        (request.gateFailureFingerprint === undefined || text(request.gateFailureFingerprint, 512)) &&
        request.priorOwnerQa.every((entry) => typeof entry === "object" && entry !== null && text(entry.question) && text(entry.answer));
}
const MAX_PACKAGED_SKILL_BYTES = 64 * 1024;
async function packagedSkills(stage) {
    const sources = await Promise.all(STAGE_SKILLS[stage].map(async (name) => {
        const source = await readFile(new URL(`../../skills/${name}/SKILL.md`, import.meta.url), "utf8");
        if (Buffer.byteLength(source) > MAX_PACKAGED_SKILL_BYTES || /\u0000/.test(source) || !new RegExp(`^---\\r?\\nname: ${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\r?\\ndescription: [^\\r\\n]+\\r?\\n---(?:\\r?\\n|$)`).test(source))
            throw new Error("packaged skill invalid");
        return `### ${name}\n${source}`;
    }));
    return ["Packaged Bearing skills (authoritative workflow instructions for this stage):", ...sources].join("\n\n");
}
function prompt(request, planDirectory, skillInstructions, focus) {
    const gatheringQuestions = request.stage === "gather-supplies" && request.gatherMode === "questions";
    const availableQuestions = Math.min(MAX_GATHER_QUESTIONS, Math.max(0, MAX_QA - request.priorOwnerQa.length));
    const grilling = gatheringQuestions
        ? ` Inspect the repository once and return at most ${availableQuestions} unresolved owner questions. Ask only when the answer materially changes scope, architecture, security, authority, or acceptance. Lead each question with **Recommendation:**, then give concise evidence, 2-3 viable options with material tradeoffs, the affected plan-spec section, and the safe default if unanswered; ask the owner to select explicitly. A recommendation is advice, never approval. State safe defaults as assumptions instead of questions when no owner choice is required. Return an empty array when no material owner decision remains.`
        : request.stage === "gather-supplies"
            ? " All grilling questions are answered. Apply the complete owner Q&A without asking another question; record reasonable assumptions or blockers in the plan specification."
            : " Ask one owner question only when a decision blocks honest progress.";
    const boundary = gatheringQuestions ? "Read and inspect only. Do not create or modify files during question discovery." : STAGE_BOUNDARY[request.stage];
    const reviewCadence = request.stage === "execute-explorer" || request.stage === "execute-expedition" ? ["Read the prior owner Q&A for the recorded Review cadence (each slice, each phase, or end) and enforce that cadence during execution. Use the harness-native reviewer when available and the read-only Surveyor fallback only when no native reviewer is available."] : [];
    const cleanupSetting = [...request.priorOwnerQa].reverse().find((entry) => entry.question === "Cleanup merged worktrees")?.answer ?? "on";
    const cleanupPolicy = request.stage === "execute-explorer" || request.stage === "execute-expedition"
        ? [cleanupSetting === "off"
                ? "Preserve every temporary worktree and branch; the owner disabled automatic cleanup."
                : `Cleanup merged worktrees is on. Merge only through the approved integration or phase gate. Before removing a temporary worktree, prove that it is clean, its branch commit is merged into the integration branch, and no active review, retry, or recovery reference needs it. ${request.stage === "execute-explorer" ? "Clean eligible worktrees after each completed phase." : "Keep parallel lanes until the entire phase is integrated, then clean eligible worktrees."} Delete only the corresponding proven-merged temporary branch. Never force-remove a worktree or branch. Preserve every dirty, unmerged, failed, or blocked lane and report its path and branch with a Resume or Resolve next action.`]
        : [];
    const nextActionStage = nextStage(request.stage);
    const selectedRoute = BUILTIN_ROUTES.find((route) => route.provider === request.selection.provider && (route.model === "*" || route.model === request.selection.model));
    const routeCatalog = BUILTIN_ROUTES.map((route) => {
        const model = route === selectedRoute && request.selection.model !== "*" ? `${route.provider} ${request.selection.model}` : route.model === "*" ? `${route.provider} agent default` : route.id;
        return `${model} [${route.reasoningLevels.join(", ")}]`;
    }).join("; ");
    const estimateGuidance = request.stage === "gather-supplies" && request.gatherMode === "apply"
        ? "Estimate the entire upcoming Map the Route phase, including design.md, seit.md, baseline review.html, implementation.md, final review generation, validation, and all required agent round trips. Do not estimate from repository inspection size alone."
        : request.stage === "map-route"
            ? "When asking a blocking design question, estimate all remaining Map the Route work after the answer, including design, SEIT, review generation, implementation drafting, validation, and required agent round trips."
            : "Estimate the complete next phase, including required artifacts, validation, and agent round trips—not only repository inspection.";
    return [
        "You are a bounded Bearing journey agent. Work only inside the supplied repository and existing authority.",
        `Stage: ${request.stage}. Apply the embedded Bearing skill instructions for this stage.${grilling}`,
        skillInstructions,
        `Stage boundary: ${boundary}`,
        `Work goal: ${JSON.stringify(request.workGoal)}`,
        `The onboarding selection ${JSON.stringify(request.selection)} governs this top-level planning agent and the Explorer/Navigator session. Keep it for planning, design, and review. Implementation.md may record task-appropriate supported model routes and reasoning levels per coding slice; execution must honor those recorded assignments instead of overwriting them.`,
        `Accepted implementation route labels and supported reasoning levels: ${routeCatalog}. Use only one of these exact labels and one of its bracketed reasoning levels. Prefer the selected route ${JSON.stringify(selectedRoute ? (request.selection.model === "*" ? `${selectedRoute.provider} agent default` : `${selectedRoute.provider} ${request.selection.model}`) : `${request.selection.provider} ${request.selection.model}`)} when another route is not demonstrably available.`,
        `Estimate guidance: ${estimateGuidance} Keep the estimate basis at most ${MAX_ESTIMATE_BASIS} characters.`,
        `Prior owner Q&A: ${JSON.stringify(request.priorOwnerQa)}`,
        ...reviewCadence,
        ...cleanupPolicy,
        `Validated plan directory: ${planDirectory ? JSON.stringify(planDirectory) : "none"}`,
        ...(planDirectory && request.stage !== "set-bearings" ? ["Reuse current session context and perform only bounded live verification when necessary. Do not require or create plan-local prompt artifacts."] : []),
        ...(request.reviewPrompt ? [`Review guidance: ${JSON.stringify(request.reviewPrompt)}`] : []),
        ...(focus ? [
            `BEARING_FOCUS ${JSON.stringify(focus.envelope)}`,
            "Bearing Focus mode is active. Act only on acceptance, required evidence, or the current blocker. Preserve this envelope when delegating a bounded subset to Crewmates. Runtime validation will reject out-of-scope paths, incomplete receipts, missing command evidence, and false completion even if provider hooks are unavailable.",
        ] : []),
        "Do not claim completion without actual work and evidence in this agent receipt. Do not invent artifacts, routes, sessions, or authority.",
        gatheringQuestions
            ? 'End the final assistant message with exactly one single-line envelope: BEARING_RESULT {"kind":"questions","questions":["first question","second question"],"nextStageEstimate":{"stage":"gather-supplies","minMinutes":MINIMUM_INTEGER,"maxMinutes":MAXIMUM_INTEGER,"basis":"specific workload basis"}}. Replace the uppercase placeholders with your honest integer estimate; do not copy a canned duration. Use an empty array when no owner decisions are needed. The optional estimate covers the remaining Gather Supplies apply/write step; omit it when you cannot honestly estimate it.'
            : request.stage === "gather-supplies" && request.gatherMode === "apply"
                ? 'End the final assistant message with exactly one single-line envelope: BEARING_RESULT {"kind":"action","summary":"what actually happened","artifacts":["relative/existing/path"],"nextStageEstimate":{"stage":"map-route","minMinutes":MINIMUM_INTEGER,"maxMinutes":MAXIMUM_INTEGER,"basis":"specific full-phase workload basis"}}. Replace the uppercase placeholders with your honest integer estimate; do not copy a canned duration. The optional estimate covers the complete Map the Route phase; omit it when you cannot honestly estimate it.'
                : focus
                    ? `End the final assistant message with exactly one single-line envelope: BEARING_RESULT {"kind":"question","question":"one blocking question"} or BEARING_RESULT {"kind":"action","summary":"what actually happened","artifacts":["every relative path changed during this invocation"],"evidence":[{"commandId":"CMD-ID","status":"passed","summary":"bounded observed result"}]}. On success include every command ID from BEARING_FOCUS exactly once. Never mark failed, skipped, missing, unknown, or duplicate evidence as passed.`
                    : `End the final assistant message with exactly one single-line envelope: BEARING_RESULT {"kind":"question","question":"one blocking question","nextStageEstimate":{"stage":"${request.stage}","minMinutes":MINIMUM_INTEGER,"maxMinutes":MAXIMUM_INTEGER,"basis":"specific remaining-work basis"}} or BEARING_RESULT {"kind":"action","summary":"what actually happened","artifacts":["relative/existing/path"],"nextStageEstimate":{"stage":"${nextActionStage}","minMinutes":MINIMUM_INTEGER,"maxMinutes":MAXIMUM_INTEGER,"basis":"specific full-phase workload basis"}}. Replace the uppercase placeholders with honest integer estimates; do not copy a canned duration. A question estimate covers all work remaining in the same stage after the answer. Omit nextStageEstimate when you cannot honestly estimate it.`,
    ].join("\n");
}
function estimate(value) {
    if (typeof value !== "object" || value === null || Array.isArray(value))
        return false;
    const item = value;
    return Object.keys(item).length === 4 && typeof item.stage === "string" && (item.stage === "execute" || item.stage in STAGE_SKILLS) &&
        typeof item.minMinutes === "number" && Number.isSafeInteger(item.minMinutes) && item.minMinutes >= 1 && item.minMinutes <= 1_440 &&
        typeof item.maxMinutes === "number" && Number.isSafeInteger(item.maxMinutes) && item.maxMinutes >= item.minMinutes && item.maxMinutes <= 1_440 && text(item.basis, MAX_ESTIMATE_BASIS);
}
function optionalEstimate(value) {
    if (value === undefined)
        return {};
    if (estimate(value))
        return { value };
    const basis = typeof value === "object" && value !== null && !Array.isArray(value) ? value.basis : undefined;
    return { dropped: typeof basis === "string" && basis.length > MAX_ESTIMATE_BASIS ? "basis_too_long" : "invalid" };
}
function commandEvidence(value) {
    return Array.isArray(value) && value.length <= 128 && value.every((entry) => {
        if (typeof entry !== "object" || entry === null || Array.isArray(entry))
            return false;
        const item = entry;
        return Object.keys(item).length === 3 && Object.keys(item).every((key) => ["commandId", "status", "summary"].includes(key)) &&
            typeof item.commandId === "string" && /^(?:CMD|PROC)-[A-Z0-9][A-Z0-9.-]*$/.test(item.commandId) &&
            (item.status === "passed" || item.status === "failed") && text(item.summary, 512);
    });
}
function envelope(value, maxQuestions = MAX_QA - 1) {
    const line = value.trim().split(/\r?\n/).at(-1) ?? "";
    const prefix = "BEARING_RESULT ";
    if (!line.startsWith(prefix))
        return "missing";
    const body = line.slice(prefix.length);
    if (!body || Buffer.byteLength(body) > MAX_ENVELOPE_BYTES)
        return "malformed";
    try {
        const parsed = JSON.parse(body);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
            return "malformed";
        const record = parsed;
        const next = optionalEstimate(record.nextStageEstimate);
        if (record.kind === "question" && Object.keys(record).every((key) => ["kind", "question", "nextStageEstimate"].includes(key)) && [2, 3].includes(Object.keys(record).length) && text(record.question))
            return { receipt: { kind: "question", question: record.question, ...(next.value ? { nextStageEstimate: next.value } : {}) }, ...(next.dropped ? { droppedEstimate: next.dropped } : {}) };
        if (record.kind === "questions" && Object.keys(record).every((key) => ["kind", "questions", "nextStageEstimate"].includes(key)) && [2, 3].includes(Object.keys(record).length) && Array.isArray(record.questions) && record.questions.length <= maxQuestions && record.questions.every((question) => text(question)) && new Set(record.questions).size === record.questions.length)
            return { receipt: { kind: "questions", questions: record.questions, ...(next.value ? { nextStageEstimate: next.value } : {}) }, ...(next.dropped ? { droppedEstimate: next.dropped } : {}) };
        if (record.kind === "action" && Object.keys(record).every((key) => ["kind", "summary", "artifacts", "evidence", "nextStageEstimate"].includes(key)) && [3, 4, 5].includes(Object.keys(record).length) && text(record.summary) && Array.isArray(record.artifacts) && record.artifacts.length > 0 && record.artifacts.length <= MAX_ARTIFACTS && record.artifacts.every(pathText) && new Set(record.artifacts).size === record.artifacts.length && (record.evidence === undefined || commandEvidence(record.evidence)))
            return { receipt: { kind: "action", summary: record.summary, artifacts: record.artifacts, ...(record.evidence ? { evidence: record.evidence } : {}), ...(next.value ? { nextStageEstimate: next.value } : {}) }, ...(next.dropped ? { droppedEstimate: next.dropped } : {}) };
        return "malformed";
    }
    catch {
        return "malformed";
    }
}
function stageArtifactsValid(stage, artifacts, planDirectory) {
    const inPlan = (path) => planDirectory !== undefined && posix.dirname(path) === planDirectory;
    const planSpec = (path) => posix.basename(path) === "plan-spec.md" || /^[A-Za-z0-9][A-Za-z0-9._-]*-route-map\.md$/.test(posix.basename(path));
    const routeReview = (path) => posix.basename(path) === "review.html" || /^[A-Za-z0-9][A-Za-z0-9._-]*-route-review\.html$/.test(posix.basename(path));
    if (stage === "set-bearings")
        return artifacts.some(planSpec) && artifacts.some((path) => posix.basename(path) === "repository-map.md" && posix.dirname(posix.dirname(path)) === posix.dirname(artifacts.find(planSpec) ?? ""));
    if (stage === "gather-supplies")
        return artifacts.some((path) => inPlan(path) && planSpec(path));
    if (stage === "map-route")
        return ["design.md", "seit.md"].every((name) => artifacts.some((path) => inPlan(path) && posix.basename(path) === name));
    if (stage === "draft-implementation")
        return artifacts.some((path) => inPlan(path) && posix.basename(path) === "implementation.md");
    if (stage === "execute-explorer" || stage === "execute-expedition")
        return artifacts.some((path) => inPlan(path) && routeReview(path)) && planDirectory !== undefined && artifacts.some((path) => !path.startsWith(`${planDirectory}/`));
    return true;
}
const MAX_PLANNING_ARTIFACT = 2 * 1024 * 1024;
async function readPlanningArtifact(root, value, allowEmpty = false) {
    if (!pathText(value) || value === "." || isAbsolute(value) || posix.normalize(value) !== value)
        return undefined;
    const candidate = resolve(root, value), lexical = relative(root, candidate);
    if (!lexical || lexical.startsWith("..") || isAbsolute(lexical))
        return undefined;
    let handle = null;
    try {
        handle = await open(candidate, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        const opened = await handle.stat(), linked = await lstat(candidate), canonical = await realpath(candidate);
        const relation = relative(root, canonical);
        if (!opened.isFile() || linked.isSymbolicLink() || !linked.isFile() || opened.dev !== linked.dev || opened.ino !== linked.ino || opened.size > MAX_PLANNING_ARTIFACT || !relation || relation.startsWith("..") || isAbsolute(relation))
            return undefined;
        const buffer = Buffer.allocUnsafe(MAX_PLANNING_ARTIFACT + 1);
        let length = 0;
        while (length < buffer.length) {
            const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
            if (!bytesRead)
                break;
            length += bytesRead;
        }
        if (length > MAX_PLANNING_ARTIFACT)
            return undefined;
        const content = buffer.subarray(0, length).toString("utf8");
        return allowEmpty || content.trim() ? content : undefined;
    }
    catch {
        return undefined;
    }
    finally {
        await handle?.close();
    }
}
async function writePlanningReview(root, value, content) {
    if (Buffer.byteLength(content) > MAX_PLANNING_ARTIFACT || !pathText(value) || value === "." || isAbsolute(value) || posix.normalize(value) !== value)
        return false;
    const candidate = resolve(root, value), lexical = relative(root, candidate);
    if (!lexical || lexical.startsWith("..") || isAbsolute(lexical))
        return false;
    let handle = null;
    try {
        try {
            handle = await open(candidate, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
        }
        catch {
            handle = await open(candidate, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
        }
        const opened = await handle.stat(), linked = await lstat(candidate), canonical = await realpath(candidate);
        const relation = relative(root, canonical);
        if (!opened.isFile() || linked.isSymbolicLink() || !linked.isFile() || opened.dev !== linked.dev || opened.ino !== linked.ino || !relation || relation.startsWith("..") || isAbsolute(relation))
            return false;
        await handle.truncate(0);
        await handle.writeFile(content, "utf8");
        return true;
    }
    catch {
        return false;
    }
    finally {
        await handle?.close();
    }
}
function escaped(value) { return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"); }
function field(section, name) {
    const label = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = new RegExp(`^\\*\\*${label}${name.endsWith("?") ? "" : "\\."}\\*\\*\\s*(.+)$`, "mi").exec(section);
    return match?.[1]?.trim();
}
const SLICE_HEADING = /^###\s+Slice\s+(?<id>[A-Za-z]+\d+|\d+(?:\.\d+)+)\b.*$/gm;
const MANIFEST_HEADING = /^###\s+(?<id>[A-Za-z]+\d+|\d+(?:\.\d+)+)\s+execution manifest\s*$/gmi;
const REQUIRED_SLICE_FIELDS = ["Goal", "Requirement IDs", "Design IDs", "SEIT proof rows", "Type", "Design lenses", "Implementation role", "Agent model route", "Agent reasoning level", "Ponytail mode", "Review path"];
const REQUIRED_MANIFEST_FIELDS = ["Write set", "Command IDs", "Stop condition", "Human decision"];
const PLAN_ID = /\b(?:AC|RISK)-[A-Z0-9][A-Z0-9.-]*\b/gi;
const DESIGN_ID = /\b(?:DES|CONTRACT)-[A-Z0-9][A-Z0-9.-]*\b/gi;
const SEIT_ID = /\bSEIT-[A-Z0-9][A-Z0-9.-]*\b/gi;
const COMMAND_ID = /\b(?:CMD|PROC)-[A-Z0-9][A-Z0-9.-]*\b/gi;
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
function identifiers(value, pattern) {
    return new Set([...(value ?? "").matchAll(pattern)].map((match) => match[0].toUpperCase()));
}
function markdownSection(content, heading) {
    const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`^##[ \\t]+${escapedHeading}[ \\t]*\\r?\\n([\\s\\S]*?)(?=^##[ \\t]+|(?![\\s\\S]))`, "mi").exec(content)?.[1]?.trim();
}
function traceabilityRows(seit) {
    const matrix = markdownSection(seit, "Traceability Matrix"), requiredCommands = markdownSection(seit, "Required Commands");
    if (!matrix || !requiredCommands)
        return undefined;
    const table = matrix.split(/\r?\n/).filter((line) => line.trim().startsWith("|"));
    if (table.length < 3)
        return undefined;
    const cells = (line) => line.trim().replace(/^\||\|$/g, "").split("|").map((value) => value.trim());
    const headers = cells(table[0]).map((value) => value.toLowerCase());
    const required = ["seit row id", "acceptance/risk id", "design/contract id", "boundary/test layer", "positive case", "negative/failure case", "command/procedure id", "evidence"];
    if (required.some((name) => !headers.includes(name)))
        return undefined;
    const rows = new Map();
    for (const line of table.slice(2)) {
        const values = cells(line);
        if (values.length !== headers.length || required.some((name) => !values[headers.indexOf(name)] || /^(?:-|tbd|todo|n\/a)$/i.test(values[headers.indexOf(name)])))
            return undefined;
        const rowIds = identifiers(values[headers.indexOf("seit row id")], SEIT_ID);
        if (rowIds.size !== 1)
            return undefined;
        const id = [...rowIds][0];
        if (rows.has(id))
            return undefined;
        const requirements = identifiers(values[headers.indexOf("acceptance/risk id")], PLAN_ID);
        const designs = identifiers(values[headers.indexOf("design/contract id")], DESIGN_ID);
        const commands = identifiers(values[headers.indexOf("command/procedure id")], COMMAND_ID);
        if (!requirements.size || !designs.size || !commands.size)
            return undefined;
        rows.set(id, { requirements, designs, commands });
    }
    const commands = new Set([...requiredCommands.matchAll(/^\s*-\s+\*\*((?:CMD|PROC)-[A-Z0-9][A-Z0-9.-]*)\*\*/gmi)].map((match) => match[1].toUpperCase()));
    return rows.size && commands.size ? { rows, commands } : undefined;
}
function structurallyValidImplementation(plan, design, seit, content) {
    const slices = sections(content, SLICE_HEADING), manifests = sections(content, MANIFEST_HEADING);
    if (!slices?.size || !manifests || slices.size !== manifests.size || [...slices.keys()].some((id) => !manifests.has(id)))
        return false;
    const trace = traceabilityRows(seit);
    if (!trace)
        return false;
    const planIds = identifiers(`${markdownSection(plan, "Acceptance criteria") ?? ""}\n${markdownSection(plan, "Risks and open questions") ?? ""}`, PLAN_ID);
    const designIds = identifiers(design, DESIGN_ID);
    if (!planIds.size || !designIds.size)
        return false;
    const sliceRows = new Map();
    for (const [id, section] of slices) {
        if (REQUIRED_SLICE_FIELDS.some((name) => !field(section, name)))
            return false;
        const requirements = identifiers(field(section, "Requirement IDs"), PLAN_ID);
        const designs = identifiers(field(section, "Design IDs"), DESIGN_ID);
        const proofRows = identifiers(field(section, "SEIT proof rows"), SEIT_ID);
        if (!requirements.size || !designs.size || !proofRows.size || [...requirements].some((value) => !planIds.has(value)) || [...designs].some((value) => !designIds.has(value)) || [...proofRows].some((value) => !trace.rows.has(value)))
            return false;
        const mappedRequirements = new Set([...proofRows].flatMap((value) => [...trace.rows.get(value).requirements]));
        const mappedDesigns = new Set([...proofRows].flatMap((value) => [...trace.rows.get(value).designs]));
        if ([...requirements].some((value) => !mappedRequirements.has(value)) || [...designs].some((value) => !mappedDesigns.has(value)))
            return false;
        sliceRows.set(id, proofRows);
    }
    for (const [id, manifest] of manifests) {
        if (REQUIRED_MANIFEST_FIELDS.some((name) => !field(manifest, name)))
            return false;
        const writeSet = field(manifest, "Write set");
        const noWrites = /\b(?:none|no writes?(?: required)?|no (?:new|required|source|product) files?)\b/i.test(writeSet);
        const paths = [...writeSet.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
        if (!noWrites && (!/\bonly\b/i.test(writeSet) || !paths.length))
            return false;
        if (paths.some((path) => /\*|\.\.\.|<|>|\\/.test(path) || posix.isAbsolute(path) || /^[A-Za-z]:/.test(path) || posix.normalize(path) !== path || path.split("/").some((segment) => !segment || segment === "." || segment === "..")))
            return false;
        const commandIds = identifiers(field(manifest, "Command IDs"), COMMAND_ID);
        const mappedCommands = new Set([...(sliceRows.get(id) ?? [])].flatMap((value) => [...trace.rows.get(value).commands]));
        if (!commandIds.size || [...commandIds].some((value) => !trace.commands.has(value) || !mappedCommands.has(value)))
            return false;
    }
    const sliceIds = new Set(slices.keys());
    if ([...content.matchAll(/\bSlice\s+([A-Za-z]+\d+|\d+(?:\.\d+)+)\b/g)].some((match) => !sliceIds.has(match[1])))
        return false;
    const waves = new Set([...content.matchAll(/\bWave\s+(\d+)\b/g)].map((match) => Number(match[1])));
    if (slices.size > 1 && !waves.size)
        return false;
    const lastWave = waves.size ? Math.max(...waves) : 0;
    return !waves.size || lastWave >= 1 && waves.size === lastWave && [...Array(lastWave).keys()].every((index) => waves.has(index + 1));
}
function completeArtifact(content, type, headings) {
    if (!new RegExp(`^---[\\s\\S]*^type:\\s*${type}\\s*$[\\s\\S]*^status:\\s*(?:complete|amended)\\s*$[\\s\\S]*^---\\s*$`, "mi").test(content))
        return false;
    return headings.every((heading) => new RegExp(`^##\\s+${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\n\\s*\\S`, "mi").test(content));
}
function sourceSection(sources) {
    return `<section id="bearing-source-artifacts"><h2>Complete planning artifacts</h2><p>These are the complete source documents used for this review.</p>${sources.map(([name, content]) => `<details><summary>${escaped(name)}</summary><pre>${escaped(content)}</pre></details>`).join("")}</section>`;
}
function sourceNavigation(sources) {
    return `<nav id="bearing-source-links" aria-label="Planning artifact sources">${sources.map(([name]) => `<a href="./${encodeURIComponent(name)}">${escaped(name)}</a>`).join(" ")}</nav>`;
}
const FINAL_QA_PENDING = '<section id="bearing-final-qa" data-status="pending"><h2>Actual implementation and QA</h2><p>Pending implementation and validation.</p></section>';
const FINAL_QA_COMPLETE_PREFIX = '<section id="bearing-final-qa" data-status="complete"><h2>Actual implementation and QA</h2><p>Planned versus actual: ';
const FINAL_QA_COMPLETE_MIDDLE = "</p><p>Validation evidence: ";
const FINAL_QA_COMPLETE_SUFFIX = "</p></section>";
export function renderPlanningReview(sources) {
    const planningFlow = '<figure><div class="flow" role="img" aria-label="Planning flow from plan specification through final QA"><span>Plan specification</span><b>→</b><span>Design</span><b>→</b><span>SEIT test map</span><b>→</b><span>Implementation</span><b>→</b><span>Final QA</span></div><figcaption>Planning flow</figcaption><p class="text-equivalent">Text equivalent: acceptance and risks drive design contracts; SEIT maps those contracts to proof; implementation slices reference the map; final QA records actual evidence.</p></figure>';
    const traceFlow = '<figure><div class="flow" role="img" aria-label="Traceability from requirements to execution evidence"><span>AC / RISK</span><b>↔</b><span>DES / CONTRACT</span><b>↔</b><span>SEIT / CMD</span><b>↔</b><span>Slice manifest</span></div><figcaption>Traceability map</figcaption><p class="text-equivalent">Text equivalent: stable IDs connect each requirement or risk to its design boundary, positive and negative test cases, command, evidence, and bounded execution slice.</p></figure>';
    return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Bearing planning review</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:1100px;margin:auto;padding:2rem;color:#17202a;background:#f7f8fa}main{background:#ffffff;padding:2rem;border:1px solid #67788a;border-radius:12px}nav{display:flex;gap:1rem;flex-wrap:wrap}figure{margin:2rem 0;padding:1rem;border:1px solid #a8b2bd;border-radius:8px}.flow{display:flex;align-items:center;gap:.65rem;flex-wrap:wrap}.flow span{padding:.55rem .8rem;background:#eef1f4;border-radius:6px}figcaption,summary{font-weight:700}.text-equivalent{margin-bottom:0}details{margin:1rem 0}summary{cursor:pointer}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#eef1f4;padding:1rem;border-radius:8px}</style></head><body><main><h1>Bearing planning review</h1><p>This deterministic view is generated from the four current planning sources.</p>${sourceNavigation(sources)}<section aria-labelledby="bearing-diagrams"><h2 id="bearing-diagrams">Plan maps</h2>${planningFlow}${traceFlow}</section>${sourceSection(sources)}${FINAL_QA_PENDING}</main></body></html>\n`;
}
function validFinalQaSection(section) {
    if (!section.startsWith(FINAL_QA_COMPLETE_PREFIX) || !section.endsWith(FINAL_QA_COMPLETE_SUFFIX))
        return false;
    const body = section.slice(FINAL_QA_COMPLETE_PREFIX.length, section.length - FINAL_QA_COMPLETE_SUFFIX.length);
    const middle = body.indexOf(FINAL_QA_COMPLETE_MIDDLE);
    if (middle < 0 || body.indexOf(FINAL_QA_COMPLETE_MIDDLE, middle + FINAL_QA_COMPLETE_MIDDLE.length) >= 0)
        return false;
    const planned = body.slice(0, middle), validation = body.slice(middle + FINAL_QA_COMPLETE_MIDDLE.length);
    return planned.trim().length > 0 && validation.trim().length > 0 && !planned.includes("<") && !planned.includes(">") && !validation.includes("<") && !validation.includes(">");
}
export async function executionReviewValid(root, planDirectory) {
    if (!planDirectory)
        return false;
    const directory = resolve(root, planDirectory), names = await readdir(directory);
    const planName = names.find((name) => name === "plan-spec.md" || /^[A-Za-z0-9][A-Za-z0-9._-]*-route-map\.md$/.test(name));
    const reviewName = names.find((name) => name === "review.html" || /^[A-Za-z0-9][A-Za-z0-9._-]*-route-review\.html$/.test(name));
    if (!planName || !reviewName || !["design.md", "seit.md", "implementation.md"].every((name) => names.includes(name)))
        return false;
    const sourceNames = [planName, "design.md", "seit.md", "implementation.md"];
    const contents = await Promise.all([...sourceNames, reviewName].map((name) => readPlanningArtifact(root, posix.join(planDirectory, name))));
    if (!contents.every((content) => content !== undefined))
        return false;
    const sources = sourceNames.map((name, index) => [name, contents[index]]);
    const expected = renderPlanningReview(sources), marker = expected.indexOf(FINAL_QA_PENDING);
    if (marker < 0)
        return false;
    const prefix = expected.slice(0, marker), suffix = expected.slice(marker + FINAL_QA_PENDING.length), review = contents.at(-1);
    if (!review.startsWith(prefix) || !review.endsWith(suffix) || review.length < prefix.length + suffix.length)
        return false;
    return validFinalQaSection(review.slice(prefix.length, review.length - suffix.length));
}
async function designReviewArtifacts(root, planDirectory, _repair = false, cancelled = () => false) {
    if (!planDirectory)
        return undefined;
    const directory = resolve(root, planDirectory), names = await readdir(directory);
    const planName = names.find((name) => name === "plan-spec.md" || /^[A-Za-z0-9][A-Za-z0-9._-]*-route-map\.md$/.test(name));
    const reviewName = names.find((name) => name === "review.html" || /^[A-Za-z0-9][A-Za-z0-9._-]*-route-review\.html$/.test(name)) ?? "review.html";
    if (!planName || !names.includes("design.md") || !names.includes("seit.md"))
        return undefined;
    const sourceNames = [planName, "design.md", "seit.md"];
    const sourceContents = await Promise.all(sourceNames.map((name) => readPlanningArtifact(root, posix.join(planDirectory, name))));
    if (!sourceContents.every((content) => content !== undefined))
        return undefined;
    const [plan, design, seit] = sourceContents;
    if (!completeArtifact(design, "design", ["Use Cases and Communication Flows", "Interface Option Check", "OOPDSA Implementation Design"]) || !completeArtifact(seit, "seit", ["Traceability Matrix", "Cross-cutting Checks"]))
        return undefined;
    const reviewPath = posix.join(planDirectory, reviewName);
    const sources = sourceNames.map((name, index) => [name, [plan, design, seit][index]]);
    const completed = renderPlanningReview(sources);
    if (Buffer.byteLength(completed) > MAX_PLANNING_ARTIFACT)
        return undefined;
    const review = names.includes(reviewName) ? await readPlanningArtifact(root, reviewPath, true) : "";
    if (review === undefined)
        return undefined;
    if (completed !== review) {
        if (cancelled())
            return undefined;
        if (!await writePlanningReview(root, reviewPath, completed))
            return undefined;
    }
    return ["design.md", "seit.md", reviewName].map((name) => posix.join(planDirectory, name));
}
function routeLabel(value) { return value.toLowerCase().replace(/[^a-z0-9]+/g, ""); }
function planningRoute(value, selection) {
    const label = routeLabel(value);
    const selected = BUILTIN_ROUTES.find((route) => route.provider === selection.provider && (route.model === "*" || route.model === selection.model));
    const matches = BUILTIN_ROUTES.filter((route) => {
        const labels = [route.id, route.provider, `${route.executable} ${route.id}`, ...(route.model === "*" ? [`${route.id} agent default`, `${route.provider} agent default`] : [route.model, `${route.executable} ${route.model}`])].map(routeLabel);
        const selectedLabels = route === selected && selection.model !== "*" ? [selection.model, `${route.id} ${selection.model}`, `${route.provider} ${selection.model}`, `${route.executable} ${selection.model}`].map(routeLabel) : [];
        return labels.includes(label) || selectedLabels.includes(label);
    });
    return matches.length === 1 ? matches[0] : undefined;
}
async function planningReview(root, planDirectory, selection) {
    if (!planDirectory)
        return undefined;
    const directory = resolve(root, planDirectory), names = await readdir(directory);
    const planName = names.find((name) => name === "plan-spec.md" || /^[A-Za-z0-9][A-Za-z0-9._-]*-route-map\.md$/.test(name));
    const reviewName = names.find((name) => name === "review.html" || /^[A-Za-z0-9][A-Za-z0-9._-]*-route-review\.html$/.test(name)) ?? "review.html";
    if (!planName || !names.includes("design.md") || !names.includes("seit.md") || !names.includes("implementation.md"))
        return undefined;
    const sourceNames = [planName, "design.md", "seit.md", "implementation.md"];
    const contents = await Promise.all(sourceNames.map((name) => readPlanningArtifact(root, posix.join(planDirectory, name))));
    if (!contents.every((content) => content !== undefined))
        return undefined;
    const [plan, design, seit, implementation] = contents;
    if (!completeArtifact(design, "design", ["Use Cases and Communication Flows", "Interface Option Check", "OOPDSA Implementation Design"]) || !completeArtifact(seit, "seit", ["Traceability Matrix", "Cross-cutting Checks"]))
        return undefined;
    if (!structurallyValidImplementation(plan, design, seit, implementation))
        return undefined;
    const headings = [...implementation.matchAll(/^###\s+(Slice\b[^\r\n]*)/gmi)];
    const assignments = [];
    for (let index = 0; index < headings.length; index += 1) {
        const start = headings[index].index ?? 0, end = headings[index + 1]?.index ?? implementation.length;
        const section = implementation.slice(start, end);
        const role = field(section, "Implementation role"), model = field(section, "Agent model route"), reasoning = field(section, "Agent reasoning level");
        const ponytail = field(section, "Ponytail mode"), reviewPath = field(section, "Review path");
        if (!role || !model || !reasoning || !ponytail || !reviewPath)
            return undefined;
        const route = planningRoute(model, selection), normalizedReasoning = reasoning.replace(/[.!?]+$/, "").trim();
        if (!route || !route.reasoningLevels.includes(normalizedReasoning.toLowerCase()) || !["full", "off"].includes(ponytail))
            return undefined;
        assignments.push({ slice: headings[index][1].trim(), role, model, reasoning: normalizedReasoning });
    }
    const completed = renderPlanningReview(sourceNames.map((name, index) => [name, [plan, design, seit, implementation][index]]));
    if (Buffer.byteLength(completed) > MAX_PLANNING_ARTIFACT)
        return undefined;
    const review = names.includes(reviewName) ? await readPlanningArtifact(root, posix.join(planDirectory, reviewName), true) : "";
    if (review === undefined || completed !== review && !await writePlanningReview(root, posix.join(planDirectory, reviewName), completed))
        return undefined;
    return { phases: [...implementation.matchAll(/^##\s+Phase\b/gmi)].length, slices: assignments.length, assignments };
}
/** Minimal provider-neutral bridge from a selected onboarding route to one staged journey action. */
export class JourneyService {
    runner;
    active = new Map();
    cancelled = new Set();
    activity = new Map();
    providerSessions = new Map();
    focusContexts = new Map();
    constructor(runner) {
        this.runner = runner;
    }
    cancel(runId) { this.cancelled.add(runId); const processRunId = this.active.get(runId); if (processRunId)
        void this.runner.cancel?.(processRunId); }
    activityTrail(runId) {
        return (this.activity.get(runId)?.trail ?? []).map((entry) => ({ ...entry }));
    }
    providerSessionId(repositoryPath, runId, selection) { return this.providerSessions.get(this.providerSessionKey(repositoryPath, runId, selection)); }
    providerSessionKey(repositoryPath, runId, selection) {
        return JSON.stringify([repositoryPath, runId, selection.provider, selection.model, selection.reasoning]);
    }
    focusKey(repositoryPath, runId) { return JSON.stringify([repositoryPath, runId]); }
    sameFocusContract(left, right) {
        const stable = (focus) => ({ ...focus.envelope, currentBlocker: "none", gateFailureFingerprint: "none", reviewPath: focus.reviewPath });
        return JSON.stringify(stable(left)) === JSON.stringify(stable(right));
    }
    beginStage(runId, stage) {
        const current = this.activity.get(runId);
        if (current?.stage === stage)
            return;
        this.activity.set(runId, { stage, nextSequence: 1, trail: [] });
    }
    recordActivity(runId, stage, source) {
        const current = this.activity.get(runId);
        if (!current || current.stage !== stage)
            return;
        const safe = (value) => value && SAFE_ACTIVITY_VALUE.test(value) && !SECRET_ACTIVITY.test(value) ? value : undefined;
        const kind = safe(source.kind);
        if (!kind)
            return;
        const status = safe(source.status), tool = safe(source.tool);
        current.trail.push({ sequence: current.nextSequence, recordedAt: new Date().toISOString(), kind, ...(status ? { status } : {}), ...(tool ? { tool } : {}) });
        current.nextSequence += 1;
        if (current.trail.length > MAX_ACTIVITY_TRAIL)
            current.trail.shift();
    }
    async executeOnce(request, activityStage = request.stage, recordStageStart = true) {
        if (!validRequest(request))
            return { status: "failure", code: "input_invalid", tokens: 0 };
        let repositoryPath;
        try {
            repositoryPath = await realpath(request.repositoryPath);
            if (repositoryPath !== request.repositoryPath || !(await lstat(repositoryPath)).isDirectory())
                throw new Error("invalid repository");
        }
        catch {
            return { status: "failure", code: "input_invalid", tokens: 0 };
        }
        const planDirectory = request.planDirectory === undefined ? undefined : await containedPath(repositoryPath, request.planDirectory, true);
        if (request.planDirectory !== undefined && planDirectory === undefined)
            return { status: "failure", code: "input_invalid", tokens: 0 };
        const projected = request.run.roles.find((role) => request.stage === "review" ? role.role === "surveyor" && !role.authority.write : role.role === "crewmate" && role.executor && role.authority.write);
        if (!projected)
            return { status: "failure", code: "crewmate_unavailable", tokens: 0 };
        if (!sameSelection(request.selection, projected.selection) || request.run.roles.some((role) => !sameSelection(role.selection, request.selection)))
            return { status: "failure", code: "selection_mismatch", tokens: 0 };
        this.beginStage(request.runId, activityStage);
        if (recordStageStart)
            this.recordActivity(request.runId, activityStage, { kind: "stage.started", status: "running" });
        if (request.stage === "set-bearings") {
            if (this.cancelled.has(request.runId))
                return { status: "failure", code: "cancelled", tokens: 0 };
            try {
                this.recordActivity(request.runId, activityStage, { kind: "repository-map.started", status: "running" });
                const workspace = await setBearingsWorkspace(repositoryPath, request.workGoal, planDirectory);
                if (!workspace || !(await Promise.all(workspace.artifacts.map((artifact) => containedPath(repositoryPath, artifact)))).every(Boolean) || !stageArtifactsValid(request.stage, workspace.artifacts, workspace.directory) || this.cancelled.has(request.runId))
                    return { status: "failure", code: this.cancelled.has(request.runId) ? "cancelled" : "artifact_invalid", tokens: 0 };
                this.recordActivity(request.runId, activityStage, { kind: "workspace.ready", status: workspace.resumed ? "resumed" : "created" });
                return { status: "action", summary: workspace.resumed ? "Bearings resumed locally." : "Bearings set locally.", artifacts: workspace.artifacts, tokens: 0 };
            }
            catch {
                return { status: "failure", code: "artifact_invalid", tokens: 0 };
            }
        }
        const executionStage = request.stage === "execute-explorer" || request.stage === "execute-expedition";
        let focus;
        let focusKey;
        if (executionStage) {
            if (!planDirectory)
                return { status: "failure", code: "focus_invalid", tokens: 0 };
            const candidate = await createFocusContext({
                root: repositoryPath,
                planDirectory,
                role: request.stage === "execute-expedition" ? "navigator" : "explorer",
                objective: request.workGoal,
                ...(request.reviewPrompt ? { currentBlocker: request.reviewPrompt } : {}),
                ...(request.gateFailureFingerprint ? { gateFailureFingerprint: request.gateFailureFingerprint } : {}),
            }).catch(() => undefined);
            focusKey = this.focusKey(repositoryPath, request.runId);
            const original = this.focusContexts.get(focusKey);
            if (!candidate || original && !this.sameFocusContract(original, candidate)) {
                this.recordActivity(request.runId, activityStage, { kind: "focus.rejected", status: "invalid" });
                return { status: "failure", code: "focus_invalid", tokens: 0 };
            }
            focus = original
                ? { ...original, envelope: { ...original.envelope, currentBlocker: candidate.envelope.currentBlocker, gateFailureFingerprint: candidate.envelope.gateFailureFingerprint } }
                : candidate;
            this.focusContexts.set(focusKey, focus);
            this.recordActivity(request.runId, activityStage, { kind: "focus.ready", status: "validated" });
        }
        let taskPrompt;
        try {
            taskPrompt = prompt(request, planDirectory, await packagedSkills(request.stage), focus);
        }
        catch {
            return { status: "failure", code: "adapter_failed", tokens: 0 };
        }
        let tokens = 0;
        let events;
        if (this.cancelled.has(request.runId))
            return { status: "failure", code: "cancelled", tokens: 0 };
        const processRunId = `${request.runId.slice(0, 70)}-${randomUUID()}`;
        this.active.set(request.runId, processRunId);
        if (request.stage === "review" && request.selection.provider === "codex") {
            const modelArgs = request.selection.model === "*" ? [] : ["-m", request.selection.model];
            let result;
            try {
                result = await this.runner.run({ routeId: "codex", executable: "codex", args: ["exec", "review", "--uncommitted", "--json", ...modelArgs, "-c", `model_reasoning_effort="${request.selection.reasoning}"`, "-c", 'approval_policy="never"', "-c", 'sandbox_mode="read-only"', "--ephemeral"], stdin: "", cwd: repositoryPath, timeoutMs: projected.limits.timeoutMs, runId: processRunId, onActivity: (activity) => this.recordActivity(request.runId, activityStage, activity) });
            }
            catch {
                return { status: "failure", code: "adapter_failed", tokens: 0 };
            }
            const reportedTokens = result.usage && Number.isSafeInteger(result.usage.tokens) && result.usage.tokens >= 0 ? result.usage.tokens : 0;
            if (this.cancelled.has(request.runId) && result.unknownSideEffect)
                return { status: "failure", code: "interrupted", tokens: reportedTokens };
            if (result.cancelled)
                return { status: "failure", code: "cancelled", tokens: reportedTokens };
            if (!result.usage || !Number.isSafeInteger(result.usage.tokens) || result.usage.tokens < 0)
                return { status: "failure", code: "adapter_failed", tokens: 0 };
            if (result.usage.tokens > projected.limits.tokenBudget)
                return { status: "failure", code: "token_budget", tokens: result.usage.tokens };
            if (result.exitCode !== 0 || result.timedOut || result.unknownSideEffect || !Array.isArray(result.events))
                return { status: "failure", code: "adapter_failed", tokens: result.usage.tokens };
            tokens = result.usage.tokens;
            events = result.events;
        }
        else {
            const adapter = createAgentAdapter(request.selection, this.runner);
            if (!adapter)
                return { status: "failure", code: "crewmate_unavailable", tokens: 0 };
            let receipt;
            const questionDiscovery = request.stage === "gather-supplies" && request.gatherMode === "questions";
            const journeySession = request.stage !== "review";
            const providerSessionKey = this.providerSessionKey(repositoryPath, request.runId, request.selection);
            const continuation = journeySession ? request.providerSessionId ?? this.providerSessions.get(providerSessionKey) : undefined;
            try {
                receipt = await adapter.execute({ runId: processRunId, sessionScope: request.runId, repositoryPath, role: { ...projected, sessionId: journeySession ? projected.sessionId : null, authority: { ...projected.authority, write: questionDiscovery ? false : projected.authority.write, network: request.selection.provider === "agy", externalAction: false }, toolAllow: questionDiscovery ? projected.toolAllow.filter((tool) => !/write|edit/i.test(tool)) : projected.toolAllow }, task: { prompt: taskPrompt }, onActivity: (activity) => this.recordActivity(request.runId, activityStage, activity), ...(continuation ? { providerSessionId: continuation } : {}), ...(executionStage ? { focusMode: true } : {}), ...(request.stage === "execute-expedition" ? { allowSubagents: true } : {}) });
            }
            catch {
                return { status: "failure", code: "adapter_failed", tokens: 0 };
            }
            if (receipt.status !== "completed")
                return { status: "failure", code: this.cancelled.has(request.runId) && (receipt.status === "blocked_reconcile" || receipt.failure === "unknown_side_effect") ? "interrupted" : receipt.failure === "token_budget" ? "token_budget" : receipt.failure === "cancelled" ? "cancelled" : "adapter_failed", tokens: receipt.usage.tokens };
            if (journeySession && receipt.providerSessionId)
                this.providerSessions.set(providerSessionKey, receipt.providerSessionId);
            tokens = receipt.usage.tokens;
            events = receipt.events;
        }
        if (this.cancelled.has(request.runId))
            return { status: "failure", code: "cancelled", tokens };
        const assistantText = events.flatMap((event) => typeof event === "object" && event !== null && !Array.isArray(event) && typeof event.data?.content === "string" ? [event.data.content] : []).at(-1);
        if (!assistantText)
            return { status: "failure", code: "result_missing", tokens };
        if (request.stage === "review" && request.selection.provider === "codex") {
            const summary = assistantText.trim().slice(0, MAX_TEXT).trim();
            return this.cancelled.has(request.runId) ? { status: "failure", code: "cancelled", tokens } : text(summary) ? { status: "action", summary, artifacts: [], tokens } : { status: "failure", code: "result_malformed", tokens };
        }
        const availableQuestions = request.stage === "gather-supplies" && request.gatherMode === "questions" ? Math.min(MAX_GATHER_QUESTIONS, Math.max(0, MAX_QA - request.priorOwnerQa.length)) : MAX_QA - 1;
        const resultEnvelope = envelope(assistantText, availableQuestions);
        if (resultEnvelope === "missing")
            return { status: "failure", code: "result_missing", tokens };
        if (resultEnvelope === "malformed")
            return { status: "failure", code: "result_malformed", tokens };
        const parsed = resultEnvelope.receipt;
        if (resultEnvelope.droppedEstimate)
            this.recordActivity(request.runId, activityStage, { kind: "estimate.dropped", status: resultEnvelope.droppedEstimate });
        const expectedEstimate = (stage) => {
            if (!parsed.nextStageEstimate || parsed.nextStageEstimate.stage === stage)
                return parsed.nextStageEstimate;
            this.recordActivity(request.runId, activityStage, { kind: "estimate.dropped", status: "stage_invalid" });
            return undefined;
        };
        if (parsed.kind === "questions") {
            if (request.stage !== "gather-supplies" || request.gatherMode !== "questions")
                return { status: "failure", code: "result_malformed", tokens };
            const nextStageEstimate = expectedEstimate("gather-supplies");
            const questions = parsed.questions.filter((question) => question.toLowerCase() !== "anything else?");
            return { status: "question", ...(questions[0] ? { question: questions[0] } : {}), questions, tokens, ...(nextStageEstimate ? { nextStageEstimate } : {}) };
        }
        if (parsed.kind === "question") {
            if (request.stage === "gather-supplies" && request.gatherMode !== undefined)
                return { status: "failure", code: "result_malformed", tokens };
            const nextStageEstimate = expectedEstimate(request.stage);
            return this.cancelled.has(request.runId) ? { status: "failure", code: "cancelled", tokens } : { status: "question", question: parsed.question, tokens, ...(nextStageEstimate ? { nextStageEstimate } : {}) };
        }
        if (request.stage === "gather-supplies" && request.gatherMode === "questions")
            return { status: "failure", code: "result_malformed", tokens };
        const nextStageEstimate = expectedEstimate(nextStage(request.stage));
        for (const artifact of parsed.artifacts) {
            if (!await containedPath(repositoryPath, artifact))
                return { status: "failure", code: "artifact_invalid", tokens };
            if (this.cancelled.has(request.runId))
                return { status: "failure", code: "cancelled", tokens };
        }
        if (!stageArtifactsValid(request.stage, parsed.artifacts, planDirectory))
            return { status: "failure", code: "artifact_invalid", tokens };
        const review = request.stage === "draft-implementation" ? await planningReview(repositoryPath, planDirectory, request.selection).catch(() => undefined) : undefined;
        const finalReviewValid = executionStage ? await executionReviewValid(repositoryPath, planDirectory).catch(() => false) : true;
        if (this.cancelled.has(request.runId))
            return { status: "failure", code: "cancelled", tokens };
        if (request.stage === "draft-implementation" && !review)
            return { status: "failure", code: "artifact_invalid", tokens };
        if (!finalReviewValid)
            return { status: "failure", code: "artifact_invalid", tokens };
        if (executionStage && focus) {
            const completion = await validateFocusCompletion(focus, repositoryPath, parsed.artifacts, parsed.evidence ?? []).catch(() => ({ ok: false, reason: "git_state" }));
            if (!completion.ok) {
                this.recordActivity(request.runId, activityStage, { kind: "focus.rejected", status: completion.reason });
                return { status: "failure", code: "completion_invalid", tokens };
            }
            this.recordActivity(request.runId, activityStage, { kind: "focus.completed", status: "validated" });
            this.focusContexts.delete(focusKey);
        }
        else if (parsed.evidence)
            return { status: "failure", code: "result_malformed", tokens };
        const artifacts = request.stage === "draft-implementation" && planDirectory ? [...new Set([...parsed.artifacts, posix.join(planDirectory, "review.html")])] : parsed.artifacts;
        return { status: "action", summary: parsed.summary, artifacts, tokens, ...(review ? { planningReview: review } : {}), ...(nextStageEstimate ? { nextStageEstimate } : {}) };
    }
    async executeMapRoute(request) {
        let designArtifacts;
        let designEstimate;
        try {
            const repositoryPath = await realpath(request.repositoryPath);
            const planDirectory = request.planDirectory === undefined ? undefined : await containedPath(repositoryPath, request.planDirectory, true);
            if (repositoryPath === request.repositoryPath && planDirectory)
                designArtifacts = await designReviewArtifacts(repositoryPath, planDirectory);
        }
        catch { /* executeOnce returns the canonical validation failure below */ }
        let tokens = 0;
        if (!designArtifacts) {
            const design = await this.executeOnce(request, "map-route");
            tokens += design.tokens;
            if (design.status !== "action")
                return design;
            designEstimate = design.nextStageEstimate;
            try {
                designArtifacts = await designReviewArtifacts(request.repositoryPath, request.planDirectory, true, () => this.cancelled.has(request.runId));
            }
            catch {
                designArtifacts = undefined;
            }
            if (this.cancelled.has(request.runId))
                return { status: "failure", code: "cancelled", tokens };
            if (!designArtifacts)
                return { status: "failure", code: "artifact_invalid", tokens };
            this.recordActivity(request.runId, "map-route", { kind: "design.ready", status: "completed" });
        }
        else {
            this.beginStage(request.runId, "map-route");
            this.recordActivity(request.runId, "map-route", { kind: "stage.started", status: "running" });
            this.recordActivity(request.runId, "map-route", { kind: "design.ready", status: "resumed" });
        }
        this.recordActivity(request.runId, "map-route", { kind: "implementation-draft.started", status: "running" });
        const implementation = await this.executeOnce({ ...request, stage: "draft-implementation" }, "map-route", false);
        tokens += implementation.tokens;
        if (implementation.status !== "action")
            return { ...implementation, tokens };
        const artifacts = [...new Set([...designArtifacts, ...implementation.artifacts])];
        const reviews = artifacts.filter((path) => posix.extname(path) === ".html");
        return { ...implementation, artifacts: [...artifacts.filter((path) => posix.extname(path) !== ".html"), ...reviews], tokens, ...(implementation.nextStageEstimate ?? designEstimate ? { nextStageEstimate: implementation.nextStageEstimate ?? designEstimate } : {}) };
    }
    async execute(request) {
        try {
            return request.stage === "map-route" ? await this.executeMapRoute(request) : await this.executeOnce(request);
        }
        finally {
            this.active.delete(request.runId);
            this.cancelled.delete(request.runId);
        }
    }
}
