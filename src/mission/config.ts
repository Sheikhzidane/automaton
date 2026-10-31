/**
 * Mission configuration helpers.
 */

import type { AutomatonConfig } from "../types.js";
import { DEFAULT_MISSION_CONFIG, type MissionConfig } from "./types.js";

export function isMissionEnabled(config: AutomatonConfig | undefined | null): boolean {
  return config?.mission?.enabled === true;
}

/**
 * Merge a partial mission config with defaults and validate numbers.
 * Invalid values fall back to the default rather than throwing, so a typo
 * in automaton.json can never widen the budget.
 */
export function resolveMissionConfig(
  raw: Partial<MissionConfig> | undefined,
): MissionConfig {
  const merged: MissionConfig = {
    ...DEFAULT_MISSION_CONFIG,
    ...(raw ?? {}),
    fx: { ...DEFAULT_MISSION_CONFIG.fx, ...(raw?.fx ?? {}) },
  };

  const positiveInt = (value: unknown, fallback: number): number =>
    typeof value === "number" && Number.isInteger(value) && value > 0
      ? value
      : fallback;

  merged.startingCapitalPence = positiveInt(
    merged.startingCapitalPence,
    DEFAULT_MISSION_CONFIG.startingCapitalPence,
  );
  merged.targetNetPence = positiveInt(
    merged.targetNetPence,
    DEFAULT_MISSION_CONFIG.targetNetPence,
  );
  merged.underperformanceDays = positiveInt(
    merged.underperformanceDays,
    DEFAULT_MISSION_CONFIG.underperformanceDays,
  );

  const milestones = Array.isArray(merged.milestonesPence)
    ? merged.milestonesPence.filter(
        (m) => typeof m === "number" && Number.isInteger(m) && m > 0,
      )
    : [];
  merged.milestonesPence = (milestones.length > 0
    ? milestones
    : DEFAULT_MISSION_CONFIG.milestonesPence
  )
    .slice()
    .sort((a, b) => a - b);

  if (
    typeof merged.fx.usdToGbp !== "number" ||
    !Number.isFinite(merged.fx.usdToGbp) ||
    merged.fx.usdToGbp <= 0
  ) {
    merged.fx.usdToGbp = DEFAULT_MISSION_CONFIG.fx.usdToGbp;
  }
  if (
    typeof merged.fx.feeBufferPct !== "number" ||
    !Number.isFinite(merged.fx.feeBufferPct) ||
    merged.fx.feeBufferPct < 0
  ) {
    merged.fx.feeBufferPct = DEFAULT_MISSION_CONFIG.fx.feeBufferPct;
  }

  if (!["byok", "conway", "free"].includes(merged.computeFunding)) {
    merged.computeFunding = DEFAULT_MISSION_CONFIG.computeFunding;
  }

  merged.enabled = merged.enabled === true;
  merged.allowShell = merged.allowShell === true;
  merged.spendControlsVerified = merged.spendControlsVerified === true;
  return merged;
}

export function getMissionConfig(config: AutomatonConfig): MissionConfig {
  return resolveMissionConfig(config.mission);
}

/**
 * Whether the runtime may spend money without a human approval.
 * In mission mode the answer is always no: startup top-ups, heartbeat
 * top-ups, in-loop top-ups and sandbox top-ups are all disabled.
 */
export function isAutoSpendAllowed(config: AutomatonConfig): boolean {
  return !isMissionEnabled(config);
}

/**
 * Convert a USD amount in cents to GBP pence, rounding up and adding the
 * configured buffer so costs are never understated.
 */
export function usdCentsToPence(usdCents: number, mission: MissionConfig): number {
  if (!Number.isFinite(usdCents) || usdCents <= 0) return 0;
  const raw = usdCents * mission.fx.usdToGbp * (1 + mission.fx.feeBufferPct / 100);
  return Math.ceil(raw - 1e-9);
}

export function formatPence(pence: number): string {
  const sign = pence < 0 ? "-" : "";
  const abs = Math.abs(Math.round(pence));
  const pounds = Math.floor(abs / 100);
  const remainder = String(abs % 100).padStart(2, "0");
  return `${sign}£${pounds.toLocaleString("en-GB")}.${remainder}`;
}
