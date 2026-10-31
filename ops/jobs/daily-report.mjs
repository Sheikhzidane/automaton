// The daily report, in plain English, from whatever the other tasks
// last recorded. Writes nothing it did not read from state.

import { readJson, writeJsonAtomic, londonDate, p } from '../lib/util.mjs';

const gbp = (n) => (typeof n === 'number' ? `£${(n / 100).toFixed(2)}` : 'unknown');

export async function run(ctx) {
  const d = ctx.s.dir;
  const health = readJson(p(d, 'health', 'latest.json'), null);
  const metrics = readJson(p(d, 'metrics', 'latest.json'), null);
  const market = readJson(p(d, 'market', 'summary.json'), null);
  const pipeline = readJson(p(d, 'pipeline', 'summary.json'), null);
  const ledger = readJson(p(d, 'ledger', 'summary.json'), null);
  const work = readJson(p(d, 'work', 'summary.json'), null);
  const tasks = ctx.s.queue.tasks;
  const alerts = Object.values(ctx.s.alerts.open);
  const date = londonDate(ctx.now);

  const lines = [];
  lines.push(`# Growth operations report, ${date}`, '');
  lines.push(`Generated ${ctx.now.toISOString()} by the scheduled runner. Figures come only from recorded state.`, '');
  lines.push('## Money', '');
  if (ledger) {
    lines.push(`- Net mission earnings: ${gbp(ledger.netPence)} of ${gbp(ledger.targetNetPence)} (${ledger.progressPct}%).`);
    lines.push(`- Counted revenue ${gbp(ledger.countedRevenuePence)}, pending ${gbp(ledger.pendingRevenuePence)}, costs ${gbp(ledger.expensesPence)}.`);
    lines.push(`- Mission capital left: ${gbp(ledger.capitalRemainingPence)} of ${gbp(ledger.capitalPence)}.`);
  } else lines.push('- Not reviewed yet.');
  lines.push('', '## OpsLog', '');
  if (health) lines.push(`- Public site: ${health.ok ? 'answering normally' : 'PROBLEM'} at ${health.at}${health.region ? `, functions in ${health.region}` : ''}.`);
  else lines.push('- Public site: not checked yet.');
  if (metrics) lines.push(`- Active organisations ${metrics.orgs?.active ?? '?'}; checklists completed in 7 days ${metrics.usage?.checklistsCompleted7d ?? '?'}; emails failed in 24 hours ${metrics.email?.failed24h ?? '?'}.`);
  else lines.push('- Aggregate metrics: not available (token not configured yet).');
  lines.push('', '## Pipeline', '');
  if (pipeline) {
    lines.push(`- ${pipeline.total} prospects. ${Object.entries(pipeline.byStage).filter(([, n]) => n).map(([s, n]) => `${s.replace(/_/g, ' ')} ${n}`).join(', ') || 'none yet'}.`);
    lines.push(`- Waiting for your approval to contact: ${pipeline.awaitingApproval}. Follow-ups due: ${pipeline.due.length}. Stale: ${pipeline.stale.length}.`);
  } else lines.push('- Not reviewed yet.');
  if (market) lines.push(`- Market data: ${market.hospitality} hospitality businesses tracked; ${market.candidates} candidates by signal.`);
  lines.push('', '## Engine', '');
  const failing = tasks.filter((t) => ['failed', 'retrying'].includes(t.status));
  const blocked = tasks.filter((t) => t.status === 'blocked');
  lines.push(`- ${tasks.filter((t) => t.lastOutcome === 'succeeded').length} of ${tasks.length} tasks last succeeded; ${failing.length} failing; ${blocked.length} blocked.`);
  for (const t of blocked) lines.push(`  - Blocked: ${t.title} (${t.lastNote}).`);
  for (const t of failing) lines.push(`  - Failing: ${t.title} (${t.lastNote}).`);
  if (alerts.length) for (const a of alerts) lines.push(`- Alert open since ${a.since}: ${a.title}.`);
  if (work) lines.push(`- Internal work: ${work.open} open, ${work.blocked.length} blocked, ${work.overdue.length} overdue.`);
  lines.push('', `Next action: ${ctx.s.memory.nextAction ?? 'not set'}`, '');

  const text = lines.join('\n');
  const path = p(d, 'reports', `${date}.md`);
  const { writeFileSync, mkdirSync } = await import('node:fs');
  mkdirSync(p(d, 'reports'), { recursive: true });
  writeFileSync(path, text);
  writeJsonAtomic(p(d, 'reports', 'latest.json'), { at: ctx.now.toISOString(), date, file: `reports/${date}.md` });
  return { outcome: 'succeeded', note: `reports/${date}.md written` };
}
