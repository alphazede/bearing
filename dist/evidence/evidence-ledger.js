import { OUTCOME_CLASSES } from "./contracts.js";
const MAX_ID = 128, MAX_TEXT = 4_096, MAX_HREF = 512, MAX_REFS = 64, MAX_ANCESTRY = 32, MAX_RECORDS = 1_000;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/, MIME = /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/;
const keys = (value, required, optional = []) => !!value && typeof value === "object" && !Array.isArray(value) && required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
const text = (value, max = MAX_TEXT) => typeof value === "string" && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
const id = (value) => text(value, MAX_ID) && ID.test(value);
const ids = (value, max = MAX_REFS) => Array.isArray(value) && value.length <= max && value.every(id) && new Set(value).size === value.length;
const validOutcome = (value) => typeof value === "string" && OUTCOME_CLASSES.includes(value);
const href = (value) => text(value, MAX_HREF) && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) && value.split("/").every((part) => part !== "." && part !== "..");
const hash = (value) => typeof value === "string" && /^(?:sha256:[a-f0-9]{64}|sha512:[a-f0-9]{128})$/.test(value);
const mediaType = (value) => text(value, 127) && MIME.test(value);
const deepFreeze = (value) => { if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value))
        deepFreeze(child);
    Object.freeze(value);
} return value; };
const copy = (value) => structuredClone(value);
const frozenCopy = (value) => deepFreeze(copy(value));
const evidenceShape = (value, publicOnly = false) => keys(value, publicOnly ? ["id", "kind", "summary", "href", "hash", "textEquivalent", "outcome"] : ["id", "kind", "summary", "outcome"], publicOnly ? [] : ["href", "hash", "textEquivalent"]) && id(value.id) && ["observation", "receipt", "artifact"].includes(value.kind) && text(value.summary) && (value.href === undefined || href(value.href)) && (value.hash === undefined || hash(value.hash)) && (value.textEquivalent === undefined || text(value.textEquivalent)) && (!publicOnly || text(value.textEquivalent)) && validOutcome(value.outcome) && (!publicOnly || value.outcome !== "redacted" || (value.summary === "Redacted evidence" && value.href === undefined && value.hash === undefined && value.textEquivalent === "Redacted evidence"));
const artifactShape = (value) => keys(value, ["id", "evidenceId", "name", "mediaType", "textEquivalent"]) && id(value.id) && id(value.evidenceId) && text(value.name) && mediaType(value.mediaType) && text(value.textEquivalent);
const claimShape = (value) => keys(value, ["id", "text", "evidenceIds", "outcome"], ["owner"]) && id(value.id) && text(value.text) && ids(value.evidenceIds) && validOutcome(value.outcome) && (value.owner === undefined || text(value.owner, MAX_ID));
const findingShape = (value) => keys(value, ["id", "claimId", "surveyId", "summary", "outcome"]) && id(value.id) && id(value.claimId) && id(value.surveyId) && text(value.summary) && ["failed", "blocked", "deviated"].includes(value.outcome);
const decisionShape = (value) => keys(value, ["id", "findingId", "decision", "summary"]) && id(value.id) && id(value.findingId) && ["approved", "rejected", "deferred"].includes(value.decision) && text(value.summary);
const remediationShape = (value) => keys(value, ["id", "findingId", "decisionId", "summary", "evidenceIds"]) && id(value.id) && id(value.findingId) && id(value.decisionId) && text(value.summary) && ids(value.evidenceIds);
const surveyShape = (value) => keys(value, ["id", "claimId", "surveyorSessionId", "executionAncestry", "certifiesSessionId", "outcome", "summary"], ["remediationId"]) && id(value.id) && id(value.claimId) && id(value.surveyorSessionId) && ids(value.executionAncestry, MAX_ANCESTRY) && id(value.certifiesSessionId) && validOutcome(value.outcome) && (value.remediationId === undefined || id(value.remediationId)) && text(value.summary);
export const assertPublicClaims = (value) => { if (!Array.isArray(value) || value.length > MAX_RECORDS || !value.every(claimShape))
    throw new Error("invalid_public_claims"); };
/** Rejects fabricated or unbounded objects before a report template sees them. */
export const assertPublicLedger = (value) => {
    if (!keys(value, ["evidence", "artifacts", "claims", "findings", "decisions", "remediations", "surveys"]))
        throw new Error("invalid_public_ledger");
    const groups = [value.evidence, value.artifacts, value.claims, value.findings, value.decisions, value.remediations, value.surveys];
    if (groups.some((group) => !Array.isArray(group) || group.length > MAX_RECORDS) || !value.evidence.every((entry) => evidenceShape(entry, true)) || !value.artifacts.every(artifactShape) || !value.claims.every(claimShape) || !value.findings.every(findingShape) || !value.decisions.every(decisionShape) || !value.remediations.every(remediationShape) || !value.surveys.every(surveyShape))
        throw new Error("invalid_public_ledger");
    const all = groups.flat(), unique = new Set(all.map((entry) => entry.id));
    const evidence = new Map(value.evidence.map((entry) => [entry.id, entry])), claims = new Map(value.claims.map((entry) => [entry.id, entry])), findings = new Map(value.findings.map((entry) => [entry.id, entry])), decisions = new Map(value.decisions.map((entry) => [entry.id, entry])), remediations = new Map(value.remediations.map((entry) => [entry.id, entry])), surveys = new Map(value.surveys.map((entry) => [entry.id, entry]));
    const supported = (ids) => ids.length > 0 && ids.every((entry) => evidence.get(entry)?.outcome === "passed");
    if (unique.size !== all.length
        || value.artifacts.some((entry) => !evidence.has(entry.evidenceId) || (evidence.get(entry.evidenceId)?.outcome === "redacted" && (entry.name !== "Redacted artifact" || entry.mediaType !== "text/plain" || entry.textEquivalent !== "Redacted artifact")))
        || value.claims.some((entry) => entry.evidenceIds.some((id) => !evidence.has(id)) || (entry.outcome === "passed" && !supported(entry.evidenceIds)))
        || value.findings.some((entry) => { const survey = surveys.get(entry.surveyId); return !claims.has(entry.claimId) || !survey || survey.claimId !== entry.claimId || survey.outcome === "passed"; })
        || value.decisions.some((entry) => !findings.has(entry.findingId))
        || value.remediations.some((entry) => { const decision = decisions.get(entry.decisionId); return !findings.has(entry.findingId) || !decision || decision.findingId !== entry.findingId || decision.decision !== "approved" || !supported(entry.evidenceIds); })
        || value.surveys.some((entry, index) => { const previous = value.surveys.slice(0, index).filter((survey) => survey.claimId === entry.claimId), remediation = entry.remediationId === undefined ? undefined : remediations.get(entry.remediationId); return !claims.has(entry.claimId) || entry.executionAncestry.length > 0 || entry.surveyorSessionId === entry.certifiesSessionId || (!previous.length && entry.remediationId !== undefined) || (entry.outcome === "passed" && !supported(previous.length ? remediation?.evidenceIds ?? [] : claims.get(entry.claimId).evidenceIds)) || (previous.length > 0 && (!remediation || findings.get(remediation.findingId)?.claimId !== entry.claimId || previous.some((survey) => survey.surveyorSessionId === entry.surveyorSessionId))); }))
        throw new Error("invalid_public_ledger");
};
/** In-memory, append-only ledger. A fresh instance is reconstructed from durable records by its caller. */
export class EvidenceLedger {
    #evidence = new Map();
    #artifacts = new Map();
    #claims = new Map();
    #findings = new Map();
    #decisions = new Map();
    #remediations = new Map();
    #surveys = new Map();
    #claimEvidence = new Map();
    recordEvidence(value) { this.unique(value); if (!evidenceShape(value))
        throw new Error("invalid_evidence"); return this.put(this.#evidence, value); }
    recordArtifact(value) { this.unique(value); if (!artifactShape(value) || !this.#evidence.has(value.evidenceId))
        throw new Error("invalid_artifact"); return this.put(this.#artifacts, value); }
    recordClaim(value) {
        this.unique(value);
        if (!claimShape(value))
            throw new Error("invalid_claim");
        if (!this.references(this.#evidence, value.evidenceIds))
            throw new Error("missing_evidence_reference");
        if (value.outcome === "passed" && !this.supported(value.evidenceIds))
            throw new Error("unsupported_claim");
        const saved = this.put(this.#claims, value);
        this.#claimEvidence.set(saved.id, new Set(saved.evidenceIds));
        return saved;
    }
    recordFinding(value) { this.unique(value); const survey = this.#surveys.get(value.surveyId); if (!findingShape(value) || !survey || survey.claimId !== value.claimId || survey.outcome === "passed" || !this.#claims.has(value.claimId))
        throw new Error("invalid_finding"); return this.put(this.#findings, value); }
    recordOwnerDecision(value) { this.unique(value); if (!decisionShape(value) || !this.#findings.has(value.findingId))
        throw new Error("invalid_owner_decision"); return this.put(this.#decisions, value); }
    recordRemediation(value) {
        this.unique(value);
        const decision = this.#decisions.get(value.decisionId);
        if (!remediationShape(value) || !this.#findings.has(value.findingId) || !decision || decision.findingId !== value.findingId || decision.decision !== "approved" || !this.references(this.#evidence, value.evidenceIds) || !this.supported(value.evidenceIds))
            throw new Error("invalid_remediation");
        return this.put(this.#remediations, value);
    }
    recordSurvey(value) {
        this.unique(value);
        const claim = this.#claims.get(value.claimId), previous = [...this.#surveys.values()].filter((survey) => survey.claimId === value.claimId);
        if (!surveyShape(value) || !claim || value.executionAncestry.length > 0)
            throw new Error("invalid_survey");
        if (value.surveyorSessionId === value.certifiesSessionId)
            throw new Error("self_certification");
        const remediation = value.remediationId === undefined ? undefined : this.#remediations.get(value.remediationId);
        if (!previous.length && value.remediationId !== undefined)
            throw new Error("resurvey_requires_remediation");
        if (previous.length && (!remediation || this.#findings.get(remediation.findingId)?.claimId !== value.claimId || previous.some((survey) => survey.surveyorSessionId === value.surveyorSessionId)))
            throw new Error("resurvey_requires_remediation");
        if (value.outcome === "passed" && !this.supported(previous.length ? remediation?.evidenceIds ?? [] : this.#claimEvidence.get(value.claimId) ?? []))
            throw new Error("unsupported_claim");
        return this.put(this.#surveys, value);
    }
    projectPublic() {
        const evidence = [...this.#evidence.values()].map((entry) => entry.outcome === "redacted" ? { id: entry.id, kind: entry.kind, summary: "Redacted evidence", href: undefined, hash: undefined, textEquivalent: "Redacted evidence", outcome: entry.outcome } : { id: entry.id, kind: entry.kind, summary: entry.summary, href: entry.href, hash: entry.hash, textEquivalent: entry.textEquivalent ?? entry.summary, outcome: entry.outcome });
        const redacted = new Set(evidence.filter((entry) => entry.outcome === "redacted").map((entry) => entry.id));
        const artifacts = [...this.#artifacts.values()].map((entry) => redacted.has(entry.evidenceId) ? { id: entry.id, evidenceId: entry.evidenceId, name: "Redacted artifact", mediaType: "text/plain", textEquivalent: "Redacted artifact" } : entry);
        const ledger = frozenCopy({ evidence, artifacts, claims: [...this.#claims.values()], findings: [...this.#findings.values()], decisions: [...this.#decisions.values()], remediations: [...this.#remediations.values()], surveys: [...this.#surveys.values()] });
        assertPublicLedger(ledger);
        return ledger;
    }
    unique(value) { if (!id(value?.id) || this.#allIds().has(value.id) || this.#allIds().size >= MAX_RECORDS * 7)
        throw new Error("duplicate_id"); }
    #allIds() { return new Set([...this.#evidence.keys(), ...this.#artifacts.keys(), ...this.#claims.keys(), ...this.#findings.keys(), ...this.#decisions.keys(), ...this.#remediations.keys(), ...this.#surveys.keys()]); }
    references(map, values) { return values.every((entry) => map.has(entry)); }
    supported(values) { const ids = [...values]; return ids.length > 0 && ids.every((entry) => this.#evidence.get(entry)?.outcome === "passed"); }
    put(map, value) { if (map.size >= MAX_RECORDS)
        throw new Error("record_limit"); const saved = frozenCopy(value); map.set(saved.id, saved); return copy(saved); }
}
