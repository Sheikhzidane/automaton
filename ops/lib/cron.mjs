// A minimal five-field cron evaluator (UTC), enough to tell the
// dashboard when the next scheduled run is due. Supports *, n, a-b,
// lists and steps. Day-of-month and day-of-week follow the usual rule:
// if both are restricted, either may match.

const RANGES = [
  [0, 59], // minute
  [0, 23], // hour
  [1, 31], // day of month
  [1, 12], // month
  [0, 6], // day of week
];

function parseField(field, [lo, hi], index) {
  const values = new Set();
  for (const part of field.split(',')) {
    const [rangePart, stepPart] = part.split('/');
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step < 1) throw new Error(`Bad cron step "${part}"`);
    let start;
    let end;
    if (rangePart === '*') {
      start = lo;
      end = hi;
    } else if (rangePart.includes('-')) {
      [start, end] = rangePart.split('-').map(Number);
    } else {
      start = Number(rangePart);
      end = stepPart === undefined ? start : hi;
    }
    if (index === 4) {
      if (start === 7) start = 0;
      if (end === 7) end = 6;
    }
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < lo || end > hi || start > end) {
      throw new Error(`Bad cron field "${field}"`);
    }
    for (let v = start; v <= end; v += step) values.add(v);
  }
  return values;
}

export function parseCron(expr) {
  const fields = String(expr).trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`Cron needs five fields: "${expr}"`);
  const sets = fields.map((f, i) => parseField(f, RANGES[i], i));
  return { sets, domRestricted: fields[2] !== '*', dowRestricted: fields[4] !== '*' };
}

function dayMatches(c, d) {
  const dom = c.sets[2].has(d.getUTCDate());
  const dow = c.sets[4].has(d.getUTCDay());
  if (c.domRestricted && c.dowRestricted) return dom || dow;
  if (c.domRestricted) return dom;
  if (c.dowRestricted) return dow;
  return true;
}

// The first matching minute strictly after `after`.
export function nextCronTime(expr, after) {
  const c = typeof expr === 'string' ? parseCron(expr) : expr;
  const d = new Date(after);
  d.setUTCSeconds(0, 0);
  d.setUTCMinutes(d.getUTCMinutes() + 1);
  const limit = after.valueOf() + 400 * 24 * 60 * 60 * 1000;
  while (d.valueOf() < limit) {
    if (!c.sets[3].has(d.getUTCMonth() + 1)) {
      d.setUTCMonth(d.getUTCMonth() + 1, 1);
      d.setUTCHours(0, 0, 0, 0);
      continue;
    }
    if (!dayMatches(c, d)) {
      d.setUTCDate(d.getUTCDate() + 1);
      d.setUTCHours(0, 0, 0, 0);
      continue;
    }
    if (!c.sets[1].has(d.getUTCHours())) {
      d.setUTCHours(d.getUTCHours() + 1, 0, 0, 0);
      continue;
    }
    if (!c.sets[0].has(d.getUTCMinutes())) {
      d.setUTCMinutes(d.getUTCMinutes() + 1, 0, 0);
      continue;
    }
    return new Date(d);
  }
  throw new Error(`No time matches "${expr}" within a year`);
}
