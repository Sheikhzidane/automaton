/**
 * Operator CLI for the commercial mission:  automaton --mission <command>
 *
 * Every command that changes money, approvals or mission data asks for
 * confirmation on an interactive terminal. A process without a TTY (such as
 * a shell the agent might run) cannot use these commands, and the policy
 * engine also blocks any agent command that mentions --mission.
 */

import fs from "fs";
import path from "path";
import readline from "readline";
import type BetterSqlite3 from "better-sqlite3";
import type { AutomatonConfig, ConwayClient } from "../types.js";
import { loadConfig, resolvePath } from "../config.js";
import { createDatabase } from "../state/database.js";
import { formatPence, getMissionConfig, isAutoSpendAllowed, isMissionEnabled } from "./config.js";
import { buildMissionSnapshot, renderDailyReport, renderMissionStatus } from "./report.js";
import { decideApproval, findApprovalByRef, listApprovals } from "./approvals.js";
import { appendLedgerEntry, getLedgerEntry } from "./ledger.js";
import { checkSpendFits, ensureMissionStarted, getMissionBudgetState, grantCapital } from "./budget.js";
import { addMissionTask, listMissionTasks, setCheckpoint } from "./tasks.js";
import { listOpportunities, upsertOpportunity } from "./opportunities.js";
import type { LedgerEntryType, MissionStage, OpportunityCriteria, OpportunityStatus } from "./types.js";
import { PolicyEngine } from "../agent/policy-engine.js";
import { createDefaultRules } from "../agent/policy-rules/index.js";
import { agentShellBlockReason, createAgentConwayClient, isReplicationEnabled } from "../security/host-exec.js";
import { scrubbedEnv } from "../security/env.js";

type Database = BetterSqlite3.Database;

export interface CliIO {
  out: (line: string) => void;
  err: (line: string) => void;
  isTTY: boolean;
  ask: (question: string) => Promise<string>;
}

export function defaultIO(): CliIO {
  return {
    out: (l) => process.stdout.write(`${l}\n`),
    err: (l) => process.stderr.write(`${l}\n`),
    isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    ask: (question) =>
      new Promise((resolve) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.question(question, (answer) => {
          rl.close();
          resolve(answer);
        });
      }),
  };
}

export function parseArgs(argv: string[]): { positional: string[]; flags: Record<string, string | true> } {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

/**
 * Require the operator to type a short code on a real terminal.
 */
export async function confirmInteractively(io: CliIO, action: string, code: string): Promise<boolean> {
  if (!io.isTTY) {
    io.err("Refused: this command changes mission records and must be run by a person on an interactive terminal.");
    return false;
  }
  io.out(action);
  const answer = (await io.ask(`Type ${code} to confirm: `)).trim();
  if (answer !== code) {
    io.err("Not confirmed. Nothing was changed.");
    return false;
  }
  return true;
}

function intFlag(flags: Record<string, string | true>, name: string): number | undefined {
  const value = flags[name];
  if (value === undefined || value === true) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n)) throw new Error(`--${name} must be a whole number`);
  return n;
}

function strFlag(flags: Record<string, string | true>, name: string): string | undefined {
  const value = flags[name];
  return typeof value === "string" ? value : undefined;
}

const HELP = `Mission commands (automaton --mission <command>):
  status                          Dashboard
  report [--write]                Daily report (stdout, or write to the reports directory)
  export [--out file.json]        JSON snapshot for dashboards
  approvals [--all]               Pending approvals (or all)
  approve <id> [--amount-pence N] [--note text]
  reject <id> [--note text]
  record-revenue --amount-pence N --evidence REF --category C --description D
                 [--counterparty REF] [--pending] [--related-party] [--not-attributable]
                 [--supersedes ENTRY_ID] [--occurred-at ISO]
  record-expense --amount-pence N --category C --description D [--evidence REF]
                 [--currency USD --original-minor N] [--pending] [--supersedes ENTRY_ID]
  record-fee     (same flags as record-expense)
  record-refund  --amount-pence N --description D --evidence REF
  grant-capital  --amount-pence N --reason R
  tasks | opportunities
  seed --file plan.json           Import opportunities, tasks and a checkpoint from a private file
  verify-controls                 Self-test of the spending and safety controls`;

export async function runMissionCli(
  argv: string[],
  io: CliIO = defaultIO(),
  deps: { config?: AutomatonConfig | null; db?: Database } = {},
): Promise<number> {
  const { positional, flags } = parseArgs(argv);
  const command = positional[0] ?? "status";
  if (command === "help" || flags.help) {
    io.out(HELP);
    return 0;
  }

  const config = deps.config !== undefined ? deps.config : loadConfig();
  if (!config) {
    io.err("Automaton is not configured. Run: automaton --setup");
    return 1;
  }
  if (!isMissionEnabled(config)) {
    io.err('Mission mode is off. Set "mission": { "enabled": true } in ~/.automaton/automaton.json.');
    return 1;
  }
  const mission = getMissionConfig(config);
  let ownedDb: { close: () => void } | undefined;
  let db = deps.db;
  if (!db) {
    const automatonDb = createDatabase(resolvePath(config.dbPath));
    ownedDb = automatonDb;
    db = automatonDb.raw;
  }

  try {
    ensureMissionStarted(db);
    switch (command) {
      case "status": {
        io.out(renderMissionStatus(buildMissionSnapshot(db, config)));
        return 0;
      }
      case "report": {
        const snapshot = buildMissionSnapshot(db, config);
        const since = snapshot.startedAt ?? new Date(Date.now() - 86_400_000).toISOString();
        const text = renderDailyReport(db, snapshot, since);
        if (flags.write) {
          const dir = resolvePath(mission.reportsDir);
          fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
          const file = path.join(dir, `${snapshot.generatedAt.slice(0, 10)}.md`);
          fs.writeFileSync(file, text, { mode: 0o600 });
          io.out(`Report written to ${file}`);
        } else {
          io.out(text);
        }
        return 0;
      }
      case "export": {
        const snapshot = buildMissionSnapshot(db, config);
        const json = JSON.stringify(snapshot, null, 2);
        const out = strFlag(flags, "out");
        if (out) {
          fs.writeFileSync(out, json, { mode: 0o600 });
          io.out(`Snapshot written to ${out}`);
        } else {
          io.out(json);
        }
        return 0;
      }
      case "approvals": {
        const rows = listApprovals(db, flags.all ? undefined : ["pending"]);
        if (rows.length === 0) io.out("No approvals.");
        for (const a of rows) {
          io.out(`${a.id}  ${a.status.padEnd(9)} ${a.kind.padEnd(15)} ${a.amountPence > 0 ? formatPence(a.amountPence).padEnd(9) : "".padEnd(9)} ${a.summary}`);
        }
        return 0;
      }
      case "approve":
      case "reject": {
        const ref = positional[1];
        if (!ref) throw new Error(`Usage: ${command} <approval id>`);
        const approval = findApprovalByRef(db, ref);
        if (!approval) throw new Error(`No unique approval matches ${ref}`);
        const amount = intFlag(flags, "amount-pence");
        const shownAmount = amount ?? approval.amountPence;
        const confirmed = await confirmInteractively(
          io,
          `${command === "approve" ? "APPROVE" : "REJECT"} [${approval.kind}] ${approval.summary}${shownAmount > 0 ? `\nAmount: ${formatPence(shownAmount)}` : ""}`,
          approval.id.slice(-4),
        );
        if (!confirmed) return 2;
        const decided = decideApproval(db, mission, approval.id, {
          decision: command === "approve" ? "approved" : "rejected",
          decidedBy: "human",
          note: strFlag(flags, "note"),
          amountPence: amount,
        });
        io.out(`Approval ${decided.id} ${decided.status}.`);
        return 0;
      }
      case "record-revenue":
      case "record-expense":
      case "record-fee":
      case "record-refund": {
        const entryType: LedgerEntryType =
          command === "record-revenue" ? "revenue" : command === "record-fee" ? "fee" : command === "record-refund" ? "refund" : "expense";
        const amountPence = intFlag(flags, "amount-pence");
        if (amountPence === undefined) throw new Error("--amount-pence is required");
        const supersedes = strFlag(flags, "supersedes");
        if (supersedes && !getLedgerEntry(db, supersedes)) throw new Error(`Unknown ledger entry ${supersedes}`);
        const description = strFlag(flags, "description") ?? (entryType === "refund" ? "Refund" : "");
        const category = strFlag(flags, "category") ?? (entryType === "refund" ? "refund" : "");

        if ((entryType === "expense" || entryType === "fee") && !flags.pending) {
          const fits = checkSpendFits(db, mission, amountPence);
          if (!fits.fits) {
            io.err(`WARNING: this takes spending past the authorised capital (${formatPence(fits.remainingPence)} remaining). It will be recorded, because concealing spend is never allowed, and flagged on the dashboard.`);
          }
        }

        const confirmed = await confirmInteractively(
          io,
          `Record ${entryType} ${flags.pending ? "(pending)" : "(settled)"} ${formatPence(amountPence)} — ${category}: ${description}`,
          String(amountPence),
        );
        if (!confirmed) return 2;
        const entry = appendLedgerEntry(db, {
          entryType,
          status: flags.pending ? "pending" : "settled",
          amountPence,
          category,
          description,
          counterpartyRef: strFlag(flags, "counterparty"),
          evidenceRef: strFlag(flags, "evidence"),
          originalCurrency: strFlag(flags, "currency"),
          originalAmountMinor: intFlag(flags, "original-minor"),
          relatedParty: flags["related-party"] === true,
          attributable: flags["not-attributable"] !== true,
          supersedesId: supersedes,
          occurredAt: strFlag(flags, "occurred-at"),
          recordedBy: "human",
        });
        io.out(`Recorded ${entry.entryType} ${entry.id}.`);
        return 0;
      }
      case "grant-capital": {
        const amountPence = intFlag(flags, "amount-pence");
        const reason = strFlag(flags, "reason");
        if (amountPence === undefined || !reason) throw new Error("--amount-pence and --reason are required");
        const confirmed = await confirmInteractively(io, `Grant ${formatPence(amountPence)} of additional capital: ${reason}`, String(amountPence));
        if (!confirmed) return 2;
        grantCapital(db, amountPence, reason);
        io.out(`Authorised capital is now ${formatPence(getMissionBudgetState(db, mission).authorisedCapitalPence)}.`);
        return 0;
      }
      case "tasks": {
        for (const t of listMissionTasks(db, { limit: 100 })) {
          io.out(`${t.id}  ${t.status.padEnd(17)} p${String(t.priority).padEnd(3)} ${t.stage.padEnd(9)} ${t.title}${t.nextAction ? ` → ${t.nextAction}` : ""}`);
        }
        return 0;
      }
      case "opportunities": {
        for (const o of listOpportunities(db)) {
          io.out(`${String(o.score).padStart(5)}  ${o.status.padEnd(10)} ${o.name} (${o.modelType})`);
        }
        return 0;
      }
      case "seed": {
        const file = strFlag(flags, "file");
        if (!file) throw new Error("--file is required");
        const plan = JSON.parse(fs.readFileSync(file, "utf-8")) as {
          opportunities?: Array<{ name: string; modelType: string; criteria: OpportunityCriteria; evidence?: string; status?: OpportunityStatus }>;
          tasks?: Array<{ title: string; stage: MissionStage; nextAction?: string; opportunity?: string; priority?: number }>;
          checkpoint?: { nextAction: string; strategy?: string; note?: string };
        };
        const confirmed = await confirmInteractively(
          io,
          `Import ${plan.opportunities?.length ?? 0} opportunities, ${plan.tasks?.length ?? 0} tasks${plan.checkpoint ? " and a checkpoint" : ""} from ${file}`,
          "SEED",
        );
        if (!confirmed) return 2;
        const apply = db.transaction(() => {
          for (const o of plan.opportunities ?? []) upsertOpportunity(db!, o, "human");
          for (const t of plan.tasks ?? []) {
            // An explicit priority lets a plan express dependencies that
            // cash-proximity ordering cannot (research before conversion).
            addMissionTask(db!, { title: t.title, stage: t.stage, nextAction: t.nextAction, opportunityId: t.opportunity, priority: t.priority }, "human");
          }
          if (plan.checkpoint) setCheckpoint(db!, plan.checkpoint, "human");
        });
        apply();
        io.out("Plan imported.");
        return 0;
      }
      case "verify-controls": {
        const results = await verifyControls(db, config);
        let failed = 0;
        for (const r of results) {
          if (!r.pass) failed++;
          io.out(`${r.pass ? "PASS" : "FAIL"}  ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
        }
        io.out(
          failed === 0
            ? 'All controls passed. After you have also tested them yourself, set "spendControlsVerified": true in the mission config.'
            : `${failed} control(s) failed. Do not fund the agent.`,
        );
        return failed === 0 ? 0 : 1;
      }
      default:
        io.err(`Unknown mission command: ${command}\n\n${HELP}`);
        return 1;
    }
  } catch (err) {
    io.err(`Error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  } finally {
    ownedDb?.close();
  }
}

export interface ControlCheck {
  name: string;
  pass: boolean;
  detail?: string;
}

/**
 * Exercise the controls against the real database inside a savepoint that
 * is always rolled back, so the check leaves no trace.
 */
export async function verifyControls(db: Database, config: AutomatonConfig): Promise<ControlCheck[]> {
  const mission = getMissionConfig(config);
  const checks: ControlCheck[] = [];
  const check = (name: string, fn: () => boolean | string) => {
    try {
      const result = fn();
      checks.push(result === true ? { name, pass: true } : { name, pass: false, detail: typeof result === "string" ? result : undefined });
    } catch (err) {
      checks.push({ name, pass: false, detail: err instanceof Error ? err.message : String(err) });
    }
  };

  check("Mission mode is enabled", () => isMissionEnabled(config));
  check("Agent shell is blocked", () => agentShellBlockReason(config) !== null || "mission.allowShell is on");
  check("Replication is disabled", () => !isReplicationEnabled(config) || "security.replicationEnabled is on");
  check("Automatic top-ups are disabled", () => !isAutoSpendAllowed(config));
  check("Child processes do not inherit API keys", () => {
    const env = scrubbedEnv({ PATH: "/usr/bin", ANTHROPIC_API_KEY: "x", OPENAI_API_KEY: "y", CONWAY_API_KEY: "z" });
    return env.PATH === "/usr/bin" && !env.ANTHROPIC_API_KEY && !env.OPENAI_API_KEY && !env.CONWAY_API_KEY;
  });

  db.exec("SAVEPOINT mission_verify");
  try {
    check("Unapproved spend is denied by the policy engine", () => {
      const engine = new PolicyEngine(db, createDefaultRules(config.treasuryPolicy));
      const decision = engine.evaluate({
        tool: { name: "topup_credits", description: "", category: "financial", riskLevel: "caution", parameters: {}, execute: async () => "" } as any,
        args: { amount_usd: 5 },
        context: { config, db: { raw: db } } as any,
        turnContext: {
          inputSource: "agent",
          turnToolCallCount: 0,
          sessionSpend: {
            recordSpend: () => {},
            getHourlySpend: () => 0,
            getDailySpend: () => 0,
            getTotalSpend: () => 0,
            checkLimit: () => ({ allowed: true, currentHourlySpend: 0, currentDailySpend: 0, limitHourly: 0, limitDaily: 0 }),
            pruneOldRecords: () => 0,
          } as any,
        },
      });
      return (decision.action === "deny" && decision.reasonCode === "MISSION_APPROVAL_REQUIRED") || `got ${decision.action}/${decision.reasonCode}`;
    });
    check("Ledger rejects edits", () => {
      const entry = appendLedgerEntry(db, {
        entryType: "expense",
        status: "pending",
        amountPence: 1,
        category: "verify",
        description: "control check",
        recordedBy: "system",
      });
      try {
        db.prepare("UPDATE mission_ledger SET amount_pence = 2 WHERE id = ?").run(entry.id);
        return "update succeeded";
      } catch {
        return true;
      }
    });
    check("Agent cannot record ledger entries", () => {
      try {
        appendLedgerEntry(db, {
          entryType: "revenue",
          status: "settled",
          amountPence: 100,
          category: "verify",
          description: "control check",
          evidenceRef: "x",
          recordedBy: "agent" as any,
        });
        return "agent entry accepted";
      } catch {
        return true;
      }
    });
    check("Spend above remaining capital is refused", () => {
      const state = getMissionBudgetState(db, mission);
      return !checkSpendFits(db, mission, state.remainingCapitalPence + 1).fits;
    });
  } finally {
    db.exec("ROLLBACK TO mission_verify");
    db.exec("RELEASE mission_verify");
  }

  try {
    const stub = { exec: async () => ({ stdout: "ran", stderr: "", exitCode: 0 }) } as unknown as ConwayClient;
    const result = await createAgentConwayClient(stub, config).exec("echo should-not-run");
    checks.push(
      result.exitCode === 126 && result.stdout === ""
        ? { name: "Agent exec is refused", pass: true }
        : { name: "Agent exec is refused", pass: false, detail: "the command reached the shell" },
    );
  } catch (err) {
    checks.push({ name: "Agent exec is refused", pass: false, detail: err instanceof Error ? err.message : String(err) });
  }

  return checks;
}
