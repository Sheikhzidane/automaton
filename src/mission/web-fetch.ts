/**
 * Safe, read-only web fetch for research without a shell.
 *
 * Mission mode removes the agent's shell, so research needs another path.
 * This fetch is GET-only, refuses private and link-local addresses (SSRF),
 * follows at most three redirects (re-checking each hop), never sends
 * credentials, caps the response size and returns plain text. The result
 * is passed through the existing external-content sanitiser by the tool
 * executor because the tool is named "web_fetch".
 *
 * Residual risk: DNS can change between the check and the request
 * (rebinding). The runtime holds no internal services worth reaching in
 * mission mode, which limits the impact.
 */

import { lookup } from "node:dns/promises";
import net from "node:net";

export const WEB_FETCH_MAX_BYTES = 200_000;
export const WEB_FETCH_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 3;

export class WebFetchBlockedError extends Error {}

export function validateFetchUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new WebFetchBlockedError(`Invalid URL: ${raw}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new WebFetchBlockedError(`Only http and https URLs are allowed (got ${url.protocol})`);
  }
  if (url.username || url.password) {
    throw new WebFetchBlockedError("URLs with embedded credentials are not allowed");
  }
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) {
    throw new WebFetchBlockedError(`Host ${host} is not a public address`);
  }
  if (net.isIP(stripBrackets(host)) && isPrivateAddress(stripBrackets(host))) {
    throw new WebFetchBlockedError(`Address ${host} is not public`);
  }
  return url;
}

function stripBrackets(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

export function isPrivateAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 4) {
    const [a, b] = address.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (family === 6) {
    const lower = address.toLowerCase();
    if (lower === "::" || lower === "::1") return true;
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // unique local
    if (/^fe[89ab]/.test(lower)) return true; // link-local
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    return false;
  }
  return true; // not an IP at all: treat as unsafe
}

async function assertPublicHost(hostname: string): Promise<void> {
  const host = stripBrackets(hostname);
  if (net.isIP(host)) {
    if (isPrivateAddress(host)) throw new WebFetchBlockedError(`Address ${host} is not public`);
    return;
  }
  const records = await lookup(host, { all: true });
  if (records.length === 0) throw new WebFetchBlockedError(`Could not resolve ${host}`);
  for (const r of records) {
    if (isPrivateAddress(r.address)) {
      throw new WebFetchBlockedError(`${host} resolves to a non-public address`);
    }
  }
}

/** Crude HTML → text: drop scripts, styles and tags, collapse whitespace. */
export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n\n")
    .trim();
}

export interface WebFetchResult {
  finalUrl: string;
  status: number;
  contentType: string;
  text: string;
  truncated: boolean;
}

export async function safeWebFetch(
  rawUrl: string,
  options: { maxBytes?: number; timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<WebFetchResult> {
  const maxBytes = options.maxBytes ?? WEB_FETCH_MAX_BYTES;
  const doFetch = options.fetchImpl ?? fetch;
  let url = validateFetchUrl(rawUrl);

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublicHost(url.hostname);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? WEB_FETCH_TIMEOUT_MS);
    let response: Response;
    try {
      response = await doFetch(url, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "User-Agent": "automaton-mission-research/1.0",
          Accept: "text/html,text/plain,application/json,application/xml;q=0.9,*/*;q=0.1",
        },
      });
    } finally {
      clearTimeout(timer);
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new WebFetchBlockedError("Redirect without a location");
      url = validateFetchUrl(new URL(location, url).toString());
      continue;
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!/^(text\/|application\/(json|xml|xhtml\+xml|rss\+xml|atom\+xml))/i.test(contentType)) {
      return { finalUrl: url.toString(), status: response.status, contentType, text: "", truncated: false };
    }

    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    let truncated = false;
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done || !value) break;
        received += value.byteLength;
        if (received > maxBytes) {
          chunks.push(value.slice(0, value.byteLength - (received - maxBytes)));
          truncated = true;
          await reader.cancel();
          break;
        }
        chunks.push(value);
      }
    }
    const body = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf-8");
    const text = /html/i.test(contentType) ? htmlToText(body) : body;
    return { finalUrl: url.toString(), status: response.status, contentType, text, truncated };
  }

  throw new WebFetchBlockedError("Too many redirects");
}
