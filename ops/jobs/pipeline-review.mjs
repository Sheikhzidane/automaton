// Reviews the prospect pipeline. Reads only; never contacts anyone.
// The summary it writes leaves the private state in the cycle's artifact
// and is committed daily, so it holds ids, stages and dates only: never a
// name or the free-text next action, which can hold contact details.

import { readJson, writeJsonAtomic, p } from '../lib/util.mjs';

// The acquisition pipeline, in order: discovery, qualification, outreach,
// response, demo, proposal, customer (signed), payment, onboarding.
export const STAGES = ['researched', 'qualified', 'approved_to_contact', 'contacted', 'replied', 'demo_booked', 'proposal_sent', 'won', 'paid', 'onboarded', 'lost', 'do_not_contact'];
// Signed customers: never profiled again as prospects.
export const CUSTOMER_STAGES = ['won', 'paid', 'onboarded'];
// No follow-up is ever due for these.
const CLOSED = ['lost', 'do_not_contact'];
// Waiting on the prospect or on OpsLog; flagged when untouched too long.
const IN_FLIGHT = ['contacted', 'replied', 'demo_booked', 'proposal_sent', 'won', 'paid'];

export async function run(ctx) {
  const file = readJson(p(ctx.s.dir, 'pipeline', 'prospects.json'), { prospects: [] });
  const today = ctx.now.toISOString().slice(0, 10);
  const staleMs = (ctx.s.config.pipeline?.staleAfterDays ?? 14) * 86400000;
  const byStage = Object.fromEntries(STAGES.map((s) => [s, 0]));
  const due = [];
  const stale = [];
  const problems = [];
  for (const pr of file.prospects) {
    if (!STAGES.includes(pr.stage)) problems.push(`${pr.id}: unknown stage`);
    else byStage[pr.stage] += 1;
    if (pr.nextActionDue && pr.nextActionDue <= today && !CLOSED.includes(pr.stage)) {
      due.push({ id: pr.id, stage: pr.stage, due: pr.nextActionDue });
    }
    const touched = pr.lastTouch ?? pr.addedAt;
    if (touched && IN_FLIGHT.includes(pr.stage) && ctx.now.valueOf() - new Date(touched).valueOf() > staleMs) {
      stale.push({ id: pr.id, stage: pr.stage, lastTouch: touched });
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
