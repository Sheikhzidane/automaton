/**
 * Mission and security policy rules, run through the real PolicyEngine
 * with the full default rule set.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { PolicyEngine } from "../../agent/policy-engine.js";
import { createDefaultRules } from "../../agent/policy-rules/index.js";
import { afterMissionToolExecuted } from "../../mission/policy.js";
import { decideApproval, listApprovals } from "../../mission/approvals.js";
import { appendLedgerEntry, summariseLedger } from "../../mission/ledger.js";
import { getMissionConfig } from "../../mission/config.js";
import type { AutomatonConfig, AutomatonDatabase } from "../../types.js";
import { createTestConfig } from "../mocks.js";
import { fakeTool, missionConfig, newDb, policyRequest } from "./helpers.js";

let db: AutomatonDatabase;
let engine: PolicyEngine;

beforeEach(() => {
  db = newDb().db;
  engine = new PolicyEngine(db.raw, createDefaultRules());
});

function evaluate(toolName: string, args: Record<string, unknown>, config: AutomatonConfig, category: any = "financial") {
  return engine.evaluate(policyRequest(fakeTool(toolName, category), args, config, db));
}

describe("mission approval gate", () => {
  const config = missionConfig();

  it("denies an unapproved spend and files a pending request with an estimate", () => {
    const decision = evaluate("topup_credits", { amount_usd: 5 }, config);
    expect(decision.action).toBe("deny");
    expect(decision.reasonCode).toBe("MISSION_APPROVAL_REQUIRED");
    const [pending] = listApprovals(db.raw, ["pending"]);
    expect(pending.kind).toBe("spend");
    expect(pending.toolName).toBe("topup_credits");
    expect(pending.amountPence).toBe(412);
  });

  it("gates outreach, publishing and self-modification too", () => {
    expect(evaluate("send_message", { to: "x", content: "hi" }, config, "conway").reasonCode).toBe("MISSION_APPROVAL_REQUIRED");
    expect(evaluate("git_push", { path: "/root/x" }, config, "git").reasonCode).toBe("MISSION_APPROVAL_REQUIRED");
    expect(evaluate("install_npm_package", { package: "left-pad" }, config, "self_mod").reasonCode).toBe("MISSION_APPROVAL_REQUIRED");
  });

  it("allows the exact approved call within budget, then books the spend once", () => {
    const args = { amount_usd: 5 };
    evaluate("topup_credits", args, config);
    const [pending] = listApprovals(db.raw, ["pending"]);
    decideApproval(db.raw, getMissionConfig(config), pending.id, { decision: "approved", decidedBy: "human" });

    expect(evaluate("topup_credits", { amount_usd: 25 }, config).reasonCode).toBe("MISSION_APPROVAL_REQUIRED");
    expect(evaluate("topup_credits", args, config).action).toBe("allow");

    afterMissionToolExecuted(db.raw, config, "topup_credits", args, "Credits topped up: $5");
    const s = summariseLedger(db.raw);
    expect(s.expensesPence).toBe(412);
    expect(evaluate("topup_credits", args, config).reasonCode).toBe("MISSION_APPROVAL_REQUIRED");

    afterMissionToolExecuted(db.raw, config, "topup_credits", args, "Credits topped up: $5");
    expect(summariseLedger(db.raw).expensesPence).toBe(412);
  });

  it("keeps the approval when the tool reports a failure", () => {
    const args = { amount_usd: 5 };
    evaluate("topup_credits", args, config);
    const [pending] = listApprovals(db.raw, ["pending"]);
    decideApproval(db.raw, getMissionConfig(config), pending.id, { decision: "approved", decidedBy: "human" });
    afterMissionToolExecuted(db.raw, config, "topup_credits", args, "Error: payment failed");
    expect(summariseLedger(db.raw).expensesPence).toBe(0);
    expect(evaluate("topup_credits", args, config).action).toBe("allow");
  });

  it("re-checks the budget at execution time", () => {
    const args = { amount_usd: 5 };
    evaluate("topup_credits", args, config);
    const [pending] = listApprovals(db.raw, ["pending"]);
    decideApproval(db.raw, getMissionConfig(config), pending.id, { decision: "approved", decidedBy: "human" });
    appendLedgerEntry(db.raw, { entryType: "expense", status: "settled", amountPence: 1800, category: "other", description: "Spent elsewhere", recordedBy: "human" });
    const decision = evaluate("topup_credits", args, config);
    expect(decision.action).toBe("deny");
    expect(decision.reasonCode).toBe("MISSION_BUDGET_EXCEEDED");
  });

  it("does not gate ordinary tools", () => {
    expect(evaluate("read_file", { path: "/root/notes.md" }, config, "vm").action).toBe("allow");
    expect(evaluate("mission_status", {}, config, "mission").action).toBe("allow");
  });

  it("is inert when the mission is off", () => {
    expect(evaluate("send_message", { to: "x", content: "hi" }, createTestConfig(), "conway").action).toBe("allow");
    expect(listApprovals(db.raw)).toHaveLength(0);
  });

  it("denies the agent a shell in mission mode unless allowShell is set", () => {
    expect(evaluate("exec", { command: "ls" }, config, "vm").reasonCode).toBe("MISSION_SHELL_DISABLED");
    expect(evaluate("exec", { command: "ls" }, missionConfig({ allowShell: true }), "vm").action).toBe("allow");
  });
});

describe("security rules", () => {
  it("denies replication by default and allows it only when enabled", () => {
    const off = createTestConfig();
    expect(evaluate("spawn_child", { name: "c" }, off, "replication").reasonCode).toBe("REPLICATION_DISABLED");
    expect(evaluate("fund_child", { child_id: "x", amount_cents: 100 }, off, "replication").reasonCode).toBe("REPLICATION_DISABLED");
    const on = createTestConfig({ security: { replicationEnabled: true } });
    expect(evaluate("spawn_child", { name: "c" }, on, "replication").reasonCode).not.toBe("REPLICATION_DISABLED");
  });

  it("denies shell commands that reach for secrets, for anyone", () => {
    const config = createTestConfig();
    for (const command of [
      "head ~/.automaton/wallet.json",
      "base64 /root/.automaton/wallet.json",
      'python3 -c "print(open(\'/root/.automaton/automaton.json\').read())"',
      "printenv",
      "env | grep KEY",
    ]) {
      const decision = evaluate("exec", { command }, config, "vm");
      expect(decision.action, command).toBe("deny");
    }
    expect(evaluate("exec", { command: "ls -la /root/project" }, config, "vm").action).toBe("allow");
  });
});
