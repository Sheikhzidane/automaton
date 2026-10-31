import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-ignore plain ESM module without type declarations
import { runCycle } from "../../../ops/lib/engine.mjs";
// @ts-ignore
import { initState, loadState, saveState, paths } from "../../../ops/lib/state.mjs";
// @ts-ignore
import { nextCronTime } from "../../../ops/lib/cron.mjs";
// @ts-ignore
import { parseFhrsXml, buildCandidates, normaliseName, diffEstablishments } from "../../../ops/lib/fhrs.mjs";
// @ts-ignore
import { addEntry, summarise, verifyChain } from "../../../ops/lib/ledger.mjs";
// @ts-ignore
import { readJsonl } from "../../../ops/lib/util.mjs";
// @ts-ignore
import { finishTask, isDue, reconcileTasks } from "../../../ops/lib/queue.mjs";

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
    addEntry(f, { type: "revenue", amountPence: 60000, settled: true, evidence: "pi_1", counterparty: "CUST-001" }, now);
    addEntry(f, { type: "revenue", amountPence: 60000, settled: false, counterparty: "CUST-002" }, now);
    addEntry(f, { type: "revenue", amountPence: 200, settled: true, evidence: "in_old", relatedParty: true }, now);
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
    addEntry(f, { type: "revenue", amountPence: 5000, settled: true, evidence: "pi_x", counterparty: "CUST-009" }, now);
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
        posted.push({ url, body: JSON.parse(init.body) });
        return new Response(JSON.stringify({ number: 7 }), { status: 201 });
      }
      return fakeFetch(routes).impl(url);
    };
    await runCycle({ dir, now: () => new Date("2026-11-01T09:37:00Z"), env: { GITHUB_TOKEN: "t", GITHUB_REPOSITORY: "o/r" }, fetchImpl: impl, log: () => {} });
    expect(posted[0].url).toBe("https://api.github.com/repos/o/r/issues");
    expect(posted[0].body.labels).toEqual(["growth-ops-alert"]);
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
    saveState(s);
    const { impl } = fakeFetch(siteRoutes());
    const r = await runCycle({ dir, now: () => new Date("2026-11-01T09:37:00Z"), env: {}, fetchImpl: impl, log: () => {} });
    expect(r.results).toHaveLength(0);
    s = loadState(dir);
    s.control = { paused: false };
    const h = s.queue.tasks.find((t: any) => t.id === "opslog.public_health");
    h.status = "running";
    h.lease = { runId: "dead", at: "2026-11-01T06:37:00Z" };
    saveState(s);
    const r2 = await runCycle({ dir, now: () => new Date("2026-11-01T09:40:00Z"), env: {}, fetchImpl: impl, log: () => {} });
    expect(r2.results.find((x: any) => x.id === "opslog.public_health").outcome).toBe("succeeded");
  });
});
