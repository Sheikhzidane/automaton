// Reads OpsLog's aggregate metrics endpoint with a read-only token.
// The endpoint returns counts and timestamps only. Nothing here can
// change OpsLog, and no customer name, email or record is received.

import { appendJsonl, trimJsonl, writeJsonAtomic, p } from '../lib/util.mjs';

function onlyNumbersAndDates(value, path = 'metrics') {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return null;
  if (typeof value === 'string') {
    // ISO-8601 dates and timestamps, including PostgREST's "+00:00" offsets.
    const isoDate = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
    return isoDate.test(value) || /^[a-z0-9_.:-]{1,40}$/i.test(value) ? null : `${path} holds free text`;
  }
  if (Array.isArray(value)) return `${path} is a list`;
  for (const [k, v] of Object.entries(value)) {
    const bad = onlyNumbersAndDates(v, `${path}.${k}`);
    if (bad) return bad;
  }
  return null;
}

export async function run(ctx) {
  const token = (ctx.env.OPS_METRICS_TOKEN ?? '').trim();
  if (!token) return { outcome: 'blocked', note: 'OPS_METRICS_TOKEN is not set for the runner' };
  const url = new URL('/api/ops/metrics', ctx.s.config.opslog.baseUrl).toString();
  const res = await ctx.http(url, { headers: { authorization: `Bearer ${token}` }, accept: 'application/json', maxBytes: 200_000 });
  if (res.status === 404) return { outcome: 'blocked', note: 'the metrics endpoint is not deployed yet' };
  if (res.status === 503) return { outcome: 'blocked', note: 'the metrics endpoint has no token configured in Vercel' };
  if (res.status === 401) {
    ctx.raise('metrics-token', 'OpsLog refused the metrics token', 'The OPS_METRICS_TOKEN in GitHub does not match the one in Vercel.');
    return { outcome: 'failed', note: 'token rejected (401)' };
  }
  if (!res.ok) return { outcome: 'failed', note: `HTTP ${res.status}` };
  ctx.resolve('metrics-token');
  let body;
  try {
    body = JSON.parse(res.text);
  } catch {
    return { outcome: 'failed', note: 'response is not JSON' };
  }
  const bad = onlyNumbersAndDates(body);
  if (bad) return { outcome: 'failed', note: `refused to store the response: ${bad}` };
  writeJsonAtomic(p(ctx.s.dir, 'metrics', 'latest.json'), { at: ctx.now.toISOString(), ...body });
  appendJsonl(p(ctx.s.dir, 'metrics', 'history.jsonl'), { at: ctx.now.toISOString(), ...body });
  trimJsonl(p(ctx.s.dir, 'metrics', 'history.jsonl'), 400);

  const failed = body?.email?.failed24h ?? 0;
  if (failed > 0) ctx.raise('email-failures', 'OpsLog emails failed in the last 24 hours', `${failed} email(s) failed to send. Check Admin, Settings, System.`);
  else ctx.resolve('email-failures');
  return { outcome: 'succeeded', note: `orgs ${body?.orgs?.active ?? '?'}, checklists completed 7d ${body?.usage?.checklistsCompleted7d ?? '?'}, emails sent 24h ${body?.email?.sent24h ?? '?'}` };
}
