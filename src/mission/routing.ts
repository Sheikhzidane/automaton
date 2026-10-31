/**
 * Cost-aware model routing for mission mode.
 *
 * Upstream routes every agent turn to the most capable model while credits
 * last. With a £20 lifetime budget that is the wrong default. In mission
 * mode routine work (agent turns, triage, summaries, safety checks) goes to
 * the cheapest adequate model and only planning reaches the capable model,
 * and only while the compute runway is healthy.
 *
 * Model IDs and prices come from the runtime's model registry; check them
 * against the provider's current price list before funding.
 */

import type { RoutingMatrix } from "../types.js";

const NONE = { candidates: [] as string[], maxTokens: 0, ceilingCents: 0 };

const NORMAL = {
  agent_turn: { candidates: ["gpt-5-mini", "gpt-4.1-mini"], maxTokens: 4096, ceilingCents: 5 },
  heartbeat_triage: { candidates: ["gpt-4.1-nano", "gpt-5-mini"], maxTokens: 1024, ceilingCents: 1 },
  safety_check: { candidates: ["gpt-5-mini", "gpt-4.1-mini"], maxTokens: 2048, ceilingCents: 2 },
  summarization: { candidates: ["gpt-4.1-mini", "gpt-5-mini"], maxTokens: 2048, ceilingCents: 2 },
  planning: { candidates: ["gpt-5.2", "gpt-5-mini"], maxTokens: 4096, ceilingCents: 15 },
};

export const MISSION_ROUTING_MATRIX: RoutingMatrix = {
  high: NORMAL,
  normal: NORMAL,
  low_compute: {
    agent_turn: { candidates: ["gpt-4.1-mini", "gpt-5-mini"], maxTokens: 3072, ceilingCents: 3 },
    heartbeat_triage: { candidates: ["gpt-4.1-nano"], maxTokens: 512, ceilingCents: 1 },
    safety_check: { candidates: ["gpt-4.1-mini"], maxTokens: 1024, ceilingCents: 1 },
    summarization: { candidates: ["gpt-4.1-mini"], maxTokens: 1024, ceilingCents: 1 },
    planning: { candidates: ["gpt-5-mini", "gpt-4.1-mini"], maxTokens: 3072, ceilingCents: 5 },
  },
  critical: {
    agent_turn: { candidates: ["gpt-4.1-nano"], maxTokens: 1024, ceilingCents: 1 },
    heartbeat_triage: { candidates: ["gpt-4.1-nano"], maxTokens: 512, ceilingCents: 1 },
    safety_check: { candidates: ["gpt-4.1-nano"], maxTokens: 512, ceilingCents: 1 },
    summarization: NONE,
    planning: NONE,
  },
  dead: {
    agent_turn: NONE,
    heartbeat_triage: NONE,
    safety_check: NONE,
    summarization: NONE,
    planning: NONE,
  },
};
