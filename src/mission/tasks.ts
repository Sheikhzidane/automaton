/**
 * Mission task queue and checkpoints.
 *
 * Tasks follow the operating cycle (research → … → collect → improve).
 * Priority is computed from how close the stage is to cash and how strong
 * the linked opportunity is; lower numbers run first. The checkpoint holds
 * the single next action so a fresh session — or a restart after a crash —
 * resumes exactly where the last one stopped.
 */

import type BetterSqlite3 from "better-sqlite3";
import { ulid } from "ulid";
import {
  MISSION_STAGES,
  type MissionStage,
  type MissionTaskRow,
  type MissionTaskStatus,
} from "./types.js";
import { recordMissionEvent, type MissionActor } from "./events.js";

type Database = BetterSqlite3.Database;

/** 0 = closest to money in the bank. */
const CASH_PROXIMITY: Record<MissionStage, number> = {
  collect: 0,
  convert: 1,
  deliver: 2,
  market: 3,
  validate: 4,
  deploy: 5,
  test: 6,
  measure: 6,
  build: 7,
  improve: 7,
  identify: 8,
  research: 9,
};

export const CHECKPOINT_KEY = "mission.checkpoint";

export function isMissionStage(value: unknown): value is MissionStage {
  return typeof value === "string" && (MISSION_STAGES as readonly string[]).includes(value);
}

export function computeTaskPriority(stage: MissionStage, opportunityScore = 0): number {
  const score = Math.max(0, Math.min(100, opportunityScore));
  const priority = 10 + CASH_PROXIMITY[stage] * 8 - Math.round(score / 20);
  return Math.max(1, Math.min(99, priority));
}

function toRow(r: any): MissionTaskRow {
  return {
    id: r.id,
    title: r.title,
    stage: r.stage,
    status: r.status,
    priority: r.priority,
    nextAction: r.next_action,
    blockedReason: r.blocked_reason,
    opportunityId: r.opportunity_id,
    result: r.result,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    completedAt: r.completed_at,
  };
}

export function getMissionTask(db: Database, idOrSuffix: string): MissionTaskRow | null {
  const exact = db.prepare("SELECT * FROM mission_tasks WHERE id = ?").get(idOrSuffix);
  if (exact) return toRow(exact);
  if (idOrSuffix.length < 6) return null;
  const rows = db
    .prepare("SELECT * FROM mission_tasks WHERE id LIKE ?")
    .all(`%${idOrSuffix.toUpperCase()}`);
  return rows.length === 1 ? toRow(rows[0]) : null;
}

export function addMissionTask(
  db: Database,
  input: {
    title: string;
    stage: MissionStage;
    nextAction?: string;
    opportunityId?: string;
    priority?: number;
  },
  actor: MissionActor = "agent",
): MissionTaskRow {
  const title = input.title?.trim();
  if (!title) throw new Error("A task needs a title");
  if (!isMissionStage(input.stage)) throw new Error(`Unknown stage: ${input.stage}`);

  let opportunityScore = 0;
  if (input.opportunityId) {
    const opp = db
      .prepare("SELECT score FROM mission_opportunities WHERE id = ? OR name = ?")
      .get(input.opportunityId, input.opportunityId) as { score: number } | undefined;
    opportunityScore = opp?.score ?? 0;
  }

  const priority =
    typeof input.priority === "number" && Number.isInteger(input.priority)
      ? Math.max(1, Math.min(99, input.priority))
      : computeTaskPriority(input.stage, opportunityScore);

  const now = new Date().toISOString();
  const id = ulid();
  db.prepare(
    `INSERT INTO mission_tasks
       (id, title, stage, status, priority, next_action, opportunity_id, created_at, updated_at)
     VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?)`,
  ).run(id, title.slice(0, 300), input.stage, priority, input.nextAction ?? null, input.opportunityId ?? null, now, now);

  recordMissionEvent(db, "task_added", actor, title.slice(0, 200), { taskId: id, stage: input.stage, priority });
  return getMissionTask(db, id)!;
}

const OPEN_STATUSES: MissionTaskStatus[] = ["queued", "in_progress", "blocked", "awaiting_approval"];

export function updateMissionTask(
  db: Database,
  idOrSuffix: string,
  patch: {
    status?: MissionTaskStatus;
    nextAction?: string | null;
    blockedReason?: string | null;
    result?: string | null;
  },
  actor: MissionActor = "agent",
): MissionTaskRow {
  const task = getMissionTask(db, idOrSuffix);
  if (!task) throw new Error(`Unknown task ${idOrSuffix}`);
  if (patch.status && ![...OPEN_STATUSES, "done", "dropped"].includes(patch.status)) {
    throw new Error(`Unknown status: ${patch.status}`);
  }
  if ((patch.status === "blocked" || patch.status === "awaiting_approval") && !(patch.blockedReason ?? task.blockedReason)) {
    throw new Error("Say why the task is blocked (blocked_reason)");
  }
  if ((patch.status === "done" || patch.status === "dropped") && !(patch.result ?? task.result)) {
    throw new Error("Record the result or the reason it was dropped (result)");
  }

  const now = new Date().toISOString();
  const status = patch.status ?? task.status;
  const completedAt =
    status === "done" || status === "dropped" ? task.completedAt ?? now : null;
  const blockedReason =
    status === "blocked" || status === "awaiting_approval"
      ? patch.blockedReason ?? task.blockedReason
      : patch.blockedReason === undefined
        ? null
        : patch.blockedReason;

  db.prepare(
    `UPDATE mission_tasks
     SET status = ?, next_action = ?, blocked_reason = ?, result = ?, updated_at = ?, completed_at = ?
     WHERE id = ?`,
  ).run(
    status,
    patch.nextAction === undefined ? task.nextAction : patch.nextAction,
    blockedReason,
    patch.result === undefined ? task.result : patch.result,
    now,
    completedAt,
    task.id,
  );

  recordMissionEvent(db, "task_updated", actor, `${task.title.slice(0, 120)} → ${status}`, {
    taskId: task.id,
    status,
  });
  return getMissionTask(db, task.id)!;
}

export function listMissionTasks(
  db: Database,
  options: { statuses?: MissionTaskStatus[]; limit?: number } = {},
): MissionTaskRow[] {
  const statuses = options.statuses ?? OPEN_STATUSES;
  const limit = Math.max(1, Math.min(options.limit ?? 50, 500));
  const rows = db
    .prepare(
      `SELECT * FROM mission_tasks
       WHERE status IN (${statuses.map(() => "?").join(",")})
       ORDER BY CASE status WHEN 'in_progress' THEN 0 WHEN 'queued' THEN 1
                            WHEN 'awaiting_approval' THEN 2 WHEN 'blocked' THEN 3 ELSE 4 END,
                priority ASC, created_at ASC
       LIMIT ${limit}`,
    )
    .all(...statuses);
  return rows.map(toRow);
}

/** The next task the agent should work on (never a blocked one). */
export function getNextMissionTask(db: Database): MissionTaskRow | null {
  const [next] = listMissionTasks(db, { statuses: ["in_progress", "queued"], limit: 1 });
  return next ?? null;
}

export function countTasksCompletedSince(db: Database, sinceIso: string): MissionTaskRow[] {
  return db
    .prepare(
      `SELECT * FROM mission_tasks WHERE status IN ('done','dropped') AND completed_at >= ?
       ORDER BY completed_at ASC`,
    )
    .all(sinceIso)
    .map(toRow);
}

export interface MissionCheckpoint {
  nextAction: string;
  strategy: string | null;
  note: string | null;
  updatedAt: string;
  actor: MissionActor;
}

export function setCheckpoint(
  db: Database,
  input: { nextAction: string; strategy?: string; note?: string },
  actor: MissionActor = "agent",
): MissionCheckpoint {
  const nextAction = input.nextAction?.trim();
  if (!nextAction) throw new Error("A checkpoint needs the exact next action");
  const previous = getCheckpoint(db);
  const checkpoint: MissionCheckpoint = {
    nextAction: nextAction.slice(0, 1000),
    strategy: input.strategy?.trim().slice(0, 1000) ?? previous?.strategy ?? null,
    note: input.note?.trim().slice(0, 1000) ?? null,
    updatedAt: new Date().toISOString(),
    actor,
  };
  db.prepare(
    "INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, datetime('now'))",
  ).run(CHECKPOINT_KEY, JSON.stringify(checkpoint));
  recordMissionEvent(db, "checkpoint", actor, `Next: ${checkpoint.nextAction.slice(0, 200)}`, {
    nextAction: checkpoint.nextAction,
    strategy: checkpoint.strategy,
  });
  return checkpoint;
}

export function getCheckpoint(db: Database): MissionCheckpoint | null {
  try {
    const row = db.prepare("SELECT value FROM kv WHERE key = ?").get(CHECKPOINT_KEY) as
      | { value: string }
      | undefined;
    return row ? (JSON.parse(row.value) as MissionCheckpoint) : null;
  } catch {
    return null;
  }
}
