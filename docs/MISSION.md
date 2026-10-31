# Commercial mission mode

Mission mode turns the automaton into a supervised business operator with a
fixed lifetime budget in GBP. It is off unless you enable it. Nothing in
this repository is specific to one operator: your strategy, leads,
customers and money live only in the runtime database under `~/.automaton`.

## What it guarantees

| Rule | How it is enforced |
|---|---|
| £20 lifetime capital (configurable) | `mission_capital_grants` + ledger; spends are checked against remaining capital when approved and again when executed |
| No real-money action without your approval | `mission.approval_gate` policy rule on every money, outreach, publishing and self-modification tool; approvals are bound to the exact tool arguments |
| No automatic purchases | Startup top-up, heartbeat top-up, in-loop top-up and the sandbox top-up on failed spawns are all disabled in mission mode |
| Only genuine revenue counts | Settled revenue with an evidence reference, not related-party, attributable to the mission; pending invoices shown separately |
| Records cannot be edited | `mission_ledger`, `mission_capital_grants` and `mission_events` are append-only (database triggers); corrections supersede |
| The agent cannot approve or record money | No agent tool exists for it; the CLI requires an interactive terminal and a typed code; the policy engine blocks shell commands mentioning `--mission` or `state.db` |
| No replication | `security.replicationEnabled` defaults to false and is checked in the policy engine, the tool and the orchestrator |
| No shell for the agent | Mission mode removes the agent's shell unless `mission.allowShell` is set; outside missions the host shell is off unless `security.allowHostExec` is set |
| State survives restarts | Tasks, checkpoint, opportunities, approvals and the ledger are in SQLite; the system prompt restores them on every turn |

## Configure

Add to `~/.automaton/automaton.json`:

```json
{
  "mission": {
    "enabled": true,
    "name": "£20 to £2,000",
    "objective": "Earn genuine net revenue from real customers through legitimate products or services.",
    "startingCapitalPence": 2000,
    "targetNetPence": 200000,
    "computeFunding": "byok",
    "fx": { "usdToGbp": 0.8, "feeBufferPct": 3 },
    "reviewCron": "0 7 * * *"
  },
  "openaiApiKey": "set this from your provider dashboard, never commit it"
}
```

`computeFunding`:

- `byok` — your own provider key with a **prepaid balance and auto-recharge off**. The provider then enforces a hard cap independently of this code. Recommended.
- `conway` — Conway credits bought with USDC. Needs a funded wallet; keep it near empty.
- `free` — local or free models only (for example Ollama).

Check model IDs and prices in the model registry against your provider's
current price list before funding. `fx.usdToGbp` should be set slightly
pessimistically.

## Before funding anything

```bash
automaton --mission verify-controls
```

Every line must say PASS. Then test the controls yourself (try to approve
from a non-interactive shell, try an unapproved spend). Only then set
`"spendControlsVerified": true`. That flag is recorded for audit; it does
not relax approvals.

## Day-to-day

```bash
automaton --mission status                 # dashboard
automaton --mission approvals              # what the agent is waiting for
automaton --mission approve <id> [--amount-pence 500] [--note "..."]
automaton --mission reject <id> --note "why"
automaton --mission record-revenue --amount-pence 5900 --evidence pi_3Q... \
    --category readiness_review --description "Readiness review" --counterparty CUST-001
automaton --mission record-expense --amount-pence 800 --category compute_prepaid \
    --description "Prepaid API credit (USD 10)" --evidence receipt-123 --currency USD --original-minor 1000
automaton --mission report --write          # daily report into the reports directory
automaton --mission export --out snapshot.json
automaton --mission seed --file plan.json   # import opportunities, tasks and a checkpoint
```

Record prepaid compute under category `compute_prepaid` (or
`compute_credits`). The compute runway is prepaid compute minus inference
consumed, and it sets the model tier: runway above 50% uses the normal
mission routing, 20–50% low-compute, below 20% critical, zero sleeps the
agent.

Counterparty references must be pseudonymous (`CUST-004`). The ledger
rejects anything that looks like an email or phone number.

## What counts as mission revenue

- Settled, with a payment, payout or bank reference.
- Not from a related party: your own businesses, your employer, family.
- Attributable: the agent sourced the lead or materially progressed the sale.
  Use `--not-attributable` for money the mission had no part in.
- Refunds, fees and all expenses (settled or pending) are subtracted.

## Approvals

The agent requests approval automatically when it calls a gated tool, or
explicitly with `mission_request_approval` for drafts (emails, posts,
proposals). Approvals expire after 72 hours. A spend approval needs an
amount; you can set or lower it with `--amount-pence`. When an approved
spend executes, the approved amount is booked as a settled expense with
`approval:<id>` as evidence — reconcile it against the receipt and record a
correction if the real cost differed.

## Recovery

- The process can be restarted at any time. On start it re-reads the
  checkpoint, tasks and ledger; the system prompt carries them into every
  turn.
- A systemd unit is in `docs/deploy/automaton-mission.service`
  (restart on failure, dedicated user, no access to the rest of the machine).
- Back up `~/.automaton/state.db` with `scripts/backup-restore.sh`.
- The daily review (`mission_review` heartbeat) uses no inference. It expires
  stale approvals, records milestones, flags active opportunities with no
  settled revenue within `underperformanceDays`, records budget exhaustion
  and writes the report. It only wakes the agent if there is a task it can
  afford to work on.

## Residual risks (read these)

- **Prompt injection.** The agent reads untrusted web pages. Approvals stop
  it from acting on an injection that needs money, outreach or publishing,
  but it can still be misled into wasting compute or writing bad drafts.
  Review drafts before approving.
- **If you turn the shell back on** (`mission.allowShell`), the agent can
  reach its own database and approvals become advisory. The pattern blocks
  are defence in depth, not a guarantee.
- **The wallet key** is stored unencrypted in `~/.automaton/wallet.json`
  (mode 0600). With `byok` funding, keep the wallet empty.
- **DNS rebinding** can defeat the web fetch private-address check between
  lookup and request. Do not run the agent on a network with sensitive
  internal services.
- **Data can leave in a URL.** `web_fetch` is read-only, but a misled agent
  could put text it has seen into a query string. Keep customer personal
  data out of the runtime; the ledger only accepts pseudonymous references.
- **Model prices change.** The runway is computed from the registry's
  prices; your provider's dashboard is the source of truth.
