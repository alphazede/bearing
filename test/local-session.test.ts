import { afterEach, describe, expect, it } from "vitest";
import { request as httpRequest } from "node:http";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { LauncherDeps } from "../src/cli";
import { run } from "../src/cli";
import {
  LocalSessionService,
  SESSION_COOKIE_NAME,
  createRequestHandler,
  greetingFor,
  unnamedGreetingFor,
  readCookie,
} from "../src/server/local-session.js";

const servers: Server[] = [];
const roots: string[] = [];
afterEach(async () => {
  while (servers.length) {
    const s = servers.pop()!;
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
  while (roots.length) {
    await rm(roots.pop()!, { recursive: true, force: true });
  }
});

interface Resp {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function call(
  port: number,
  opts: { method: string; path: string; headers?: Record<string, string>; body?: string },
): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        method: opts.method,
        path: opts.path,
        headers: opts.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

async function launch(): Promise<{ port: string; cap: string }> {
  const out: string[] = [];
  const d: Required<LauncherDeps> = {
    openBrowser: () => {},
    stdout: { write: (s: string) => { out.push(s); return true; } },
    stderr: { write: (s: string) => { out.push(s); return true; } },
    exit: () => {
      throw new Error("unexpected exit");
    },
  };
  const server = await run(["start", "--no-open"], d);
  if (!server) throw new Error("server did not start");
  servers.push(server);
  const url = new URL(out.join("").trim());
  const cap = /^#cap=([0-9a-f]+)$/.exec(url.hash)?.[1];
  if (!cap) throw new Error("no capability in launch URL");
  return { port: url.port, cap };
}

function sessionHeaders(port: string, extra: Record<string, string> = {}): Record<string, string> {
  return { origin: `http://127.0.0.1:${port}`, "content-type": "application/json", ...extra };
}

async function tempRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "bearing-session-"));
  roots.push(root);
  return root;
}

async function exchangeCookie(port: string, cap: string): Promise<string> {
  const r = await call(port, {
    method: "POST",
    path: "/api/v1/session",
    headers: sessionHeaders(port),
    body: JSON.stringify({ capability: cap }),
  });
  expect(r.status).toBe(200);
  const sc = r.headers["set-cookie"];
  if (!Array.isArray(sc)) throw new Error("missing Set-Cookie");
  return sc[0].split(";")[0];
}

describe("LocalSessionService unit", () => {
  it("rotates stable owner greetings by local date, time, and weekend", () => {
    const at = (year: number, month: number, date: number, hour: number) => new Date(year, month, date, hour);
    const mondayMorning = at(2026, 6, 20, 9);
    expect(greetingFor("Smokie", mondayMorning)).toBe(greetingFor("Smokie", mondayMorning));
    expect(greetingFor("Smokie", mondayMorning)).toContain("Smokie");
    expect(greetingFor("Smokie", at(2026, 6, 20, 13))).toMatch(/afternoon|Afternoon|Welcome back/);
    expect(greetingFor("Smokie", at(2026, 6, 20, 19))).toMatch(/evening|Evening/);
    expect(greetingFor("Smokie", at(2026, 6, 20, 23))).toMatch(/midnight oil|Late-night|exploring|trail is quiet|Night-owl/);
    expect(greetingFor("Smokie", at(2026, 6, 25, 9))).toContain("Weekend");
    expect(greetingFor("Smokie", at(2026, 6, 26, 23))).toMatch(/weekend|Weekend/);
    const weekdayMornings = [20, 21, 22, 23, 24, 27, 28, 29, 30, 31].map((date) => greetingFor("Smokie", at(2026, 6, date, 9)));
    expect(new Set(weekdayMornings).size).toBeGreaterThanOrEqual(3);
  });

  it("provides a time-aware unnamed greeting before repository selection", () => {
    expect(unnamedGreetingFor(new Date(2026, 6, 20, 9))).toBe("Good morning. What are we working on today?");
    expect(unnamedGreetingFor(new Date(2026, 6, 20, 13))).toBe("Good afternoon. What are we building today?");
    expect(unnamedGreetingFor(new Date(2026, 6, 20, 23))).toBe("Burning the midnight oil? What's on your mind to build?");
    expect(unnamedGreetingFor(new Date(2026, 6, 25, 19))).toContain("Weekend warrior");
  });

  it("issues a distinct high-entropy capability and validates Host/Origin", () => {
    const a = new LocalSessionService("127.0.0.1:5000");
    const b = new LocalSessionService("127.0.0.1:5000");
    expect(a.capability).toMatch(/^[0-9a-f]{64}$/);
    expect(a.capability).not.toBe(b.capability);
    expect(a.validHost("127.0.0.1:5000")).toBe(true);
    expect(a.validHost("127.0.0.1:5001")).toBe(false);
    expect(a.validHost(undefined)).toBe(false);
    expect(a.validOrigin("http://127.0.0.1:5000")).toBe(true);
    expect(a.validOrigin(undefined)).toBe(false);
    expect(a.validOrigin("https://127.0.0.1:5000")).toBe(false);
    expect(a.validOrigin("http://localhost:5000")).toBe(false);
    expect(a.validOrigin("http://127.0.0.1:5000/evil")).toBe(false);
    expect(a.validOrigin("null")).toBe(false);
  });

  it("exchanges the capability exactly once and is replay-safe on failure", () => {
    const s = new LocalSessionService("127.0.0.1:5000");
    const first = s.exchange(s.capability);
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.cookieValue).toMatch(/^[0-9a-f]{64}$/);
    // replay of the correct capability fails
    expect(s.exchange(s.capability).ok).toBe(false);
    // a wrong capability does not consume a fresh capability
    const s2 = new LocalSessionService("127.0.0.1:5000");
    expect(s2.exchange("0".repeat(64)).ok).toBe(false);
    expect(s2.exchange(s2.capability).ok).toBe(true);
  });

  it("authenticates only the issued session cookie, constant-time", () => {
    const s = new LocalSessionService("127.0.0.1:5000");
    expect(s.authenticate(undefined)).toBe(false);
    const r = s.exchange(s.capability);
    if (!r.ok) throw new Error("exchange failed");
    expect(s.authenticate(r.cookieValue)).toBe(true);
    expect(s.authenticate("0".repeat(64))).toBe(false);
    expect(s.authenticate(undefined)).toBe(false);
    // before any exchange a fresh service rejects every cookie
    expect(new LocalSessionService("127.0.0.1:5000").authenticate("0".repeat(64))).toBe(false);
  });

  it("parses the named session cookie without exposing unrelated cookies", () => {
    expect(readCookie(undefined, SESSION_COOKIE_NAME)).toBeUndefined();
    expect(readCookie("a=1; bearing_session=abc=123; b=2", SESSION_COOKIE_NAME)).toBe(
      "abc=123",
    );
    expect(
      readCookie("bearing_session=abc; bearing_session=def", SESSION_COOKIE_NAME),
    ).toBeUndefined();
    expect(readCookie("bearing_session=abc=123; other=x=y", SESSION_COOKIE_NAME)).toBe(
      "abc=123",
    );
    expect(readCookie("a=1; b=2", SESSION_COOKIE_NAME)).toBeUndefined();
  });
});

describe("GET / native page and fragment secrecy", () => {
  it("serves the native page and never embeds the capability server-side", async () => {
    const { port, cap } = await launch();
    const r = await call(port, { method: "GET", path: "/" });
    expect(r.status).toBe(200);
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
    expect(r.body).toContain("<title>Bearing</title>");
    expect(r.body).toContain('<link rel="icon" href="data:,">');
    expect(r.body).toContain("history.replaceState");
    expect(r.body).toContain('id="repository-panel" hidden');
    expect(r.body).toContain('id="current-repository" type="button" disabled');
    expect(r.body).toContain('id="browse-repository" type="button" disabled');
    expect(r.body).toContain("/api/v1/repository-options");
    expect(r.body).toContain("var browseAvailable = false");
    expect(r.body).toContain("function restoreRepositoryControls()");
    expect(r.body).toContain("browseRepository.disabled = !browseAvailable");
    expect(r.body).not.toContain('id="provider"');
    expect(r.body).not.toContain('id="model"');
    expect(r.body).toContain('<label for="owner-name">What should we call you?</label><input id="owner-name" type="text" required autocomplete="name" maxlength="80">');
    expect(r.body).toContain('id="route-options"');
    expect(r.body).toContain("document.createElement(\"input\")");
    expect(r.body).toContain('input.type = "radio"');
    expect(r.body).toContain('input.name = "route"');
    expect(r.body).toContain("input.disabled = !route.detected");
    expect(r.body).toContain("input.required = true");
    expect(r.body).toContain('input.addEventListener("change"');
    expect(r.body).toContain("configureRoute(route)");
    expect(r.body).not.toContain("input.checked = true");
    expect(r.body).toContain('Codex CLI');
    expect(r.body).toContain('Claude Code');
    expect(r.body).toContain('Agy');
    expect(r.body).toContain('Grok Build');
    expect(r.body).toContain('OpenCode');
    expect(r.body).toContain('"pi": "Pi"');
    expect(r.body).toContain('statusText.textContent = route.detected ? "Agent detected" : "Agent unavailable"');
    expect(r.body).toContain("routeForm.reportValidity()");
    expect(r.body).toContain("provider: selectedRoute.provider, model: selectedRoute.model");
    expect(r.body).toContain('JSON.stringify({ provider: selectedRoute.provider, model: selectedRoute.model, reasoning: selectedRoute.reasoning })');
    expect(r.body).toContain('var name = ownerName.value.trim()');
    expect(r.body).toContain('document.getElementById("owner-name").addEventListener("input", function () { this.setCustomValidity(""); })');
    expect(r.body).toContain('fetch("/api/v1/owner"');
    expect(r.body).toContain('function revealWork(greeting) { onboardingReady = true;');
    expect(r.body).toContain('revealWork(body.greeting)');
    expect(r.body).toContain('Your name could not be remembered. Try again.');
    expect(r.body).not.toContain('Ready, " + name + ". Your name could not be remembered.');
    expect(r.body).toContain('rememberedGreeting');
    expect(r.body).not.toContain("localStorage");
    expect(r.body).not.toContain("innerHTML");
    expect(r.body).toContain("Repository request failed. Try again.");
    expect(r.body).not.toContain('id="repository-path" name=');
    expect(r.body).not.toContain('for="repository-path"');
    expect(r.body).toContain('alt="A bear in sunglasses working at a tidy office desk."');
    expect(r.body).toContain('src="/assets/bearing-office.png"');
    expect(r.body.match(/src="\/assets\/bearing-title-mark\.png"/g)).toHaveLength(2);
    expect(r.body).toContain('<img class="title-mark" src="/assets/bearing-title-mark.png" alt="">');
    expect(r.body).not.toContain('class="brand-mark"');
    expect(r.body).toContain('class="signature-link" href="https://github.com/alphazede/bearing" target="_blank" rel="noopener noreferrer" aria-label="Open Bearing GitHub repository"');
    expect(r.body).toContain("<figcaption>GitHub repo \u2197</figcaption>");
    expect(r.body).toContain('<nav class="nav-state" aria-label="Runtime status"><a class="repo-switch" href="https://github.com/alphazede/bearing"');
    expect(r.body).not.toContain("github.com/alphazede/developers");
    expect(r.body).toContain("#repository-panel .signature-link{display:block;min-height:84px");
    expect(r.body).toContain('url("/assets/bearing-expedition.png")');
    expect(r.body).not.toContain('<img src="/assets/bearing-expedition.png"');
    expect(r.body).toContain("#repository-panel{max-width:780px;background:var(--s1)}");
    expect(r.body).toContain("#repository-panel .panel-head{padding:11px 16px}");
    expect(r.body).toContain("#repository-panel .repo-card{min-height:84px;padding:12px}");
    expect(r.body).toContain("#repository-panel .signature img{height:58px}");
    expect(r.body).toContain("background:rgba(15,16,17,.78)");
    expect(r.body).toContain("backdrop-filter:blur(8px)");
    expect(r.body).toContain("#repository-panel .repo-grid,.route-options,.route-details{grid-template-columns:1fr}");
    expect(r.body).toContain("#repository-panel .signature-link{display:none}");
    expect(r.body).toContain("--canvas:#010102");
    expect(r.body).toContain("html{zoom:1.2}.token-banner{");
    expect(r.body).toContain(".panel,#repository-panel{background:rgba(15,16,17,.35)");
    expect(r.body).toContain("padding:0 clamp(24px,4vw,72px)");
    expect(r.body).toContain("main{max-width:1180px;margin:0;padding:42px clamp(24px,4vw,72px) 72px}");
    expect(r.body).not.toContain("calc((100vw - 1180px)/2)");
    expect(r.body).toContain("@media(max-width:760px){header{padding:0 16px}");
    expect(r.body).toContain("main{padding:28px 16px 56px}");
    expect(r.body).toContain("/api/v1/repository");
    expect(r.body).toContain("/api/v1/routes");
    expect(r.body).toContain('"/api/v1/routes/" + encodeURIComponent(route.id) + "/models"');
    expect(r.body).toContain("Loading model choices for ");
    expect(r.body).toContain('id="detected-routes"');
    expect(r.body).toContain('Choose a discovered model and a reasoning level');
    expect(r.body).toContain('id="model-choice"');
    expect(r.body).toContain('id="reasoning-choice"');
    expect(r.body).toContain('MVP support is currently limited to Claude Code, Codex, Agy, Grok Build, OpenCode, and Pi.');
    expect(r.body).toContain("detectedRoutes.textContent");
    expect(r.body).toContain('<span class="step">AGENT SETTINGS</span>');
    expect(r.body).toContain('<button class="primary" id="launch-bearing" disabled>Apply settings</button>');
    expect(r.body).toContain('setStatus("Launching Bearing with "');
    expect(r.body).toContain('id="work-form"><div class="chat-heading"');
    expect(r.body).toMatch(/<h2 id="work-greeting">(Good morning|Good afternoon|Good evening|Burning the midnight oil)/);
    expect(r.body).not.toContain("Where should we start?");
    expect(r.body).toContain('id="work-back" type="button" aria-haspopup="dialog"><small>Agent</small>');
    expect(r.body).toContain('class="primary">Embark</button>');
    expect(r.body).toContain('id="app-shell"');
    expect(r.body).toContain('class="journey-rail" aria-label="Journey navigation"');
    expect(r.body).toContain('id="rail-history-list"');
    expect(r.body).toContain('id="workspace-chip"');
    expect(r.body).toContain('id="model-chip"');
    expect(r.body).toContain('id="reasoning-chip"');
    expect(r.body).toContain('data-starter="Add a feature to this codebase."');
    expect(r.body).toContain('.journey-rail{position:sticky');
    expect(r.body).toContain('background:rgba(8,9,10,.35)');
    expect(r.body).toContain('function renderRailHistory(entries)');
    expect(r.body).toContain('function syncShellSummary()');
    expect(r.body).toContain('function openRouteChooser()');
    expect(r.body).toContain('function closeSetupSheets()');
    expect(r.body).toContain('class="panel journey-surface" id="planning-panel"');
    expect(r.body).toContain('class="panel journey-surface" id="plan-review-panel"');
    expect(r.body).toContain('.setup-sheet{position:fixed');
    expect(r.body).toContain('workForm.hidden = false; syncShellSummary(); loadRepositoryOptions()');
    expect(r.body).toContain("Plan for substantial token use.");
    expect(r.body).toContain("consider a higher tier, choose reasoning deliberately");
    expect(r.body).toContain("https://github.com/juliusbrussee/caveman");
    expect(r.body).toContain('workBack.addEventListener("click"');
    expect(r.body).toContain('.compact-back{min-height:32px');
    expect(r.body).toContain('id="work-goal" required maxlength="4096"');
    expect(r.body).not.toContain('id="run-id"');
    expect(r.body).not.toContain('id="work-items"');
    expect(r.body).not.toContain('id="crew-limit"');
    expect(r.body).not.toContain('id="agent-tokens"');
    expect(r.body).not.toContain('id="work-title"');
    expect(r.body).not.toContain('workItems: 1, maxCrewmatesPerExplorer: 3, perAgentTokenEstimate: 4000');
    expect(r.body).toContain('id="planning-panel" hidden');
    expect(r.body).toContain("You choose Explorer or Expedition after implementation.md is ready.");
    expect(r.body).toContain('<h2>Journey</h2>');
    expect(r.body).toContain('id="journey-phase">SET BEARINGS</span>');
    expect(r.body).toContain('"set-bearings": "Set Bearings"');
    expect(r.body).toContain('id="planning-answer-form"');
    expect(r.body).toContain('endQuestions.textContent = "End questions"');
    expect(r.body).toContain('invokeJourney("gather-supplies", { answer: answer, endQuestions: true })');
    expect(r.body).toContain('currentStage !== "gather-supplies"');
    expect(r.body).not.toContain("Anything else?");
    expect(r.body).toContain('if (!endQuestions.hidden) endQuestions.disabled = false');
    expect(r.body).toContain('<label for="planning-answer">Your answer</label>');
    expect(r.body).toContain('placeholder="Type your answer here…"');
    expect(r.body).toContain('fetch("/api/v1/journey"');
    expect(r.body).toContain('postCommand(currentRunId, state, "createWorkRequest"');
    expect(r.body).toContain('postCommand(currentRunId, state, "requireDecision"');
    expect(r.body).toContain('postCommand(currentRunId, state, "recordOwnerAnswer"');
    expect(r.body).toContain('invokeJourney("set-bearings")');
    expect(r.body).toContain('currentStage === "set-bearings" ? "gather-supplies" : "map-route"');
    expect(r.body).toContain('if (body.status === "action" && currentStage === "gather-supplies") invokeJourney("map-route")');
    expect(r.body).toContain('id="journey-wait" hidden');
    expect(r.body).toContain('role="progressbar" aria-label="Agent work in progress"');
    expect(r.body).not.toContain("aria-valuenow");
    expect(r.body).toContain('id="journey-body" aria-busy="false"');
    expect(r.body).toContain('id="wait-elapsed">0s elapsed');
    expect(r.body).toContain('id="wait-activity">Last real activity: waiting for the first event.');
    expect(r.body).toContain('id="wait-range">Typical time: about 3 minutes');
    expect(r.body).toContain("Safe to leave—resume this journey from History.");
    expect(r.body).toContain("Still active; this is taking longer than usual.");
    expect(r.body).toContain('function cacheEstimate(body)');
    expect(r.body).toContain('estimate.stage === "execute"');
    expect(r.body).toContain('function waitEstimate(stage)');
    expect(r.body).toContain('stage === "execute-explorer" || stage === "execute-expedition" ? waitEstimates.execute : null');
    expect(r.body).toContain('Timing estimate will appear after agent inspection.');
    expect(r.body).toContain('Agent estimate: " + estimate.minMinutes');
    expect(r.body).toContain('if (/\\blens(?:es)?\\b/i.test(question))');
    expect(r.body).not.toContain('currentStage === "map-route" && /\\blenses?\\b/i.test(question)');
    expect(r.body).toContain('function reconcileJourney()');
    expect(r.body).toContain('var reconcileTimer = null');
    expect(r.body).toContain('clearTimeout(reconcileTimer)');
    expect(r.body).toContain('reconcileTimer = setTimeout(function ()');
    expect(r.body).toContain('currentRunId === runId && currentStage === run.stage');
    expect(r.body).toContain('then(renderJourney, reconcileJourney)');
    expect(r.body).toContain('function renderSavedExecution(body)');
    expect(r.body).toContain('The follow-on review request disconnected. Your implementation success is saved; choose Retry to start Surveyor review.');
    expect(r.body).toContain('var stage = retryStage || currentStage; retryStage = ""; invokeJourney(stage)');
    expect(r.body).toContain('run.stage === "execute-explorer" || run.stage === "execute-expedition"');
    expect(r.body).toContain('For more information about lenses, use Glossary in the bottom-left.');
    expect(r.body).toContain('per-slice model and reasoning assignments');
    expect(r.body).toContain("Bearing is creating or resuming the local plan stub and bounded repository map. Next: Gather Supplies discovers owner decisions.");
    expect(r.body).toContain("The selected agent is inspecting the repository to discover unresolved owner questions. Next: your answers become the validated plan specification.");
    expect(r.body).toContain("The selected agent is producing design.md, SEIT evidence, implementation slices, and the review package.");
    expect(r.body).toContain("Explorer is executing the approved slices with the recorded review cadence.");
    expect(r.body).toContain("Expedition is coordinating approved parallel lanes and their review cadence.");
    expect(r.body).toContain("Surveyor is reviewing the integrated uncommitted diff without modifying it.");
    expect(r.body).toContain('"Last real activity: "');
    expect(r.body).toContain("renderActivityTrail(body.activityTrail)");
    expect(r.body).toContain("activity.sequence <= waitActivitySequence");
    expect(r.body).toContain("waitActivitySequence = activity.sequence");
    expect(r.body).not.toContain('recordTrail("Agent session started for "');
    expect(r.body).toContain('recordTrail("Repository snapshot: "');
    expect(r.body).toContain("@keyframes wait-trail");
    expect(r.body).toContain('name="review-cadence" value="phase" checked');
    expect(r.body).toContain("Each phase <b>(recommended)</b>");
    expect(r.body).toContain('id="cleanup-worktrees" type="checkbox" checked');
    expect(r.body).toContain("Only clean, proven-merged temporary lanes are removed.");
    expect(r.body).toContain('cleanupMergedWorktrees: document.getElementById("cleanup-worktrees").checked');
    expect(r.body).toContain('id="journey-retry" type="button" hidden>Retry');
    expect(r.body).toContain('id="recovery-report" hidden');
    expect(r.body).toContain('id="dismiss-recovery-report" type="button">Not now</button>');
    expect(r.body).toContain('https://github.com/alphazede/bearing/issues/new?title=');
    expect(r.body).toContain('https://github.com/alphazede/bearing/security/advisories/new');
    expect(r.body).toContain('window.open("https://github.com/alphazede/bearing/issues/new?title="');
    expect(r.body).toContain('document.getElementById("dismiss-recovery-report").addEventListener("click", function () { document.getElementById("recovery-report").hidden = true; });');
    expect(r.body).not.toContain('fetch("https://github.com/alphazede/bearing');
    expect(r.body).toContain('setStatus(phaseNames[stage] + " is working…", true)');
    expect(r.body).toContain("This run reached its token budget before the phase completed. Retry after lowering reasoning with /model or raise the CLI budget.");
    expect(r.body).toContain("Your answers and planning files are saved. Bearing could not verify the generated implementation package.");
    expect(r.body).toContain('complete.firstElementChild.textContent = "Journey paused"');
    expect(r.body).toContain("Your questions are complete; the generated files need another validation pass.");
    expect(r.body).toContain('id="journey-action-back" type="button">← Back');
    expect(r.body).toContain('id="plan-review-panel" hidden');
    expect(r.body).toContain("Review your route");
    expect(r.body).toContain("The review HTML contains the complete planning package.");
    expect(r.body).toContain('id="request-plan-changes" type="button">Request changes');
    expect(r.body).toContain('id="approve-plan" class="primary" type="button">Approve route');
    expect(r.body).toContain("Execution can pause.");
    expect(r.body).toContain("what stopped, why, the recommended next step");
    expect(r.body).toContain("renderPlanReview(body)");
    expect(r.body).toContain('<p class="hero-help">New to Bearing?<button class="demo-link" id="view-demo" type="button">See how it works</button><button class="demo-link" id="view-glossary" type="button">Glossary</button></p>');
    expect(r.body).toContain('id="glossary-dialog"');
    expect(r.body).toContain("Contract-Driven Design defines interface behavior");
    expect(r.body).toContain("Security-Driven Design examines threats");
    expect(r.body).toContain('id="question-help" hidden');
    expect(r.body).toContain("function questionHelp(question)");
    expect(r.body).not.toContain('id="view-demo" type="button" hidden');
    expect(r.body).not.toContain("Live demo");
    expect(r.body).toContain('class="actions actions-end"><button class="primary" id="launch-bearing" disabled>Apply settings</button>');
    expect(r.body).not.toContain("Want a quick, token-free tour before you continue?");
    expect(r.body).not.toContain('id="planning-demo"');
    expect(r.body).toContain('id="demo-panel" hidden');
    expect(r.body).toContain("How Bearing works");
    expect(r.body).toContain("NO TOKENS");
    expect(r.body).toContain('id="demo-step" aria-live="polite">Step 1 of 4</span>');
    expect(r.body).toContain('<ol class="demo-progress" aria-label="Tutorial progress"><li aria-current="step">Why Bearing</li>');
    expect(r.body).toContain("Stay in control while agents do the work");
    expect(r.body).toContain("Bearing is a local control room");
    expect(r.body).toContain("Before planning, it checks whether the source files are here");
    expect(r.body).toContain("Safe defaults are recorded as assumptions");
    expect(r.body).toContain("Come back to evidence, not just “done”");
    expect(r.body).toContain('currentRunId ? "Back to journey" : "Start journey"');
    expect(r.body).toContain('id="demo-explorer" type="button" aria-pressed="false"');
    expect(r.body).toContain('src="/assets/bearing-explorer-card.png"');
    expect(r.body).toContain('id="demo-expedition" type="button" aria-pressed="false"');
    expect(r.body).toContain('src="/assets/bearing-expedition-card.png"');
    expect(r.body).toContain("<b>Use when:</b>");
    expect(r.body).toContain("<b>Pros:</b>");
    expect(r.body).toContain("<b>Tradeoff:</b>");
    expect(r.body).toContain(".mode-grid{display:grid");
    expect(r.body).toContain(".panel,#repository-panel{background:rgba(15,16,17,.35)");
    expect(r.body).toContain("backdrop-filter:blur(6px)");
    expect(r.body).toContain("function chooseDemoMode(mode)");
    expect(r.body).toContain('if (demoStage === 2 && !demoMode) { chooseDemoMode("explorer")');
    expect(r.body).toContain("Explorer highlighted as the lower-token example. In a real run, you choose Explorer or Expedition.");
    expect(r.body).toContain('textContent = "Continue \\u2192"');
    expect(r.body).not.toContain('"recommendExecutionMode"');
    expect(r.body).not.toContain('"approveExecutionMode"');
    expect(r.body).not.toContain('"overrideExecutionMode"');
    expect(r.body).toContain('id="change-repository" type="button" hidden');
    expect(r.body).toContain('function toggleRepositoryChooser()');
    expect(r.body).toContain('function openWorkspacePicker() { closeSetupSheets(); chooseRepository("browse"); }');
    expect(r.body).toContain('changeRepository.addEventListener("click", openWorkspacePicker)');
    expect(r.body).toContain('document.getElementById("workspace-chip").addEventListener("click", openWorkspacePicker)');
    expect(r.body).toContain('if (code === "repository_picker_unavailable") { browseAvailable = false; repositoryPanel.hidden = false;');
    expect(r.body).toContain('setStatus("Choose a workspace. Your current screen will stay open."');
    expect(r.body).toContain('document.getElementById("launch-bearing").disabled = false;');
    expect(r.body).toContain('history-button');
    expect(r.body).toContain('id="clear-history"');
    expect(r.body.match(/var hasSavedResult = !!\(entry\.stage && entry\.lastResult\)/g)).toHaveLength(2);
    expect(r.body).toContain('entry.status === "complete" && hasSavedResult ? "View completed evidence"');
    expect(r.body).toContain('setStatus(entry.status === "complete" ? "Opened completed journey evidence." : "Resumed the saved journey.", false)');
    expect(r.body).not.toContain('entry.status !== "complete"');
    expect(r.body).toContain('remove.textContent = "Delete"');
    expect(r.body).toContain('method: "DELETE"');
    expect(r.body).toContain("Generated files will stay in the repository.");
    expect(r.body).toContain('input.placeholder = "Steer this phase');
    expect(r.body).toContain('steer.textContent = "Steer"');
    expect(r.body).toContain('stop.textContent = "Stop"');
    expect(r.body).toContain('fetch("/api/v1/journey/control"');
    expect(r.body).toContain('"Git: " + body.changedFiles + " changed "');
    expect(r.body).toContain('fetch("/api/v1/git-diff?path="');
    expect(r.body).toContain('className = "diff-add"');
    expect(r.body).toContain('id="journey-question-box" hidden');
    expect(r.body).toContain('id="planning-answer-form" hidden');
    expect(r.body).toContain('<button class="primary" type="submit">Continue</button>');
    expect(r.body).toContain('classList.toggle("busy"');
    expect(r.body).toContain('@keyframes panel-in');
    expect(r.body).toContain('@keyframes compass-spin');
    expect(r.body).not.toContain('id="workflow-select"');
    expect(r.body).not.toContain('id="showcase"');
    expect(r.body).toContain('"/api/v1/journey"');
    expect(r.body).not.toContain('/launch');
    expect(r.body).not.toContain(cap);
    // If the fragment leaked into req.url the path check would 404; a 200 proves
    // the server only ever saw "/" on the initial GET.
    expect(r.body).not.toContain("Rejected");
    const scriptStart = r.body.indexOf("<script>"), scriptEnd = r.body.lastIndexOf("</script>");
    const script = scriptStart >= 0 && scriptEnd > scriptStart ? r.body.slice(scriptStart + "<script>".length, scriptEnd) : undefined;
    expect(script).toBeDefined();
    expect(() => new Function(script!)).not.toThrow();

    const image = await call(port, { method: "GET", path: "/assets/bearing-office.png" });
    expect(image.status).toBe(200);
    expect(image.headers["content-type"]).toBe("image/png");
    expect(Number(image.headers["content-length"])).toBeGreaterThan(2_000_000);
    expect(image.headers["cache-control"]).toBe("no-cache");
    expect(image.headers["x-content-type-options"]).toBe("nosniff");
    const titleMark = await call(port, { method: "GET", path: "/assets/bearing-title-mark.png" });
    expect(titleMark.status).toBe(200);
    expect(titleMark.headers["content-type"]).toBe("image/png");
    expect(Number(titleMark.headers["content-length"])).toBeGreaterThan(0);
    expect(titleMark.headers["cache-control"]).toBe("no-cache");
    expect(titleMark.headers["x-content-type-options"]).toBe("nosniff");
    const background = await call(port, { method: "GET", path: "/assets/bearing-expedition.png" });
    expect(background.status).toBe(200);
    expect(background.headers["content-type"]).toBe("image/png");
    expect(Number(background.headers["content-length"])).toBeGreaterThan(2_000_000);
    expect(background.headers["cache-control"]).toBe("no-cache");
    expect(background.headers["x-content-type-options"]).toBe("nosniff");
    for (const path of ["/assets/bearing-explorer-card.png", "/assets/bearing-expedition-card.png"]) {
      const card = await call(port, { method: "GET", path });
      expect(card.status).toBe(200);
      expect(card.headers["content-type"]).toBe("image/png");
      expect(Number(card.headers["content-length"])).toBeGreaterThan(1_000_000);
      expect(card.headers["cache-control"]).toBe("no-cache");
      expect(card.headers["x-content-type-options"]).toBe("nosniff");
    }
  });

  it("authenticates before protected route selection and returns 404 only after authentication", async () => {
    const { port, cap } = await launch();
    for (const path of ["/api/v1/routes", "/api/v1/workflows", "/api/v1/workflows/example/report", "/api/v1/workflows/example", "/api/v1/runs/example"]) {
      expect((await call(port, { method: "GET", path })).status).toBe(401);
    }
    const cookie = await exchangeCookie(port, cap);
    expect((await call(port, { method: "GET", path: "/api/v1/nope", headers: { cookie } })).status).toBe(404);
  });
});

describe("POST /api/v1/repository", () => {
  it("requires Host, Origin, and the established session cookie", async () => {
    const { port, cap } = await launch();
    const cookie = await exchangeCookie(port, cap);
    const root = await tempRepo();

    const badHost = await call(port, {
      method: "POST",
      path: "/api/v1/repository",
      headers: sessionHeaders(port, { host: "evil.example", cookie }),
      body: JSON.stringify({ path: root }),
    });
    expect(badHost.status).toBe(421);

    const badOrigin = await call(port, {
      method: "POST",
      path: "/api/v1/repository",
      headers: sessionHeaders(port, { origin: "https://evil.example", cookie }),
      body: JSON.stringify({ path: root }),
    });
    expect(badOrigin.status).toBe(403);

    const noCookie = await call(port, {
      method: "POST",
      path: "/api/v1/repository",
      headers: sessionHeaders(port),
      body: JSON.stringify({ path: root }),
    });
    expect(noCookie.status).toBe(401);

    const badCookie = await call(port, {
      method: "POST",
      path: "/api/v1/repository",
      headers: sessionHeaders(port, { cookie: `${SESSION_COOKIE_NAME}=${"0".repeat(64)}` }),
      body: JSON.stringify({ path: root }),
    });
    expect(badCookie.status).toBe(401);

    for (const duplicate of [
      `${cookie}; ${SESSION_COOKIE_NAME}=${"0".repeat(64)}`,
      `${SESSION_COOKIE_NAME}=${"0".repeat(64)}; ${cookie}`,
    ]) {
      const duplicateCookie = await call(port, {
        method: "POST",
        path: "/api/v1/repository",
        headers: sessionHeaders(port, { cookie: duplicate }),
        body: JSON.stringify({ path: root }),
      });
      expect(duplicateCookie.status).toBe(401);
    }
  });

  it("requires an exact JSON media type and accepts parameters", async () => {
    const { port, cap } = await launch();
    const cookie = await exchangeCookie(port, cap);
    const root = await tempRepo();

    for (const contentType of [undefined, "text/plain", "application/json;"]) {
      const headers = sessionHeaders(port, { cookie });
      if (contentType === undefined) delete headers["content-type"];
      else headers["content-type"] = contentType;
      const r = await call(port, {
        method: "POST",
        path: "/api/v1/repository",
        headers,
        body: JSON.stringify({ path: root }),
      });
      expect(r.status).toBe(415);
    }

    const accepted = await call(port, {
      method: "POST",
      path: "/api/v1/repository",
      headers: sessionHeaders(port, {
        cookie,
        "content-type": 'Application/JSON; charset="utf-8"',
      }),
      body: JSON.stringify({ path: root }),
    });
    expect(accepted.status).toBe(200);
  });

  it("initializes and resumes through the authenticated route", async () => {
    const { port, cap } = await launch();
    const cookie = await exchangeCookie(port, cap);
    const root = await tempRepo();

    const initialized = await call(port, {
      method: "POST",
      path: "/api/v1/repository",
      headers: sessionHeaders(port, { cookie }),
      body: JSON.stringify({ path: root }),
    });
    expect(initialized.status).toBe(200);
    expect(JSON.parse(initialized.body)).toMatchObject({ status: "initialized" });
    expect(await readFile(join(root, ".bearing", "workspace.json"), "utf8")).toContain(root);

    const resumed = await call(port, {
      method: "POST",
      path: "/api/v1/repository",
      headers: sessionHeaders(port, { cookie }),
      body: JSON.stringify({ path: root }),
    });
    expect(resumed.status).toBe(200);
    expect(JSON.parse(resumed.body)).toMatchObject({ status: "resumed", repositoryPath: root });
    expect(resumed.body).not.toContain(cookie);
    expect(resumed.body).not.toContain(cap);

    const nextRoot = await tempRepo();
    const switched = await call(port, {
      method: "POST",
      path: "/api/v1/repository",
      headers: sessionHeaders(port, { cookie }),
      body: JSON.stringify({ path: nextRoot }),
    });
    expect(switched.status).toBe(200);
    expect(JSON.parse(switched.body)).toMatchObject({ status: "initialized", repositoryPath: nextRoot });
    expect(await readFile(join(nextRoot, ".bearing", "workspace.json"), "utf8")).toContain(nextRoot);
  });

  it("rejects malformed, oversized, and invalid repository requests before mutation", async () => {
    const { port, cap } = await launch();
    const cookie = await exchangeCookie(port, cap);
    const root = await tempRepo();
    const file = join(root, "file");
    await writeFile(file, "");

    const malformed = await call(port, {
      method: "POST",
      path: "/api/v1/repository",
      headers: sessionHeaders(port, { cookie }),
      body: "{bad",
    });
    expect(malformed.status).toBe(400);

    const extraKey = await call(port, {
      method: "POST",
      path: "/api/v1/repository",
      headers: sessionHeaders(port, { cookie }),
      body: JSON.stringify({ path: root, ignored: true }),
    });
    expect(extraKey.status).toBe(400);

    const oversized = await call(port, {
      method: "POST",
      path: "/api/v1/repository",
      headers: sessionHeaders(port, { cookie }),
      body: JSON.stringify({ path: "x".repeat(9 * 1024) }),
    });
    expect(oversized.status).toBe(413);

    const relative = await call(port, {
      method: "POST",
      path: "/api/v1/repository",
      headers: sessionHeaders(port, { cookie }),
      body: JSON.stringify({ path: "relative" }),
    });
    expect(relative.status).toBe(400);

    const notDirectory = await call(port, {
      method: "POST",
      path: "/api/v1/repository",
      headers: sessionHeaders(port, { cookie }),
      body: JSON.stringify({ path: file }),
    });
    expect(notDirectory.status).toBe(400);
  });
});

describe("POST /api/v1/owner", () => {
  it("persists an exact validated name and returns it on the next repository session", async () => {
    const first = await launch();
    const firstCookie = await exchangeCookie(first.port, first.cap);
    const root = await tempRepo();

    expect((await call(first.port, {
      method: "POST",
      path: "/api/v1/owner",
      headers: sessionHeaders(first.port, { origin: "https://evil.example", cookie: firstCookie }),
      body: JSON.stringify({ name: "Smokie" }),
    })).status).toBe(403);
    expect((await call(first.port, {
      method: "POST",
      path: "/api/v1/owner",
      headers: sessionHeaders(first.port),
      body: JSON.stringify({ name: "Smokie" }),
    })).status).toBe(401);

    const beforeRepository = await call(first.port, {
      method: "POST",
      path: "/api/v1/owner",
      headers: sessionHeaders(first.port, { cookie: firstCookie }),
      body: JSON.stringify({ name: "Smokie" }),
    });
    expect(beforeRepository.status).toBe(409);

    expect((await call(first.port, {
      method: "POST",
      path: "/api/v1/repository",
      headers: sessionHeaders(first.port, { cookie: firstCookie }),
      body: JSON.stringify({ path: root }),
    })).status).toBe(200);

    for (const body of [{ name: "" }, { name: " Smokie " }, { name: "bad\nname" }, { name: "Smokie", extra: true }]) {
      expect((await call(first.port, {
        method: "POST",
        path: "/api/v1/owner",
        headers: sessionHeaders(first.port, { cookie: firstCookie }),
        body: JSON.stringify(body),
      })).status).toBe(400);
    }

    const saved = await call(first.port, {
      method: "POST",
      path: "/api/v1/owner",
      headers: sessionHeaders(first.port, { cookie: firstCookie }),
      body: JSON.stringify({ name: "Smokie" }),
    });
    expect(saved.status).toBe(200);
    expect(JSON.parse(saved.body)).toMatchObject({ name: "Smokie", greeting: expect.stringContaining("Smokie") });
    expect(JSON.parse(await readFile(join(root, ".bearing", "owner.json"), "utf8"))).toEqual({ name: "Smokie" });

    const second = await launch();
    const secondCookie = await exchangeCookie(second.port, second.cap);
    const resumed = await call(second.port, {
      method: "POST",
      path: "/api/v1/repository",
      headers: sessionHeaders(second.port, { cookie: secondCookie }),
      body: JSON.stringify({ path: root }),
    });
    expect(resumed.status).toBe(200);
    expect(JSON.parse(resumed.body)).toMatchObject({ status: "resumed", ownerName: "Smokie", greeting: expect.stringContaining("Smokie") });
  });
});

describe("POST /api/v1/session rejection matrix", () => {
  it("requires exactly the capability key", async () => {
    const { port, cap } = await launch();
    const r = await call(port, {
      method: "POST",
      path: "/api/v1/session",
      headers: sessionHeaders(port),
      body: JSON.stringify({ capability: cap, ignored: true }),
    });
    expect(r.status).toBe(400);
  });
  it("rejects a wrong Host (DNS-rebinding guard)", async () => {
    const { port, cap } = await launch();
    const r = await call(port, {
      method: "POST",
      path: "/api/v1/session",
      headers: sessionHeaders(port, { host: "evil.example" }),
      body: JSON.stringify({ capability: cap }),
    });
    expect(r.status).toBe(421);
    expect(r.body).not.toContain(cap);
  });

  it("rejects a missing Origin", async () => {
    const { port, cap } = await launch();
    const r = await call(port, {
      method: "POST",
      path: "/api/v1/session",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ capability: cap }),
    });
    expect(r.status).toBe(403);
  });

  it("rejects a cross-site Origin", async () => {
    const { port, cap } = await launch();
    const r = await call(port, {
      method: "POST",
      path: "/api/v1/session",
      headers: sessionHeaders(port, { origin: "https://evil.example" }),
      body: JSON.stringify({ capability: cap }),
    });
    expect(r.status).toBe(403);
  });

  it("rejects a wrong capability without consuming it", async () => {
    const { port, cap } = await launch();
    const r1 = await call(port, {
      method: "POST",
      path: "/api/v1/session",
      headers: sessionHeaders(port),
      body: JSON.stringify({ capability: "0".repeat(64) }),
    });
    expect(r1.status).toBe(403);
    // the real capability still exchanges after a failed attempt
    const r2 = await call(port, {
      method: "POST",
      path: "/api/v1/session",
      headers: sessionHeaders(port),
      body: JSON.stringify({ capability: cap }),
    });
    expect(r2.status).toBe(200);
  });

  it("exchanges once, sets a strict cookie, and rejects replay", async () => {
    const { port, cap } = await launch();
    const r = await call(port, {
      method: "POST",
      path: "/api/v1/session",
      headers: sessionHeaders(port),
      body: JSON.stringify({ capability: cap }),
    });
    expect(r.status).toBe(200);
    const sc = r.headers["set-cookie"];
    expect(Array.isArray(sc)).toBe(true);
    const cookie = (sc as string[])[0];
    expect(cookie).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Path=/");
    expect(cookie).not.toContain("Secure"); // plain loopback HTTP
    expect(r.body).not.toContain(cap); // capability never echoed, even on success

    const authenticatedReplay = await call(port, {
      method: "POST",
      path: "/api/v1/session",
      headers: sessionHeaders(port, { cookie: cookie.split(";")[0] }),
      body: JSON.stringify({ capability: cap }),
    });
    expect(authenticatedReplay.status).toBe(200);
    expect(authenticatedReplay.headers["set-cookie"]).toBeUndefined();

    const replay = await call(port, {
      method: "POST",
      path: "/api/v1/session",
      headers: sessionHeaders(port),
      body: JSON.stringify({ capability: cap }),
    });
    expect(replay.status).toBe(403);
  });

  it("rejects oversized and malformed bodies", async () => {
    const { port } = await launch();
    const big = await call(port, {
      method: "POST",
      path: "/api/v1/session",
      headers: sessionHeaders(port),
      body: "x".repeat(9 * 1024),
    });
    expect(big.status).toBe(413);

    const bad = await call(port, {
      method: "POST",
      path: "/api/v1/session",
      headers: sessionHeaders(port),
      body: "{not json",
    });
    expect(bad.status).toBe(400);

    const missing = await call(port, {
      method: "POST",
      path: "/api/v1/session",
      headers: sessionHeaders(port),
      body: JSON.stringify({ nope: true }),
    });
    expect(missing.status).toBe(400);
  });

  it("requires an exact JSON media type before consuming the capability", async () => {
    const { port, cap } = await launch();

    for (const contentType of [undefined, "text/plain", "application/json;"]) {
      const headers = sessionHeaders(port);
      if (contentType === undefined) delete headers["content-type"];
      else headers["content-type"] = contentType;
      const r = await call(port, {
        method: "POST",
        path: "/api/v1/session",
        headers,
        body: JSON.stringify({ capability: cap }),
      });
      expect(r.status).toBe(415);
    }

    const accepted = await call(port, {
      method: "POST",
      path: "/api/v1/session",
      headers: sessionHeaders(port, {
        "content-type": "Application/JSON; Charset=UTF-8",
      }),
      body: JSON.stringify({ capability: cap }),
    });
    expect(accepted.status).toBe(200);
  });
});

describe("createRequestHandler host binding", () => {
  it("binds Host checks to the host the service was constructed with", () => {
    // ponytail: a direct handler test proves Host binding without spinning a socket.
    const service = new LocalSessionService("127.0.0.1:7");
    const handler = createRequestHandler(service);
    const calls: { status: number }[] = [];
    const res = {
      writeHead(status: number) {
        calls.push({ status });
      },
      end() {},
    } as unknown as import("node:http").ServerResponse;
    handler({ method: "GET", url: "/", headers: { host: "127.0.0.1:8" } } as never, res);
    expect(calls[0]?.status).toBe(421);
  });
});
