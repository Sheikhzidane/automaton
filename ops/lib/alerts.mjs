// Operational alerts. An alert opens once per problem (by key), stays
// open while the problem lasts and closes when it clears. When the
// runner has a GitHub token, each new alert becomes an issue in the
// private repository (which emails the owner) and is closed with a
// comment when it clears.

export function emptyAlerts() {
  return { open: {}, closed: [] };
}

export function raise(alerts, key, title, detail, now) {
  const at = now.toISOString();
  const existing = alerts.open[key];
  if (existing) {
    existing.lastSeen = at;
    existing.count += 1;
    existing.detail = detail;
    return false;
  }
  alerts.open[key] = { key, title, detail, since: at, lastSeen: at, count: 1, issueNumber: null };
  return true;
}

export function resolve(alerts, key, now) {
  const existing = alerts.open[key];
  if (!existing) return false;
  delete alerts.open[key];
  alerts.closed = [...alerts.closed, { ...existing, resolvedAt: now.toISOString(), pendingClose: Boolean(existing.issueNumber) }].slice(-50);
  return true;
}

// The marker that ties an issue to its alert. Issues are reconciled with
// the alerts on every run, so a run whose state was not saved neither
// opens a duplicate nor leaves an issue open after the problem clears.
export function issueMarker(key) {
  return `<!-- growth-ops-alert:${String(key).replace(/[^A-Za-z0-9:._-]/g, '')} -->`;
}

const MARKER = /<!-- growth-ops-alert:([A-Za-z0-9:._-]+) -->/;
const MAX_PAGES = 10;

// Open issues (never pull requests) that carry an alert marker, and, in
// GitHub Actions, that the workflow's own bot opened. Null if the list
// could not be read in full, so nothing is opened or closed on a guess.
async function listAlertIssues({ http, repo, headers, author, log }) {
  const found = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    let res;
    try {
      res = await http(`https://api.github.com/repos/${repo}/issues?state=open&per_page=100&page=${page}`, { headers });
    } catch (err) {
      log?.('warn', 'could not list open issues', { error: err.message });
      return null;
    }
    if (res.status !== 200) {
      log?.('warn', 'could not list open issues', { status: res.status });
      return null;
    }
    const items = JSON.parse(res.text);
    if (!Array.isArray(items)) return null;
    for (const i of items) {
      if (!i || i.pull_request) continue;
      if (author && i.user?.login !== author) continue;
      const m = typeof i.body === 'string' ? MARKER.exec(i.body) : null;
      if (m) found.push({ number: i.number, key: m[1] });
    }
    if (items.length < 100) return found;
  }
  log?.('warn', 'more than 1,000 open issues; alert issues not reconciled this run');
  return null;
}

export async function syncIssues(alerts, { http, token, repo, label = 'growth-ops-alert', author = null, now = new Date(), log }) {
  if (!token || !repo) return { synced: 0, skipped: 'no GitHub token in this environment' };
  const headers = {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'content-type': 'application/json',
    'x-github-api-version': '2022-11-28',
  };
  const open = await listAlertIssues({ http, repo, headers, author, log });
  if (!open) return { synced: 0, skipped: 'open issues could not be listed; will try next run' };

  // The oldest open issue per alert is the one in use; any others are duplicates.
  const byKey = new Map();
  const duplicates = [];
  for (const i of [...open].sort((a, b) => a.number - b.number)) {
    if (byKey.has(i.key)) duplicates.push(i);
    else byKey.set(i.key, i);
  }

  let synced = 0;
  const close = async (number, comment) => {
    try {
      await http(`https://api.github.com/repos/${repo}/issues/${number}/comments`, { method: 'POST', headers, body: JSON.stringify({ body: comment }) });
      const res = await http(`https://api.github.com/repos/${repo}/issues/${number}`, { method: 'PATCH', headers, body: JSON.stringify({ state: 'closed' }) });
      if (res.status === 200) {
        synced += 1;
        return true;
      }
    } catch (err) {
      log?.('warn', 'alert issue not closed', { error: err.message });
    }
    return false;
  };

  // Every open alert has exactly one open issue.
  for (const a of Object.values(alerts.open)) {
    const existing = byKey.get(a.key);
    if (existing) {
      a.issueNumber = existing.number;
      continue;
    }
    try {
      const res = await http(`https://api.github.com/repos/${repo}/issues`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          title: `[growth-ops] ${a.title}`,
          body: `${a.detail}\n\nOpened by the scheduled growth-ops run at ${a.since}. It closes itself when the problem clears.\n\n${issueMarker(a.key)}`,
          labels: [label],
        }),
      });
      if (res.status === 201) {
        a.issueNumber = JSON.parse(res.text).number;
        synced += 1;
      } else {
        a.issueNumber = null;
        log?.('warn', 'alert issue not created', { status: res.status });
      }
    } catch (err) {
      a.issueNumber = null;
      log?.('warn', 'alert issue not created', { error: err.message });
    }
  }

  // Issues whose problem has cleared, including ones opened by a run whose
  // state was never saved, and duplicates.
  const at = now.toISOString();
  for (const [key, issue] of byKey) {
    if (!alerts.open[key]) await close(issue.number, `Cleared at ${at}.`);
  }
  for (const d of duplicates) await close(d.number, `Duplicate of #${byKey.get(d.key).number}; closed at ${at}.`);
  for (const c of alerts.closed) c.pendingClose = false;
  return { synced };
}
