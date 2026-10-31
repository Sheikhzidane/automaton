// Outbound HTTP for scheduled jobs. HTTPS only, to hosts named in the
// config, with a timeout and a size cap. Redirects are followed by hand
// so a redirect can never take a request to a host that is not allowed.

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

export function makeHttp({ allowHosts, timeoutMs = 25000, fetchImpl = globalThis.fetch, userAgent = 'opslog-growth-ops/1 (+https://opslog.co.uk)' }) {
  return async function request(url, { method = 'GET', headers = {}, body, maxBytes = 2_000_000, accept } = {}) {
    let current = url;
    for (let hop = 0; hop < 4; hop++) {
      if (!hostAllowed(current, allowHosts)) {
        throw new Error(`Refused: ${new URL(current).hostname} is not an allowed host`);
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const started = Date.now();
      let res;
      try {
        res = await fetchImpl(current, {
          method,
          headers: { 'user-agent': userAgent, ...(accept ? { accept } : {}), ...headers },
          body,
          redirect: 'manual',
          signal: controller.signal,
        });
      } catch (err) {
        clearTimeout(timer);
        throw new Error(err?.name === 'AbortError' ? `Timed out after ${timeoutMs} ms` : `Network error: ${err?.message ?? err}`);
      }
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        clearTimeout(timer);
        current = new URL(res.headers.get('location'), current).toString();
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
      } finally {
        clearTimeout(timer);
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
