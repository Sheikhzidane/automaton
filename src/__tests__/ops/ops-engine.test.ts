import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-ignore plain ESM module without type declarations
import { runCycle, runnerRefusal } from "../../../ops/lib/engine.mjs";
// @ts-ignore
import { initState, loadState, saveState, saveOwnerFiles, paths } from "../../../ops/lib/state.mjs";
// @ts-ignore
import { nextCronTime } from "../../../ops/lib/cron.mjs";
// @ts-ignore
import { parseFhrsXml, buildCandidates, normaliseName, diffEstablishments } from "../../../ops/lib/fhrs.mjs";
// @ts-ignore
import { addEntry, summarise, verifyChain, validateEntry } from "../../../ops/lib/ledger.mjs";
// @ts-ignore
import { readJsonl, readJson } from "../../../ops/lib/util.mjs";
// @ts-ignore
import { billedSeconds } from "../../../ops/lib/budget.mjs";
// @ts-ignore
import { syncIssues, issueMarker } from "../../../ops/lib/alerts.mjs";
// @ts-ignore
import { looksPhone } from "../../../ops/lib/util.mjs";
// @ts-ignore
import { makeHttp } from "../../../ops/lib/http.mjs";
// @ts-ignore
import { finishTask, isDue, reconcileTasks, recoverStale } from "../../../ops/lib/queue.mjs";

const FHRS = `<?xml version="1.0" encoding="utf-8"?>
<FHRSEstablishment xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<Header><ExtractDate>2026-10-31</ExtractDate><ItemCount>5</ItemCount><ReturnCode>Success</ReturnCode></Header>
<EstablishmentCollection>
<EstablishmentDetail><FHRSID>101</FHRSID><BusinessName>Wee Bistro - Leith</BusinessName><BusinessType>Restaurant/Cafe/Canteen</BusinessType><BusinessTypeID>1</BusinessTypeID><AddressLine1>1 Shore</AddressLine1><AddressLine2>Edinburgh</AddressLine2><PostCode>EH6 6QW</PostCode><RatingValue>Pass</RatingValue><RatingKey>fhis_pass_en-GB</RatingKey><RatingDate>2025-05-01</RatingDate><LocalAuthorityName>Edinburgh (City of)</LocalAuthorityName><SchemeType>FHIS</SchemeType><NewRatingPending>False</NewRatingPending><Geocode><Longitude>-3.17</Longitude><Latitude>55.97</Latitude></Geocode></EstablishmentDetail>
<EstablishmentDetail><FHRSID>102</FHRSID><BusinessName>Wee Bistro (Stockbridge)</BusinessName><BusinessType>Restaurant/Cafe/Canteen</BusinessType><BusinessTypeID>1</BusinessTypeID><AddressLine1>2 Raeburn Place</AddressLine1><PostCode>EH4 1HN</PostCode><RatingValue>Improvement Required</RatingValue><RatingDate>2026-09-01</RatingDate><LocalAuthorityName>Edinburgh (City of)</LocalAuthorityName><NewRatingPending>False</NewRatingPending></EstablishmentDetail>
<EstablishmentDetail><FHRSID>103</FHRSID><BusinessName>Greggs</BusinessName><BusinessType>Retailers - other</BusinessType><BusinessTypeID>1</BusinessTypeID><PostCode>EH1 1AA</PostCode><RatingValue>Pass</RatingValue><RatingDate>2025-01-01</RatingDate><LocalAuthorityName>Edinburgh (City of)</LocalAuthorityName></EstablishmentDetail>
<EstablishmentDetail><FHRSID>104</FHRSID><BusinessName>Leith Primary School</BusinessName><BusinessType>Restaurant/Cafe/Canteen</BusinessType><BusinessTypeID>1</BusinessTypeID><PostCode>EH6 1AA</PostCode><RatingValue>Pass</RatingValue><RatingDate xsi:nil="true" /><LocalAuthorityName>Edinburgh (City of)</LocalAuthorityName></EstablishmentDetail>
<EstablishmentDetail><FHRSID>105</FHRSID><BusinessName>Café &amp; Co</BusinessName><BusinessType>Restaurant/Cafe/Canteen</BusinessType><BusinessTypeID>1</BusinessTypeID><PostCode>EH3 9AA</PostCode><RatingValue>Awaiting Inspection</RatingValue><RatingDate xsi:nil="true" /><LocalAuthorityName>Edinburgh (City of)</LocalAuthorityName></EstablishmentDetail>
<EstablishmentDetail><FHRSID>106</FHRSID><BusinessName>Corner Kebab</BusinessName><BusinessType>Takeaway/sandwich shop</BusinessType><BusinessTypeID>7844</BusinessTypeID><PostCode>EH7 4AA</PostCode><RatingValue>Pass</RatingValue><RatingDate>2024-02-02</RatingDate><LocalAuthorityName>Edinburgh (City of)</LocalAuthorityName></EstablishmentDetail>
</EstablishmentCollection></FHRSEstablishment>`;

function fakeFetch(routes: Record<string, { status: number; body: string; headers?: Record<string, string> }>) {
  const calls: string[] = [];
  const impl = async (url: string) => {
    calls.push(url);
    const hit = Object.entries(routes).find(([k]) => url.startsWith(k));
    if (!hit) throw new Error(`unexpected ${url}`);
    const { status, body, headers = {} } = hit[1];
    return new Response(body, { status, headers });
  };
  return { impl, calls };
}

const HOME = `<html><body><h1>Run your restaurant with complete confidence.</h1></body></html>`;

function siteRoutes(overrides: Record<string, any> = {}) {
  return {
    "https://opslog.co.uk/login": { status: 200, body: "<h1>Sign in</h1>" },
    "https://opslog.co.uk/robots.txt": { status: 200, body: "User-agent: *" },
    "https://opslog.co.uk/sitemap.xml": { status: 200, body: "<urlset/>" },
    "https://opslog.co.uk/api/health": { status: 200, body: JSON.stringify({ ok: true, region: "lhr1", commit: "abc1234", env: "production" }) },
    "https://opslog.co.uk/api/ops/metrics": { status: 503, body: "{}" },
    "https://ratings.food.gov.uk/": { status: 200, body: FHRS },
    "https://opslog.co.uk/": { status: 200, body: HOME, headers: { "x-vercel-id": "lhr1::lhr1::x" } },
    ...overrides,
  };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ops-test-"));
  initState(dir, { market: { authorities: [{ id: 773, name: "Edinburgh (City of)" }], existingCustomers: ["Corner Kebab"] } });
});

describe("growth ops: cron", () => {
  it("finds the next matching minute in UTC", () => {
    expect(nextCronTime("37 */3 * * *", new Date("2026-10-31T15:40:00Z")).toISOString()).toBe("2026-10-31T18:37:00.000Z");
    expect(nextCronTime("40 5 * * *", new Date("2026-10-31T05:40:00Z")).toISOString()).toBe("2026-11-01T05:40:00.000Z");
    expect(nextCronTime("0 9 * * 1", new Date("2026-10-31T10:00:00Z")).toISOString()).toBe("2026-11-02T09:00:00.000Z");
  });
});

describe("growth ops: FSA data", () => {
  it("parses establishments, decodes entities and handles nil dates", () => {
    const { extractDate, establishments } = parseFhrsXml(FHRS);
    expect(extractDate).toBe("2026-10-31");
    expect(establishments).toHaveLength(6);
    expect(establishments.find((e: any) => e.id === 105).name).toBe("Café & Co");
    expect(establishments.find((e: any) => e.id === 104).ratingDate).toBeNull();
    expect(establishments[0].address).toBe("1 Shore, Edinburgh");
  });

  it("groups sites by brand, skips chains, institutions and existing customers", () => {
    expect(normaliseName("Wee Bistro - Leith")).toBe("wee bistro");
    expect(normaliseName("Wee Bistro (Stockbridge)")).toBe("wee bistro");
    const { establishments } = parseFhrsXml(FHRS);
    const c = buildCandidates(establishments, { now: new Date("2026-10-31T00:00:00Z"), existingCustomers: ["Corner Kebab"] });
    const names = c.map((x: any) => x.key);
    expect(names).toContain("wee bistro");
    expect(names).toContain("cafe and co");
    expect(names).not.toContain("greggs");
    expect(names).not.toContain("leith primary school");
    expect(names).not.toContain("corner kebab");
    const wee = c.find((x: any) => x.key === "wee bistro");
    expect(wee.siteCount).toBe(2);
    expect(wee.signals.join(" ")).toMatch(/Improvement Required/);
    expect(c[0].key).toBe("wee bistro");
  });

  it("reports new, removed and re-rated businesses", () => {
    const d = diffEstablishments(
      [{ id: 1, rating: "Pass", ratingDate: "2024-01-01" }, { id: 2, rating: "Pass", ratingDate: "2024-01-01" }],
      [{ id: 1, rating: "Improvement Required", ratingDate: "2026-10-01" }, { id: 3, rating: "Awaiting Inspection", ratingDate: null }]
    );
    expect(d.added).toEqual([3]);
    expect(d.removed).toEqual([2]);
    expect(d.ratingChanged).toEqual([{ id: 1, from: "Pass", to: "Improvement Required", date: "2026-10-01" }]);
  });
});

describe("growth ops: ledger", () => {
  it("counts only settled, evidenced, unrelated, attributable revenue and subtracts every cost", () => {
    const f = paths(dir).ledger;
    const now = new Date("2026-11-01T10:00:00Z");
    addEntry(f, { type: "revenue", amountPence: 60000, settled: true, evidence: "pi_3Qaa01", counterparty: "CUST-001" }, now);
    addEntry(f, { type: "revenue", amountPence: 60000, settled: false, counterparty: "CUST-002" }, now);
    addEntry(f, { type: "revenue", amountPence: 200, settled: true, evidence: "po_3Qold", relatedParty: true }, now);
    addEntry(f, { type: "expense", amountPence: 800, settled: true, evidence: "rcpt", fundedFromCapital: true, category: "compute_prepaid" }, now);
    addEntry(f, { type: "refund", amountPence: 1000, settled: true, evidence: "re_1" }, now);
    const s = summarise(readJsonl(f), { capitalPence: 2000, targetNetPence: 200000 });
    expect(s.countedRevenuePence).toBe(60000);
    expect(s.pendingRevenuePence).toBe(60000);
    expect(s.netPence).toBe(60000 - 1000 - 800);
    expect(s.capitalRemainingPence).toBe(1200);
    expect(s.progressPct).toBe(29.1);
    expect(verifyChain(readJsonl(f)).ok).toBe(true);
  });

  it("supersedes instead of editing, and detects deletion", () => {
    const f = paths(dir).ledger;
    const now = new Date("2026-11-01T10:00:00Z");
    addEntry(f, { type: "revenue", amountPence: 5000, settled: true, evidence: "pi_3Qxx09", counterparty: "CUST-009" }, now);
    addEntry(f, { type: "correction", supersedes: 1, description: "entered twice" }, now);
    expect(summarise(readJsonl(f), { capitalPence: 2000, targetNetPence: 200000 }).countedRevenuePence).toBe(0);
    const lines = readFileSync(f, "utf8").trim().split("\n");
    writeFileSync(f, `${lines[1]}\n`);
    expect(verifyChain(readJsonl(f)).ok).toBe(false);
  });

  it("refuses phone numbers and unevidenced settled revenue", () => {
    const f = paths(dir).ledger;
    expect(() => addEntry(f, { type: "revenue", amountPence: 100, settled: true })).toThrow(/evidence/);
    expect(() => addEntry(f, { type: "expense", amountPence: 100, description: "call 0131 555 0101" })).toThrow(/phone/);
  });
});

describe("growth ops: queue", () => {
  it("backs off on failure, gives up after maxAttempts and resets on success", () => {
    const now = new Date("2026-11-01T10:00:00Z");
    const t: any = { id: "x", intervalMinutes: 180, maxAttempts: 2, history: [] };
    expect(finishTask(t, { outcome: "failed", note: "boom" }, now, 5)).toBe(false);
    expect(t.status).toBe("retrying");
    expect(new Date(t.nextRunAt).valueOf() - now.valueOf()).toBe(15 * 60 * 1000);
    expect(finishTask(t, { outcome: "failed", note: "boom" }, now, 5)).toBe(true);
    expect(t.status).toBe("failed");
    finishTask(t, { outcome: "succeeded" }, now, 5);
    expect(t.consecutiveFailures).toBe(0);
    expect(isDue(t, now)).toBe(false);
    expect(isDue(t, new Date(now.valueOf() + 170 * 60 * 1000))).toBe(true);
  });

  it("keeps runtime fields and the operator's disable when definitions change", () => {
    const tasks = reconcileTasks([{ id: "opslog.public_health", enabled: false, status: "disabled", lastSuccessAt: "x", title: "old", history: [] }]);
    const h = tasks.find((t: any) => t.id === "opslog.public_health");
    expect(h.enabled).toBe(false);
    expect(h.lastSuccessAt).toBe("x");
    expect(h.title).not.toBe("old");
    expect(tasks.length).toBeGreaterThanOrEqual(8);
  });
});

describe("growth ops: full cycle", () => {
  it("runs every due task, persists state and writes the dashboard feed", async () => {
    const { impl, calls } = fakeFetch(siteRoutes());
    const now = new Date("2026-11-01T09:37:00Z");
    const r = await runCycle({ dir, now: () => now, env: {}, fetchImpl: impl, log: () => {} });
    const byId = Object.fromEntries(r.results.map((x: any) => [x.id, x.outcome]));
    expect(byId["opslog.public_health"]).toBe("succeeded");
    expect(byId["opslog.ops_metrics"]).toBe("blocked"); // no token
    expect(byId["market.fsa_refresh"]).toBe("succeeded");
    expect(byId["ops.daily_report"]).toBe("succeeded");
    expect(r.ok).toBe(true);
    expect(calls.some((u) => u.includes("FHRS773en-GB.xml"))).toBe(true);
    const status = JSON.parse(readFileSync(join(dir, "status.json"), "utf8"));
    expect(status.runtime.nextScheduledAt).toBe("2026-11-01T12:37:00.000Z");
    expect(status.budget.inferenceSpendPence).toBe(0);
    expect(status.tasks.find((t: any) => t.id === "opslog.ops_metrics").status).toBe("blocked");
    const health = JSON.parse(readFileSync(join(dir, "health", "latest.json"), "utf8"));
    expect(health.region).toBe("lhr1");
    const cands = JSON.parse(readFileSync(join(dir, "market", "candidates.json"), "utf8"));
    expect(cands.candidates[0].key).toBe("wee bistro");
    expect(existsSync(join(dir, "reports", "2026-11-01.md"))).toBe(true);
    expect(readJsonl(join(dir, "state", "runs.jsonl")).length).toBe(r.results.length);
    expect(existsSync(join(dir, "state", "lock.json"))).toBe(false);

    // A second cycle in the same slot does not repeat daily or weekly work.
    const r2 = await runCycle({ dir, now: () => new Date("2026-11-01T09:50:00Z"), env: {}, fetchImpl: impl, log: () => {} });
    const ids2 = r2.results.map((x: any) => x.id);
    expect(ids2).toContain("ops.self_check");
    expect(ids2).not.toContain("market.fsa_refresh");
    expect(ids2).not.toContain("ops.daily_report");
  });

  it("raises an alert and fails the cycle when the site is down, then clears it", async () => {
    const down = fakeFetch(siteRoutes({ "https://opslog.co.uk/": { status: 500, body: "err" } }));
    const t0 = new Date("2026-11-01T09:37:00Z");
    const r = await runCycle({ dir, now: () => t0, env: {}, fetchImpl: down.impl, log: () => {} });
    expect(r.ok).toBe(false);
    let s = loadState(dir);
    expect(Object.keys(s.alerts.open)).toContain("opslog-public-down");
    const up = fakeFetch(siteRoutes());
    await runCycle({ dir, now: () => new Date("2026-11-01T12:37:00Z"), env: {}, fetchImpl: up.impl, log: () => {} });
    s = loadState(dir);
    expect(Object.keys(s.alerts.open)).not.toContain("opslog-public-down");
  });

  it("opens a GitHub issue for a new alert when a token is present", async () => {
    const posted: any[] = [];
    const routes = siteRoutes({ "https://opslog.co.uk/": { status: 500, body: "err" } });
    const impl = async (url: string, init: any) => {
      if (url.startsWith("https://api.github.com/")) {
        if ((init?.method ?? "GET") === "GET") return new Response("[]", { status: 200 });
        posted.push({ url, body: JSON.parse(init.body) });
        return new Response(JSON.stringify({ number: 7 }), { status: 201 });
      }
      return fakeFetch(routes).impl(url);
    };
    await runCycle({ dir, now: () => new Date("2026-11-01T09:37:00Z"), env: { GITHUB_TOKEN: "t", GITHUB_REPOSITORY: "o/r" }, fetchImpl: impl, log: () => {} });
    expect(posted[0].url).toBe("https://api.github.com/repos/o/r/issues");
    expect(posted[0].body.labels).toEqual(["growth-ops-alert"]);
    expect(posted[0].body.body).toContain("<!-- growth-ops-alert:opslog-public-down -->");
    expect(loadState(dir).alerts.open["opslog-public-down"].issueNumber).toBe(7);
  });

  it("refuses to store a metrics response that contains free text", async () => {
    const { impl } = fakeFetch(siteRoutes({ "https://opslog.co.uk/api/ops/metrics": { status: 200, body: JSON.stringify({ orgs: { active: 3, names: "Wee Bistro" } }) } }));
    const r = await runCycle({ dir, now: () => new Date("2026-11-01T09:37:00Z"), env: { OPS_METRICS_TOKEN: "abc" }, fetchImpl: impl, log: () => {}, only: "opslog.ops_metrics" });
    expect(r.results[0].outcome).toBe("failed");
    expect(existsSync(join(dir, "metrics", "latest.json"))).toBe(false);
  });

  it("does nothing while paused and recovers a task interrupted by a crash", async () => {
    let s = loadState(dir);
    s.control = { paused: true, reason: "holiday" };
    saveOwnerFiles(s);
    const { impl } = fakeFetch(siteRoutes());
    const r = await runCycle({ dir, now: () => new Date("2026-11-01T09:37:00Z"), env: {}, fetchImpl: impl, log: () => {} });
    expect(r.results).toHaveLength(0);
    s = loadState(dir);
    s.control = { paused: false };
    saveOwnerFiles(s);
    const h = s.queue.tasks.find((t: any) => t.id === "opslog.public_health");
    h.status = "running";
    h.lease = { runId: "dead", at: "2026-11-01T06:37:00Z" };
    saveState(s);
    const r2 = await runCycle({ dir, now: () => new Date("2026-11-01T09:40:00Z"), env: {}, fetchImpl: impl, log: () => {} });
    expect(r2.results.find((x: any) => x.id === "opslog.public_health").outcome).toBe("succeeded");
  });
});

describe("growth ops: review fixes", () => {
  it("accepts PostgREST timestamps with an offset", async () => {
    const body = { generatedAt: "2026-11-01T09:37:01.123Z", orgs: { active: 3 }, email: { failed24h: 0, lastSentAt: "2026-11-01T07:00:04.846+00:00" }, licences: { byStatus: { active: 3 } } };
    const { impl } = fakeFetch(siteRoutes({ "https://opslog.co.uk/api/ops/metrics": { status: 200, body: JSON.stringify(body) } }));
    const r = await runCycle({ dir, now: () => new Date("2026-11-01T09:37:00Z"), env: { OPS_METRICS_TOKEN: "a-long-enough-token-1234" }, fetchImpl: impl, log: () => {}, only: "opslog.ops_metrics" });
    expect(r.results[0].outcome).toBe("succeeded");
    expect(existsSync(join(dir, "metrics", "latest.json"))).toBe(true);
  });

  it("never stores a secret, even one with a line break in it", async () => {
    const secret = "SECRETAAAAAAAAAA\nBBBBBBBBBBTAIL";
    const { impl } = fakeFetch(siteRoutes());
    const r = await runCycle({ dir, now: () => new Date("2026-11-01T09:37:00Z"), env: { OPS_METRICS_TOKEN: secret }, fetchImpl: impl, log: () => {}, only: "opslog.ops_metrics" });
    expect(r.results[0].outcome).toBe("failed");
    const stored = readFileSync(join(dir, "state", "queue.json"), "utf8") + readFileSync(join(dir, "state", "runs.jsonl"), "utf8") + readFileSync(join(dir, "status.json"), "utf8");
    expect(stored).not.toMatch(/SECRETAAAA|BBBBBBBBBBTAIL/);
  });

  it("keeps running health checks when the ledger file is malformed", async () => {
    mkdirSync(join(dir, "ledger"), { recursive: true });
    writeFileSync(paths(dir).ledger, "{not json\n");
    const { impl } = fakeFetch(siteRoutes());
    const r = await runCycle({ dir, now: () => new Date("2026-11-01T09:37:00Z"), env: {}, fetchImpl: impl, log: () => {} });
    const byId = Object.fromEntries(r.results.map((x: any) => [x.id, x.outcome]));
    expect(byId["opslog.public_health"]).toBe("succeeded");
    expect(byId["ops.self_check"]).toBe("failed");
    expect(Object.keys(loadState(dir).alerts.open)).toContain("ledger-damaged");
    expect(JSON.parse(readFileSync(join(dir, "status.json"), "utf8")).budget.ledgerError).toMatch(/Corrupt/);
  });

  it("detects lines removed from the end after a cycle has recorded the head", async () => {
    const f = paths(dir).ledger;
    const t = new Date("2026-11-01T08:00:00Z");
    addEntry(f, { type: "revenue", amountPence: 5000, settled: true, evidence: "pi_3Qend1", counterparty: "CUST-001" }, t);
    addEntry(f, { type: "expense", amountPence: 1500, settled: true, evidence: "rcpt-1", fundedFromCapital: true }, t);
    const { impl } = fakeFetch(siteRoutes());
    await runCycle({ dir, now: () => new Date("2026-11-01T09:37:00Z"), env: {}, fetchImpl: impl, log: () => {} });
    const lines = readFileSync(f, "utf8").trim().split("\n");
    writeFileSync(f, `${lines[0]}\n`);
    const r = await runCycle({ dir, now: () => new Date("2026-11-01T12:37:00Z"), env: {}, fetchImpl: impl, log: () => {} });
    expect(r.results.find((x: any) => x.id === "ops.self_check").outcome).toBe("failed");
  });

  it("refuses duplicate evidence and lets a correction be undone", () => {
    const f = paths(dir).ledger;
    const t = new Date("2026-11-01T10:00:00Z");
    addEntry(f, { type: "revenue", amountPence: 60000, settled: true, evidence: "pi_3QdupA", counterparty: "CUST-001" }, t);
    expect(() => addEntry(f, { type: "revenue", amountPence: 60000, settled: true, evidence: "pi_3QdupA", counterparty: "CUST-001" }, t)).toThrow(/already recorded/);
    addEntry(f, { type: "correction", supersedes: 1, description: "wrong venue" }, t);
    addEntry(f, { type: "correction", supersedes: 2, description: "the first correction was a mistake" }, t);
    expect(summarise(readJsonl(f), { capitalPence: 2000, targetNetPence: 200000 }).countedRevenuePence).toBe(60000);
    expect(() => addEntry(f, { type: "correction", supersedes: 9 }, t)).toThrow(/existing earlier line/);
  });

  it("counts capital spent even on a cost that is not attributable", () => {
    const f = paths(dir).ledger;
    addEntry(f, { type: "expense", amountPence: 1800, evidence: "rcpt-2", fundedFromCapital: true, attributable: false }, new Date());
    const s = summarise(readJsonl(f), { capitalPence: 2000, targetNetPence: 200000 });
    expect(s.capitalRemainingPence).toBe(200);
    expect(s.expensesPence).toBe(0);
  });

  it("does not call long-established businesses newly listed after the first snapshot", async () => {
    const { impl } = fakeFetch(siteRoutes());
    await runCycle({ dir, now: () => new Date("2026-11-01T09:37:00Z"), env: {}, fetchImpl: impl, log: () => {}, only: "market.fsa_refresh" });
    await runCycle({ dir, now: () => new Date("2026-11-08T09:37:00Z"), env: {}, fetchImpl: impl, log: () => {}, only: "market.fsa_refresh" });
    const cands = JSON.parse(readFileSync(join(dir, "market", "candidates.json"), "utf8")).candidates;
    // Wee Bistro was re-inspected on 2026-09-01; that is not an opening.
    const wee = cands.find((c: any) => c.key === "wee bistro");
    expect(wee.signals.join(" ")).not.toMatch(/newly listed/);
  });

  it("escalates a task that keeps killing its cycle", () => {
    const now = new Date("2026-11-01T10:00:00Z");
    const tasks: any[] = [{ id: "x", status: "running", maxAttempts: 2, attempts: 1, intervalMinutes: 10080, lease: { runId: "dead", at: now.toISOString() }, history: [] }];
    const r = recoverStale(tasks, now, "new");
    expect(r.exhausted).toEqual(["x"]);
    expect(tasks[0].status).toBe("failed");
    expect(new Date(tasks[0].nextRunAt).valueOf()).toBeGreaterThan(now.valueOf());
  });
});


describe("growth ops: round-two fixes", () => {
  it("charges compute the way GitHub bills it: each job rounded up to a whole minute", async () => {
    expect(billedSeconds(0)).toBe(120); // cycle job + save job, a minute each
    expect(billedSeconds(30)).toBe(120);
    expect(billedSeconds(31)).toBe(180);
    expect(billedSeconds(0, {}, 40)).toBe(180); // 40 s of job so far + 25 s of steps after the engine
    const { impl } = fakeFetch(siteRoutes());
    const t = new Date("2026-11-01T09:37:00Z");
    await runCycle({ dir, now: () => t, env: { GITHUB_ACTIONS: "true", GROWTH_OPS_JOB_STARTED_AT: String(t.valueOf() / 1000 - 20) }, fetchImpl: impl, log: () => {}, only: "ops.self_check" });
    // 20 s of checkout and Node, a short cycle, 25 s after: one minute, plus the save job.
    expect(loadState(dir).budget.compute.secondsUsed).toBe(120);
  });

  it("charges nothing for a cycle run on a laptop, which uses no Actions minutes", async () => {
    const { impl } = fakeFetch(siteRoutes());
    await runCycle({ dir, now: () => new Date("2026-11-01T09:37:00Z"), env: {}, fetchImpl: impl, log: () => {}, only: "ops.self_check" });
    expect(loadState(dir).budget.compute.secondsUsed).toBe(0);
  });

  it("charges the minimum before any task runs, so a cycle that dies is still counted", async () => {
    let seenDuringRun = -1;
    const routes = siteRoutes();
    const impl = async (url: string) => {
      if (seenDuringRun < 0) seenDuringRun = JSON.parse(readFileSync(join(dir, "state", "budget.json"), "utf8")).compute.secondsUsed;
      return fakeFetch(routes).impl(url);
    };
    await runCycle({ dir, now: () => new Date("2026-11-01T09:37:00Z"), env: { GITHUB_ACTIONS: "true" }, fetchImpl: impl, log: () => {}, only: "opslog.public_health" });
    expect(seenDuringRun).toBe(120);
  });

  it("in GitHub Actions replaces a lock that came with the checkout without waiting or charging", async () => {
    const t = new Date("2026-11-01T09:37:00Z");
    writeFileSync(join(dir, "state", "lock.json"), JSON.stringify({ runId: "committed", at: new Date(t.valueOf() - 10 * 60000).toISOString() }));
    const { impl } = fakeFetch(siteRoutes());
    const r = await runCycle({ dir, now: () => t, env: { GITHUB_ACTIONS: "true" }, fetchImpl: impl, log: () => {}, only: "ops.self_check" });
    expect(r.locked).toBeFalsy();
    expect(r.results.length).toBe(1);
    expect(loadState(dir).budget.compute.secondsUsed).toBe(120); // not 120 + 25 minutes
  });

  it("never runs a task that costs money from the scheduled runner, approved or not", () => {
    const now = new Date("2026-11-02T09:00:00Z");
    const task = { id: "x", priority: 2, costPence: 500 };
    const approvals = [{ id: "A1", taskId: "x", status: "approved", amountPence: 500, expiresAt: "2026-12-01T00:00:00Z" }];
    expect(runnerRefusal(task, { budget: { compute: null }, ledgerSummary: { capitalRemainingPence: 2000 }, approvals, control: {}, now })).toMatch(/never runs a task that costs money/);
    expect(runnerRefusal({ ...task, costPence: 0 }, { budget: { compute: null }, ledgerSummary: {}, approvals: [], control: {}, now })).toBeNull();
  });

  it("does not write to the owner ledger during a cycle", async () => {
    const f = paths(dir).ledger;
    addEntry(f, { type: "revenue", amountPence: 60000, settled: true, evidence: "pi_3Qabc", counterparty: "CUST-001" }, new Date("2026-11-01T08:00:00Z"));
    const before = readFileSync(f, "utf8");
    const { impl } = fakeFetch(siteRoutes());
    await runCycle({ dir, now: () => new Date("2026-11-01T09:37:00Z"), env: {}, fetchImpl: impl, log: () => {} });
    expect(readFileSync(f, "utf8")).toBe(before);
  });

  it("reports a corrupt people-edited file without quoting what is in it", () => {
    const f = join(dir, "pipeline", "prospects.json");
    mkdirSync(join(dir, "pipeline"), { recursive: true });
    writeFileSync(f, '{"prospects": [{"contact": jane.smith@example.com}]}');
    expect(() => readJson(f, {})).toThrow(/Corrupt JSON/);
    try {
      readJson(f, {});
    } catch (e: any) {
      expect(e.message).not.toMatch(/jane|smith|example/);
    }
  });

  it("never profiles a business marked do_not_contact or won, by FSA id or by name", async () => {
    mkdirSync(join(dir, "pipeline"), { recursive: true });
    writeFileSync(join(dir, "pipeline", "prospects.json"), JSON.stringify({ prospects: [
      { id: "P-001", name: "Wee Bistro", stage: "do_not_contact", fhrsIds: [] },
      { id: "P-002", name: "Something Else", stage: "won", fhrsIds: [105] },
      { id: "P-003", name: "Paid Up", stage: "paid", fhrsIds: [] },
      { id: "P-004", name: "Live Venue", stage: "onboarded", fhrsIds: [] },
    ] }));
    const { impl } = fakeFetch(siteRoutes());
    await runCycle({ dir, now: () => new Date("2026-11-01T09:37:00Z"), env: {}, fetchImpl: impl, log: () => {}, only: "market.fsa_refresh" });
    const cands = JSON.parse(readFileSync(join(dir, "market", "candidates.json"), "utf8")).candidates;
    const names = cands.map((c: any) => c.key);
    expect(names).not.toContain("wee bistro"); // by name
    expect(names).not.toContain("cafe and co"); // by FSA id 105
    const summary = JSON.parse(readFileSync(join(dir, "market", "summary.json"), "utf8"));
    expect(summary.excludedFromProfiling).toBe(4);
    // The objection itself is kept: the prospects file is not rewritten.
    expect(JSON.parse(readFileSync(join(dir, "pipeline", "prospects.json"), "utf8")).prospects[0].stage).toBe("do_not_contact");
  });

  it("keeps no names or addresses in the weekly comparison snapshot", async () => {
    const { impl } = fakeFetch(siteRoutes());
    await runCycle({ dir, now: () => new Date("2026-11-01T09:37:00Z"), env: {}, fetchImpl: impl, log: () => {}, only: "market.fsa_refresh" });
    const snap = JSON.parse(readFileSync(join(dir, "market", "establishments.json"), "utf8"));
    expect(snap.establishments.length).toBeGreaterThan(0);
    for (const e of snap.establishments) expect(Object.keys(e).sort()).toEqual(["id", "laId", "rating", "ratingDate", "typeId"]);
  });

  it("reuses an open alert issue instead of opening a duplicate, and waits when it cannot check", async () => {
    const now = new Date("2026-11-01T09:37:00Z");
    const alerts = { open: { k1: { key: "k1", title: "x", detail: "y", since: now.toISOString(), count: 1, issueNumber: null } }, closed: [] };
    let posts = 0;
    const listing = async (_u: string, o: any = {}) => ((o.method ?? "GET") === "GET"
      ? { status: 200, text: JSON.stringify([{ number: 41, body: `old\n${issueMarker("k1")}` }]) }
      : (posts++, { status: 201, text: JSON.stringify({ number: 42 }) }));
    await syncIssues(alerts, { http: listing, token: "t", repo: "o/r" });
    expect(posts).toBe(0);
    expect(alerts.open.k1.issueNumber).toBe(41);

    const alerts2 = { open: { k2: { key: "k2", title: "x", detail: "y", since: now.toISOString(), count: 1, issueNumber: null } }, closed: [] };
    const listFails = async (_u: string, o: any = {}) => ((o.method ?? "GET") === "GET" ? { status: 502, text: "" } : (posts++, { status: 201, text: "{}" }));
    await syncIssues(alerts2, { http: listFails, token: "t", repo: "o/r", log: () => {} });
    expect(posts).toBe(0);
    expect(alerts2.open.k2.issueNumber).toBeNull();
  });

  it("lets a large download take longer than the default request timeout", async () => {
    const slow = async (_u: string, init: any) => {
      await new Promise((r, j) => {
        const t = setTimeout(r, 60);
        init.signal?.addEventListener("abort", () => { clearTimeout(t); j(Object.assign(new Error("aborted"), { name: "AbortError" })); });
      });
      return new Response("ok", { status: 200 });
    };
    const http = makeHttp({ allowHosts: ["ratings.food.gov.uk"], timeoutMs: 10, fetchImpl: slow });
    await expect(http("https://ratings.food.gov.uk/x")).rejects.toThrow(/Timed out after 10 ms/);
    await expect(http("https://ratings.food.gov.uk/x", { timeoutMs: 1000 })).resolves.toMatchObject({ status: 200 });
  });

  it("accepts numeric payment references and refuses a bank reference that carries a name", () => {
    expect(validateEntry({ type: "revenue", amountPence: 100, settled: true, evidence: "txn_1234567890", counterparty: "CUST-006" })).toEqual([]);
    expect(validateEntry({ type: "revenue", amountPence: 100, settled: true, evidence: "bank:20261031-60000", counterparty: "CUST-006" })).toEqual([]);
    expect(validateEntry({ type: "revenue", amountPence: 100, settled: true, evidence: "bank:FP JANE SMITH EH6", counterparty: "CUST-007" }).length).toBeGreaterThan(0);
    expect(validateEntry({ type: "expense", amountPence: 100, category: "Jane Smith" }).length).toBeGreaterThan(0);
    expect(validateEntry({ type: "expense", amountPence: 100, description: "x".repeat(121) }).length).toBeGreaterThan(0);
  });
});

describe("growth ops: round-three fixes", () => {
  const BOT = { login: "github-actions[bot]" };
  function github(issues: any[], opts: { failList?: boolean } = {}) {
    const calls: string[] = [];
    const http = async (url: string, o: any = {}) => {
      const method = o.method ?? "GET";
      calls.push(`${method} ${url.replace("https://api.github.com/repos/o/r", "")}`);
      if (method === "GET") {
        if (opts.failList) return { status: 502, text: "" };
        const page = Number(new URL(url).searchParams.get("page") ?? 1);
        return { status: 200, text: JSON.stringify(issues.slice((page - 1) * 100, page * 100)) };
      }
      if (method === "POST" && url.endsWith("/issues")) return { status: 201, text: JSON.stringify({ number: 900 }) };
      return { status: 200, text: "{}" };
    };
    return { http, calls };
  }
  const alert = (key: string) => ({ key, title: "t", detail: "d", since: "2026-11-01T00:00:00Z", count: 1, issueNumber: null });

  it("finds an alert issue beyond the first page, and never adopts a pull request or a stranger's issue", async () => {
    const filler = Array.from({ length: 130 }, (_, i) => ({ number: 1000 - i, body: "unrelated", user: { login: "someone" } }));
    const issues = [
      ...filler,
      { number: 52, body: `copied ${issueMarker("k1")}`, user: BOT, pull_request: {} },
      { number: 60, body: `pasted ${issueMarker("k1")}`, user: { login: "someone" } },
      { number: 41, body: `real ${issueMarker("k1")}`, user: BOT },
    ];
    const { http, calls } = github(issues);
    const alerts = { open: { k1: alert("k1") }, closed: [] };
    await syncIssues(alerts, { http, token: "t", repo: "o/r", author: BOT.login });
    expect(alerts.open.k1.issueNumber).toBe(41);
    expect(calls.filter((c) => c.startsWith("GET")).length).toBe(2);
    expect(calls.some((c) => c.startsWith("POST /issues "))).toBe(false);
    expect(calls.some((c) => c.includes("/issues/52") || c.includes("/issues/60"))).toBe(false);
  });

  it("closes an issue whose alert cleared in a run that was never saved, and closes duplicates", async () => {
    const issues = [
      { number: 41, body: issueMarker("site-down"), user: BOT },
      { number: 45, body: issueMarker("k2"), user: BOT },
      { number: 47, body: issueMarker("k2"), user: BOT },
    ];
    const { http, calls } = github(issues);
    const alerts = { open: { k2: alert("k2") }, closed: [] };
    await syncIssues(alerts, { http, token: "t", repo: "o/r", author: BOT.login, now: new Date("2026-11-02T00:00:00Z") });
    expect(alerts.open.k2.issueNumber).toBe(45);
    expect(calls).toContain("PATCH /issues/41");
    expect(calls).toContain("PATCH /issues/47");
    expect(calls).not.toContain("PATCH /issues/45");
  });

  it("opens and closes nothing when the issue list cannot be read", async () => {
    const { http, calls } = github([], { failList: true });
    const alerts = { open: { k3: alert("k3") }, closed: [] };
    await syncIssues(alerts, { http, token: "t", repo: "o/r", author: BOT.login, log: () => {} });
    expect(calls.filter((c) => !c.startsWith("GET"))).toEqual([]);
  });

  it("still charges a run whose people-edited files cannot be read", async () => {
    writeFileSync(join(dir, "state", "control.json"), '{"paused": true,}');
    const { impl } = fakeFetch(siteRoutes());
    await expect(runCycle({ dir, now: () => new Date("2026-11-01T09:37:00Z"), env: { GITHUB_ACTIONS: "true" }, fetchImpl: impl, log: () => {} })).rejects.toThrow(/Corrupt JSON/);
    expect(JSON.parse(readFileSync(join(dir, "state", "budget.json"), "utf8")).compute.secondsUsed).toBe(120);
  });

  it("keeps phone numbers out of every kind of ledger evidence, and lets dates through descriptions", () => {
    expect(validateEntry({ type: "expense", amountPence: 100, evidence: "paid to Jane Smith 07700 900123" }).length).toBeGreaterThan(0);
    expect(validateEntry({ type: "refund", amountPence: 100, evidence: "refund to +44 7700 900123" }).length).toBeGreaterThan(0);
    expect(validateEntry({ type: "revenue", amountPence: 100, settled: true, test: true, evidence: "Jane 07700900123" }).length).toBeGreaterThan(0);
    expect(validateEntry({ type: "revenue", amountPence: 100, settled: true, evidence: "bank:JANE.SMITH", counterparty: "CUST-001" }).length).toBeGreaterThan(0);
    expect(validateEntry({ type: "expense", amountPence: 100, category: "licence", description: "Domain 2026-11-01 to 2027-10-31" })).toEqual([]);
    expect(validateEntry({ type: "expense", amountPence: 100, category: "licence", description: "Invoice INV-2026-000123" })).toEqual([]);
    expect(looksPhone("0131 496 0000")).toBe(true);
    expect(looksPhone("2026-11-01")).toBe(false);
  });

  it("writes no prospect names or free-text next actions into the pipeline summary", async () => {
    mkdirSync(join(dir, "pipeline"), { recursive: true });
    writeFileSync(join(dir, "pipeline", "prospects.json"), JSON.stringify({ prospects: [
      { id: "P-001", name: "Hill Bistro", stage: "qualified", nextAction: "Call Jane Smith on 07700 900123", nextActionDue: "2026-10-30" },
      { id: "P-002", name: "Dale Cafe", stage: "contacted", lastTouch: "2026-09-01" },
    ] }));
    const { impl } = fakeFetch(siteRoutes());
    await runCycle({ dir, now: () => new Date("2026-11-01T09:37:00Z"), env: {}, fetchImpl: impl, log: () => {}, only: "pipeline.review" });
    const text = readFileSync(join(dir, "pipeline", "summary.json"), "utf8");
    expect(text).not.toMatch(/Hill Bistro|Dale Cafe|Jane|07700/);
    expect(JSON.parse(text).due[0].id).toBe("P-001");
  });

  it("tracks the full acquisition pipeline: proposal, signed, paid, onboarded", async () => {
    mkdirSync(join(dir, "pipeline"), { recursive: true });
    writeFileSync(join(dir, "pipeline", "prospects.json"), JSON.stringify({ prospects: [
      { id: "P-001", stage: "proposal_sent", lastTouch: "2026-09-01" },
      { id: "P-002", stage: "won", lastTouch: "2026-09-01", nextActionDue: "2026-10-30" },
      { id: "P-003", stage: "paid", lastTouch: "2026-10-30" },
      { id: "P-004", stage: "onboarded", lastTouch: "2026-09-01" },
      { id: "P-005", stage: "lost", nextActionDue: "2026-10-01" },
      { id: "P-006", stage: "trial" },
    ] }));
    const { impl } = fakeFetch(siteRoutes());
    await runCycle({ dir, now: () => new Date("2026-11-01T09:37:00Z"), env: {}, fetchImpl: impl, log: () => {}, only: "pipeline.review" });
    const sum = JSON.parse(readFileSync(join(dir, "pipeline", "summary.json"), "utf8"));
    expect(sum.byStage).toMatchObject({ proposal_sent: 1, won: 1, paid: 1, onboarded: 1, lost: 1 });
    // A signed but unpaid customer still has actions due; a lost one never does.
    expect(sum.due.map((d: any) => d.id)).toEqual(["P-002"]);
    // Untouched proposals and unpaid signings go stale; a live customer does not.
    expect(sum.stale.map((d: any) => d.id)).toEqual(["P-001", "P-002"]);
    // There is no free-trial stage: OpsLog offers no free periods.
    expect(sum.problems).toEqual(["P-006: unknown stage"]);
  });
});
