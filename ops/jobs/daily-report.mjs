// The daily report, in plain English, from whatever the other tasks
// last recorded. Every figure says how old it is; nothing is invented.

import { mkdirSync, writeFileSync } from 'node:fs';
import { readJson, writeJsonAtomic, londonDate, p } from '../lib/util.mjs';

const gbp = (n) => (typeof n === 'number' ? `£${(n / 100).toFixed(2)}` : 'unknown');

function age(at, now) {
  if (!at) return 'never';
  const h = Math.round((now.valueOf() - new Date(at).valueOf()) / 3600000);
  return h < 1 ? 'under an hour ago' : h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}

export async function run(ctx) {
  const d = ctx.s.dir;
  const now = ctx.now;
  const task = (id) => ctx.s.queue.tasks.find((t) => t.id === id);
  const health = readJson(p(d, 'health', 'latest.json'), null);
  const metrics = readJson(p(d, 'metrics', 'latest.json'), null);
  const market = readJson(p(d, 'market', 'summary.json'), null);
  const pipeline = readJson(p(d, 'pipeline', 'summary.json'), null);
  const ledger = readJson(p(d, 'ledger', 'summary.json'), null);
  const work = readJson(p(d, 'work', 'summary.json'), null);
  const tasks = ctx.s.queue.tasks;
  const alerts = Object.values(ctx.s.alerts.open);
  const date = londonDate(now);
  const why = (id) => {
    const t = task(id);
    return t?.lastNote ? `${t.status}: ${t.lastNote}` : 'not run yet';
  };

  const lines = [];
  lines.push(`# Growth operations report, ${date}`, '');
  lines.push(`Generated ${now.toISOString()} by the scheduled runner from recorded state. Each figure says when it was measured.`, '');
  lines.push('## Money', '');
  if (ledger) {
    lines.push(`- Net mission earnings: ${gbp(ledger.netPence)} of ${gbp(ledger.targetNetPence)} (${ledger.progressPct}%), as of ${age(ledger.at, now)}.`);
    lines.push(`- Counted revenue ${gbp(ledger.countedRevenuePence)} from ${ledger.payingCustomers ?? 0} paying customer(s); pending ${gbp(ledger.pendingRevenuePence)}; costs ${gbp(ledger.expensesPence)}.`);
    lines.push(`- Mission capital left: ${gbp(ledger.capitalRemainingPence)} of ${gbp(ledger.capitalPence)}.`);
  } else lines.push(`- Not reviewed (${why('revenue.review')}).`);
  lines.push('', '## OpsLog', '');
  if (health) lines.push(`- Public site: ${health.ok ? 'answering normally' : 'PROBLEM'}, checked ${age(health.at, now)}${health.region ? `; functions in ${health.region}` : ''}.`);
  else lines.push(`- Public site: no result (${why('opslog.public_health')}).`);
  if (metrics) {
    const stale = now.valueOf() - new Date(metrics.at).valueOf() > 2 * 86400000;
    lines.push(`- ${stale ? 'STALE: ' : ''}Active organisations ${metrics.orgs?.active ?? '?'}; checklists completed in 7 days ${metrics.usage?.checklistsCompleted7d ?? '?'}; emails failed in 24 hours ${metrics.email?.failed24h ?? '?'} (measured ${age(metrics.at, now)}).`);
  } else lines.push(`- Aggregate metrics: none yet (${why('opslog.ops_metrics')}).`);
  lines.push('', '## Pipeline', '');
  if (pipeline) {
    const stages = Object.entries(pipeline.byStage).filter(([, n]) => n).map(([s, n]) => `${s.replace(/_/g, ' ')} ${n}`).join(', ');
    lines.push(`- ${pipeline.total} prospects${stages ? `: ${stages}` : ''}.`);
    lines.push(`- Waiting for your approval to contact: ${pipeline.awaitingApproval}. Follow-ups due: ${pipeline.due.length}. Stale: ${pipeline.stale.length}.`);
  } else lines.push(`- Not reviewed (${why('pipeline.review')}).`);
  if (market) lines.push(`- Market data: ${market.hospitality} hospitality businesses tracked, ${market.candidates} candidates by signal (refreshed ${age(market.at, now)}).`);
  else lines.push(`- Market data: none yet (${why('market.fsa_refresh')}).`);
  lines.push('', '## Engine', '');
  const failing = tasks.filter((t) => ['failed', 'retrying'].includes(t.status));
  const blocked = tasks.filter((t) => t.status === 'blocked');
  lines.push(`- ${tasks.filter((t) => t.lastOutcome === 'succeeded').length} of ${tasks.length} tasks last succeeded; ${failing.length} failing; ${blocked.length} blocked.`);
  for (const t of blocked) lines.push(`  - Blocked: ${t.title} (${t.lastNote}).`);
  for (const t of failing) lines.push(`  - Failing: ${t.title} (${t.lastNote}).`);
  for (const a of alerts) lines.push(`- Alert open since ${a.since}: ${a.title}.`);
  if (work) lines.push(`- Internal work: ${work.open} open, ${work.blocked.length} blocked, ${work.overdue.length} overdue, ${work.needsOwner?.length ?? 0} waiting for you.`);
  lines.push('', `Next action: ${ctx.s.memory.nextAction ?? 'not set'}`, '');

  mkdirSync(p(d, 'reports'), { recursive: true });
  writeFileSync(p(d, 'reports', `${date}.md`), lines.join('\n'));
  writeJsonAtomic(p(d, 'reports', 'latest.json'), { at: now.toISOString(), date, file: `reports/${date}.md` });
  return { outcome: 'succeeded', note: `reports/${date}.md written` };
}
