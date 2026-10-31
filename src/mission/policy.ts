/**
 * Mission policy rules and the post-execution hook.
 *
 * In mission mode every tool that spends money, contacts someone, publishes
 * something, changes the agent's own code or installs software needs an
 * approved request bound to the exact call. The rule runs inside the
 * existing PolicyEngine, so it is enforced in code for every tool call
 * rather than requested in a prompt.
 */

import type BetterSqlite3 from "better-sqlite3";
import type {
  AutomatonConfig,
  PolicyRequest,
  PolicyRule,
  PolicyRuleResult,
} from "../types.js";
import type { ApprovalKind } from "./types.js";
import { getMissionConfig, isMissionEnabled, usdCentsToPence } from "./config.js";
import {
  consumeApproval,
  findUsableApproval,
  hashToolArgs,
  requestApproval,
} from "./approvals.js";
import { checkSpendFits } from "./budget.js";
import { appendLedgerEntry } from "./ledger.js";

type Database = BetterSqlite3.Database;

/** Tools that need an approved request in mission mode, and what kind. */
export const MISSION_GATED_TOOLS: Readonly<Record<string, ApprovalKind>> = Object.freeze({
  // Money
  topup_credits: "spend",
  transfer_credits: "spend",
  x402_fetch: "spend",
  register_domain: "spend",
  create_sandbox: "spend",
  register_erc8004: "spend",
  fund_child: "spend",
  switch_model: "spend",
  // Contacting people or other agents
  send_message: "outreach",
  message_child: "outreach",
  give_feedback: "outreach",
  // Publishing
  expose_port: "publish",
  manage_dns: "publish",
  git_push: "publish",
  update_agent_card: "publish",
  // Replication and changes to the agent itself
  spawn_child: "external_action",
  start_child: "external_action",
  delete_sandbox: "external_action",
  install_npm_package: "external_action",
  install_mcp_server: "external_action",
  install_skill: "external_action",
  create_skill: "external_action",
  remove_skill: "external_action",
  edit_own_file: "external_action",
  revert_last_edit: "external_action",
  reset_to_upstream: "external_action",
  pull_upstream: "external_action",
  update_genesis_prompt: "external_action",
  modify_heartbeat: "external_action",
});

/** Ledger category for an approved spend, by tool. */
const SPEND_CATEGORY: Readonly<Record<string, string>> = Object.freeze({
  topup_credits: "compute_credits",
  transfer_credits: "credit_transfer",
  x402_fetch: "paid_api",
  register_domain: "domain",
  create_sandbox: "hosting",
  register_erc8004: "onchain_fee",
  fund_child: "child_funding",
});

/** Best estimate of a spend in pence from the tool arguments, or 0 if priced later. */
export function estimateSpendPence(
  toolName: string,
  args: Record<string, unknown>,
  config: AutomatonConfig,
): number {
  const mission = getMissionConfig(config);
  if (toolName === "topup_credits") {
    const usd = Number(args.amount_usd);
    return Number.isFinite(usd) && usd > 0 ? usdCentsToPence(usd * 100, mission) : 0;
  }
  if (toolName === "transfer_credits" || toolName === "fund_child") {
    const cents = Number(args.amount_cents);
    return Number.isFinite(cents) && cents > 0 ? usdCentsToPence(cents, mission) : 0;
  }
  return 0;
}

function describeCall(toolName: string, args: Record<string, unknown>): string {
  let rendered: string;
  try {
    rendered = JSON.stringify(args);
  } catch {
    rendered = "[unserialisable arguments]";
  }
  return `${toolName}(${rendered.length > 400 ? `${rendered.slice(0, 400)}…` : rendered})`;
}

function deny(rule: string, reasonCode: string, humanMessage: string): PolicyRuleResult {
  return { rule, action: "deny", reasonCode, humanMessage };
}

function rawDbFrom(request: PolicyRequest): Database | undefined {
  return (request.context as any)?.db?.raw as Database | undefined;
}

const shellDisabledRule: PolicyRule = {
  id: "mission.shell_disabled",
  description: "In mission mode the agent has no shell unless mission.allowShell is set",
  priority: 40,
  appliesTo: { by: "name", names: ["exec"] },
  evaluate(request: PolicyRequest): PolicyRuleResult | null {
    const config = request.context?.config;
    if (!isMissionEnabled(config)) return null;
    if (config?.mission?.allowShell === true) return null;
    return deny(
      "mission.shell_disabled",
      "MISSION_SHELL_DISABLED",
      "Shell access is disabled in mission mode. Use the mission, file and web_fetch tools.",
    );
  },
};

const approvalGateRule: PolicyRule = {
  id: "mission.approval_gate",
  description: "Spending, outreach, publishing and self-modification need an approved request in mission mode",
  priority: 45,
  appliesTo: { by: "all" },
  evaluate(request: PolicyRequest): PolicyRuleResult | null {
    const config = request.context?.config;
    if (!isMissionEnabled(config)) return null;
    const toolName = request.tool.name;
    const kind = MISSION_GATED_TOOLS[toolName];
    if (!kind) return null;

    const db = rawDbFrom(request);
    if (!db) {
      return deny("mission.approval_gate", "MISSION_APPROVALS_UNAVAILABLE", "Cannot verify approvals, so the action is blocked.");
    }

    const args = request.args ?? {};
    const argsHash = hashToolArgs(toolName, args);
    const approval = findUsableApproval(db, toolName, argsHash);

    if (approval) {
      if (kind === "spend") {
        const fits = checkSpendFits(db, getMissionConfig(config!), approval.amountPence);
        if (!fits.fits) {
          return deny("mission.approval_gate", "MISSION_BUDGET_EXCEEDED", fits.reason ?? "Over budget");
        }
      }
      return null;
    }

    try {
      const pending = requestApproval(db, {
        kind,
        toolName,
        argsHash,
        summary: describeCall(toolName, args),
        amountPence: kind === "spend" ? estimateSpendPence(toolName, args, config!) : 0,
        requestedBy: "agent",
      });
      return deny(
        "mission.approval_gate",
        "MISSION_APPROVAL_REQUIRED",
        `This needs the operator's approval (request ${pending.id}). Carry on with other work and retry this exact call once it is approved.`,
      );
    } catch (err) {
      return deny(
        "mission.approval_gate",
        "MISSION_APPROVAL_QUEUE_FULL",
        err instanceof Error ? err.message : String(err),
      );
    }
  },
};

export function createMissionPolicyRules(): PolicyRule[] {
  return [shellDisabledRule, approvalGateRule];
}

const FAILURE_PREFIX = /^\s*(blocked|error|failed|failure|policy denied)\b/i;

/**
 * Called after a tool has executed. Consumes the approval it used and, for
 * spends, records the approved amount as a settled expense in the ledger.
 * Failed calls leave the approval in place so the agent can retry.
 */
export function afterMissionToolExecuted(
  db: Database,
  config: AutomatonConfig,
  toolName: string,
  args: Record<string, unknown>,
  result: string,
): void {
  if (!isMissionEnabled(config)) return;
  const kind = MISSION_GATED_TOOLS[toolName];
  if (!kind) return;
  if (FAILURE_PREFIX.test(result)) return;

  const approval = findUsableApproval(db, toolName, hashToolArgs(toolName, args));
  if (!approval) return;

  const apply = db.transaction(() => {
    if (!consumeApproval(db, approval.id)) return;
    if (kind === "spend" && approval.amountPence > 0) {
      appendLedgerEntry(db, {
        entryType: "expense",
        status: "settled",
        amountPence: approval.amountPence,
        category: SPEND_CATEGORY[toolName] ?? "other",
        description: `Approved ${toolName} (maximum authorised; reconcile against the receipt)`,
        evidenceRef: `approval:${approval.id}`,
        approvalId: approval.id,
        recordedBy: "system",
      });
    }
  });
  apply();
}
