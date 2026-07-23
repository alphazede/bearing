import type { Claim, PublicLedger } from "../evidence/contracts.js";
import { assertPublicClaims, assertPublicLedger } from "../evidence/evidence-ledger.js";

const MAX_ROWS = 100, MAX_SVG_ROWS = 12;
const escape = (value: string): string => value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
const label = (value: string): string => value.replaceAll("-", " ");
const rows = <T>(values: readonly T[]): readonly T[] => values.slice(0, MAX_ROWS);
export function renderLaunchReadinessSvg(claims: readonly Claim[]): string {
  assertPublicClaims(claims);
  const shown = claims.slice(0, MAX_SVG_ROWS), body = shown.map((claim, index) => `<text x="24" y="${48 + index * 24}">${escape(claim.id)}: ${escape(label(claim.outcome))}</text>`).join(""), height = Math.max(96, 72 + shown.length * 24);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 720 ${height}" role="img" aria-labelledby="readiness-title readiness-desc"><title id="readiness-title">Launch readiness</title><desc id="readiness-desc">${escape(`${shown.length} of ${claims.length} claims: ${shown.map((claim) => `${claim.id} ${claim.outcome}`).join(", ") || "no claims"}`)}</desc><rect width="100%" height="100%" fill="#fff" stroke="#222"/><text x="24" y="28">Launch readiness evidence</text>${body}</svg>`;
}

/** Fixed native template; intentionally consumes only the ledger's public projection. */
export class ReportRenderer {
  render(ledger: PublicLedger, title = "Bearing evidence report"): string {
    if (typeof title !== "string" || title.length === 0 || title.length > 128 || /[\x00-\x1f\x7f]/.test(title)) throw new Error("invalid_report_title");
    assertPublicLedger(ledger); const svg = renderLaunchReadinessSvg(ledger.claims);
    const claims = rows(ledger.claims).map((claim) => `<li><strong>${escape(claim.id)}</strong> — ${escape(claim.text)} <span>[${escape(label(claim.outcome))}]</span></li>`).join("");
    const evidence = rows(ledger.evidence).map((item) => `<li><strong>${escape(item.id)}</strong> — ${escape(item.summary)} [${escape(label(item.outcome))}]${item.href ? ` <a href="${escape(item.href)}">evidence link</a>` : ""}${item.hash ? ` <code>${escape(item.hash)}</code>` : ""}<br><span>${escape(item.textEquivalent)}</span></li>`).join("");
    const artifacts = rows(ledger.artifacts).map((item) => `<li><strong>${escape(item.name)}</strong> (${escape(item.mediaType)}) — ${escape(item.textEquivalent)}</li>`).join("");
    const findings = rows(ledger.findings).map((item) => `<li>${escape(item.id)} — ${escape(item.summary)} [${escape(label(item.outcome))}]</li>`).join("");
    const history = rows(ledger.surveys).map((item) => `<li>${escape(item.id)} — ${escape(item.claimId)} [${escape(label(item.outcome))}]${item.remediationId ? ` after ${escape(item.remediationId)}` : ""} — ${escape(item.summary)}</li>`).join("");
    const decisions = rows(ledger.decisions).map((item) => `<li>${escape(item.id)} — ${escape(item.decision)} — ${escape(item.summary)}</li>`).join("");
    const remediations = rows(ledger.remediations).map((item) => `<li>${escape(item.id)} — ${escape(item.summary)} [evidence: ${escape(item.evidenceIds.join(", "))}]</li>`).join("");
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)} evidence report</title><style>body{font:16px system-ui,sans-serif;max-width:900px;margin:auto;padding:2rem;color:#111;background:#fff}svg{max-width:100%;height:auto}code{overflow-wrap:anywhere}li{margin:.5rem 0}</style></head><body><main><h1>${escape(title)} evidence report</h1><p>Offline, public-safe evidence projection. Outcomes are recorded, not inferred.</p><section aria-labelledby="overview"><h2 id="overview">Evidence overview</h2>${svg}<p>Text equivalent: ${escape(ledger.claims.map((claim) => `${claim.id}: ${claim.outcome}`).join("; ") || "No claims.")}</p></section><section><h2>Claims</h2><ul>${claims}</ul></section><section><h2>Evidence</h2><ul>${evidence}</ul></section><section><h2>Artifacts</h2><ul>${artifacts}</ul></section><section><h2>Findings</h2><ul>${findings}</ul></section><section><h2>Owner decisions</h2><ul>${decisions}</ul></section><section><h2>Remediations</h2><ul>${remediations}</ul></section><section><h2>Survey history</h2><ul>${history}</ul></section></main></body></html>`;
  }
}
