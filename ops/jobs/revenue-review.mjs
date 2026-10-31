import { readJsonl, writeJsonAtomic, p } from '../lib/util.mjs';
import { verifyChain, summarise } from '../lib/ledger.mjs';

export async function run(ctx) {
  const entries = readJsonl(ctx.s.files.ledger);
  const chain = verifyChain(entries);
  if (!chain.ok) return { outcome: 'failed', note: `ledger damaged: ${chain.error}` };
  const summary = summarise(entries, ctx.s.config.mission);
  writeJsonAtomic(p(ctx.s.dir, 'ledger', 'summary.json'), { at: ctx.now.toISOString(), ...summary });
  ctx.ledgerSummary = summary;
  const gbp = (n) => `£${(n / 100).toFixed(2)}`;
  return { outcome: 'succeeded', note: `net ${gbp(summary.netPence)} of ${gbp(summary.targetNetPence)} (${summary.progressPct}%); capital left ${gbp(summary.capitalRemainingPence)}` };
}
