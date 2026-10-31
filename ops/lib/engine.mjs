// One cycle: lock, recover, run what is due within budget, record every
// outcome, write the dashboard feed, sync alerts, unlock. Everything
// external (clock, HTTP, environment) is injected so tests can drive it.

import { appendJsonl, readJsonl, trimJsonl, writeJsonAtomic, newId } from './util.mjs';
import { loadState, saveState, acquireLock, releaseLock } from './state.mjs';
import { dueTasks, recoverStale, startTask, finishTask } from './queue.mjs';
import { denyReason, recordCompute, computeAllowance } from './budget.mjs';
import { raise, resolve, syncIssues } from './alerts.mjs';
import { summarise } from './ledger.mjs';
import { nextCronTime } from './cron.mjs';
import { makeHttp } from './http.mjs';
import { JOBS } from '../jobs/index.mjs';

const JOB_TIMEOUT_MS = { 'fsa-refresh': 10 * 60 * 1000 };

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)} s`)), ms);
    }),
  ]);
}

export function buildStatus(s, { now, cycle }) {
  const tasks = s.queue.tasks;
  const c = computeAllowance(s.budget, now);
  let nextScheduledAt = null;
  try {
    nextScheduledAt = nextCronTime(s.config.schedule.cron, now).toISOString();
  } catch {
    nextScheduledAt = null;
  }
  const counts = {};
  for (const t of tasks) counts[t.status] = (counts[t.status] ?? 0) + 1;
  const ledger = summarise(readJsonl(s.files.ledger), s.config.mission);
  return {
    generatedAt: now.toISOString(),
    runtime: {
      lastCycleAt: cycle.startedAt,
      lastCycleFinishedAt: cycle.finishedAt,
      lastCycleOk: cycle.ok,
      lastCycleRunId: cycle.runId,
      host: cycle.host,
      trigger: cycle.trigger,
      runUrl: cycle.runUrl,
      schedule: s.config.schedule.cron,
      nextScheduledAt,
      cyclesTotal: (s.memory.cyclesTotal ?? 0),
    },
    paused: Boolean(s.control.paused),
    pausedReason: s.control.reason ?? null,
    counts,
    tasks: tasks.map((t) => ({
      id: t.id,
      title: t.title,
      priority: t.priority,
      status: t.status,
      lastOutcome: t.lastOutcome,
      lastNote: t.lastNote,
      lastRunAt: t.lastRunAt,
      lastSuccessAt: t.lastSuccessAt,
      nextRunAt: t.nextRunAt,
      requires: t.requires,
      costPence: t.costPence,
      completion: t.completion,
      consecutiveFailures: t.consecutiveFailures,
    })),
    alerts: Object.values(s.alerts.open).map((a) => ({ key: a.key, title: a.title, since: a.since, count: a.count })),
    approvalsPending: (s.approvals.approvals ?? []).filter((a) => a.status === 'pending').length,
    budget: {
      capitalPence: ledger.capitalPence,
      capitalRemainingPence: ledger.capitalRemainingPence,
      netPence: ledger.netPence,
      targetNetPence: ledger.targetNetPence,
      progressPct: ledger.progressPct,
      computeMonth: c.month,
      computeMinutesUsed: Math.round((c.secondsUsed / 60) * 10) / 10,
      computeCapMinutes: c.capMinutes,
      inferenceSpendPence: 0,
    },
  };
}

export async function runCycle({ dir, now = () => new Date(), env = process.env, fetchImpl = globalThis.fetch, only = null, log = defaultLog }) {
  const started = now();
  const runId = env.GITHUB_RUN_ID ? `gh_${env.GITHUB_RUN_ID}_${env.GITHUB_RUN_ATTEMPT ?? 1}` : newId('local');
  const s = loadState(dir);
  const lock = acquireLock(s, runId, started);
  if (!lock.ok) {
    log('warn', 'another cycle holds the lock; exiting', { heldBy: lock.heldBy, since: lock.since });
    return { ok: false, locked: true, runId, results: [] };
  }
  const cycle = {
    runId,
    startedAt: started.toISOString(),
    host: env.GITHUB_ACTIONS ? 'github-actions' : 'local',
    trigger: env.GITHUB_EVENT_NAME ?? 'manual',
    runUrl: env.GITHUB_RUN_ID && env.GITHUB_REPOSITORY ? `${env.GITHUB_SERVER_URL ?? 'https://github.com'}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` : null,
  };
  const results = [];
  try {
    const recovered = recoverStale(s.queue.tasks, started, runId);
    if (recovered.length) log('warn', 'recovered tasks from an interrupted cycle', { recovered });
    if (lock.replacedStale) log('warn', 'replaced a stale lock from a cycle that did not finish');

    const http = makeHttp({ allowHosts: s.config.http.allowHosts, timeoutMs: s.config.http.timeoutMs, fetchImpl });
    const ledgerSummary = summarise(readJsonl(s.files.ledger), s.config.mission);
    const control = s.control;
    let due = dueTasks(s.queue.tasks, started);
    if (only) due = s.queue.tasks.filter((t) => t.id === only);

    if (control.paused) {
      log('info', 'paused by the operator; no tasks run', { reason: control.reason });
    }
    for (const task of control.paused ? [] : due) {
      const t0 = now();
      const denied = denyReason({ task, budget: s.budget, ledgerSummary, approvals: s.approvals.approvals, control, now: t0 });
      if (denied) {
        finishTask(task, { outcome: 'blocked', note: denied }, t0, 0);
        results.push({ id: task.id, outcome: 'blocked', note: denied, ms: 0 });
        appendJsonl(s.files.runs, { runId, at: t0.toISOString(), task: task.id, outcome: 'blocked', ms: 0, note: denied });
        saveState(s);
        continue;
      }
      startTask(task, t0, runId);
      saveState(s); // checkpoint: a crash from here leaves a lease to recover
      const job = JOBS[task.job];
      let result;
      const ctx = {
        s,
        now: t0,
        http,
        env,
        log,
        ledgerSummary,
        raise: (key, title, detail) => raise(s.alerts, key, title, detail, t0),
        resolve: (key) => resolve(s.alerts, key, t0),
      };
      try {
        if (!job) throw new Error(`No job called "${task.job}"`);
        result = await withTimeout(job(ctx, task), JOB_TIMEOUT_MS[task.job] ?? 120000, task.id);
        if (!result || !['succeeded', 'failed', 'blocked', 'skipped'].includes(result.outcome)) {
          result = { outcome: 'failed', note: 'job returned no outcome' };
        }
      } catch (err) {
        result = { outcome: 'failed', note: String(err?.message ?? err).slice(0, 500) };
      }
      const t1 = now();
      const ms = t1.valueOf() - t0.valueOf();
      const exhausted = finishTask(task, result, t1, ms);
      if (exhausted) raise(s.alerts, `task:${task.id}`, `Scheduled task keeps failing: ${task.title}`, `Last error: ${result.note}`, t1);
      if (result.outcome === 'succeeded') resolve(s.alerts, `task:${task.id}`, t1);
      results.push({ id: task.id, outcome: result.outcome, note: result.note ?? null, ms });
      appendJsonl(s.files.runs, { runId, at: t1.toISOString(), task: task.id, outcome: result.outcome, ms, note: result.note ?? null });
      log(result.outcome === 'failed' ? 'error' : 'info', `${task.id}: ${result.outcome}`, { ms, note: result.note });
      saveState(s);
    }

    const finished = now();
    recordCompute(s.budget, finished, (finished.valueOf() - started.valueOf()) / 1000 + (s.config.compute.perRunOverheadSeconds ?? 45));
    s.budget.compute.capMinutes = s.config.compute.monthlyMinutesCap;
    s.memory.cyclesTotal = (s.memory.cyclesTotal ?? 0) + 1;
    s.memory.lastCycleAt = cycle.startedAt;
    cycle.finishedAt = finished.toISOString();
    cycle.ok = !results.some((r) => r.outcome === 'failed');
    if (s.config.alerts.githubIssues) {
      const sync = await syncIssues(s.alerts, { http, token: env.GITHUB_TOKEN, repo: env.GITHUB_REPOSITORY, label: s.config.alerts.label, log });
      cycle.alertSync = sync;
    }
    saveState(s);
    writeJsonAtomic(s.files.status, buildStatus(s, { now: finished, cycle }));
    appendJsonl(s.files.cycles, { ...cycle, results: results.map(({ id, outcome, ms }) => ({ id, outcome, ms })) });
    trimJsonl(s.files.runs, 5000);
    trimJsonl(s.files.cycles, 2000);
    return { ok: cycle.ok, runId, results };
  } finally {
    releaseLock(s, runId);
  }
}

export function defaultLog(level, message, extra) {
  const line = { t: new Date().toISOString(), level, message, ...(extra ?? {}) };
  (level === 'error' ? console.error : console.log)(JSON.stringify(line));
}
