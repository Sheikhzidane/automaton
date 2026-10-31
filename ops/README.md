# Growth operations engine

A small, dependency-free runner that does the routine, deterministic work of
the commercial mission on a schedule, with no model calls and no spending:

| Task | Every | What it does |
|---|---|---|
| `ops.self_check` | cycle | Verifies the ledger hash chain, compute allowance and state |
| `opslog.public_health` | 3 h | Fetches the public OpsLog pages and `/api/health`; alerts if home or login fail |
| `opslog.ops_metrics` | day | Reads OpsLog's counts-only metrics with a read-only token |
| `market.fsa_refresh` | week | Downloads FSA open data for Edinburgh and the Lothians; records changes; scores candidates |
| `pipeline.review` | day | Counts prospects by stage; lists follow-ups due and stale prospects |
| `revenue.review` | day | Recomputes mission net from the ledger (only genuine, evidenced revenue counts) |
| `work.review` | day | Open, blocked and overdue internal work |
| `ops.daily_report` | day | Writes `reports/<date>.md` from recorded state |

It never contacts a prospect, publishes anything, changes OpsLog, or spends
money. Anything with a cost needs a recorded approval and must fit in the
capital left; there are no such tasks today.

## Where it runs

The scheduler lives in the **private** OpsLog repository
(`.github/workflows/growth-ops.yml`) and checks out this engine at a pinned
commit. State lives on that repository's `growth-ops` branch, so leads,
pipeline and revenue never enter this public repository. Each run commits its
state, which is also the audit trail.

## State layout (`--state DIR`)

```
config.json            schedule, hosts allowed, authorities, exclusions
status.json            dashboard feed, rewritten every cycle
state/queue.json       tasks: priority, status, permissions, cost, completion
                       criteria, last/next run, attempts, history
state/control.json     kill switch: {"paused": true, "reason": "..."}
state/budget.json      compute minutes used this month and the cap
state/alerts.json      open and recently closed alerts
state/approvals.json   approvals for any task that would cost money
state/memory.json      next action, strategy, cycle count
state/runs.jsonl       one line per task run (append-only log)
state/cycles.jsonl     one line per cycle
ledger/ledger.jsonl    hash-chained money records
pipeline/prospects.json, work/backlog.json   maintained by people (or Claude)
health/ metrics/ market/ reports/            written by tasks
```

## Guarantees

- **Idempotent.** A task that succeeded in its current slot does not run again.
- **Crash recovery.** A task left `running` by a dead cycle is retried; a stale
  lock is replaced; state is written after every task.
- **Retries.** Exponential backoff from 15 minutes, `maxAttempts` per task, then
  an alert. Blocked tasks (missing credential) are not failures.
- **Budget.** Money: approval plus remaining capital. Compute: monthly cap
  (default 900 minutes); past it only priority-1 tasks run.
- **Alerts.** New problems open an issue in the private repository (emails the
  owner) and close it when they clear. A failed task also fails the workflow run.
- **Kill switch.** `node ops/run.mjs pause --state DIR --reason "..."`.

## Commands

```bash
node ops/run.mjs verify-controls          # 15 checks, no network
node ops/run.mjs init   --state DIR
node ops/run.mjs cycle  --state DIR [--only TASK_ID]
node ops/run.mjs status --state DIR
node ops/run.mjs pause  --state DIR --reason "why" ; node ops/run.mjs resume --state DIR
node ops/run.mjs ledger add --state DIR --type revenue --amount-pence 60000 \
    --evidence pi_... --counterparty CUST-001 --category licence
node ops/run.mjs ledger verify --state DIR
```

Tests: `npx vitest run src/__tests__/ops`.
