---
name: goalkeeper
description: Autonomous build/audit/verify loop that runs until a machine-checkable done-contract passes, with deterministic anti-spin stop conditions (no-progress, 3-retry, oscillation, budget) and on-disk human escalation. Use for "keep going until it is actually done" multi-round work that has objective pass/fail checks. Not for one-shot tasks or work without verifiable acceptance criteria.
---

# Goalkeeper

Goalkeeper drives multi-round work to a **machine-checkable "done"** and stops itself the moment it stops making real progress. You hand it a *done-contract* (a goal plus a list of items, each with an objective pass/fail check), or just a goal and let it plan the contract for you. It loops build to green, refusing to declare victory on anything but an independent external check, and it refuses to spin forever: it has deterministic stop conditions wired into code, not into a model's good intentions.

The defining risk this skill addresses is the opposite of laziness. An eager loop will happily run forever, cheat its own tests, or converge perfectly on the wrong target. Goalkeeper is built to fail *loudly and on disk* instead.

**Fable-mode workflow built in (v2).** Beyond the core build/verify loop, Goalkeeper now plans, critiques, and re-plans:

- **Plan.** Hand it a bare `goal` (no `items[]`) and a PLANNER agent decomposes it into a full contract before anything is built.
- **Self-critique.** When every check is green, an adversarial critic hunts for what the checks missed (green is not the same as good) and can re-open the loop with capped remediation items.
- **Scope checkpoint.** Every few rounds it steps back and asks "is finishing still worth it?".
- **Living re-plan.** A builder that discovers the plan is wrong can request the contract be revised mid-run, capped so the plan cannot grow forever.

These are described in detail below; the contract is therefore mutable and durable, surviving resume.

## Architecture: three layers

**1. The brain is code, not a prompt.** The stop logic lives in a fixed Workflow script at `goalkeeper.workflow.js`, invoked via the Workflow tool. Convergence, the 3-retry rule, no-progress detection, oscillation detection, and the budget backstop are all evaluated deterministically in that script. They are not the model's *memory* of how it is supposed to behave, so they cannot be argued away mid-run, forgotten after a `/clear`, or talked around by an over-helpful agent.

**2. The spine is durable on-disk state.** Everything that matters persists under `<repo>/.goalkeeper/`, split across **two files** plus a log:

- `plan.json` — **runtime state only**: `status`, the set of `passing` item ids, per-item `attempts` (retry counts), the current `iteration`, `prevGoodHead` (the last known-green git SHA), and `fpHistory` (the fingerprint history used for no-progress and oscillation detection). The bookkeeper writes this every round.
- `contract.json` — the **durable working contract**: `goal`, `items` (each with its `expectedOutput`, `check`, and `dependsOn`), and the two spent budgets `replanCount` and `critiqueRounds`. This is the contract the loop is *actually* building to right now, which can differ from what you first handed in (the planner may have generated it, self-critique may have appended items, a re-plan may have split items). It is written only by the planner/seed/re-plan/self-critique persist steps; the bookkeeper never touches it.
- `worklog.md` — an append-only log of per-round reflections.

Splitting runtime state from the working contract is deliberate: the bookkeeper rewrites `plan.json` every round, but the contract must not be at risk of a bookkeeping overwrite, so it lives in its own file written only when it genuinely changes.

A **fresh** invocation reads all of these and continues from exactly where the last one left off. Crucially, the anti-spin counters round-trip too: `attempts`, `fpHistory`, **and** the contract-mutation budgets (`replanCount`, `critiqueRounds`) are all restored, so the 3-retry, no-progress, oscillation, re-plan, and critique caps resume mid-progress rather than resetting to zero on every re-invocation. That is the point: Goalkeeper survives crashes, `/clear`, dropped channels, and machine reboots, because the truth lives on disk and not in a session. Workflow's own resume is merely an optimization on top of this; the on-disk state is authoritative.

If a run that has already made progress finds **no** `contract.json` (lost contract state), it refuses to silently re-seed a possibly-stale caller contract over lost revisions and instead escalates (`contract-lost`): you must re-invoke with `amendContract: true` and the contract, or reset state.

**3. The doorbell is Telegram, best-effort only.** When the loop halts and needs a human, it writes `ESCALATION.md` to disk and *then* tries to ping Telegram. The Telegram ping can fail, be muted, or never arrive. `ESCALATION.md` is the system of record. Never treat "no Telegram message" as "nothing to decide" — check the file.

## How to invoke

Call the Workflow tool with the script path and an `args` object. The full shape:

```js
Workflow({ scriptPath: "${CLAUDE_SKILL_DIR}/goalkeeper.workflow.js", args: {
  mode: "build",                 // build | audit | verify  (build is hardened)
  autonomy: "envelope",          // envelope (default: run unattended, halt only on triggers) | leash (pause each round for approval)
  repo: "/path/to/target-repo",
  statePath: null,               // optional; the durable state dir. Defaults to <repo>/.goalkeeper (plan.json + contract.json + worklog.md + ESCALATION.md live here)
  contract: { goal },            // OR { goal, items[] }. Goal alone -> the planner decomposes it into items. See templates/contract.schema.json + contract.example.json
  checkPaths: ["tests/**"],      // write-protected; if the builder edits these, the round is auto-reverted
  caps: {
    maxIterations: 20, maxItemRetries: 3, maxStalls: 3, maxTokens: null,
    maxReplans: 2,               // living re-plan: max contract revisions before escalating (replan-budget)
    maxCritiqueRounds: 1,        // self-critique: max critique passes before converging anyway
    scopeCheckEvery: 4           // scope checkpoint cadence in rounds; 0 disables
  },
  denylist: ["git push","deploy","secrets","external-send"],  // forbidden actions, enforced regardless of mode
  telegram: { chatId: null },    // best-effort doorbell
  approvals: [],                 // leash: e.g. ["start"] to clear the pre-build gate; ["contract-gaps"] to proceed past blocking spec gaps
  runRounds: 1,                  // leash: rounds to run per invocation before pausing

  // ---- resume / amend (used when re-invoking after an escalation) ----
  amendContract: false,          // true: OVERRIDE the persisted contract.json with this call's contract.items[] (otherwise the persisted contract wins on resume)
  resetAttempts: []              // e.g. ["over-limit-returns-429"]: clear that item's retry count + stall on a human-amended resume so a relaxed check gets a fresh budget
}})
```

### The contract is the product

`contract` carries the entire definition of "done": a top-level `goal` string and an `items[]` array. **You can pass `{ goal }` alone** and let the PLANNER agent decompose it into items, **or pass `{ goal, items[] }`** with the items written yourself. Each item has an `id`, an optional `priority`, a `description`, an optional `expectedOutput` (the concrete result that proves the item done), an optional `dependsOn` (ids that must pass first), and an objective, machine-runnable `check`. See `templates/contract.schema.json` for the shape and `templates/contract.example.json` for a worked example.

**Item fields that shape scheduling:**

- `expectedOutput` — the concrete artifact or observable result that proves the item is done. It is what the builder aims to produce; `check` is how the loop measures it.
- `dependsOn` — an array of item ids that must be passing before this item is eligible. This enables **dependency-ordered scheduling**: the loop only ever picks an item whose dependencies are all green. (Note: dependency-*aware* scheduling is implemented, but execution is still **sequential**, one item per round. *Concurrent* execution is deferred to per-round git worktrees, the standing deferral. So items run in a dependency-respecting order, not in parallel.)

Write the contract carefully. Goalkeeper is extremely good at converging on whatever you actually wrote, which is exactly why a sloppy contract is dangerous: a perfectly-green run against the wrong checks is worse than a failed run, because it *looks* finished. The spec-review step below exists precisely to catch this before any code is written.

## The workflow phases

A run moves through five phases: **Plan -> Setup -> Loop -> Review -> Escalate**.

### Plan (once, only if needed)

If you pass `{ goal }` with no `items[]`, a **PLANNER** agent decomposes the goal into an ordered contract: atomic, independently-checkable items, each with an `expectedOutput`, a machine-runnable `check`, and a `dependsOn` list. The planner is told to make checks exercise real behavior including error/failure paths, not just the happy path, and to keep items small enough to build in one round. If you passed your own `items[]`, this phase is skipped. Either way the resulting contract is persisted to `contract.json`. If the planner returns nothing usable, the run escalates (`planning-failed`).

### Setup (once)

**Adversarial spec-review.** A critic agent attacks the contract itself, looking for gaps, ambiguity, unmeasurable checks, missing acceptance criteria, and any `dependsOn` that points at a missing id. The contract *is* the product, and the scariest failure mode is converging flawlessly on the wrong target, so the contract gets reviewed before a single line is built. **Blocking gaps halt the run for human input** (`contract-incomplete`) rather than letting Goalkeeper build confidently toward something underspecified, unless you pass `approvals: ["contract-gaps"]`.

### Loop (each round; advances at most one item)

1. **Select (dependency-aware).** From the items not yet passing, take those whose `dependsOn` are *all* already passing, and pick the lowest `priority` number among them. One item per round, no more. If nothing is eligible but items remain, the dependencies are unsatisfiable and the run escalates (`dependency-deadlock`).

2. **Scope checkpoint (periodic).** Every `scopeCheckEvery` rounds (default 4; `0` disables), before building, a low-effort agent steps back and asks: is the original goal still the right target, is finishing worth the remaining cost, is what's done already good enough? A recommendation other than `continue` (`stop-good-enough`, `stop-goal-stale`, or `escalate`) halts the run (`scope-checkpoint`) for a human call. The default is `continue`.

3. **Build.** A builder agent implements *only* that one item, then commits. It is given the item's `expectedOutput` and told to read `worklog.md` first so it never repeats a failed approach.

4. **Living re-plan (only if the builder asks).** If the builder discovers the **contract itself** is wrong (the item needs an unlisted prerequisite, or should be split), it returns a `replanRequest` and the loop revises the working contract (adding and/or splitting items), persists it, and re-evaluates. This is capped by `maxReplans` (default 2); exceeding it escalates (`replan-budget`). It is for plan-is-wrong situations only, not for dodging a hard item.

5. **Verify (authoritative).** An independent verifier — which does **not** trust the builder's report — runs the item's check *and* the full suite, plus a regression re-run of every already-passing item. It reports: regressions, any tampering with protected check files, the resulting git HEAD sha, a tree-id artifact hash, and whether the working tree is clean (a pass with uncommitted source changes is *not* a durable pass). This verifier, not the builder, decides whether the item passed.

6. **Bookkeep.** A bookkeeper agent persists the updated **runtime** `plan.json` and appends to `worklog.md`, and **reverts the round** to `prevGoodHead` if the verifier flagged a regression or tamper (or any non-passing outcome).

### Review (the self-critique gate, when all items pass)

When every item passes, an independent **final** full-suite check runs (`final-suite-failed` if it is not clean). Then, before declaring victory, an **adversarial SELF-CRITIQUE** agent reads the finished work against the goal and hunts for what the checks *missed*: unhandled error paths, edge cases, race conditions, performance cliffs, security gaps, near-placeholder implementations, or work that satisfies the *letter* of the checks while missing the intent. **Green is not the same as good.**

- A **blocking** weakness with a concrete suggested check re-opens the loop as a capped remediation item (the critique budget is `maxCritiqueRounds`, default 1, so this cannot loop forever). In leash mode it escalates (`self-critique`) instead of silently adding work.
- If the critic is *not* satisfied but offers no actionable item, the run escalates (`self-critique-unactionable`) rather than laundering an unresolved concern into a false "converged".
- If the critic is satisfied, the run **converges** — but a converged result can still carry a `weaknesses[]` array and a `selfCritiqueSummary` of **minor** limitations it flagged but did not block on. So a "converged" result may ship with explicitly-flagged limitations; read them.
- If the critique budget is already spent, the run converges without another pass.

## Stop conditions (deterministic, with rationale)

Each of these is evaluated in code at the end of a round. Each cites the prior art it is modeled on.

- **Converged.** Every item passes, an independent *final* full-suite check is green, **and** the adversarial self-critique gate found no *blocking* weakness. Done is always an external check passing, never the builder's self-report. A converged result may still include `weaknesses[]` + `selfCritiqueSummary` listing minor limitations the critic flagged but did not block on, so "converged" can ship with documented caveats. (Modeled on Aider's zero-exit gate, SWE-agent's explicit `submit`, and Anthropic's evaluator-optimizer pattern, where a separate evaluator signs off on the work.)

- **Item-stuck.** The same item fails its check **3 times** → stop and escalate *that specific item* (the rest of the contract may already be green). (Modeled on Aider's `max_reflections = 3`.)

- **No-progress.** For **3 consecutive rounds** (default `maxStalls`), no item newly passes **and** git HEAD does not advance → halt. For a single stuck item the per-item **item-stuck** guard (3 attempts) usually fires first and names the blocking item; no-progress is the loop-wide backstop for churn across several items. The fingerprint recorded each round is `{tree-id, passing-count, head}`. (Modeled on OpenHands-style stuck detection.)

- **Oscillation.** The loop returns to a recently-seen tree-state without the passing-count having increased → halt. Going in circles is treated as being stuck. (Modeled on OpenHands' ping-pong / loop detector.)

- **Budget backstop.** `maxIterations` or the token budget is exhausted → enter a **distinct "halted, not done" terminal state** that *always* routes to a human. This is never silently relabeled as success. (Modeled on Semantic Kernel's two distinct terminal states and LangGraph's `recursion_limit`, whose default is 25.)

The budget backstop and convergence are *different* terminal states on purpose. "We ran out of budget" must never be reported as "we finished."

## Build-mode anti-destruction guards

Under pressure to make a check pass, an unconstrained agent will cheat. These guards make cheating either impossible or self-reverting:

- **Write-protected checks.** The builder may not edit its own check files. `allowTestEdit` defaults to `false`. Any edit to a path under `checkPaths` is detected via `git diff` and the whole round is auto-reverted. (Agents under pressure will "fix" a failing test by editing the test; this closes that door.)

- **No placeholders.** No stubs, no TODOs-standing-in-for-work, and no mocking of the very thing under test. Only a full, real implementation counts as a passing item.

- **CI-must-stay-green.** Any round that regresses a previously-green check is reset to `prevGoodHead` and counts as a *failed attempt* against that item's retry budget. Progress moves forward only; the working tree never ratchets backward into a broken state to chase a new item.

## Escalation and resume

Any non-converged stop writes **`ESCALATION.md`** to `<repo>/.goalkeeper/` and then pings Telegram if reachable. The full set of escalation reasons:

- **`item-stuck`** — one item failed its check 3 times.
- **`no-progress`** — 3 consecutive rounds with no new pass and no HEAD advance.
- **`oscillation`** — the loop returned to a recently-seen tree-state without progress.
- **`budget-exhausted`** — `maxIterations` or the token budget ran out.
- **`final-suite-failed`** — all items passed individually but the final full-suite check did not.
- **`contract-incomplete`** — the spec-review found blocking gaps in the contract.
- **`dependency-deadlock`** — items remain but none are eligible (a `dependsOn` is unsatisfiable / points at a missing id).
- **`scope-checkpoint`** — the periodic scope check recommended stopping or asking the human.
- **`replan`** — (leash only) a living re-plan revised the contract and paused for your review.
- **`replan-budget`** — a builder requested another re-plan past `maxReplans`.
- **`self-critique`** — (leash only) the self-critique gate opened remediation items and paused.
- **`self-critique-unactionable`** — the critic is unsatisfied but produced no actionable remediation item.
- **`planning-failed`** — the planner could not produce a usable contract from the goal.
- **`contract-lost`** — a started run found no `contract.json`; re-invoke with `amendContract` or reset.
- **`persist-failed`** — the working contract could not be written to disk (a fatal durability failure).

`ESCALATION.md` contains: the goal restated; progress so far; the specific blocking item; the actual failing check output; what was already tried; the decision needed; **five one-tap options** (skip / relax / hint / **revise the contract** / abort); and exact resume instructions.

**To resume:** re-invoke goalkeeper (it reads `plan.json` + `contract.json` and picks up where it stopped), or first amend the contract and then re-invoke:

- Relax a check, add a hint, or drop an item, then re-invoke — the persisted contract wins on resume by default.
- To **replace** the contract wholesale, pass `amendContract: true` with the new `contract.items[]`; that overrides the persisted contract.
- To give a stuck item a fresh retry budget on a human-amended resume (e.g. after relaxing its check), pass `resetAttempts: ["<item-id>"]`, which clears that item's retry count and resets the stall counter.

Because all state is on disk, resuming is just running the skill again against the same repo.

## Autonomy modes

- **envelope (default).** Runs unattended. It halts only on the hard triggers above (a blocking spec gap, a stuck item, no-progress, oscillation, budget, a dependency deadlock, a scope-check recommending a stop, an unactionable self-critique, or a re-plan past budget). Re-planning and minor self-critique remediation happen *automatically* in this mode, within their caps. This is the "go do it, and bother me only if you're genuinely blocked" mode.

- **leash.** Pauses at a pre-build approval gate and again after every `runRounds` rounds. You re-invoke to continue, passing `approvals: ["start"]` to clear that first pre-build gate (and `approvals: ["contract-gaps"]` to proceed past a spec-review that flagged blocking gaps). In leash mode the contract-mutating gates also pause for your review instead of acting silently: a living re-plan escalates as `replan`, and the self-critique gate opening remediation items escalates as `self-critique`. Because state is durable, **leash is simply envelope run in smaller batches** — same machinery, same on-disk spine, you are just choosing to look in between.

## When to use / when not

**Use it when** the goal has objective, machine-checkable acceptance criteria and the work benefits from iteration:

- build a feature until its test suite is green
- drive an audit down to zero findings
- verify a system until a defined suite passes

**Do not use it for:**

- one-shot edits (just make the edit)
- work that needs fresh human design judgment at each step
- anything that lacks a verifiable "done" signal — Goalkeeper's whole value is the external check, and without one it has nothing to converge on.

## Limitations (honest deviations)

Three things are deferred, all sharing the same safety property (a bad round can never corrupt good work) with fully-understood semantics:

1. **Concurrent execution is deferred.** Dependency-*aware* scheduling is in: items run in a dependency-respecting order. But execution is still **sequential**, one item per round. Running independent items *concurrently* needs per-round git worktrees, because concurrent commits to one repo would break reset-on-fail, so it is deferred.

2. **No per-round git worktree yet.** The loop uses snapshot-HEAD plus reset-on-fail on the *live* repo. This preserves the core guarantee — a bad round is reset to `prevGoodHead` — but proper isolated worktrees (which also unlock deferral 1) are deferred pending a check of the Workflow execution lifecycle.

3. **The wall-clock cap is soft.** The scripts cannot read the clock, so there is no hard time limit. The hard backstops that *do* stop a runaway loop are the iteration count and the token budget.

## Hard denylist and kill switch

**Denylist.** The forbidden actions — `git push`, `deploy`, `secrets`, `external-send` — are enforced in **both** autonomy modes, regardless of `mode` or `autonomy`. Goalkeeper operates inside the repo and does not reach outside it.

**Kill switch.** To stop a run, **stop the Workflow** from `/workflows`. To reset Goalkeeper's state entirely, **delete the `.goalkeeper/` directory** (under `<repo>/`) — that clears *both* state files, `plan.json` (runtime) and `contract.json` (working contract), plus `worklog.md` and any `ESCALATION.md`. The next invocation then starts fresh from the contract you pass in (or re-plans from the goal).

## Example invocation

**With an explicit contract** (note `expectedOutput` and `dependsOn` ordering the work):

```js
Workflow({ scriptPath: "${CLAUDE_SKILL_DIR}/goalkeeper.workflow.js", args: {
  mode: "build",
  autonomy: "envelope",
  repo: "/path/to/your/repo",
  contract: {
    goal: "Add CSV export to the report page with full test coverage",
    items: [
      { id: "export-endpoint", priority: 1, dependsOn: [],
        expectedOutput: "GET /report/export returns 200 with text/csv",
        check: { type: "command", command: "npm test -- export.endpoint" } },
      { id: "csv-formatter",   priority: 2, dependsOn: ["export-endpoint"],
        expectedOutput: "Rows serialize to RFC-4180 CSV, commas and quotes escaped",
        check: { type: "command", command: "npm test -- csv.format" } },
      { id: "ui-button",       priority: 3, dependsOn: ["export-endpoint"],
        expectedOutput: "Report page renders an Export button that hits the endpoint",
        check: { type: "command", command: "npm test -- report.ui" } }
    ]
  },
  checkPaths: ["tests/**"],
  caps: { maxIterations: 20, maxItemRetries: 3, maxStalls: 3, maxTokens: null,
          maxReplans: 2, maxCritiqueRounds: 1, scopeCheckEvery: 4 },
  denylist: ["git push","deploy","secrets","external-send"],
  telegram: { chatId: null }
}})
```

**Goal only** — let the planner build the contract:

```js
Workflow({ scriptPath: "${CLAUDE_SKILL_DIR}/goalkeeper.workflow.js", args: {
  mode: "build",
  autonomy: "envelope",
  repo: "/path/to/your/repo",
  contract: { goal: "Add CSV export to the report page with full test coverage" },
  checkPaths: ["tests/**"],
  denylist: ["git push","deploy","secrets","external-send"]
}})
```

Both run unattended: Goalkeeper plans the contract if you gave only a goal, reviews it, builds one item per round (in dependency order) to its check, verifies each independently against the full suite, runs an adversarial self-critique once everything is green, and either converges (all items green, a clean final suite run, no blocking weakness — possibly with minor caveats flagged) or halts and writes `ESCALATION.md` for you to decide.
