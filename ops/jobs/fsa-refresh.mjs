// Weekly: downloads the FSA open data for each configured local
// authority, keeps the hospitality businesses, records what changed
// since last week and recomputes prospect candidates.

import { appendJsonl, readJson, writeJsonAtomic, p } from '../lib/util.mjs';
import { parseFhrsXml, buildCandidates, diffEstablishments, DEFAULT_CHAINS } from '../lib/fhrs.mjs';

export async function run(ctx) {
  const m = ctx.s.config.market;
  const keepTypes = new Set(m.businessTypeIds);
  const all = [];
  const perAuthority = [];
  for (const a of m.authorities) {
    const url = `https://ratings.food.gov.uk/api/open-data-files/FHRS${a.id}en-GB.xml`;
    const res = await ctx.http(url, { maxBytes: 40_000_000, accept: 'application/xml' });
    if (!res.ok) return { outcome: 'failed', note: `${a.name}: HTTP ${res.status}` };
    const parsed = parseFhrsXml(res.text);
    if (parsed.establishments.length === 0) return { outcome: 'failed', note: `${a.name}: no establishments parsed` };
    const kept = parsed.establishments.filter((e) => keepTypes.has(e.typeId));
    perAuthority.push({ id: a.id, name: a.name, extractDate: parsed.extractDate, total: parsed.establishments.length, hospitality: kept.length });
    all.push(...kept);
  }
  all.sort((x, y) => x.id - y.id);

  const estPath = p(ctx.s.dir, 'market', 'establishments.json');
  const prev = readJson(estPath, { establishments: [] });
  const firstSeenPath = p(ctx.s.dir, 'market', 'first-seen.json');
  const firstSeen = readJson(firstSeenPath, {});
  const isFirstRun = prev.establishments.length === 0;
  const diff = diffEstablishments(prev.establishments, all);
  for (const e of all) if (!firstSeen[e.id]) firstSeen[e.id] = isFirstRun ? (e.ratingDate ?? '1970-01-01') : ctx.now.toISOString().slice(0, 10);

  const byRating = {};
  const byType = {};
  for (const e of all) {
    byRating[e.rating ?? 'none'] = (byRating[e.rating ?? 'none'] ?? 0) + 1;
    byType[e.type] = (byType[e.type] ?? 0) + 1;
  }
  const candidates = buildCandidates(all, {
    now: ctx.now,
    newWithinDays: m.newWithinDays,
    chains: [...DEFAULT_CHAINS, ...m.chainExclusions],
    existingCustomers: m.existingCustomers,
    keep: m.keepCandidates,
    firstSeen: isFirstRun ? {} : firstSeen,
  });

  writeJsonAtomic(estPath, { at: ctx.now.toISOString(), authorities: perAuthority, establishments: all });
  writeJsonAtomic(firstSeenPath, firstSeen);
  writeJsonAtomic(p(ctx.s.dir, 'market', 'candidates.json'), { at: ctx.now.toISOString(), source: 'FSA open data, Open Government Licence v3.0', candidates });
  writeJsonAtomic(p(ctx.s.dir, 'market', 'summary.json'), {
    at: ctx.now.toISOString(),
    authorities: perAuthority,
    hospitality: all.length,
    byRating,
    byType,
    candidates: candidates.length,
    changesSinceLast: isFirstRun ? null : { added: diff.added.length, removed: diff.removed.length, ratingChanged: diff.ratingChanged.length },
  });
  if (!isFirstRun) appendJsonl(p(ctx.s.dir, 'market', 'changes.jsonl'), { at: ctx.now.toISOString(), ...diff });
  return {
    outcome: 'succeeded',
    note: `${all.length} hospitality businesses across ${perAuthority.length} authorities; ${candidates.length} candidates${isFirstRun ? ' (first snapshot)' : `; ${diff.added.length} new, ${diff.ratingChanged.length} rating changes`}`,
  };
}
