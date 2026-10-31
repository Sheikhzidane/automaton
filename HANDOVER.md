# Handover: security fixes and commercial mission mode

Branch: `mission-mode-and-security-fixes` (base: upstream `d8f8168`). Written
so a fresh engineer or Claude Code session can pick this up without context.

## Why

An audit of upstream found that the in-app treasury limits did not cover
most of the ways the runtime can spend money or leak secrets:

| # | Finding (upstream) | Severity | Fix |
|---|---|---|---|
| 1 | Local mode runs the agent's `exec` with `execSync` on the host, in `$HOME`, as the operator | Critical | `security.allowHostExec` (default off); agent tools get a guarded client (`src/security/host-exec.ts`) |
| 2 | The loop copies provider keys into `process.env`; child shells inherit them (`env`, `echo $KEY`) | Critical | Child processes get a scrubbed environment (`src/security/env.ts`) |
| 3 | Wallet/config protection in the shell was a single `cat …wallet.json` pattern | Critical | `command.sensitive_access` rule + inline guard (`src/security/sensitive.ts`); mission mode removes the shell entirely |
| 4 | `spawnChild` read `(db as any).config.maxChildren`, which never exists: the cap was always 3, and 0 did not disable replication | Critical | Explicit `SpawnChildOptions`; `security.replicationEnabled` (default off) enforced in the policy engine, the tool and the orchestrator |
| 5 | Five automatic USDC spend paths bypass the policy engine: startup top-up, heartbeat top-up, in-loop top-up, and top-up-and-retry on failed spawns (tool and orchestrator) | Critical | All gated by `isAutoSpendAllowed(config)` — false in mission mode |
| 6 | `quarantine` (require confirmation) had no confirmation mechanism; it simply blocked | Important | Mission approvals (`src/mission/approvals.ts`) with a human-only CLI |
| 7 | Several treasury rules were declarations that never denied anything (`x402_max_single`, `minimum_reserve`) | Important | Not changed upstream-wide; in mission mode spends need an approval with an amount checked against capital |
| 8 | Prompt-injection defence is keyword matching | Important | Not fixable by patterns; mitigated by approvals on every external action |
| 9 | Zero Conway credits means "dying", which kills agents that pay for compute another way | Important | In mission mode the tier follows the mission's compute runway |

## What was added

- `src/security/` — env scrubbing, sensitive command detection, agent shell gate.
- `src/self-mod/code.ts` — the security and mission control files are added to the list the agent can never modify.
- `src/agent/policy-rules/security.ts` — replication and sensitive-command rules.
- `src/mission/` — config, ledger, budget, approvals, milestones, opportunities, tasks and checkpoint, reports, policy rules and post-execution hook, agent tools (including a GET-only `web_fetch` with SSRF guards), daily review heartbeat, cost-first routing matrix, operator CLI.
- Schema v12 (`src/state/schema.ts`): mission tables; ledger, capital grants and events are append-only via triggers.
- `docs/MISSION.md` (operator guide), `docs/deploy/automaton-mission.service`, `docs/mission-seed.example.json`.

Integration points touched: `src/index.ts` (CLI, startup), `src/agent/loop.ts`
(guarded client, mission tools, tier, routing, spawn gates),
`src/agent/tools.ts` (inline guards, post-execution hook),
`src/agent/system-prompt.ts` (mission section), `src/heartbeat/*`
(mission review, auto-spend gates, tier), `src/inference/router.ts`
(injectable matrix), `src/replication/spawn.ts`, `src/conway/client.ts`.

## Behaviour changes for non-mission users

- The agent no longer gets a host shell in local mode unless `security.allowHostExec: true`.
- Replication (sandbox children and in-process workers) is off unless `security.replicationEnabled: true`. The orchestrator self-assigns instead.
- Shell commands touching secrets, the state database, or dumping the environment are denied.

## Verify

```bash
pnpm install
pnpm typecheck
npx vitest run src/__tests__/mission        # new tests
npx vitest run                              # full suite (see note below)
pnpm build
node dist/index.js --mission verify-controls  # needs a configured ~/.automaton
```

Note: `src/__tests__/context-hardening.test.ts` hangs in a network-restricted
environment on the upstream commit as well; it is not affected by these
changes.

## Not done (needs a decision or credentials)

- Running the agent anywhere. It has not been funded or deployed.
- A live inference turn in mission mode. The BYOK path (own provider key,
  no Conway key) passes the unit tests and the CLI smoke test, but no real
  model call has been made with it. Watch the first live run.
- Wallet encryption at rest. With `byok` funding the wallet should stay empty, which makes this low priority.
- Read-only payment-provider integration (e.g. a restricted Stripe key) so settled revenue can be verified automatically instead of entered by hand.
- Upstreaming the security fixes to Conway-Research/automaton.

## Where operator data lives

Never in this repository (it is public). Mission state is in
`~/.automaton/state.db`; daily reports in `~/.automaton/mission/reports/`.
Import a private plan with `automaton --mission seed --file <path outside the repo>`.

---

# Addendum (31 October): growth operations engine

Branch: `growth-ops-engine` (on top of `mission-mode-and-security-fixes`).

## Verified on this branch before adding anything

- `pnpm typecheck` passes; `npx vitest run src/__tests__/mission` 101/101;
  full suite 1,715/1,715 in 69 files (`context-hardening.test.ts` excluded,
  it hangs offline as noted above); `pnpm build` passes.
- `node dist/index.js --mission verify-controls` 10/10 PASS on a scratch home.
- GitHub Actions has never run on this fork (forks start with Actions
  disabled), so the CI workflow here has not run either.

## What was added

`ops/`: a dependency-free scheduled runner for deterministic mission work
(health checks of OpsLog's public pages, counts-only OpsLog metrics, weekly
FSA open data refresh with prospect signals, pipeline, revenue and backlog
reviews, daily report). Details and guarantees in `ops/README.md`.
Tests: `src/__tests__/ops` (22) and `node ops/run.mjs verify-controls` (26).

## Why the schedule lives in the OpsLog repository

- Actions is disabled on this fork, and enabling it is the owner's click.
- This repository is public. Prospects, pipeline notes and revenue must not
  be. State therefore lives on the private OpsLog repo's `growth-ops` branch
  and the workflow there checks this engine out **by commit**.

## Relationship to mission mode

Mission mode (`src/mission`) is the supervised agent: it reasons, drafts and
asks for approvals, and needs a funded model key. The ops engine is the
part that must run every day for free. They share the rules (pseudonymous
counterparties, settled-and-evidenced revenue only, approvals for money)
but not a database: the ops ledger is a hash-chained JSONL file so it can
live in git. If mission mode is later funded and deployed, import the ops
pipeline and ledger with `automaton --mission seed`.
