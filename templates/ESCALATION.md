# Goalkeeper escalation — HALTED, needs a decision

You can unblock this in ~30 seconds: read the **Decision needed** and reply with one **Option** line. You do not need to read the whole run.

## Goal
Add token-bucket rate limiting to the Express API so each client is capped at N requests per window, with over-limit requests rejected via HTTP 429 and a Retry-After header.

## Reason halted
`item-stuck` — `over-limit-returns-429` failed its check 3 consecutive times (attempt budget per item = 3).

(This example shows `item-stuck`. The same file is written for any non-converged halt. Possible reasons: `item-stuck`, `no-progress`, `oscillation`, `budget-exhausted`, `final-suite-failed`, `contract-incomplete`, `dependency-deadlock`, `scope-checkpoint`, `replan`, `replan-budget`, `self-critique`, `self-critique-unactionable`, `planning-failed`, `contract-lost`, `persist-failed`. The Decision needed and Options below are tailored to the actual reason.)

## Progress
2 / 5 items passing.
Passing: `middleware-exists`, `unit-tests-pass`.
Not passing: `over-limit-returns-429` (stuck), `retry-after-header` and `full-suite-green` (blocked behind it).

## Blocking item
- **id:** `over-limit-returns-429`
- **description:** After exhausting the bucket, the next request over the limit is rejected with HTTP 429. The integration test boots the app, fires N+1 requests from one client, and asserts the (N+1)th status is 429.
- **check:** `{ "type": "command", "command": "npm test -- rate-limit.integration" }` — boots the app, fires N+1 requests inside one window, and asserts the (N+1)th status is 429.

## Last check output / detail
```
> npm test -- rate-limit.integration

  rate limit (integration)
    1) over-limit request returns 429

  AssertionError: expected 200 to equal 429
    request #11 of a 10-req window returned 200, expected 429
    note: result varies run-to-run — the 11th request sometimes lands after a refill tick
```

## What was tried and why each attempt failed
(from `.goalkeeper/worklog.md`)
1. **r4 — bucket reused in live middleware.** Mutated module-level state across requests; regressed the unit suite (`unit-tests-pass`). Auto-reverted to `prevGoodHead`.
2. **r5 — check-then-decrement.** Off-by-one: the limit was compared before the token decrement, so the boundary request slipped through as 200.
3. **r6 — decrement-then-compare.** Fixed the boundary in isolation, but the integration test fires N+1 requests faster than one refill tick, so whether the (N+1)th is 429 now depends on timing rather than on the limit.

## Decision needed
The integration check is timing-sensitive as written: the (N+1)th request can arrive before or after a refill tick, so a correct limiter can still return 200 at the boundary. Pin the semantics so the check is deterministic — e.g. freeze the clock for the burst window (no refill mid-burst), or assert "at least one of the over-limit requests is 429" instead of exactly the (N+1)th — then the loop can resume.

## Options (reply with one line)
```
OPTION 1  skip over-limit-returns-429 (mark out-of-scope, continue with the rest)
OPTION 2  relax/replace its check — e.g. freeze the clock for the burst window, or assert any over-limit request is 429
OPTION 3  hint: "burst test must hold the clock fixed across the N+1 requests; no refill mid-burst" then resume
OPTION 4  revise the contract: re-invoke with amendContract:true and a new contract.items[] (add/split/replace items)
OPTION 5  abort the run
```

## Resume instructions
State of record lives at `<repo>/.goalkeeper/plan.json` (runtime state) and `contract.json` (the working contract), with `worklog.md` beside them; nothing was lost on halt. After you choose:
- **Options 1–3:** re-invoke `goalkeeper` — it reloads `plan.json` + `contract.json` and continues from `iteration: 6`. For option 2/3, edit the item's check (and/or `checkPaths`) or pass the hint as an arg.
- **Option 4 (revise the contract):** re-invoke with `amendContract: true` and the new `contract.items[]`; that overrides the persisted contract. To also clear a stuck item's retry count and stall on the amended resume, pass `resetAttempts: ["<item-id>"]`.
- **Option 5:** leave it; `status` is `halted`. Re-invoking later still resumes from the same durable state, or resume the workflow directly with updated args.
