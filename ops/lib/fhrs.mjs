// Parses the Food Standards Agency's open-data XML (Open Government
// Licence) and turns it into prospect signals. Deterministic: the same
// file always gives the same candidates. Signals describe the business
// (several sites, newly opened, latest inspection result); they are not
// evidence that anyone wants to buy anything.

function decode(text) {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function tag(block, name) {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`));
  if (!m) return null;
  const v = decode(m[1].trim());
  return v === '' ? null : v;
}

export function parseFhrsXml(xml) {
  const extract = tag(xml, 'ExtractDate');
  const out = [];
  const re = /<EstablishmentDetail>([\s\S]*?)<\/EstablishmentDetail>/g;
  let m;
  while ((m = re.exec(xml))) {
    const b = m[1];
    const lines = ['AddressLine1', 'AddressLine2', 'AddressLine3', 'AddressLine4'].map((n) => tag(b, n)).filter(Boolean);
    const lat = tag(b, 'Latitude');
    const lon = tag(b, 'Longitude');
    out.push({
      id: Number(tag(b, 'FHRSID')),
      name: tag(b, 'BusinessName') ?? '',
      type: tag(b, 'BusinessType') ?? '',
      typeId: Number(tag(b, 'BusinessTypeID')),
      address: lines.join(', '),
      postcode: tag(b, 'PostCode'),
      rating: tag(b, 'RatingValue'),
      ratingDate: tag(b, 'RatingDate')?.slice(0, 10) ?? null,
      la: tag(b, 'LocalAuthorityName'),
      newRatingPending: /true/i.test(tag(b, 'NewRatingPending') ?? ''),
      lat: lat ? Number(lat) : null,
      lon: lon ? Number(lon) : null,
    });
  }
  return { extractDate: extract, establishments: out.filter((e) => Number.isFinite(e.id)) };
}

const INSTITUTIONAL = /\b(school|nursery|academy|college|university|hospital|care home|nursing home|hospice|church|prison|barracks|council|surgery|playgroup|out of school|breakfast club|day centre|day care|sheltered)\b/i;

export const DEFAULT_CHAINS = [
  'greggs', 'costa', 'starbucks', 'caffe nero', 'pret a manger', 'mcdonalds', 'burger king', 'kfc', 'subway', 'dominos',
  'papa johns', 'pizza hut', 'nandos', 'wagamama', 'pizza express', 'zizzi', 'ask italian', 'prezzo', 'frankie and bennys',
  'wetherspoon', 'j d wetherspoon', 'harvester', 'toby carvery', 'miller and carter', 'five guys', 'tim hortons', 'leon',
  'itsu', 'wasabi', 'tesco', 'sainsburys', 'coop', 'co op', 'aldi', 'lidl', 'marks and spencer', 'm and s', 'boots',
  'morrisons', 'asda', 'spar', 'premier', 'one stop', 'scotmid', 'holiday inn', 'premier inn', 'travelodge', 'ibis',
  'hilton', 'marriott', 'novotel', 'mercure', 'radisson', 'crowne plaza', 'brewdog', 'slug and lettuce', 'all bar one',
  'browns', 'cote', 'gourmet burger kitchen', 'honest burgers', 'bella italia', 'chiquito', 'tgi fridays', 'black sheep coffee',
  'gails', 'joe and the juice', 'paul', 'krispy kreme', 'taco bell', 'wingstop', 'popeyes', 'german doner kebab', 'chopstix',
  'tortilla', 'barburrito', 'boojum', 'mowgli', 'dishoom', 'rosas thai', 'franco manca', 'wildwood', 'the botanist',
  'revolution', 'nicholsons', 'greene king', 'stonegate', 'caffe nero', 'esquires', 'bb s coffee and muffins', 'pizza punks',
  'byron', 'yo sushi', 'sushi kai', 'buffalo grill', 'burger and lobster', 'hard rock cafe', 'hotel chocolat', 'whsmith',
];

export function normaliseName(name) {
  // Café -> cafe, not caf: fold accents before dropping other characters.
  let n = String(name).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  n = n.replace(/\(.*?\)/g, ' ');
  n = n.split(/\s[-–@|]\s|\s+at\s+/)[0];
  n = n.replace(/&/g, ' and ').replace(/['’`]/g, '').replace(/[^a-z0-9]+/g, ' ');
  n = n.replace(/\b(ltd|limited|plc|llp|t a|ta|trading as)\b/g, ' ');
  n = n.replace(/^the\s+/, '');
  return n.replace(/\s+/g, ' ').trim();
}

function isChain(norm, chains) {
  return chains.some((c) => norm === c || norm.startsWith(`${c} `));
}

const TYPE_POINTS = { 1: 2, 7843: 2, 7842: 1, 7844: 0 };

// `exclude` holds businesses that must not be profiled again: anyone who
// asked not to be contacted (an objection to direct marketing, UK GDPR
// Art. 21(3)) and anyone already won. Matched by FHRS id and by name.
export function buildCandidates(establishments, { now, newWithinDays = 120, chains = DEFAULT_CHAINS, existingCustomers = [], keep = 150, firstSeen = {}, exclude = {} }) {
  const cutoff = now.valueOf() - newWithinDays * 86400000;
  const existing = [...existingCustomers, ...(exclude.names ?? [])].map(normaliseName).filter(Boolean);
  const excludedIds = new Set((exclude.ids ?? []).map(Number));
  const excludedKeys = new Set();
  const groups = new Map();
  for (const e of establishments) {
    if (INSTITUTIONAL.test(e.name)) continue;
    const norm = normaliseName(e.name);
    if (!norm || norm.length < 3) continue;
    if (isChain(norm, chains)) continue;
    if (existing.some((x) => norm === x || norm.startsWith(`${x} `))) continue;
    if (excludedIds.has(e.id)) {
      excludedKeys.add(norm); // one excluded site excludes the business
      continue;
    }
    if (!groups.has(norm)) groups.set(norm, []);
    groups.get(norm).push(e);
  }
  const candidates = [];
  for (const [key, sites] of groups) {
    if (excludedKeys.has(key)) continue;
    const postcodes = new Set(sites.map((s) => s.postcode ?? s.address));
    const siteCount = postcodes.size;
    if (siteCount > 10) continue; // a national or large regional operator
    const signals = [];
    let score = Math.max(...sites.map((s) => TYPE_POINTS[s.typeId] ?? 0));
    if (siteCount >= 2) {
      signals.push(`${siteCount} sites`);
      score += 5 + Math.min(siteCount - 2, 4);
    }
    const improvement = sites.filter((s) => /improvement required/i.test(s.rating ?? ''));
    if (improvement.length) {
      signals.push(`latest inspection result "Improvement Required" at ${improvement.length} site(s)`);
      score += 3;
    }
    const isNew = sites.filter(
      (s) => /awaiting inspection/i.test(s.rating ?? '') || (firstSeen[s.id] && new Date(firstSeen[s.id]).valueOf() >= cutoff)
    );
    if (isNew.length) {
      signals.push(`${isNew.length} site(s) awaiting first inspection or newly listed`);
      score += 2;
    }
    if (signals.length === 0) continue; // nothing distinguishes it from 3,000 others
    candidates.push({
      key,
      name: sites[0].name,
      siteCount,
      score,
      signals,
      authorities: [...new Set(sites.map((s) => s.la))],
      sites: sites.map((s) => ({ id: s.id, name: s.name, type: s.type, address: s.address, postcode: s.postcode, rating: s.rating, ratingDate: s.ratingDate })),
    });
  }
  candidates.sort((a, b) => b.score - a.score || b.siteCount - a.siteCount || a.key.localeCompare(b.key));
  return candidates.slice(0, keep);
}

export function diffEstablishments(prev, next) {
  const before = new Map(prev.map((e) => [e.id, e]));
  const after = new Map(next.map((e) => [e.id, e]));
  const added = next.filter((e) => !before.has(e.id)).map((e) => e.id);
  const removed = prev.filter((e) => !after.has(e.id)).map((e) => e.id);
  const ratingChanged = next
    .filter((e) => before.has(e.id) && (before.get(e.id).rating !== e.rating || before.get(e.id).ratingDate !== e.ratingDate))
    .map((e) => ({ id: e.id, from: before.get(e.id).rating, to: e.rating, date: e.ratingDate }));
  return { added, removed, ratingChanged };
}
