/**
 * Safe web fetch (SSRF guards) and the operator CLI.
 */

import { describe, it, expect, beforeEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import type BetterSqlite3 from "better-sqlite3";
import { listMissionTasks } from "../../mission/tasks.js";
import { htmlToText, isPrivateAddress, safeWebFetch, validateFetchUrl, WebFetchBlockedError } from "../../mission/web-fetch.js";
import { confirmInteractively, parseArgs, runMissionCli, verifyControls, type CliIO } from "../../mission/cli.js";
import { listApprovals, requestApproval } from "../../mission/approvals.js";
import { summariseLedger } from "../../mission/ledger.js";
import { createTestConfig } from "../mocks.js";
import { missionConfig, newDb } from "./helpers.js";

describe("web fetch guards", () => {
  it("rejects non-http schemes, credentials and private hosts", () => {
    for (const url of [
      "file:///etc/passwd",
      "ftp://example.com",
      "http://localhost:3000",
      "http://127.0.0.1/",
      "http://10.0.0.5/",
      "http://169.254.169.254/latest/meta-data/",
      "http://[::1]/",
      "https://user:pass@example.com/",
      "http://printer.local/",
    ]) {
      expect(() => validateFetchUrl(url), url).toThrow(WebFetchBlockedError);
    }
    expect(validateFetchUrl("https://example.com/page").hostname).toBe("example.com");
  });

  it("classifies private and public addresses", () => {
    expect(isPrivateAddress("192.168.1.10")).toBe(true);
    expect(isPrivateAddress("172.20.0.1")).toBe(true);
    expect(isPrivateAddress("100.64.0.1")).toBe(true);
    expect(isPrivateAddress("::ffff:10.0.0.1")).toBe(true);
    expect(isPrivateAddress("fd00::1")).toBe(true);
    expect(isPrivateAddress("93.184.216.34")).toBe(false);
    expect(isPrivateAddress("2606:4700::1111")).toBe(false);
  });

  it("refuses redirects into private address space", async () => {
    const fetchImpl = (async () =>
      new Response(null, { status: 302, headers: { location: "http://127.0.0.1/admin" } })) as typeof fetch;
    await expect(safeWebFetch("http://93.184.216.34/", { fetchImpl })).rejects.toThrow(WebFetchBlockedError);
  });

  it("returns plain text and truncates large bodies", async () => {
    const html = `<html><head><style>x{}</style><script>alert(1)</script></head><body><h1>Menu</h1><p>Pizza &amp; pasta</p>${"a".repeat(500)}</body></html>`;
    const fetchImpl = (async () => new Response(html, { status: 200, headers: { "content-type": "text/html" } })) as typeof fetch;
    const result = await safeWebFetch("http://93.184.216.34/", { fetchImpl, maxBytes: 200 });
    expect(result.truncated).toBe(true);
    expect(result.text).toContain("Menu");
    expect(result.text).not.toContain("alert");
    expect(htmlToText("<p>a</p><p>b</p>")).toBe("a\n b");
  });

  it("ignores binary content", async () => {
    const fetchImpl = (async () => new Response("PK\u0003\u0004", { status: 200, headers: { "content-type": "application/zip" } })) as typeof fetch;
    const result = await safeWebFetch("http://93.184.216.34/file.zip", { fetchImpl });
    expect(result.text).toBe("");
  });
});

function fakeIO(answers: string[] = [], isTTY = true): CliIO & { lines: string[]; errors: string[] } {
  const lines: string[] = [];
  const errors: string[] = [];
  return {
    lines,
    errors,
    isTTY,
    out: (l) => lines.push(l),
    err: (l) => errors.push(l),
    ask: async () => answers.shift() ?? "",
  };
}

describe("operator CLI", () => {
  let raw: BetterSqlite3.Database;
  const config = missionConfig();

  beforeEach(() => {
    raw = newDb().raw;
  });

  it("parses flags and positionals", () => {
    expect(parseArgs(["approve", "01ABC", "--amount-pence", "500", "--pending"])).toEqual({
      positional: ["approve", "01ABC"],
      flags: { "amount-pence": "500", pending: true },
    });
  });

  it("refuses changes without an interactive terminal", async () => {
    const io = fakeIO([], false);
    expect(await confirmInteractively(io, "do it", "1234")).toBe(false);
    const code = await runMissionCli(
      ["record-revenue", "--amount-pence", "5000", "--evidence", "pi_1", "--category", "service", "--description", "Paid"],
      io,
      { config, db: raw },
    );
    expect(code).toBe(2);
    expect(summariseLedger(raw).countableRevenuePence).toBe(0);
  });

  it("records settled revenue after typed confirmation", async () => {
    const io = fakeIO(["5000"]);
    const code = await runMissionCli(
      ["record-revenue", "--amount-pence", "5000", "--evidence", "pi_1", "--category", "service", "--description", "Readiness review", "--counterparty", "CUST-001"],
      io,
      { config, db: raw },
    );
    expect(code).toBe(0);
    expect(summariseLedger(raw).countableRevenuePence).toBe(5000);
  });

  it("approves by ID suffix with the confirmation code", async () => {
    const approval = requestApproval(raw, { kind: "outreach", summary: "Email to CUST-002", requestedBy: "agent" });
    const io = fakeIO([approval.id.slice(-4)]);
    const code = await runMissionCli(["approve", approval.id.slice(-8)], io, { config, db: raw });
    expect(code).toBe(0);
    expect(listApprovals(raw, ["approved"])).toHaveLength(1);
  });

  it("does nothing when the confirmation code is wrong", async () => {
    const approval = requestApproval(raw, { kind: "outreach", summary: "Email", requestedBy: "agent" });
    const code = await runMissionCli(["approve", approval.id], fakeIO(["nope"]), { config, db: raw });
    expect(code).toBe(2);
    expect(listApprovals(raw, ["pending"])).toHaveLength(1);
  });

  it("imports a private plan with explicit task order", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mission-plan-"));
    const file = path.join(dir, "plan.json");
    fs.writeFileSync(
      file,
      JSON.stringify({
        tasks: [
          { title: "Collect payment", stage: "collect", priority: 40 },
          { title: "Build lead list", stage: "research", priority: 5 },
        ],
        checkpoint: { nextAction: "Build lead list" },
      }),
    );
    const code = await runMissionCli(["seed", "--file", file], fakeIO(["SEED"]), { config, db: raw });
    expect(code).toBe(0);
    expect(listMissionTasks(raw).map((t) => t.title)).toEqual(["Build lead list", "Collect payment"]);
  });

  it("refuses to run when the mission is off", async () => {
    const io = fakeIO();
    expect(await runMissionCli(["status"], io, { config: createTestConfig(), db: raw })).toBe(1);
  });

  it("passes every control check with the default mission settings and leaves no trace", async () => {
    const checks = await verifyControls(raw, config);
    const failed = checks.filter((c) => !c.pass);
    expect(failed).toEqual([]);
    expect(listApprovals(raw)).toHaveLength(0);
    expect(raw.prepare("SELECT COUNT(*) AS n FROM mission_ledger").get()).toEqual({ n: 0 });
  });

  it("reports failing controls when safety switches are turned off", async () => {
    const unsafe = missionConfig({ allowShell: true }, { security: { replicationEnabled: true } });
    const checks = await verifyControls(raw, unsafe);
    const failed = checks.filter((c) => !c.pass).map((c) => c.name);
    expect(failed).toEqual(expect.arrayContaining(["Agent shell is blocked", "Replication is disabled", "Agent exec is refused"]));
  });
});
