# Growth operations engine

A small, dependency-free runner that does the routine, deterministic work of
the commercial mission on a schedule, with no model calls and no spending:

| Task | Every | What it does |
|---|---|---|
| `ops.self_check` | cycle | Verifies the ledger hash chain, compute allowance and state |
| `opslog.public_health` | 3 h | Fetches the public OpsLog pages and `/api/health`; alerts if home or login fail |
| `opslog.ops_metrics` | day | Reads OpsLog's counts-only metrics with a read-only token |
| `market.fsa_refresh` | week | Downloads FSA open data for Edinburgh, East Lothian, Midlothian and West Lothian; records changes; scores candidates, never anyone marked do_not_contact or won |
| `pipeline.review` | day | Counts prospects by stage; lists follow-ups due and stale prospects |
| `revenue.review` | day | Recomputes mission net from the ledger (only genuine, evidenced revenue counts) |
| `work.review` | day | Open, blocked and overdue internal work |
| `ops.daily_report` | day | Writes `reports/<date>.md` from recorded state |

It never contacts a prospect, publishes anything, changes OpsLog, or spends
money. The scheduled runner refuses any task with a cost, approved or not:
the ledger is written by people only, so a cost is recorded by hand first.
There are no such tasks today.

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

## Who writes what

People edit the same branch the scheduled run commits to, so the engine only
ever writes the paths it owns (`ENGINE_OWNED` in `lib/state.mjs`): the queue,
budget, alerts, `state/engine.json`, the run logs, `status.json`, the
`health/ metrics/ market/ reports/` folders and the three `summary.json`
files. `config.json`, `state/control.json` (the kill switch),
`state/approvals.json`, `state/memory.json`, the ledger, the pipeline and the
backlog belong to people; a cycle reads them and never rewrites them. The
workflow's save step copies only engine-owned paths back.

## Guarantees

- **Idempotent.** A task that succeeded in its current slot does not run again.
- **Slot-anchored.** The next run is the start of the next slot (3-hourly,
  daily at 00:00 UTC, weekly), so a late GitHub start never skips a check.
- **Crash recovery.** A task left `running` by a dead cycle counts as a failed
  attempt under the same retry limit; state is written after every task. Each
  cycle charges its minimum billed minutes when it starts, so one that dies is
  still counted. On a laptop a stale lock is replaced and its time charged; in
  GitHub Actions (fresh checkout, one run at a time) a lock that came with the
  checkout is replaced without a charge, and `state/lock.json` is git-ignored.
- **Alert issues are idempotent.** Each issue carries a hidden marker for its
  alert; a run whose state was not saved finds the open issue and reuses it
  instead of opening another.
- **Objections are honoured.** A prospect marked `do_not_contact` (or `won`)
  in `pipeline/prospects.json` is never profiled again: matched by FSA id
  (`fhrsIds`) and by normalised business name. Keep the record, with its
  stage, as the suppression entry; deleting it would let the business back in.
- **Secrets.** Header values with line breaks are refused, error text never
  quotes a header, credentialed requests are never redirected to another host,
  and known secret values are removed from every stored note, log and issue.
- **Retries.** Exponential backoff from 15 minutes, `maxAttempts` per task, then
  an alert. Blocked tasks (missing credential) are not failures.
- **Budget.** Money: the scheduled runner never runs a costed task. The
  approval rules (single use, within remaining capital; an unreadable ledger
  means no capital) still apply to a hand-run task. Compute: what GitHub
  bills, each job rounded up to the minute (cycle job plus setup, plus one
  minute for the save job), against a monthly cap (default 900 minutes); past
  it only priority-1 tasks run. The cap limits work, not runs: the schedule
  itself costs at least 2 billed minutes a run, 8 runs a day, so about 500
  minutes a month before any work (GitHub Free includes 2,000 private-repo
  minutes a month).
- **Ledger.** Hash-chained, with the last verified head kept in
  `state/engine.json`, so an edited, removed or truncated line is detected.
  Settled revenue needs a payment reference (`pi_`, `ch_`, `py_`, `po_`,
  `tr_`, `txn_` or `bank:` with no spaces), never an invoice number, and the
  same reference cannot be counted twice. A line can never be erased, so it
  holds nothing about a person: counterparties are pseudonyms (`CUST-001`),
  categories are short codes, descriptions are at most 120 characters and
  must not name anyone. Keep the pseudonym-to-customer list outside the
  ledger; deleting an entry there is how a customer's data is erased.
- **Retention.** The weekly FSA snapshot kept for comparison holds ids and
  ratings only. Candidate lists (business names and addresses from the FSA's
  open data) are rewritten each week, but git keeps old versions: every three
  months, or on request, replace the branch history with one commit of its
  current files (see GROWTH_OPS.md in OpsLog).
- **Alerts.** New problems open an issue in the private repository (emails the
  owner) and close it when they clear. A failed task also fails the workflow run.
- **Kill switch.** `node ops/run.mjs pause --state DIR --reason "..."`.

## Commands

```bash
node ops/run.mjs verify-controls          # 26 checks, no network
node ops/run.mjs init   --state DIR
node ops/run.mjs cycle  --state DIR [--only TASK_ID]
node ops/run.mjs status --state DIR
node ops/run.mjs pause  --state DIR --reason "why" ; node ops/run.mjs resume --state DIR
node ops/run.mjs ledger add --state DIR --type revenue --amount-pence 60000 \
    --settled --evidence pi_... --counterparty CUST-001 --category licence
node ops/run.mjs ledger verify --state DIR
```

Tests: `npx vitest run src/__tests__/ops`.
