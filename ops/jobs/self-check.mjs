import { readJsonl } from '../lib/util.mjs';
import { verifyChain } from '../lib/ledger.mjs';
import { computeAllowance } from '../lib/budget.mjs';

export async function run(ctx) {
  const problems = [];
  let chain;
  try {
    chain = verifyChain(readJsonl(ctx.s.files.ledger), ctx.s.engine.ledgerHead);
  } catch (err) {
    chain = { ok: false, error: err.message };
  }
  if (!chain.ok) {
    problems.push(`ledger: ${chain.error}`);
    ctx.raise('ledger-damaged', 'Mission ledger failed its integrity check', `${chain.error}. Restore ledger/ledger.jsonl from git history and add corrections as new lines.`);
  } else ctx.resolve('ledger-damaged');

  const c = computeAllowance(ctx.s.budget, ctx.now);
  const usedPct = Math.round((c.secondsUsed / (c.capMinutes * 60)) * 100);
  if (usedPct >= 80) ctx.raise('compute-cap', "Scheduled runs have used most of this month's compute allowance", `${usedPct}% of ${c.capMinutes} minutes used in ${c.month}.`);
  else ctx.resolve('compute-cap');

  for (const t of ctx.s.queue.tasks) {
    if (!t.id || !t.job) problems.push('task without id or job');
  }
  if (problems.length) return { outcome: 'failed', note: problems.join('; ') };
  return { outcome: 'succeeded', note: `ledger ${chain.count} lines verified; compute ${usedPct}% of monthly cap` };
}
