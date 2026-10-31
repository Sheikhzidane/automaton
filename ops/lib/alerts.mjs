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

// The marker that ties an issue to its alert, so a run whose state was
// not saved adopts the issue it opened instead of opening another.
export function issueMarker(key) {
  return `<!-- growth-ops-alert:${String(key).replace(/[^A-Za-z0-9:._-]/g, '')} -->`;
}

export async function syncIssues(alerts, { http, token, repo, label = 'growth-ops-alert', log }) {
  if (!token || !repo) return { synced: 0, skipped: 'no GitHub token in this environment' };
  const headers = {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'content-type': 'application/json',
    'x-github-api-version': '2022-11-28',
  };
  let synced = 0;
  const unsynced = Object.values(alerts.open).filter((a) => !a.issueNumber);
  let existing = null;
  if (unsynced.length) {
    try {
      // Not filtered by label: GitHub drops labels silently for a token
      // without push access, so the marker is what identifies an issue.
      const res = await http(`https://api.github.com/repos/${repo}/issues?state=open&per_page=100`, { headers });
      if (res.status === 200) existing = JSON.parse(res.text);
      else log?.('warn', 'could not list open alert issues', { status: res.status });
    } catch (err) {
      log?.('warn', 'could not list open alert issues', { error: err.message });
    }
  }
  for (const a of unsynced) {
    // Without the list we cannot tell whether the issue already exists;
    // wait for the next run rather than risk a duplicate.
    if (!existing) break;
    const found = existing.find((i) => typeof i?.body === 'string' && i.body.includes(issueMarker(a.key)));
    if (found) {
      a.issueNumber = found.number;
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
      } else log?.('warn', 'alert issue not created', { status: res.status });
    } catch (err) {
      log?.('warn', 'alert issue not created', { error: err.message });
    }
  }
  for (const c of alerts.closed) {
    if (!c.pendingClose || !c.issueNumber) continue;
    try {
      await http(`https://api.github.com/repos/${repo}/issues/${c.issueNumber}/comments`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ body: `Cleared at ${c.resolvedAt}.` }),
      });
      const res = await http(`https://api.github.com/repos/${repo}/issues/${c.issueNumber}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ state: 'closed' }),
      });
      if (res.status === 200) {
        c.pendingClose = false;
        synced += 1;
      }
    } catch (err) {
      log?.('warn', 'alert issue not closed', { error: err.message });
    }
  }
  return { synced };
}
