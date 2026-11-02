#!/usr/bin/env node
// Growth operations runner. Deterministic, no model calls, no money.
//
//   node ops/run.mjs init    --state DIR
//   node ops/run.mjs cycle   --state DIR [--only TASK_ID]
//   node ops/run.mjs status  --state DIR
//   node ops/run.mjs pause   --state DIR --reason "why"
//   node ops/run.mjs resume  --state DIR
//   node ops/run.mjs ledger  add --state DIR --type revenue --amount-pence N --settled --evidence pi_... --counterparty CUST-001
//   node ops/run.mjs ledger  verify|summary --state DIR
//   node ops/run.mjs verify-controls

import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initState, loadState, saveOwnerFiles, paths, acquireLock } from './lib/state.mjs';
import { runCycle, buildStatus, runnerRefusal } from './lib/engine.mjs';
import { addEntry, verifyChain, summarise, validateEntry } from './lib/ledger.mjs';
import { readJsonl, readJson } from './lib/util.mjs';
import { denyReason, billedSeconds } from './lib/budget.mjs';
import { buildCandidates } from './lib/fhrs.mjs';
import { syncIssues, issueMarker } from './lib/alerts.mjs';
import { makeHttp, redactor } from './lib/http.mjs';
import { isDue, finishTask, recoverStale } from './lib/queue.mjs';

function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[key] = true;
      else {
        out[key] = next;
        i++;
      }
    } else out._.push(a);
  }
  return out;
}

function need(a, key) {
  if (!a[key] || a[key] === true) {
    console.error(`--${key} is required`);
    process.exit(2);
  }
  return a[key];
}

async function verifyControls() {
  const dir = mkdtempSync(join(tmpdir(), 'growth-ops-verify-'));
  const now = new Date('2026-11-02T09:00:00Z');
  const results = [];
  const check = (name, ok, detail = '') => results.push({ name, ok: Boolean(ok), detail });
  const offline = async () => {
    throw new Error('network disabled in verify-controls');
  };

  // 1. Kill switch
  let s = initState(dir);
  s.control = { paused: true, reason: 'verify' };
  saveOwnerFiles(s);
  let r = await runCycle({ dir, now: () => now, env: {}, fetchImpl: offline, log: () => {} });
  check('Paused engine runs no tasks', r.results.length === 0);
  s = loadState(dir);
  check('A cycle never rewrites the kill switch', s.control.paused === true);
  s.control = { paused: false, reason: null };
  saveOwnerFiles(s);

  // 2. Spending needs an unused approval and must fit in the capital left
  const costly = { id: 'x', priority: 2, costPence: 500 };
  const summary = { capitalRemainingPence: 2000 };
  const approved = [{ id: 'A1', taskId: 'x', status: 'approved', amountPence: 500, expiresAt: '2026-12-01T00:00:00Z' }];
  check('Task with a cost and no approval is refused', denyReason({ task: costly, budget: { compute: null }, ledgerSummary: summary, approvals: [], control: {}, now }) !== null);
  check('Approved task within capital is allowed', denyReason({ task: costly, budget: { compute: null }, ledgerSummary: summary, approvals: approved, control: {}, now }) === null);
  check('An approval cannot be used twice', denyReason({ task: costly, budget: { compute: null, approvalsUsed: ['A1'] }, ledgerSummary: summary, approvals: approved, control: {}, now }) !== null);
  check('Spend above remaining capital is refused even when approved', denyReason({ task: { ...costly, costPence: 2500 }, budget: { compute: null }, ledgerSummary: summary, approvals: [{ ...approved[0], amountPence: 2500 }], control: {}, now }) !== null);
  check('Expired approval is refused', denyReason({ task: costly, budget: { compute: null }, ledgerSummary: summary, approvals: [{ ...approved[0], expiresAt: '2026-11-01T00:00:00Z' }], control: {}, now }) !== null);
  check('An unreadable ledger leaves no capital to spend', denyReason({ task: costly, budget: { compute: null }, ledgerSummary: { capitalRemainingPence: 0 }, approvals: approved, control: {}, now }) !== null);
  check('The scheduled runner refuses a costed task even with a valid approval', runnerRefusal(costly, { budget: { compute: null }, ledgerSummary: summary, approvals: approved, control: {}, now }) !== null);
  const ledgerText = () => (existsSync(paths(dir).ledger) ? readFileSync(paths(dir).ledger, 'utf8') : null);
  const ledgerBefore = ledgerText();
  await runCycle({ dir, now: () => now, env: {}, fetchImpl: offline, log: () => {} });
  check('A cycle never writes to the owner ledger', ledgerText() === ledgerBefore);

  // 3. Compute cap
  const capped = { compute: { month: '2026-11', secondsUsed: 60 * 901, capMinutes: 900 } };
  check('Past the compute cap, low-priority tasks stop', denyReason({ task: { priority: 3, costPence: 0 }, budget: capped, control: {}, now }) !== null);
  check('Past the compute cap, priority-1 health checks still run', denyReason({ task: { priority: 1, costPence: 0 }, budget: capped, control: {}, now }) === null);
  check('Compute is charged as GitHub bills it: each job rounded up to a whole minute', billedSeconds(0) === 120 && billedSeconds(30) === 120 && billedSeconds(31) === 180 && billedSeconds(0, {}, 40) === 180);

  // 4. Ledger rules and integrity
  const ledger = paths(dir).ledger;
  addEntry(ledger, { type: 'revenue', amountPence: 60000, settled: true, evidence: 'pi_test', counterparty: 'CUST-001', test: true }, now);
  addEntry(ledger, { type: 'revenue', amountPence: 60000, settled: false, counterparty: 'CUST-002' }, now);
  addEntry(ledger, { type: 'revenue', amountPence: 60000, settled: true, evidence: 'po_3Qrel', counterparty: 'CUST-003', relatedParty: true }, now);
  const sm = summarise(readJsonl(ledger), { capitalPence: 2000, targetNetPence: 200000 });
  check('Test, unsettled and related-party revenue are not counted', sm.countedRevenuePence === 0, `counted ${sm.countedRevenuePence}`);
  const refuses = (input) => {
    try {
      addEntry(ledger, input, now);
      return false;
    } catch {
      return true;
    }
  };
  check('Ledger refuses an email address as a counterparty', refuses({ type: 'revenue', amountPence: 100, settled: true, evidence: 'pi_3Qabc', counterparty: 'jo@example.com' }));
  check('Ledger refuses an invoice number as proof of payment', refuses({ type: 'revenue', amountPence: 100, settled: true, evidence: 'INV-0001', counterparty: 'CUST-004' }));
  check('Ledger refuses the same payment twice', refuses({ type: 'revenue', amountPence: 60000, settled: true, evidence: 'po_3Qrel', counterparty: 'CUST-005' }));
  check('Ledger refuses a correction to a line that does not exist', refuses({ type: 'correction', supersedes: 99 }));
  const head = verifyChain(readJsonl(ledger));
  const lines = readFileSync(ledger, 'utf8').trim().split('\n');
  writeFileSync(ledger, `${lines.slice(0, -1).join('\n')}\n`);
  check('A line cut off the end is detected', !verifyChain(readJsonl(ledger), { count: head.count, head: head.head }).ok);
  writeFileSync(ledger, `${lines.join('\n').replace('"amountPence":60000', '"amountPence":6000000')}\n`);
  check('An edited ledger line is detected', !verifyChain(readJsonl(ledger)).ok);

  // 5. Outbound requests
  const http = makeHttp({ allowHosts: ['opslog.co.uk', 'api.github.com'], fetchImpl: offline });
  const refusedWith = async (fn, pattern) => {
    try {
      await fn();
      return false;
    } catch (e) {
      return pattern.test(e.message) ? e.message : false;
    }
  };
  check('Requests to hosts outside the allowlist are refused', await refusedWith(() => http('https://example.com/'), /not an allowed host/));
  check('Plain HTTP is refused', await refusedWith(() => http('http://opslog.co.uk/'), /not an allowed host/));
  const redirecting = makeHttp({
    allowHosts: ['opslog.co.uk', 'api.github.com'],
    fetchImpl: async () => new Response(null, { status: 302, headers: { location: 'https://api.github.com/x' } }),
  });
  check('A credentialed request is not followed to another host', await refusedWith(() => redirecting('https://opslog.co.uk/api/ops/metrics', { headers: { authorization: 'Bearer secret-value-123' } }), /redirected to another host/));
  const msg = await refusedWith(() => http('https://opslog.co.uk/', { headers: { authorization: 'Bearer abcd\nefgh-secret' } }), /line break/);
  check('A malformed secret is refused without quoting it', msg && !msg.includes('efgh-secret'));
  const redact = redactor({ OPS_METRICS_TOKEN: 'tok-AAAAAAAA\nBBBBBBBB-tail' });
  check('Secrets are removed from stored text', !/AAAAAAAA|BBBBBBBB/.test(redact('saw tok-AAAAAAAA and BBBBBBBB-tail')));

  // 6. Scheduling, idempotency and crash recovery
  const t = { id: 'demo', intervalMinutes: 180, maxAttempts: 2, history: [] };
  finishTask(t, { outcome: 'succeeded' }, new Date('2026-11-02T09:37:00Z'), 1);
  check('A task that succeeded in this slot is not run again', !isDue(t, new Date('2026-11-02T09:50:00Z')));
  check('A late start does not skip the next slot', isDue(t, new Date('2026-11-02T12:05:00Z')));
  const crashed = [{ id: 'c', status: 'running', maxAttempts: 2, attempts: 1, lease: { runId: 'old', at: now.toISOString() }, history: [] }];
  const rec = recoverStale(crashed, now, 'new');
  check('A task killed mid-cycle too often is marked failed and alerted', rec.exhausted.length === 1 && crashed[0].status === 'failed');

  // 7. Single runner at a time
  s = loadState(dir);
  const first = acquireLock(s, 'a', now);
  const second = acquireLock(s, 'b', now);
  check('A second cycle cannot start while one holds the lock', first.ok && !second.ok);
  const fromCheckout = acquireLock(s, 'c', now, { fresh: true });
  check('In GitHub Actions a lock that came with the checkout is replaced, not waited on', fromCheckout.ok && fromCheckout.replacedFromCheckout);

  // 8. Personal data stays out of logs and issues; objections are honoured
  const bad = join(dir, 'bad.json');
  writeFileSync(bad, '{"contact": jane.smith@example.com}');
  let parseMsg = '';
  try {
    readJson(bad, {});
  } catch (e) {
    parseMsg = e.message;
  }
  check('A corrupt file is reported without quoting its contents', parseMsg.includes('Corrupt JSON') && !/jane|smith|example/.test(parseMsg), parseMsg);
  const sites = [
    { id: 1, name: 'Hill Bistro', typeId: 1, postcode: 'EH1 1AA', rating: 'Pass' },
    { id: 2, name: 'Hill Bistro', typeId: 1, postcode: 'EH2 2AA', rating: 'Pass' },
    { id: 3, name: 'Dale Cafe', typeId: 1, postcode: 'EH3 3AA', rating: 'Pass' },
    { id: 4, name: 'Dale Cafe', typeId: 1, postcode: 'EH4 4AA', rating: 'Pass' },
  ];
  const kept = buildCandidates(sites, { now, exclude: { names: ['Hill Bistro'], ids: [4] } });
  check('A business that objected is never profiled again (by name and by FSA id)', kept.length === 0, kept.map((k) => k.name).join(', '));
  check('A phone number is refused in any kind of evidence; a date is accepted in a description',
    validateEntry({ type: 'refund', amountPence: 100, evidence: 'refund to +44 7700 900123' }).length > 0 &&
    validateEntry({ type: 'expense', amountPence: 100, category: 'licence', description: 'Domain 2026-11-01 to 2027-10-31' }).length === 0);
  check('A payment reference made of digits is accepted; a bank reference with a name is refused',
    validateEntry({ type: 'revenue', amountPence: 100, settled: true, evidence: 'txn_1234567890', counterparty: 'CUST-006' }).length === 0 &&
    validateEntry({ type: 'revenue', amountPence: 100, settled: true, evidence: 'bank:FP JANE SMITH', counterparty: 'CUST-007' }).length > 0);
  let posts = 0;
  const alertState = { open: { k1: { key: 'k1', title: 'x', detail: 'y', since: now.toISOString(), count: 1, issueNumber: null } }, closed: [] };
  const fakeGitHub = async (url, opts = {}) => {
    if ((opts.method ?? 'GET') === 'GET') return { status: 200, text: JSON.stringify([{ number: 41, body: `old\n${issueMarker('k1')}` }]) };
    posts++;
    return { status: 201, text: JSON.stringify({ number: 42 }) };
  };
  await syncIssues(alertState, { http: fakeGitHub, token: 't', repo: 'o/r' });
  check('An alert whose issue is already open reuses it instead of opening another', posts === 0 && alertState.open.k1.issueNumber === 41);
  let patched = 0;
  const orphanGitHub = async (url, opts = {}) => {
    const method = opts.method ?? 'GET';
    if (method === 'GET') return { status: 200, text: JSON.stringify([{ number: 41, body: issueMarker('gone'), user: { login: 'github-actions[bot]' } }]) };
    if (method === 'PATCH') patched++;
    return { status: 200, text: '{}' };
  };
  await syncIssues({ open: {}, closed: [] }, { http: orphanGitHub, token: 't', repo: 'o/r', author: 'github-actions[bot]' });
  check('An alert issue left open by a run that was never saved is closed once the problem has cleared', patched === 1);

  let failed = 0;
  for (const res of results) {
    console.log(`${res.ok ? 'PASS' : 'FAIL'}  ${res.name}${res.detail && !res.ok ? ` (${res.detail})` : ''}`);
    if (!res.ok) failed++;
  }
  console.log(failed ? `${failed} control(s) failed.` : `All ${results.length} controls passed.`);
  return failed ? 1 : 0;
}

async function main() {
  const a = args(process.argv.slice(2));
  const cmd = a._[0];
  if (cmd === 'verify-controls') process.exit(await verifyControls());
  if (cmd === 'init') {
    initState(need(a, 'state'));
    console.log('Initialised.');
    return;
  }
  const dir = need(a, 'state');
  if (cmd === 'cycle') {
    const r = await runCycle({ dir, only: typeof a.only === 'string' ? a.only : null });
    if (r.locked) process.exit(0);
    process.exit(r.ok ? 0 : 1);
  }
  if (cmd === 'status') {
    const s = loadState(dir);
    const st = buildStatus(s, { now: new Date(), cycle: { runId: null, startedAt: s.engine.lastCycleAt ?? null } });
    for (const t of st.tasks) console.log(`${t.status.padEnd(9)} ${t.id.padEnd(24)} last ${t.lastRunAt ?? 'never'}  next ${t.nextRunAt ?? 'next cycle'}  ${t.lastNote ?? ''}`);
    console.log(`Paused: ${st.paused}. Next scheduled cycle: ${st.runtime.nextScheduledAt}. Capital left: ${st.budget.capitalRemainingPence}p.`);
    return;
  }
  if (cmd === 'pause' || cmd === 'resume') {
    const s = loadState(dir);
    s.control = cmd === 'pause' ? { paused: true, reason: typeof a.reason === 'string' ? a.reason : null, at: new Date().toISOString() } : { paused: false, reason: null, at: new Date().toISOString() };
    saveOwnerFiles(s);
    console.log(cmd === 'pause' ? 'Paused.' : 'Resumed.');
    return;
  }
  if (cmd === 'ledger') {
    const s = loadState(dir);
    const sub = a._[1];
    if (sub === 'verify') {
      const v = verifyChain(readJsonl(s.files.ledger), s.engine.ledgerHead);
      console.log(v.ok ? `Ledger intact: ${v.count} lines.` : `Ledger damaged: ${v.error}`);
      process.exit(v.ok ? 0 : 1);
    }
    if (sub === 'summary') {
      console.log(JSON.stringify(summarise(readJsonl(s.files.ledger), s.config.mission), null, 2));
      return;
    }
    if (sub === 'add') {
      const e = addEntry(s.files.ledger, {
        type: need(a, 'type'),
        amountPence: a['amount-pence'] ? Number(a['amount-pence']) : undefined,
        // Nothing is settled unless you say so: an issued invoice is not money.
        settled: Boolean(a.settled),
        evidence: typeof a.evidence === 'string' ? a.evidence : null,
        counterparty: typeof a.counterparty === 'string' ? a.counterparty : null,
        category: typeof a.category === 'string' ? a.category : null,
        description: typeof a.description === 'string' ? a.description : null,
        relatedParty: Boolean(a['related-party']),
        attributable: !a['not-attributable'],
        test: Boolean(a.test),
        fundedFromCapital: Boolean(a['from-capital']),
        supersedes: a.supersedes ? Number(a.supersedes) : undefined,
      });
      console.log(`Recorded line ${e.seq}.`);
      return;
    }
  }
  console.error('Unknown command. See the header of ops/run.mjs.');
  process.exit(2);
}

main().catch((err) => {
  console.error(err?.stack ?? String(err));
  process.exit(3);
});
