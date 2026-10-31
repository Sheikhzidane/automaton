// Where everything the engine knows is kept, and the lock that stops
// two cycles running over the same state at once.

import { existsSync, rmSync } from 'node:fs';
import { readJson, writeJsonAtomic, p } from './util.mjs';
import { reconcileTasks } from './queue.mjs';
import { emptyAlerts } from './alerts.mjs';
import { LEASE_TIMEOUT_MS } from './queue.mjs';

export const DEFAULT_CONFIG = {
  schemaVersion: 1,
  mission: { name: '£20 to £2,000', capitalPence: 2000, targetNetPence: 200000 },
  schedule: { cron: '37 */3 * * *', note: 'UTC; must match the workflow' },
  compute: { monthlyMinutesCap: 900, perRunOverheadSeconds: 45 },
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

export function paths(dir) {
  return {
    config: p(dir, 'config.json'),
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
    budget: readJson(f.budget, { capitalPence: config.mission.capitalPence, compute: null }),
    control: readJson(f.control, { paused: false, reason: null }),
    alerts: readJson(f.alerts, emptyAlerts()),
    approvals: readJson(f.approvals, { approvals: [] }),
    memory: readJson(f.memory, { nextAction: null, strategy: null, notes: [] }),
  };
}

export function saveState(s) {
  writeJsonAtomic(s.files.queue, s.queue);
  writeJsonAtomic(s.files.budget, s.budget);
  writeJsonAtomic(s.files.control, s.control);
  writeJsonAtomic(s.files.alerts, s.alerts);
  writeJsonAtomic(s.files.approvals, s.approvals);
  writeJsonAtomic(s.files.memory, s.memory);
}

export function initState(dir, overrides = {}) {
  const f = paths(dir);
  if (!existsSync(f.config)) writeJsonAtomic(f.config, deepMerge(DEFAULT_CONFIG, overrides));
  const s = loadState(dir);
  saveState(s);
  return s;
}

export function acquireLock(s, runId, now) {
  const held = readJson(s.files.lock, null);
  if (held && now.valueOf() - new Date(held.at).valueOf() < LEASE_TIMEOUT_MS + 15 * 60 * 1000) {
    return { ok: false, heldBy: held.runId, since: held.at };
  }
  writeJsonAtomic(s.files.lock, { runId, at: now.toISOString(), pid: process.pid, previous: held ?? null });
  return { ok: true, replacedStale: Boolean(held) };
}

export function releaseLock(s, runId) {
  const held = readJson(s.files.lock, null);
  if (held && held.runId === runId) rmSync(s.files.lock, { force: true });
}
