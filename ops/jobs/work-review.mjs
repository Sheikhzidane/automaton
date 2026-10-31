import { readJson, writeJsonAtomic, p } from '../lib/util.mjs';

export async function run(ctx) {
  const file = readJson(p(ctx.s.dir, 'work', 'backlog.json'), { items: [] });
  const today = ctx.now.toISOString().slice(0, 10);
  const open = file.items.filter((i) => !['done', 'dropped'].includes(i.status));
  const blocked = open.filter((i) => i.status === 'blocked').map((i) => ({ id: i.id, title: i.title, blockedBy: i.blockedBy ?? null, owner: i.owner ?? null }));
  const overdue = open.filter((i) => i.due && i.due < today).map((i) => ({ id: i.id, title: i.title, due: i.due }));
  const byArea = {};
  for (const i of open) byArea[i.area ?? 'other'] = (byArea[i.area ?? 'other'] ?? 0) + 1;
  writeJsonAtomic(p(ctx.s.dir, 'work', 'summary.json'), {
    at: ctx.now.toISOString(),
    open: open.length,
    done: file.items.filter((i) => i.status === 'done').length,
    blocked,
    overdue,
    byArea,
    needsOwner: open.filter((i) => i.owner === 'owner').map((i) => ({ id: i.id, title: i.title })),
  });
  return { outcome: 'succeeded', note: `${open.length} open, ${blocked.length} blocked, ${overdue.length} overdue` };
}
