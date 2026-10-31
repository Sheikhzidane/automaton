/**
 * Shared helpers for mission tests.
 */

import type BetterSqlite3 from "better-sqlite3";
import type {
  AutomatonConfig,
  AutomatonDatabase,
  AutomatonTool,
  PolicyRequest,
  SpendTrackerInterface,
} from "../../types.js";
import type { MissionConfig } from "../../mission/types.js";
import { createTestConfig, createTestDb } from "../mocks.js";

export function missionConfig(
  mission: Partial<MissionConfig> = {},
  overrides: Partial<AutomatonConfig> = {},
): AutomatonConfig {
  return createTestConfig({
    mission: { enabled: true, ...mission },
    ...overrides,
  });
}

export function newDb(): { db: AutomatonDatabase; raw: BetterSqlite3.Database } {
  const db = createTestDb();
  return { db, raw: db.raw };
}

export function fakeTool(name: string, category: AutomatonTool["category"] = "financial"): AutomatonTool {
  return {
    name,
    description: name,
    category,
    riskLevel: "caution",
    parameters: { type: "object", properties: {} },
    execute: async () => "ok",
  };
}

export function spendTrackerStub(): SpendTrackerInterface {
  return {
    recordSpend: () => {},
    getHourlySpend: () => 0,
    getDailySpend: () => 0,
    getTotalSpend: () => 0,
    checkLimit: () => ({
      allowed: true,
      currentHourlySpend: 0,
      currentDailySpend: 0,
      limitHourly: 1_000_000,
      limitDaily: 1_000_000,
    }),
    pruneOldRecords: () => 0,
  };
}

export function policyRequest(
  tool: AutomatonTool,
  args: Record<string, unknown>,
  config: AutomatonConfig,
  db: AutomatonDatabase,
): PolicyRequest {
  return {
    tool,
    args,
    context: { config, db } as any,
    turnContext: {
      inputSource: "agent",
      turnToolCallCount: 0,
      sessionSpend: spendTrackerStub(),
    },
  };
}

/** Record a human-approved compute purchase so the mission has runway. */
export function recordInferenceCost(raw: BetterSqlite3.Database, costCents: number): void {
  raw
    .prepare(
      `INSERT INTO inference_costs (id, session_id, model, provider, cost_cents, tier, task_type)
       VALUES (?, 's', 'gpt-5-mini', 'openai', ?, 'normal', 'agent_turn')`,
    )
    .run(`cost-${Math.random().toString(36).slice(2)}`, costCents);
}
