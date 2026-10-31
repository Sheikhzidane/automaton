// One cycle: lock, recover, run what is due within budget, record every
// outcome, write the dashboard feed, sync alerts, unlock. Everything
// external (clock, HTTP, environment) is injected so tests can drive it.

import { appendJsonl, readJsonl, trimJsonl, writeJsonAtomic, newId, readJson } from './util.mjs';
import { loadState, saveState, acquireLock, releaseLock } from './state.mjs';
import { dueTasks, recoverStale, startTask, finishTask } from './queue.mjs';
import { denyReason, recordCompute, computeAllowance, billedSeconds } from './budget.mjs';
import { raise, resolve, syncIssues } from './alerts.mjs';
import { safeSummary, verifyChain } from './ledger.mjs';
import { nextCronTime } from './cron.mjs';
import { makeHttp, redactor } from './http.mjs';
import { JOBS } from '../jobs/index.mjs';

function jobTimeoutMs(task, config) {
  if (task.job === 'fsa-refresh') return 10 * 60 * 1000;
  if (task.job === 'public-health') return (config.opslog.pages.length * config.http.timeoutMs) + 30000;
  return 120000;
}

// Why the scheduled runner will not run a task now, or null. The ledger
// is written by people only, and the runner saves only engine-owned
// files, so it can never book a cost: a task that costs money is refused
// here whatever approval exists.
export function runnerRefusal(task, { budget, ledgerSummary, approvals, control, now }) {
  if (task.costPence > 0) {
    return `Costs ${task.costPence}p; the scheduled runner never runs a task that costs money. Record the spend in the ledger, then run it by hand.`;
  }
  return denyReason({ task, budget, ledgerSummary, approvals, control, now });
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
  const { summary: ledger, error: ledgerError } = safeSummary(s.files.ledger, s.config.mission);
  return {
    generatedAt: now.toISOString(),
    runtime: {
      lastCycleAt: cycle.startedAt,
      lastCycleFinishedAt: cycle.finishedAt ?? null,
      lastCycleOk: cycle.ok ?? null,
      lastCycleRunId: cycle.runId,
      host: cycle.host ?? null,
      trigger: cycle.trigger ?? null,
      runUrl: cycle.runUrl ?? null,
      lastScheduledCycleAt: s.engine.lastScheduledCycleAt ?? null,
      schedule: s.config.schedule.cron,
      nextScheduledAt,
      cyclesTotal: s.engine.cyclesTotal ?? 0,
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
      payingCustomers: ledger.payingCustomers,
      ledgerError,
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
  const redact = redactor(env);
  const say = (level, message, extra) => log(level, redact(message), extra ? JSON.parse(redact(JSON.stringify(extra))) : undefined);
  const s = loadState(dir);
  const staleLock = readJson(s.files.lock, null);
  const lock = acquireLock(s, runId, started, { fresh: Boolean(env.GITHUB_ACTIONS) });
  if (!lock.ok) {
    say('warn', 'another cycle holds the lock; exiting', { heldBy: lock.heldBy, since: lock.since });
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
  const raiseAt = (when) => (key, title, detail) => raise(s.alerts, key, redact(title), redact(detail), when);
  try {
    if (lock.replacedFromCheckout) {
      // Committed by mistake (state/lock.json is git-ignored). Not a dead
      // run here: a run that dies in Actions was charged when it started.
      say('warn', 'a lock file came with the checkout; replaced it without charging', { previous: staleLock?.runId ?? null });
    } else if (lock.replacedStale && staleLock?.at) {
      // A local cycle that died: it used time the cap never saw.
      const lost = Math.min(Math.max(0, started.valueOf() - new Date(staleLock.at).valueOf()) / 1000, 25 * 60);
      recordCompute(s.budget, started, billedSeconds(lost, s.config.compute));
      say('warn', 'replaced a stale lock from a cycle that did not finish', { previous: staleLock.runId, estimatedSeconds: Math.round(lost) });
    }
    // Charge the least this run can be billed now, so a cycle that dies
    // part-way is still counted; the rest is added when it finishes.
    const minimumBilled = billedSeconds(0, s.config.compute);
    recordCompute(s.budget, started, minimumBilled);
    saveState(s);
    const { recovered, exhausted } = recoverStale(s.queue.tasks, started, runId);
    if (recovered.length) say('warn', 'recovered tasks from an interrupted cycle', { recovered });
    for (const id of exhausted) {
      const t = s.queue.tasks.find((x) => x.id === id);
      raiseAt(started)(`task:${id}`, `Scheduled task keeps failing: ${t?.title ?? id}`, 'The cycle running it stopped before it finished, more times than its retry limit.');
    }

    const http = makeHttp({ allowHosts: s.config.http.allowHosts, timeoutMs: s.config.http.timeoutMs, fetchImpl });
    const { summary: ledgerSummary } = safeSummary(s.files.ledger, s.config.mission);
    const control = s.control;
    let due = dueTasks(s.queue.tasks, started);
    if (only) due = s.queue.tasks.filter((t) => t.id === only);

    if (control.paused) say('info', 'paused by the operator; no tasks run', { reason: control.reason });
    for (const task of control.paused ? [] : due) {
      const t0 = now();
      const denied = runnerRefusal(task, { budget: s.budget, ledgerSummary, approvals: s.approvals.approvals, control, now: t0 });
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
      const controller = new AbortController();
      const ctx = {
        s,
        now: t0,
        http: (url, opts = {}) => http(url, { ...opts, signal: controller.signal }),
        env,
        log: say,
        ledgerSummary,
        raise: raiseAt(t0),
        resolve: (key) => resolve(s.alerts, key, t0),
      };
      let result;
      let timer;
      try {
        if (!job) throw new Error(`No job called "${task.job}"`);
        const limit = jobTimeoutMs(task, s.config);
        result = await Promise.race([
          job(ctx, task),
          new Promise((_, reject) => {
            timer = setTimeout(() => {
              controller.abort();
              reject(new Error(`${task.id} timed out after ${Math.round(limit / 1000)} s`));
            }, limit);
          }),
        ]);
        if (!result || !['succeeded', 'failed', 'blocked', 'skipped'].includes(result.outcome)) {
          result = { outcome: 'failed', note: 'job returned no outcome' };
        }
      } catch (err) {
        result = { outcome: 'failed', note: String(err?.message ?? err).slice(0, 500) };
      } finally {
        clearTimeout(timer);
      }
      result.note = redact(result.note ?? null);
      const t1 = now();
      const ms = t1.valueOf() - t0.valueOf();
      const exhaustedNow = finishTask(task, result, t1, ms);
      if (exhaustedNow) raiseAt(t1)(`task:${task.id}`, `Scheduled task keeps failing: ${task.title}`, `Last error: ${result.note}`);
      if (result.outcome === 'succeeded') resolve(s.alerts, `task:${task.id}`, t1);
      results.push({ id: task.id, outcome: result.outcome, note: result.note, ms });
      appendJsonl(s.files.runs, { runId, at: t1.toISOString(), task: task.id, outcome: result.outcome, ms, note: result.note });
      say(result.outcome === 'failed' ? 'error' : 'info', `${task.id}: ${result.outcome}`, { ms, note: result.note });
      saveState(s);
    }

    // Remember the verified ledger head so lines cut off the end are noticed.
    try {
      const chain = verifyChain(readJsonl(s.files.ledger), s.engine.ledgerHead);
      if (chain.ok) s.engine.ledgerHead = { count: chain.count, head: chain.head };
    } catch {
      // unreadable: self_check has already raised it
    }

    const finished = now();
    recordCompute(s.budget, finished, billedSeconds((finished.valueOf() - started.valueOf()) / 1000, s.config.compute) - minimumBilled);
    s.budget.compute.capMinutes = s.config.compute.monthlyMinutesCap;
    s.engine.cyclesTotal = (s.engine.cyclesTotal ?? 0) + 1;
    s.engine.lastCycleAt = cycle.startedAt;
    if (cycle.trigger === 'schedule') s.engine.lastScheduledCycleAt = cycle.startedAt;
    cycle.finishedAt = finished.toISOString();
    cycle.ok = !results.some((r) => r.outcome === 'failed');
    if (s.config.alerts.githubIssues) {
      cycle.alertSync = await syncIssues(s.alerts, { http, token: env.GITHUB_TOKEN, repo: env.GITHUB_REPOSITORY, label: s.config.alerts.label, log: say });
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
