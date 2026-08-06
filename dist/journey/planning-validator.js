import { createHash } from "node:crypto";
import { artifactComplete, parsePlanDocuments, structuralFindings, } from "./plan-structure.js";
export function foldVerdict(findings) {
    if (findings.some((finding) => finding.severity === "amendment"))
        return "NEEDS_AMENDMENT";
    if (findings.some((finding) => finding.severity === "owner_decision"))
        return "OWNER_DECISION_REQUIRED";
    return "PASS";
}
function finding(code, severity, artifact, observed, required, remedy, sliceId) {
    return { code, severity, artifact, ...(sliceId ? { sliceId } : {}), observed: observed.slice(0, 512), required, remedy };
}
function section(content, heading) {
    const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`^##[ \\t]+${escaped}[ \\t]*\\r?\\n([\\s\\S]*?)(?=^##[ \\t]+|(?![\\s\\S]))`, "mi").exec(content)?.[1]?.trim() ?? "";
}
function markdownHeadings(content) {
    return [...content.matchAll(/^(#{1,6})[ \t]+(.+?)[ \t]*\r?$/gm)].map((match) => ({
        level: match[1].length,
        title: match[2].trim(),
        start: match.index,
        contentStart: match.index + match[0].length,
    }));
}
function headingSection(content, headings, index, limit) {
    const heading = headings[index];
    const next = headings.slice(index + 1).find((candidate) => candidate.start < limit && candidate.level <= heading.level);
    return content.slice(heading.contentStart, next?.start ?? limit).trim();
}
function assertsPresence(clause, evidence) {
    const value = clause.trim();
    if (!value || /^(?:-|tbd|todo|n\/a|none)\.?$/i.test(value))
        return false;
    const absentClause = /^(?:unavailable|unassigned|unowned|unbound|absent|missing|pending|future|planned)\b|^no\b.{0,120}\b(?:assigned|available|owned|bound|present|scheduled|performed|ready)\b|\b(?:is|are|was|were|remains?)\s+(?:(?:currently|still|presently)\s+)?(?:unavailable|unassigned|unowned|unbound|absent|missing|pending|not\s+(?:assigned|available|owned|bound|present|scheduled|performed|ready))\b/i;
    if (!evidence)
        return !absentClause.test(value);
    const matches = value.matchAll(new RegExp(evidence.source, evidence.flags.includes("g") ? evidence.flags : `${evidence.flags}g`));
    for (const match of matches) {
        const before = value.slice(0, match.index);
        const after = value.slice(match.index + match[0].length);
        if (/\b(?:no|none|not)(?:\s+\w+)?\s*$/i.test(before)
            || /\b(?:never|without)(?:\s+(?:an?|the))?(?:\s+\w+)?\s*$/i.test(before)
            || /\b(?:do|does|did|is|are|was|were|can|could|will|would|shall|should|may|might|must)\s+not\s*$/i.test(before)
            || /^(?:unavailable|unassigned|unowned|unbound|absent|missing|pending)\b/i.test(match[0])
            || /^\s*(?:unavailable|unassigned|unowned|unbound|absent|missing|pending)\b/i.test(after)
            || /^\s*(?:cannot|can't|can\s+not|could\s+not|does?\s+not|did\s+not)\b/i.test(after)
            || /^\s*(?:is|are|was|were|remains?)\s+(?:(?:currently|still|presently)\s+)?(?:not|never|unavailable|unassigned|unowned|unbound|absent|missing|pending)\b/i.test(after)
            || /^\s*never\s+(?:occurs?|happens?|materiali[sz]es?)\b/i.test(after)
            || /^\s*without\s+(?:independence|independent\s+review|ownership|authority|binding)\b/i.test(after))
            continue;
        return true;
    }
    return false;
}
function traceabilityFindings(model) {
    const findings = [];
    const tracedPlanIds = new Set([...model.traceRows.values()].flatMap((row) => [...row.requirements]));
    for (const id of model.planIds) {
        if (!tracedPlanIds.has(id))
            findings.push(finding("traceability_broken", "amendment", "plan-spec.md", id, "every AC and RISK id must reach a traceability row", "add a proof row for the identifier"));
    }
    for (const [id, row] of model.traceRows) {
        if (!row.commands.size)
            findings.push(finding("traceability_broken", "amendment", "seit.md", id, "every traceability row must reach an evidence command", "add a declared command to the row"));
        for (const requirement of row.requirements) {
            if (!model.planIds.has(requirement))
                findings.push(finding("traceability_broken", "amendment", "seit.md", requirement, "every trace-row requirement must be declared in the plan", "declare or remove the dangling requirement", id));
        }
        for (const design of row.designs) {
            if (!model.designIds.has(design))
                findings.push(finding("traceability_broken", "amendment", "seit.md", design, "every trace-row design id must be declared in the design", "declare or remove the dangling design id", id));
        }
        for (const command of row.commands) {
            if (!model.requiredCommands.has(command))
                findings.push(finding("traceability_broken", "amendment", "seit.md", command, "every trace-row command must be declared under Required Commands", "declare or remove the dangling command", id));
        }
    }
    for (const [id, slice] of model.slices) {
        const rows = [...slice.proofRowIds].flatMap((rowId) => {
            const row = model.traceRows.get(rowId);
            return row ? [row] : [];
        });
        const requirements = new Set(rows.flatMap((row) => [...row.requirements]));
        const designs = new Set(rows.flatMap((row) => [...row.designs]));
        for (const requirement of slice.requirementIds) {
            if (!requirements.has(requirement))
                findings.push(finding("traceability_broken", "amendment", "implementation.md", requirement, "each slice requirement must be reachable through its own SEIT proof rows", "add a matching proof row or remove the requirement", id));
        }
        for (const design of slice.designIds) {
            if (!designs.has(design))
                findings.push(finding("traceability_broken", "amendment", "implementation.md", design, "each slice design id must be reachable through its own SEIT proof rows", "add a matching proof row or remove the design id", id));
        }
    }
    return findings;
}
function dependencyFindings(model) {
    const nodes = new Set([
        ...model.slices.keys(),
        ...model.dependencies.keys(),
        ...[...model.dependencies.values()].flatMap((targets) => [...targets]),
    ]);
    const indegree = new Map([...nodes].map((node) => [node, 0]));
    for (const [source, targets] of model.dependencies) {
        if (!nodes.has(source))
            continue;
        for (const target of targets)
            if (nodes.has(target))
                indegree.set(target, (indegree.get(target) ?? 0) + 1);
    }
    const ready = [...indegree].filter(([, count]) => count === 0).map(([id]) => id);
    let visited = 0;
    while (ready.length) {
        const source = ready.shift();
        visited += 1;
        for (const target of model.dependencies.get(source) ?? []) {
            if (!indegree.has(target))
                continue;
            const next = indegree.get(target) - 1;
            indegree.set(target, next);
            if (next === 0)
                ready.push(target);
        }
    }
    return visited === nodes.size ? [] : [
        finding("dependency_cycle", "amendment", "implementation.md", [...indegree].filter(([, count]) => count > 0).map(([id]) => id).join(", "), "slice dependencies must form an acyclic graph", "remove or reverse an edge in the cycle"),
    ];
}
function validationFindings(model) {
    const findings = [];
    for (const [id, manifest] of model.manifests) {
        if (!manifest.commandIds.size)
            findings.push(finding("validation_missing", "amendment", "implementation.md", "no evidence command", "every slice must declare an evidence command", "add a focused command", id));
    }
    for (const [id, row] of model.traceRows) {
        const failureEvidence = /\b(?:does\s+not(?!\s+(?:fail|reject|error|den[iy]|block|refus|stop|escalat|prevent)\w*)|never(?!\s+(?:fail|reject|error|den[iy]|block|refus|stop|escalat|prevent)\w*)|(?:creat|grant|produc|issu|writ|record|leav)\w*\s+(?:no|zero)(?!\s+(?:fail|error|denial|rejection)\w*)|fail|reject|error|missing|den[iy]|block|refus|stop|cannot|unchanged|finding|non-?zero|escalat|prevent|omit|mismatch|conflict|cycle|unsafe)\w*\b/i;
        if (!assertsPresence(row.negativeCase, failureEvidence)) {
            findings.push(finding("validation_missing", "amendment", "seit.md", row.negativeCase, "the negative/failure case must describe an observable failure", "state how the seeded defect fails", id));
        }
    }
    return findings;
}
function sharedPaths(model) {
    const index = new Map();
    for (const [id, manifest] of model.manifests) {
        for (const path of new Set(manifest.writeSetPaths)) {
            const owners = index.get(path) ?? [];
            owners.push(id);
            index.set(path, owners);
        }
    }
    return index;
}
function parallelismFindings(model) {
    const findings = [];
    for (const [wave, sliceIds] of model.waves) {
        const paths = new Map();
        for (const id of sliceIds) {
            for (const path of model.manifests.get(id)?.writeSetPaths ?? []) {
                const prior = paths.get(path);
                if (prior && prior !== id)
                    findings.push(finding("parallelism_unsafe", "amendment", "implementation.md", `${path}: ${prior}, ${id}`, "same-wave slice write sets must be disjoint", `move one slice out of Wave ${wave} or separate the write sets`, id));
                else
                    paths.set(path, id);
            }
        }
    }
    return findings;
}
function integrationFindings(model) {
    const findings = [];
    for (const [path, sliceIds] of sharedPaths(model)) {
        for (const waveSliceIds of model.waves.values()) {
            const concurrentSliceIds = sliceIds.filter((id) => waveSliceIds.has(id));
            if (concurrentSliceIds.length < 2)
                continue;
            const owners = concurrentSliceIds.filter((id) => {
                const declared = /^\*\*Integration owner\.\*\*\s*(.+)$/mi.exec(model.manifests.get(id)?.raw ?? "")?.[1]?.trim();
                if (!declared || !assertsPresence(declared))
                    return false;
                return declared === id || declared === path || declared?.includes(`\`${path}\``);
            });
            const reviewEvidence = /\b(?:(?:native|independent|peer)(?:\s+review)?|surveyor(?:\s+review)?)\b/i;
            const independentReview = concurrentSliceIds.some((id) => (model.slices.get(id)?.fields.get("Review path") ?? "")
                .split(/[.;]/)
                .some((clause) => assertsPresence(clause, reviewEvidence)));
            if (owners.length !== 1 || !independentReview)
                findings.push(finding("integration_unowned", "owner_decision", "implementation.md", `${path}: ${concurrentSliceIds.join(", ")}`, "shared integration paths need one owning slice and an independent review path", owners.length !== 1 ? "designate exactly one touching slice as the integration owner" : "assign an independent review path"));
        }
    }
    return findings;
}
function ambiguityFindings(model) {
    const findings = [];
    const ambiguous = /\b(?:TBD|TODO|decide later|one of)\b|\beither\b.{0,120}\bor\b/i;
    const acceptance = section(model.documents.plan, "Acceptance criteria");
    if (ambiguous.test(acceptance))
        findings.push(finding("contract_ambiguous", "owner_decision", "plan-spec.md", acceptance, "acceptance criteria must not contain unresolved alternatives", "ask the owner to choose the contract"));
    for (const line of model.documents.design.split(/\r?\n/)) {
        if (/^\s*(?:(?:[-*+]|#{1,6})\s+)?\*{0,2}(?:DES|CONTRACT)-[A-Za-z0-9._-]+\*{0,2}\s*(?:[—–:.]|$)/i.test(line) && ambiguous.test(line)) {
            findings.push(finding("contract_ambiguous", "owner_decision", "design.md", line.trim(), "a binding design contract must not contain an unresolved alternative", "ask the owner to settle the design contract"));
        }
    }
    for (const [id, slice] of model.slices) {
        const goal = slice.fields.get("Goal") ?? "";
        if (ambiguous.test(goal))
            findings.push(finding("contract_ambiguous", "owner_decision", "implementation.md", goal, "a slice Goal must state one settled outcome", "ask the owner to settle the Goal", id));
    }
    for (const [id, manifest] of model.manifests) {
        for (const name of ["Stop condition", "Human decision"]) {
            const value = manifest.fields.get(name) ?? "";
            if (ambiguous.test(value))
                findings.push(finding("contract_ambiguous", "owner_decision", "implementation.md", value, `${name} must not contain an unresolved alternative`, "ask the owner to settle the contract", id));
        }
        const stop = manifest.fields.get("Stop condition") ?? "";
        if (stop && !/\b(?:if|when|unless|fails?|failure|passes?|returns?|reproduces?|requires?|cannot)\b/i.test(stop)) {
            findings.push(finding("contract_ambiguous", "owner_decision", "implementation.md", stop, "the stop condition must contain a falsifiable predicate", "state the observable condition that stops the slice", id));
        }
    }
    return findings;
}
function phaseControlFindings(model) {
    if (!artifactComplete(model.documents.plan, "plan-spec", []))
        return [];
    const controls = ["Entry criteria", "Exit criteria", "Rollback or repair", "Accountable controller"];
    const headings = markdownHeadings(model.documents.plan);
    const phases = headings
        .map((heading, index) => ({ heading, index }))
        .filter(({ heading }) => /^Phase\s+(?=[A-Za-z0-9.-]*\d)[A-Za-z0-9.-]+(?:\s|$)/i.test(heading.title));
    if (phases.length) {
        return phases.flatMap(({ heading: phase }, phaseIndex) => {
            const limit = phases[phaseIndex + 1]?.heading.start ?? model.documents.plan.length;
            return controls.flatMap((name) => {
                const controlIndex = headings.findIndex((candidate) => candidate.start >= phase.contentStart
                    && candidate.start < limit
                    && candidate.title.localeCompare(name, undefined, { sensitivity: "accent" }) === 0);
                const value = controlIndex < 0 ? "" : headingSection(model.documents.plan, headings, controlIndex, limit);
                return assertsPresence(value)
                    ? []
                    : [finding("phase_control_missing", "advisory", "plan-spec.md", `${phase.title}: ${name}`, `${phase.title} must name ${name.toLowerCase()}`, `add the ${name} control to ${phase.title}`)];
            });
        });
    }
    return controls.flatMap((name) => {
        const value = section(model.documents.plan, name);
        return assertsPresence(value)
            ? []
            : [finding("phase_control_missing", "advisory", "plan-spec.md", name, `the phase must name ${name.toLowerCase()}`, `add the ${name} control`)];
    });
}
function reconFindings(model) {
    const requiresRecon = /\b(?:requires?|requiring)\s+Recon\b/i.test(model.documents.design);
    const bindingEvidence = /\b(?:Recon report|reconReport)\s+(?:is\s+)?bound\b|\bbound\s+(?:Recon report|reconReport)\b/i;
    const reportBound = `${model.documents.plan}\n${model.documents.implementation}`
        .split(/[\r\n.;]+/)
        .some((clause) => assertsPresence(clause, bindingEvidence));
    return requiresRecon && !reportBound
        ? [finding("recon_recommended", "owner_decision", "design.md", "assumption requires Recon", "a material Recon assumption needs an owner decision or a bound report", "run Recon or record the owner's decision to skip it")]
        : [];
}
function semanticFindings(model) {
    return [
        ...traceabilityFindings(model),
        ...dependencyFindings(model),
        ...validationFindings(model),
        ...parallelismFindings(model),
        ...integrationFindings(model),
        ...ambiguityFindings(model),
        ...phaseControlFindings(model),
        ...reconFindings(model),
    ];
}
function contentHash(documents) {
    const hash = createHash("sha256");
    for (const [name, content] of [
        ["plan-spec.md", documents.plan],
        ["design.md", documents.design],
        ["seit.md", documents.seit],
        ["implementation.md", documents.implementation],
    ])
        hash.update(`${name}\0${Buffer.byteLength(content)}\0${content}`);
    return hash.digest("hex");
}
export function validatePlan(input) {
    const model = parsePlanDocuments(input.documents);
    const findings = [...structuralFindings(model), ...semanticFindings(model)];
    findings.sort((left, right) => left.artifact.localeCompare(right.artifact)
        || (left.sliceId ?? "").localeCompare(right.sliceId ?? "")
        || left.code.localeCompare(right.code)
        || left.observed.localeCompare(right.observed));
    return {
        verdict: foldVerdict(findings),
        findings,
        checkedContentHash: contentHash(input.documents),
    };
}
