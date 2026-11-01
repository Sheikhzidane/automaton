// Where everything the engine knows is kept, and the lock that stops
// two cycles running over the same state at once.
//
// Ownership matters because people edit the same branch the scheduled
// run commits to. The engine writes only ENGINE_OWNED paths; config,
// control (the kill switch), approvals, memory (next action, strategy),
// the ledger, the pipeline and the backlog belong to people and are
// only ever read by a cycle.

import { existsSync, rmSync } from 'node:fs';
import { readJson, writeJsonAtomic, p } from './util.mjs';
import { reconcileTasks } from './queue.mjs';
import { emptyAlerts } from './alerts.mjs';
import { LEASE_TIMEOUT_MS } from './queue.mjs';

export const DEFAULT_CONFIG = {
  schemaVersion: 1,
  mission: { name: '£20 to £2,000', capitalPence: 2000, targetNetPence: 200000 },
  schedule: { cron: '37 */3 * * *', note: 'UTC; must match the workflow' },
  // GitHub bills each job rounded up to a whole minute. A run is two
  // jobs: the cycle (checkout, Node, the cycle itself) and the save, so a
  // short run is 2 billed minutes: about 500 a month at 8 runs a day. The
  // cap leaves room for that and for weekly FSA runs, under the 2,000 free
  // private-repository minutes. Only runs in GitHub Actions are charged.
  compute: { monthlyMinutesCap: 1200, cycleJobSetupSeconds: 30, cycleJobTailSeconds: 25, otherBilledMinutesPerRun: 1 },
  http: { allowHosts: ['opslog.co.uk', 'ratings.food.gov.uk', 'api.github.com'], timeoutMs: 25000 },
  opslog: {
    baseUrl: 'https://opslog.co.uk',
    pages: [
      { path: '/', expect: 'Run your restaurant with complete confidence', required: true },
      { path: '/login', expect: 'Sign in', required: true },
      { path: '/robots.txt', required: false },
      { path: '/sitemap.xml', required: false },
      { path: '/api/health', json: true, required: false },
    ],
  },
  market: {
    authorities: [
      { id: 773, name: 'Edinburgh (City of)' },
      { id: 781, name: 'East Lothian' },
      { id: 783, name: 'Midlothian' },
      { id: 782, name: 'West Lothian' },
    ],
    businessTypeIds: [1, 7843, 7844, 7842],
    newWithinDays: 120,
    chainExclusions: [],
    existingCustomers: [],
    keepCandidates: 150,
  },
  pipeline: { staleAfterDays: 14 },
  alerts: { githubIssues: true, label: 'growth-ops-alert' },
};

export const ENGINE_OWNED = [
  'status.json',
  'state/queue.json',
  'state/budget.json',
  'state/alerts.json',
  'state/engine.json',
  'state/runs.jsonl',
  'state/cycles.jsonl',
  'health',
  'metrics',
  'market',
  'reports',
  'pipeline/summary.json',
  'ledger/summary.json',
  'work/summary.json',
];

export function paths(dir) {
  return {
    config: p(dir, 'config.json'),
    engine: p(dir, 'state', 'engine.json'),
    queue: p(dir, 'state', 'queue.json'),
    budget: p(dir, 'state', 'budget.json'),
    control: p(dir, 'state', 'control.json'),
    alerts: p(dir, 'state', 'alerts.json'),
    approvals: p(dir, 'state', 'approvals.json'),
    memory: p(dir, 'state', 'memory.json'),
    lock: p(dir, 'state', 'lock.json'),
    runs: p(dir, 'state', 'runs.jsonl'),
    cycles: p(dir, 'state', 'cycles.jsonl'),
    ledger: p(dir, 'ledger', 'ledger.jsonl'),
    status: p(dir, 'status.json'),
  };
}

function deepMerge(base, over) {
  if (Array.isArray(base) || typeof base !== 'object' || base === null) return over === undefined ? base : over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over ?? {})) out[k] = k in base ? deepMerge(base[k], v) : v;
  return out;
}

export function loadState(dir) {
  const f = paths(dir);
  const config = deepMerge(DEFAULT_CONFIG, readJson(f.config, {}));
  const queue = readJson(f.queue, { tasks: [] });
  queue.tasks = reconcileTasks(queue.tasks);
  return {
    dir,
    files: f,
    config,
    queue,
    budget: readJson(f.budget, { compute: null, approvalsUsed: [] }),
    engine: readJson(f.engine, { cyclesTotal: 0, lastCycleAt: null, ledgerHead: null }),
    control: readJson(f.control, { paused: false, reason: null }),
    alerts: readJson(f.alerts, emptyAlerts()),
    approvals: readJson(f.approvals, { approvals: [] }),
    memory: readJson(f.memory, { nextAction: null, strategy: null, notes: [] }),
  };
}

// Writes only what the engine owns.
export function saveState(s) {
  writeJsonAtomic(s.files.queue, s.queue);
  writeJsonAtomic(s.files.budget, s.budget);
  writeJsonAtomic(s.files.alerts, s.alerts);
  writeJsonAtomic(s.files.engine, s.engine);
}

// People's files, written only by explicit commands (init, pause, resume).
export function saveOwnerFiles(s) {
  writeJsonAtomic(s.files.control, s.control);
  writeJsonAtomic(s.files.approvals, s.approvals);
  writeJsonAtomic(s.files.memory, s.memory);
}

export function initState(dir, overrides = {}) {
  const f = paths(dir);
  if (!existsSync(f.config)) writeJsonAtomic(f.config, deepMerge(DEFAULT_CONFIG, overrides));
  const s = loadState(dir);
  saveState(s);
  for (const [file, value] of [[f.control, s.control], [f.approvals, s.approvals], [f.memory, s.memory]]) {
    if (!existsSync(file)) writeJsonAtomic(file, value);
  }
  return s;
}

// `fresh` is set where every run starts from a new checkout and the
// workflow's concurrency group already stops two runs overlapping (GitHub
// Actions). There, a lock found at start can only be one that was
// committed by mistake: it is replaced, never waited on.
export function acquireLock(s, runId, now, { fresh = false } = {}) {
  const held = readJson(s.files.lock, null);
  if (held && !fresh && now.valueOf() - new Date(held.at).valueOf() < LEASE_TIMEOUT_MS + 15 * 60 * 1000) {
    return { ok: false, heldBy: held.runId, since: held.at };
  }
  writeJsonAtomic(s.files.lock, { runId, at: now.toISOString(), pid: process.pid, previous: held ?? null });
  return { ok: true, replacedStale: Boolean(held), replacedFromCheckout: Boolean(held) && fresh };
}

export function releaseLock(s, runId) {
  const held = readJson(s.files.lock, null);
  if (held && held.runId === runId) rmSync(s.files.lock, { force: true });
}
