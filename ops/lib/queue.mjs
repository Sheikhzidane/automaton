// The durable task queue. Every scheduled job is a task with its own
// interval, priority, permissions, cost estimate and completion
// criteria. The runtime fields (last run, next run, attempts, history)
// live in state/queue.json and survive every restart.

import { minutes } from './util.mjs';

// A cycle may start a few minutes either side of the hour it was
// scheduled for, so a task counts as due a little before its time.
export const DUE_GRACE_MS = minutes(20);
export const LEASE_TIMEOUT_MS = minutes(30);
const HISTORY_KEEP = 20;

export const DEFAULT_TASKS = [
  {
    id: 'ops.self_check',
    title: 'Check the engine: state files, ledger chain, budget, stale leases',
    job: 'self-check',
    priority: 1,
    intervalMinutes: 0,
    requires: [],
    costPence: 0,
    completion: 'State parses, ledger hash chain verifies, no task left running from a crashed cycle.',
    maxAttempts: 1,
  },
  {
    id: 'opslog.public_health',
    title: 'Check the public OpsLog pages respond and say what they should',
    job: 'public-health',
    priority: 1,
    intervalMinutes: 180,
    requires: ['network:opslog.co.uk'],
    costPence: 0,
    completion: 'Home and login return 200 with their expected text; results written to health/latest.json.',
    maxAttempts: 2,
  },
  {
    id: 'opslog.ops_metrics',
    title: 'Read aggregate OpsLog metrics (counts only, no customer data)',
    job: 'ops-metrics',
    priority: 2,
    intervalMinutes: 1440,
    requires: ['network:opslog.co.uk', 'secret:OPS_METRICS_TOKEN'],
    costPence: 0,
    completion: 'GET /api/ops/metrics returns 200 with numbers only; written to metrics/latest.json.',
    maxAttempts: 3,
  },
  {
    id: 'market.fsa_refresh',
    title: 'Refresh Edinburgh and Lothians food business data from the FSA open data',
    job: 'fsa-refresh',
    priority: 3,
    intervalMinutes: 10080,
    requires: ['network:ratings.food.gov.uk'],
    costPence: 0,
    completion: 'Each configured authority file downloaded and parsed; establishments, changes and candidates written under market/.',
    maxAttempts: 3,
  },
  {
    id: 'pipeline.review',
    title: 'Review the prospect pipeline: stages, follow-ups due, stale prospects',
    job: 'pipeline-review',
    priority: 2,
    intervalMinutes: 1440,
    requires: [],
    costPence: 0,
    completion: 'pipeline/summary.json written with counts by stage and every follow-up due today or overdue.',
    maxAttempts: 2,
  },
  {
    id: 'revenue.review',
    title: 'Recalculate mission revenue, costs and net from the ledger',
    job: 'revenue-review',
    priority: 2,
    intervalMinutes: 1440,
    requires: [],
    costPence: 0,
    completion: 'ledger/summary.json written; only settled, evidenced, non-related-party, attributable revenue counted.',
    maxAttempts: 2,
  },
  {
    id: 'work.review',
    title: 'Track outstanding internal work and what is blocked',
    job: 'work-review',
    priority: 3,
    intervalMinutes: 1440,
    requires: [],
    costPence: 0,
    completion: 'work/summary.json written with open, blocked and overdue items.',
    maxAttempts: 2,
  },
  {
    id: 'ops.daily_report',
    title: 'Write the daily progress report',
    job: 'daily-report',
    priority: 4,
    intervalMinutes: 1440,
    requires: [],
    costPence: 0,
    completion: 'reports/<date>.md written from the latest results of every other task.',
    maxAttempts: 2,
  },
];

const STATIC_FIELDS = ['title', 'job', 'priority', 'intervalMinutes', 'requires', 'costPence', 'completion', 'maxAttempts'];

function freshRuntime() {
  return {
    status: 'idle',
    enabled: true,
    lastRunAt: null,
    lastSuccessAt: null,
    nextRunAt: null,
    attempts: 0,
    consecutiveFailures: 0,
    lastOutcome: null,
    lastNote: null,
    lastIdempotencyKey: null,
    lease: null,
    history: [],
  };
}

// Adds new default tasks and refreshes their definitions while keeping
// every runtime field. A task the operator disabled stays disabled.
export function reconcileTasks(stored = [], defaults = DEFAULT_TASKS) {
  const byId = new Map(stored.map((t) => [t.id, t]));
  const out = [];
  for (const def of defaults) {
    const existing = byId.get(def.id);
    const merged = existing ? { ...existing } : { id: def.id, ...freshRuntime() };
    for (const f of STATIC_FIELDS) merged[f] = def[f];
    out.push(merged);
    byId.delete(def.id);
  }
  // Tasks no longer defined are kept, disabled, so their history stays.
  for (const orphan of byId.values()) out.push({ ...orphan, enabled: false, status: 'disabled' });
  return out;
}

export function slotKey(task, now) {
  const interval = task.intervalMinutes > 0 ? minutes(task.intervalMinutes) : 1;
  return `${task.id}:${Math.floor(now.valueOf() / interval)}`;
}

export function isDue(task, now) {
  if (task.enabled === false || task.status === 'disabled') return false;
  if (task.intervalMinutes === 0) return true; // every cycle
  if (task.lastIdempotencyKey && task.lastIdempotencyKey === slotKey(task, now) && task.lastOutcome === 'succeeded') return false;
  if (!task.nextRunAt) return true;
  return new Date(task.nextRunAt).valueOf() <= now.valueOf() + DUE_GRACE_MS;
}

export function dueTasks(tasks, now) {
  return tasks
    .filter((t) => isDue(t, now))
    .sort((a, b) => a.priority - b.priority || String(a.nextRunAt ?? '').localeCompare(String(b.nextRunAt ?? '')));
}

// The start of the slot after the one `now` is in. Tasks are anchored
// to slots, not to when they last finished, so a late GitHub start never
// makes a task skip a cycle or drift around the clock.
export function nextSlotStart(task, now) {
  if (!task.intervalMinutes) return new Date(now);
  const interval = minutes(task.intervalMinutes);
  return new Date((Math.floor(now.valueOf() / interval) + 1) * interval);
}

function backoffAt(task, now) {
  const interval = minutes(task.intervalMinutes || 0);
  const backoff = Math.min(minutes(15) * 2 ** Math.max(0, task.attempts - 1), interval || minutes(15));
  return new Date(now.valueOf() + backoff).toISOString();
}

// A task still marked running from an earlier cycle means that cycle
// died. It counts as a failed attempt, with the same retry limit as any
// other failure. Returns the ids recovered and those now out of retries.
export function recoverStale(tasks, now, runId) {
  const recovered = [];
  const exhausted = [];
  for (const t of tasks) {
    if (t.status !== 'running' || !t.lease || t.lease.runId === runId) continue;
    // Only one cycle runs at a time (workflow concurrency and the state
    // lock), so any lease from another run is a dead one.
    const note = `Interrupted: cycle ${t.lease.runId} stopped while this task was running`;
    t.lease = null;
    t.lastOutcome = 'interrupted';
    t.lastNote = note;
    t.attempts = (t.attempts ?? 0) + 1;
    t.consecutiveFailures = (t.consecutiveFailures ?? 0) + 1;
    pushHistory(t, { at: now.toISOString(), outcome: 'interrupted', ms: 0, note });
    if (t.attempts >= (t.maxAttempts ?? 1)) {
      t.status = 'failed';
      t.attempts = 0;
      t.nextRunAt = nextSlotStart(t, now).toISOString();
      exhausted.push(t.id);
    } else {
      t.status = 'retrying';
      t.nextRunAt = backoffAt(t, now);
    }
    recovered.push(t.id);
  }
  return { recovered, exhausted };
}

export function startTask(task, now, runId) {
  task.status = 'running';
  task.lease = { runId, at: now.toISOString() };
  task.lastRunAt = now.toISOString();
}

function pushHistory(task, entry) {
  task.history = [...(task.history ?? []), entry].slice(-HISTORY_KEEP);
}

// Records what happened and decides when the task runs next.
// Returns true when the task has just used its last retry.
export function finishTask(task, result, now, ms) {
  const at = now.toISOString();
  task.lease = null;
  task.lastOutcome = result.outcome;
  task.lastNote = result.note ?? null;
  pushHistory(task, { at, outcome: result.outcome, ms, note: result.note ?? null });

  if (result.outcome === 'succeeded') {
    task.status = 'idle';
    task.lastSuccessAt = at;
    task.attempts = 0;
    task.consecutiveFailures = 0;
    task.lastIdempotencyKey = slotKey(task, now);
    task.nextRunAt = nextSlotStart(task, now).toISOString();
    return false;
  }
  if (result.outcome === 'blocked' || result.outcome === 'skipped') {
    task.status = result.outcome === 'blocked' ? 'blocked' : 'idle';
    task.attempts = 0;
    task.nextRunAt = nextSlotStart(task, now).toISOString();
    return false;
  }
  // failed
  task.attempts = (task.attempts ?? 0) + 1;
  task.consecutiveFailures = (task.consecutiveFailures ?? 0) + 1;
  if (task.attempts < (task.maxAttempts ?? 1)) {
    task.status = 'retrying';
    task.nextRunAt = backoffAt(task, now);
    return false;
  }
  task.status = 'failed';
  task.attempts = 0;
  task.nextRunAt = nextSlotStart(task, now).toISOString();
  return true;
}
