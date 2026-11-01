// Spending and compute controls. The engine itself never spends money:
// a task with a cost needs a matching, unexpired approval recorded by
// the operator, and even then it must fit in the capital that is left.
// Compute is capped per month so the free CI allowance is never
// exceeded; past the cap only priority-1 tasks run.

import { monthKey } from './util.mjs';

export function computeAllowance(budget, now) {
  const month = monthKey(now);
  if (!budget.compute || budget.compute.month !== month) {
    budget.compute = { month, secondsUsed: 0, capMinutes: budget.compute?.capMinutes ?? 1200 };
  }
  return budget.compute;
}

// What GitHub will bill for one run: the cycle job rounded up to a whole
// minute, plus the other jobs at their one-minute minimum. The cycle job's
// length is measured from GROWTH_OPS_JOB_STARTED_AT (set by the workflow's
// first step) when known, plus the steps that follow the engine; otherwise
// it is the cycle's own time plus an allowance for checkout and Node.
export function billedSeconds(cycleSeconds, compute = {}, jobSecondsSoFar = null) {
  const others = compute.otherBilledMinutesPerRun ?? 1;
  const jobSeconds = jobSecondsSoFar !== null && Number.isFinite(jobSecondsSoFar)
    ? Math.max(0, jobSecondsSoFar) + (compute.cycleJobTailSeconds ?? 25)
    : Math.max(0, cycleSeconds) + (compute.cycleJobSetupSeconds ?? 30);
  return (Math.max(1, Math.ceil(jobSeconds / 60)) + others) * 60;
}

export function recordCompute(budget, now, seconds) {
  const c = computeAllowance(budget, now);
  c.secondsUsed += Math.max(0, Math.round(seconds));
  return c;
}

// Returns null when the task may run, otherwise the reason it may not.
export function denyReason({ task, budget, ledgerSummary, approvals = [], control, now }) {
  if (control?.paused) return `Paused by the operator${control.reason ? `: ${control.reason}` : ''}`;
  const c = computeAllowance(budget, now);
  if (c.secondsUsed >= c.capMinutes * 60 && task.priority > 1) {
    return `Monthly compute cap of ${c.capMinutes} minutes reached; only priority-1 tasks run until next month`;
  }
  if (task.costPence > 0) {
    const used = new Set(budget.approvalsUsed ?? []);
    const approval = approvals.find(
      (a) => a.taskId === task.id && a.status === 'approved' && !used.has(a.id) && new Date(a.expiresAt).valueOf() > now.valueOf()
    );
    if (!approval) return `Costs ${task.costPence}p and has no unused approval`;
    if (approval.amountPence < task.costPence) return `Approved for ${approval.amountPence}p but costs ${task.costPence}p`;
    if (task.costPence > (ledgerSummary?.capitalRemainingPence ?? 0)) {
      return `Costs ${task.costPence}p but only ${ledgerSummary?.capitalRemainingPence ?? 0}p of capital remains`;
    }
  }
  return null;
}

// The approval a costed task will use. Each approval is used once.
export function approvalFor({ task, budget, approvals = [], now }) {
  const used = new Set(budget.approvalsUsed ?? []);
  return approvals.find(
    (a) => a.taskId === task.id && a.status === 'approved' && !used.has(a.id) && new Date(a.expiresAt).valueOf() > now.valueOf()
  ) ?? null;
}
