// Outbound HTTP for scheduled jobs. HTTPS only, to hosts named in the
// config, with a timeout and a size cap. Redirects are followed by hand
// so a redirect can never take a request to a host that is not allowed,
// and a request carrying credentials is never sent on to another origin.
// Error messages are fixed text: fetch's own messages can quote header
// values, and a header value can be a secret.

const CREDENTIAL_HEADERS = ['authorization', 'cookie', 'proxy-authorization'];

export function hostAllowed(url, allowHosts) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:') return false;
  if (u.username || u.password) return false;
  return allowHosts.includes(u.hostname.toLowerCase());
}

function hasCredentials(headers) {
  return Object.keys(headers).some((k) => CREDENTIAL_HEADERS.includes(k.toLowerCase()));
}

export function makeHttp({ allowHosts, timeoutMs = 25000, fetchImpl = globalThis.fetch, userAgent = 'opslog-growth-ops/1 (+https://opslog.co.uk)' }) {
  return async function request(url, { method = 'GET', headers = {}, body, maxBytes = 2_000_000, accept, signal, timeoutMs: perRequestMs } = {}) {
    // A large download (the FSA files) may take longer than the default.
    const limitMs = perRequestMs ?? timeoutMs;
    for (const [k, v] of Object.entries(headers)) {
      if (/[\r\n\0]/.test(String(v))) throw new Error(`Refused: the ${k} header contains a line break or control character (check the secret's value)`);
    }
    let current = url;
    let currentMethod = method;
    let currentBody = body;
    let currentHeaders = { ...headers };
    for (let hop = 0; hop < 4; hop++) {
      if (!hostAllowed(current, allowHosts)) {
        throw new Error(`Refused: ${new URL(current).hostname} is not an allowed host`);
      }
      const timeout = AbortSignal.timeout(limitMs);
      const combined = signal ? AbortSignal.any([timeout, signal]) : timeout;
      const started = Date.now();
      let res;
      try {
        res = await fetchImpl(current, {
          method: currentMethod,
          headers: { 'user-agent': userAgent, ...(accept ? { accept } : {}), ...currentHeaders },
          body: currentBody,
          redirect: 'manual',
          signal: combined,
        });
      } catch (err) {
        if (signal?.aborted) throw new Error('Cancelled: the job ran out of time');
        if (timeout.aborted) throw new Error(`Timed out after ${limitMs} ms`);
        throw new Error(`Network error (${err?.cause?.code ?? err?.name ?? 'unknown'})`);
      }
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        const next = new URL(res.headers.get('location'), current);
        if (next.origin !== new URL(current).origin) {
          if (hasCredentials(currentHeaders)) throw new Error('Refused: a request carrying credentials was redirected to another host');
        }
        if ([301, 302, 303].includes(res.status) && currentMethod !== 'GET' && currentMethod !== 'HEAD') {
          currentMethod = 'GET';
          currentBody = undefined;
        }
        current = next.toString();
        continue;
      }
      let text = '';
      let bytes = 0;
      try {
        if (res.body && typeof res.body.getReader === 'function') {
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            bytes += value.byteLength;
            if (bytes > maxBytes) {
              await reader.cancel();
              throw new Error(`Response larger than ${maxBytes} bytes`);
            }
            text += decoder.decode(value, { stream: true });
          }
          text += decoder.decode();
        } else {
          text = await res.text();
          bytes = Buffer.byteLength(text);
          if (bytes > maxBytes) throw new Error(`Response larger than ${maxBytes} bytes`);
        }
      } catch (err) {
        if (/larger than/.test(err?.message ?? '')) throw err;
        if (signal?.aborted) throw new Error('Cancelled: the job ran out of time');
        if (timeout.aborted) throw new Error(`Timed out after ${limitMs} ms`);
        throw new Error(`Network error while reading (${err?.cause?.code ?? err?.name ?? 'unknown'})`);
      }
      return {
        status: res.status,
        ok: res.status >= 200 && res.status < 300,
        url: current,
        ms: Date.now() - started,
        bytes,
        text,
        header: (name) => res.headers.get(name),
      };
    }
    throw new Error('Too many redirects');
  };
}

// Removes every known secret value from text before it is stored,
// logged or put in an issue. Covers a secret split across lines.
export function redactor(env, names = ['OPS_METRICS_TOKEN', 'GITHUB_TOKEN']) {
  const parts = [];
  for (const n of names) {
    const v = env?.[n];
    if (typeof v !== 'string' || v.trim().length < 8) continue;
    parts.push(v.trim());
    for (const piece of v.split(/\s+/)) if (piece.length >= 8) parts.push(piece);
  }
  parts.sort((a, b) => b.length - a.length);
  return (text) => {
    if (text === null || text === undefined) return text;
    let out = String(text);
    for (const p of parts) out = out.split(p).join('[redacted]');
    return out;
  };
}
