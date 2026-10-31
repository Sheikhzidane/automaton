/**
 * Mission event log (append-only).
 *
 * Every mission-relevant action — task changes, approval requests and
 * decisions, checkpoints, lessons, milestones, reviews — is recorded here so
 * a fresh session can reconstruct what happened and why.
 */

import type BetterSqlite3 from "better-sqlite3";
import { ulid } from "ulid";

type Database = BetterSqlite3.Database;

export type MissionEventType =
  | "task_added"
  | "task_updated"
  | "approval_requested"
  | "approval_decided"
  | "approval_consumed"
  | "ledger_entry"
  | "capital_granted"
  | "checkpoint"
  | "lesson"
  | "milestone"
  | "opportunity"
  | "review"
  | "reassess"
  | "budget_exhausted";

export type MissionActor = "agent" | "human" | "system";

export interface MissionEventRow {
  id: string;
  eventType: MissionEventType;
  actor: MissionActor;
  summary: string;
  data: Record<string, unknown> | null;
  createdAt: string;
}

export function recordMissionEvent(
  db: Database,
  eventType: MissionEventType,
  actor: MissionActor,
  summary: string,
  data?: Record<string, unknown>,
  createdAt: string = new Date().toISOString(),
): MissionEventRow {
  const row: MissionEventRow = {
    id: ulid(),
    eventType,
    actor,
    summary: summary.slice(0, 2000),
    data: data ?? null,
    createdAt,
  };
  db.prepare(
    `INSERT INTO mission_events (id, event_type, actor, summary, data, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.eventType,
    row.actor,
    row.summary,
    row.data ? JSON.stringify(row.data) : null,
    row.createdAt,
  );
  return row;
}

export function listMissionEvents(
  db: Database,
  options: { types?: MissionEventType[]; since?: string; limit?: number } = {},
): MissionEventRow[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (options.types && options.types.length > 0) {
    clauses.push(`event_type IN (${options.types.map(() => "?").join(",")})`);
    params.push(...options.types);
  }
  if (options.since) {
    clauses.push("created_at >= ?");
    params.push(options.since);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const limit = Math.max(1, Math.min(options.limit ?? 50, 500));
  const rows = db
    .prepare(
      `SELECT * FROM mission_events ${where} ORDER BY created_at DESC, id DESC LIMIT ${limit}`,
    )
    .all(...params) as any[];
  return rows.map((r) => ({
    id: r.id,
    eventType: r.event_type,
    actor: r.actor,
    summary: r.summary,
    data: r.data ? safeParse(r.data) : null,
    createdAt: r.created_at,
  }));
}

/** True if an event of this type with this dedup key was recorded since `since`. */
export function hasMissionEventSince(
  db: Database,
  eventType: MissionEventType,
  dedupKey: string,
  since: string,
): boolean {
  const row = db
    .prepare(
      `SELECT 1 FROM mission_events
       WHERE event_type = ? AND created_at >= ? AND json_extract(data, '$.dedupKey') = ?
       LIMIT 1`,
    )
    .get(eventType, since, dedupKey);
  return row !== undefined;
}

function safeParse(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}
