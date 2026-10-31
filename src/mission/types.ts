/**
 * Commercial Mission — types and defaults.
 *
 * A mission turns the automaton into a supervised business operator:
 * a fixed lifetime capital allowance in GBP, an append-only ledger that
 * counts only settled customer payments, human approval for every
 * real-money or externally binding action, and durable task state that
 * survives restarts and context loss.
 *
 * Nothing in this file is specific to one operator. Operator-specific
 * strategy, leads and customers live in the runtime database under
 * ~/.automaton, never in the repository.
 */

export type MissionComputeFunding = "byok" | "conway" | "free";

export interface MissionFxConfig {
  /** GBP per 1 USD used to convert USD-denominated costs. Set conservatively. */
  usdToGbp: number;
  /** Extra percentage added to converted costs to cover FX and card fees. */
  feeBufferPct: number;
}

export interface MissionConfig {
  enabled: boolean;
  name: string;
  objective: string;
  /** Lifetime starting capital in pence. Not a recurring allowance. */
  startingCapitalPence: number;
  /** Net earnings target in pence. */
  targetNetPence: number;
  /** Ascending milestone thresholds in pence (net earnings). */
  milestonesPence: number[];
  /**
   * How inference is paid for:
   *  - byok: the operator's own provider key with a prepaid, capped balance
   *  - conway: Conway credits bought with USDC
   *  - free: local or free models only (e.g. Ollama)
   */
  computeFunding: MissionComputeFunding;
  /**
   * Set by the operator only after the spending controls have been tested
   * independently. Recorded for audit; it does NOT relax approvals.
   */
  spendControlsVerified: boolean;
  /** Allow the agent a shell in mission mode. Makes approvals advisory. */
  allowShell: boolean;
  fx: MissionFxConfig;
  /** Cron expression for the deterministic daily review (UTC). */
  reviewCron: string;
  /** Directory for daily reports, outside the repository. */
  reportsDir: string;
  /** Days without settled revenue before an active opportunity is flagged. */
  underperformanceDays: number;
}

export const DEFAULT_MISSION_CONFIG: MissionConfig = {
  enabled: false,
  name: "Commercial mission",
  objective:
    "Earn genuine net revenue from real customers through legitimate products or services, starting from a fixed capital allowance.",
  startingCapitalPence: 2000,
  targetNetPence: 200000,
  milestonesPence: [1000, 5000, 10000, 25000, 50000, 100000, 200000],
  computeFunding: "byok",
  spendControlsVerified: false,
  allowShell: false,
  fx: { usdToGbp: 0.8, feeBufferPct: 3 },
  reviewCron: "0 7 * * *",
  reportsDir: "~/.automaton/mission/reports",
  underperformanceDays: 14,
};

// ─── Ledger ─────────────────────────────────────────────────────

export type LedgerEntryType = "revenue" | "expense" | "refund" | "fee";
export type LedgerStatus = "settled" | "pending";
export type LedgerRecorder = "human" | "system";

export interface LedgerEntryInput {
  entryType: LedgerEntryType;
  status: LedgerStatus;
  amountPence: number;
  category: string;
  description: string;
  /** Pseudonymous reference only. Never names, emails or addresses. */
  counterpartyRef?: string;
  /** Payment ID, invoice number or receipt ID that proves the entry. */
  evidenceRef?: string;
  originalCurrency?: string;
  originalAmountMinor?: number;
  /** Payments from the operator's own businesses or related people. */
  relatedParty?: boolean;
  /** Whether the agent sourced or materially progressed this revenue. */
  attributable?: boolean;
  approvalId?: string;
  /** ID of the entry this one corrects (e.g. pending → settled). */
  supersedesId?: string;
  recordedBy: LedgerRecorder;
  occurredAt?: string;
}

export interface LedgerEntryRow {
  id: string;
  entryType: LedgerEntryType;
  status: LedgerStatus;
  amountPence: number;
  category: string;
  description: string;
  counterpartyRef: string | null;
  evidenceRef: string | null;
  originalCurrency: string | null;
  originalAmountMinor: number | null;
  relatedParty: boolean;
  attributable: boolean;
  approvalId: string | null;
  supersedesId: string | null;
  recordedBy: LedgerRecorder;
  occurredAt: string;
  createdAt: string;
}

export interface LedgerSummary {
  settledRevenuePence: number;
  /** Settled revenue that counts towards the mission (not related, attributable, evidenced). */
  countableRevenuePence: number;
  excludedRevenuePence: number;
  pendingRevenuePence: number;
  refundsPence: number;
  expensesPence: number;
  feesPence: number;
  /** countable revenue − refunds − expenses − fees */
  netPence: number;
  confirmedPayments: number;
  outstandingInvoices: number;
  revenueByCategory: Record<string, number>;
}

// ─── Approvals ──────────────────────────────────────────────────

export type ApprovalKind =
  | "spend"
  | "outreach"
  | "publish"
  | "contract"
  | "external_action"
  | "capital"
  | "other";

export type ApprovalStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "consumed"
  | "expired";

export interface ApprovalRow {
  id: string;
  kind: ApprovalKind;
  toolName: string | null;
  summary: string;
  amountPence: number;
  argsHash: string | null;
  status: ApprovalStatus;
  requestedBy: "agent" | "human" | "system";
  requestedAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  decisionNote: string | null;
  consumedAt: string | null;
  expiresAt: string | null;
}

// ─── Tasks ──────────────────────────────────────────────────────

/** The operating cycle, ordered from furthest to closest to cash. */
export const MISSION_STAGES = [
  "research",
  "identify",
  "validate",
  "build",
  "test",
  "deploy",
  "market",
  "convert",
  "deliver",
  "collect",
  "measure",
  "improve",
] as const;

export type MissionStage = (typeof MISSION_STAGES)[number];

export type MissionTaskStatus =
  | "queued"
  | "in_progress"
  | "blocked"
  | "awaiting_approval"
  | "done"
  | "dropped";

export interface MissionTaskRow {
  id: string;
  title: string;
  stage: MissionStage;
  status: MissionTaskStatus;
  priority: number;
  nextAction: string | null;
  blockedReason: string | null;
  opportunityId: string | null;
  result: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

// ─── Opportunities ──────────────────────────────────────────────

/** Each criterion is scored 0–5 by whoever records the opportunity. */
export interface OpportunityCriteria {
  /** 5 = no upfront cost, 0 = needs most of the capital. */
  startupCost: number;
  /** 5 = paying customers or signed intent, 0 = no evidence at all. */
  demandEvidence: number;
  /** 5 = first customer within days, 0 = months away. */
  timeToFirstCustomer: number;
  /** 5 = high gross margin. */
  margin: number;
  /**
   * 5 = the target is reachable with a handful of customers (high ticket or
   * recurring), 0 = it needs thousands of small sales.
   */
  revenuePotential: number;
  /** 5 = near-zero ongoing maintenance. */
  lowMaintenance: number;
  /** 5 = deliverable with existing software and skills. */
  deliverability: number;
  /** 5 = reuses work already built or owned. */
  assetReuse: number;
  /** Hard gate: false rejects the opportunity regardless of score. */
  legalAndEthical: boolean;
}

export type OpportunityStatus =
  | "candidate"
  | "validating"
  | "active"
  | "paused"
  | "rejected"
  | "won";

export interface OpportunityRow {
  id: string;
  name: string;
  modelType: string;
  status: OpportunityStatus;
  criteria: OpportunityCriteria;
  score: number;
  rejectionReason: string | null;
  evidence: string | null;
  createdAt: string;
  updatedAt: string;
}

// ─── Budget ─────────────────────────────────────────────────────

export interface MissionBudgetState {
  startingCapitalPence: number;
  grantedCapitalPence: number;
  authorisedCapitalPence: number;
  committedSpendPence: number;
  remainingCapitalPence: number;
  /** Prepaid compute bought (expense category compute_prepaid). */
  computePurchasedPence: number;
  /** Inference consumed since the mission started, converted to pence. */
  computeConsumedPence: number;
  computeRunwayPence: number;
}
