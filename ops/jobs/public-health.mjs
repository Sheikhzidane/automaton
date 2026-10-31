// Fetches the public OpsLog pages a customer would see first and checks
// they answer and say what they should. Uses only public URLs.

import { appendJsonl, trimJsonl, writeJsonAtomic, p } from '../lib/util.mjs';

export async function run(ctx) {
  const { baseUrl, pages } = ctx.s.config.opslog;
  const checks = [];
  for (const page of pages) {
    const url = new URL(page.path, baseUrl).toString();
    const check = { path: page.path, required: Boolean(page.required) };
    try {
      const res = await ctx.http(url, { maxBytes: 3_000_000, accept: page.json ? 'application/json' : 'text/html' });
      check.status = res.status;
      check.ms = res.ms;
      check.bytes = res.bytes;
      check.vercelId = res.header('x-vercel-id');
      check.hsts = Boolean(res.header('strict-transport-security'));
      check.ok = res.ok;
      if (res.ok && page.expect && !res.text.includes(page.expect)) {
        check.ok = false;
        check.problem = `expected text not found: "${page.expect}"`;
      }
      if (res.ok && page.json) {
        try {
          const body = JSON.parse(res.text);
          check.body = { ok: body.ok ?? null, region: body.region ?? null, commit: body.commit ?? null, env: body.env ?? null };
        } catch {
          check.ok = false;
          check.problem = 'not JSON';
        }
      }
      if (!res.ok && !page.required && res.status === 404) check.note = 'not deployed yet';
    } catch (err) {
      check.ok = false;
      check.problem = err.message;
    }
    checks.push(check);
  }
  const failedRequired = checks.filter((c) => c.required && !c.ok);
  const health = checks.find((c) => c.path === '/api/health' && c.ok);
  const result = {
    at: ctx.now.toISOString(),
    ok: failedRequired.length === 0,
    region: health?.body?.region ?? null,
    commit: health?.body?.commit ?? null,
    checks,
  };
  writeJsonAtomic(p(ctx.s.dir, 'health', 'latest.json'), result);
  appendJsonl(p(ctx.s.dir, 'health', 'history.jsonl'), { at: result.at, ok: result.ok, ms: checks.map((c) => c.ms ?? null), region: result.region });
  trimJsonl(p(ctx.s.dir, 'health', 'history.jsonl'), 1500);

  if (failedRequired.length) {
    const detail = failedRequired.map((c) => `${c.path}: ${c.problem ?? `HTTP ${c.status}`}`).join('\n');
    ctx.raise('opslog-public-down', 'opslog.co.uk is not answering as expected', detail);
    return { outcome: 'failed', note: detail };
  }
  ctx.resolve('opslog-public-down');
  const slowest = Math.max(...checks.map((c) => c.ms ?? 0));
  return { outcome: 'succeeded', note: `${checks.filter((c) => c.ok).length}/${checks.length} pages ok, slowest ${slowest} ms${result.region ? `, functions in ${result.region}` : ''}` };
}
