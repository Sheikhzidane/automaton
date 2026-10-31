// Reviews the prospect pipeline. Reads only; never contacts anyone.

import { readJson, writeJsonAtomic, p } from '../lib/util.mjs';

export const STAGES = ['researched', 'qualified', 'approved_to_contact', 'contacted', 'replied', 'demo_booked', 'trial', 'won', 'lost', 'do_not_contact'];

export async function run(ctx) {
  const file = readJson(p(ctx.s.dir, 'pipeline', 'prospects.json'), { prospects: [] });
  const today = ctx.now.toISOString().slice(0, 10);
  const staleMs = (ctx.s.config.pipeline?.staleAfterDays ?? 14) * 86400000;
  const byStage = Object.fromEntries(STAGES.map((s) => [s, 0]));
  const due = [];
  const stale = [];
  const problems = [];
  for (const pr of file.prospects) {
    if (!STAGES.includes(pr.stage)) problems.push(`${pr.id}: unknown stage "${pr.stage}"`);
    else byStage[pr.stage] += 1;
    if (pr.nextActionDue && pr.nextActionDue <= today && !['won', 'lost', 'do_not_contact'].includes(pr.stage)) {
      due.push({ id: pr.id, name: pr.name, stage: pr.stage, nextAction: pr.nextAction, due: pr.nextActionDue });
    }
    const touched = pr.lastTouch ?? pr.addedAt;
    if (touched && ['contacted', 'replied', 'demo_booked', 'trial'].includes(pr.stage) && ctx.now.valueOf() - new Date(touched).valueOf() > staleMs) {
      stale.push({ id: pr.id, name: pr.name, stage: pr.stage, lastTouch: touched });
    }
  }
  const awaitingApproval = file.prospects.filter((x) => x.stage === 'qualified').length;
  writeJsonAtomic(p(ctx.s.dir, 'pipeline', 'summary.json'), {
    at: ctx.now.toISOString(),
    total: file.prospects.length,
    byStage,
    due,
    stale,
    awaitingApproval,
    problems,
  });
  return { outcome: problems.length ? 'failed' : 'succeeded', note: `${file.prospects.length} prospects; ${due.length} actions due; ${stale.length} stale${problems.length ? `; ${problems.join('; ')}` : ''}` };
}
