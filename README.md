# Goalkeeper

**An autonomous build / audit / verify loop for [Claude Code](https://claude.com/claude-code) that runs until a machine-checkable contract passes, and stops itself the moment it stops making real progress.**

Goalkeeper is a Claude Code skill. You hand it a repository and either a goal or a full "done-contract" (a list of items, each with an objective pass/fail check). It then loops: build one item, verify it with an independent check, and repeat, refusing to declare victory on anything but an external check passing. Its defining feature is the opposite of laziness: an eager agentic loop will happily run forever, cheat its own tests, or converge perfectly on the wrong target, so Goalkeeper is built to **fail loudly and on disk** instead, with deterministic stop conditions wired into code rather than into a model's good intentions.

---

## Why this exists

Most "agent in a loop" setups share the same failure mode: nothing in the loop ever asks *"am I actually making progress?"*. The agent keeps going, retries the same broken approach, edits the test to make it pass, or quietly decides it is done when it is not. Goalkeeper addresses that head-on:

- **"Done" is always an external check passing,** never the builder agent's self-report. A separate verifier runs the checks.
- **The loop cannot spin forever.** Item-stuck (3 retries), no-progress, oscillation, and a hard iteration/token budget are all evaluated in code at the end of every round.
- **It cannot cheat.** The builder may not edit its own check files; any round that regresses a previously-green check is reset; and the verifier inspects the diff so a check that passes only by being *gamed* (hardcoded output, stubbed return, gutted assertions, a no-op pass) is scored as a failed round, not a win.
- **When it gets stuck, it tells you.** It writes a structured `ESCALATION.md` to disk (and optionally pings Telegram) with the blocking item, what was tried, and one-tap options to unblock it.

It also has a planning and self-correction layer built in (a "fable-mode" workflow): give it just a goal and it plans the contract; once everything is green it runs an adversarial self-critique to catch what the checks missed; it periodically asks whether finishing is still worth it; and a builder that discovers the plan is wrong can request the contract be revised mid-run. Every one of those loop-extending features is capped so the skill that prevents infinite loops does not grow one.

---

## Key features

| Feature | What it does |
| --- | --- |
| **Deterministic stop conditions** | item-stuck (3 retries), no-progress, oscillation, and a budget backstop are enforced in code, not prompts. A "ran out of budget" state is kept distinct from "converged". |
| **Contract-is-the-product spec review** | Before any code is written, an adversarial critic attacks the contract for gaps and ambiguity, because a perfectly-green run against the wrong checks is worse than a failed one. It also **distrusts the check itself**: a check that is wrong (passes buggy code or fails correct code) or cheat-able is a blocking gap, and it prefers mechanical pass/fail checks over subjective rubrics. |
| **Independent + anti-gaming verifier** | A separate agent, which does not trust the builder, runs each item's check plus the full suite and a regression re-run of every passing item. It also inspects the builder's diff and, if the check passed only by **gaming** it (hardcoded output, stubbed return, gutted assertions, no-op pass), fails the round (`revert-gaming`) so a gamed item can never converge. |
| **Anti-destruction guards** | Write-protected check files, a no-placeholder rule, the anti-gaming revert, and reset-to-last-good on any non-passing round. The working tree never ratchets backward into a broken state. The discarded diff of each failed round is saved to `last-attempt-<item>.patch` so you can still inspect reverted work. |
| **Reflexion failure ledger** | Each failed attempt's "why it failed + what to change" is persisted per item (`attemptLog`) and re-injected into the next builder attempt with a "do not repeat these" instruction; the last retry before escalation demands a fundamentally different approach or a blocked declaration. |
| **Durable on-disk state** | Two state files under the target repo survive crashes, `/clear`, dropped channels, and reboots. A fresh invocation resumes exactly where the last one stopped. |
| **Human escalation** | Any non-converged stop writes a structured `ESCALATION.md` (system of record) and best-effort pings Telegram (a doorbell, never the record). |
| **Planning front-end** | Hand it a bare goal and a planner decomposes it into an ordered contract with expected outputs, checks, and dependencies. |
| **Self-critique gate** | When all checks are green, an adversarial critic hunts for what the checks missed. Green is not the same as good. |
| **Scope checkpoint** | Periodically steps back and asks whether finishing is still worth the remaining cost. |
| **Living re-plan + dependency scheduling** | The contract is mutable and durable; items can declare `dependsOn` and are scheduled in dependency order. |
| **Non-deterministic / hardware-in-the-loop checks** | A check can declare `nondeterministic: true` with a retry `passPolicy` (latch / k-of-n) and a `precondition`; a pass latches the git tree-hash, so a later flaky miss at that tree is not a code regression. |
| **Shell pinning + pipeline checks** | A check can pin `shell`/`cwd`/`env` so it runs under exactly the shell it needs, or be a `pipeline` (build → deploy → verify) that short-circuits on a failed build and forces a fresh build when a stale artifact cannot be ruled out. |
| **Contract-identity resume gate** | Auto-resume only fires for the same task (goal + sorted item ids). A different contract on an in-progress run halts with `contract-mismatch` and asks, rather than resuming the wrong work. |

---

## Optional power features (opt-in, default-off)

Nine extra capabilities are gated behind flags and **change nothing unless you turn them on**. With no flags set, Goalkeeper behaves exactly as described above.

- **Best-of-N builders** (`caps.candidates` > 1, default 1). For a hard item, Goalkeeper builds **N diverse candidate solutions** and the **deterministic contract** (the independent verifier) picks the winner: there is **no LLM judge**. The candidates run **sequentially on the live repo** (each resets to last-good, builds a different approach guided by a diversity hint, is verified in place; the winning commit is promoted by cherry-pick), not in parallel worktrees. By default only **retries** fan out (`candidatesHardOnly`), so you pay the N-cost only where the loop is struggling, and N is capped (`maxCandidates`, default 6). If no candidate passes it is a normal failed round and item-stuck still bounds it. Cost: candidates multiply a round's build+verify token cost by up to N. A related `maxPlateau` stop (default 8) halts with reason `plateau` if the passing-count does not advance for that many rounds (a best-of-N backstop, since promoting a winner can move HEAD without a new item passing).
- **Step memoization** (`memoize: true`, default false). Call-granular crash-resume: the expensive builder and verifier calls are keyed by a deterministic fingerprint of their inputs and their results stored in `.goalkeeper/results.json`, so a re-invocation returns a completed call's stored result instead of re-running it (no duplicate LLM spend). Invalidation is structural (a changed check or tree yields a different key), and a corrupt or missing ledger just degrades to recompute, so a stale result is never replayed.
- **Durable approval token** (`approveToken: true`, default false). Instead of resolving an escalation by re-invoking with args, each escalation mints a deterministic token (shown in `ESCALATION.md`); a human writes `.goalkeeper/resolution.json` = `{ token, action }` (`action` is `approve` | `redirect` | `abandon` | `hint`) and the next invocation consumes it once, mapping it onto the existing resume levers. A token that does not match the active halt is ignored.
- **Repo map** (`caps.repoMap`, default `'off'`). A cheap agent writes a token-bounded `.goalkeeper/repomap.md` (ranked key files in `'tree'` mode, plus top-level symbols via a ctags → git-grep → tree fallback in `'symbols'` mode; budget `caps.repoMapTokens`, default 1500) once at setup (refreshed after a re-plan/self-critique, or every `caps.repoMapRefreshEvery` rounds if > 0), and the planner and builder read it for grounding. It is git-ignored and never a gate.
- **Verified pattern library** (`libraryPath`, default off). Point Goalkeeper at a cross-repo directory and every verifier-passed solution is **banked** there (the committed diff, secret-scrubbed, source repo recorded by basename only), keyed by the item description. When a later run **in any repo** starts a similar item, the most relevant banked patterns are **retrieved semantically and injected into the builder** as a "PROVEN PATTERNS" advisory block, so you stop re-solving the same primitive from scratch. It is **advisory only**: the independent verifier and the anti-gaming inspection are untouched, so a pattern can never make a wrong solution pass. Dedup (append / update / replace-variant) is decided deterministically by the script, and the library lives **outside** any repo's `.goalkeeper/`, so `freshStart` and state resets never touch it.
- **Durable physical human-in-the-loop** (`humanGate: true` + a check's `humanPrecondition`, default off). For a check that cannot pass until a **person does something physical** (move a radio to the next room, reseat an SD card, power-cycle a board), Goalkeeper **suspends at zero compute** (status `awaiting-human`, **not** a failure and **not** counted against any anti-spin budget), writes `AWAITING-HUMAN.md` with a one-time token, and waits. The person performs the action, writes `resolution.json { token, action: "ready" }`, and re-invokes; the run latches the human step (recording the authorizing token) and proceeds to verify. The latch is per-tree by default (re-asks only when the baseline tree changes). A `humanPrecondition` with the gate **off** escalates (`human-gate-disabled`) rather than being silently skipped.
- **CI-fix mode** (`fix: { command }`, default off). Point Goalkeeper at a single **red command** (a failing build / test / lint) and it synthesizes a one-item contract whose check *is* that command, captures the failing output to seed the first build, and drives the real command to green, without letting the builder edit or stub the command itself. It composes with every other feature (it is just a generated contract), and re-invoking with the same `fix` resumes the in-progress run.
- **Human-proven diagnosis** (`diagnosis`, default off). When you have already done the decisive diagnosis (the kind that needs human judgment or out-of-band observation), hand the proven finding in as a string (or `{ text, itemId }` to scope it to one item). The builder gets it as a trust-this block, **re-planning is locked** (`maxReplans` forced to 0) and that item stays single-builder, so the loop executes the mechanical fix instead of re-theorizing around it. A builder that finds reality contradicting the diagnosis reports `blocked` quoting the contradiction, which is exactly the signal you need.
- **Auto-retro** (`retro: true`, default off). On converge or a lesson-worthy halt, one low-effort agent appends a dated one-line lesson about how the loop was **driven** (check authoring, contract scoping, diagnosis handling) to `LESSONS.md` (at `libraryPath` when the pattern library is on, so lessons accumulate cross-repo). Uneventful runs append nothing; administrative pauses and infra failures never spend the call. **The lessons feed back:** the planner and spec-review read LESSONS.md as advisory context on later runs, so the loop learns how to author and review contracts from its own history.

Two cost/quality behaviors come free with the defaults: repeat `contract-incomplete` halts on an unchanged contract **replay the cached rejection** instead of re-running the reviewer (about 40 percent cheaper per repeat halt; any edit, commit, or new lesson forces a real re-review, and approvals are never cached), and pattern-library eviction is retrieval-aware (each retrieval bumps `timesRetrieved`, so the patterns that actually get used survive the per-problem variant cap).

### Turning the opt-in features on

All seven are off by default. Set the flag in the `args` you pass to the workflow (or just ask Claude, e.g. *"use goalkeeper on this repo with best-of-3 builders and the repo map on"*).

**Best-of-N builders** (try several approaches to a hard item, keep the one the contract accepts):
```js
caps: { candidates: 3 }                               // up to 3 candidates; by default only RETRIES fan out
// caps: { candidates: 3, candidatesHardOnly: false }  // fan out from the first try too
// per item:  { id: "gnarly-item", candidates: 4, check: { ... } }   // force best-of-N for one item only
```

**Step memoization** (make crash/resume cheap by skipping unchanged builder/verifier calls):
```js
memoize: true                                         // writes .goalkeeper/results.json; safe to delete (it just recomputes)
```

**Repo map** (give the planner and builder a token-bounded map of the codebase):
```js
caps: { repoMap: "symbols" }                          // 'tree' = file tree only | 'symbols' = ctags->grep->tree; budget caps.repoMapTokens
```

**Durable approval token** (resolve an escalation by dropping a file instead of re-invoking with args):
```js
approveToken: true
```
When a run halts, `ESCALATION.md` (and `plan.json`'s `activeToken`) carry a token such as `gk-a1b2c3-item-stuck-d4e5f6`. To unblock it, write `<repo>/.goalkeeper/resolution.json` and re-invoke goalkeeper with no new contract:
```json
{ "token": "gk-a1b2c3-item-stuck-d4e5f6", "action": "hint",
  "hint": "the refill must use the injected clock, not Date.now()" }
```
`action` is one of:
- `approve`: give the blocking item a fresh attempt budget and continue.
- `hint`: same, plus inject `hint` into the builder's memory (the Reflexion ledger) so the next attempt sees it.
- `redirect`: replace the contract by adding `"amendItems": [ { id, description, check, ... } ]` (and optional `"amendGoal"`).
- `abandon`: archive the run and stop.

The token is **consumed once** (the file is deleted and `activeToken` cleared on resume); a token that does not match the current halt is ignored, so a stale resolution can never fire on the wrong run.

**Verified pattern library** (bank every passing solution to a cross-repo store and inject the relevant ones into future builds):
```js
libraryPath: "/path/to/goalkeeper-pattern-library"   // any directory, shared across repos; never reset by freshStart
```
Every verifier-passed item is banked there (diff + summary, secrets scrubbed, source repo recorded by basename only) and the patterns relevant to a later item are injected into the builder as advisory "PROVEN PATTERNS" context. Tune retrieval with `caps.libraryTopK` (default 3).

**Durable physical human-in-the-loop** (suspend for a real-world action instead of failing the check):
```js
humanGate: true
// ...and a check declares the physical step it depends on:
// check: { type: "command", command: "./mesh-rx-check.sh", nondeterministic: true,
//          humanPrecondition: "Move Unit B 50m away, power it on, and start the listener" }
```
When the loop reaches that item it suspends (status `awaiting-human`, no anti-spin budget consumed) and writes `AWAITING-HUMAN.md` with a one-time token. Perform the action, then write `<repo>/.goalkeeper/resolution.json` and re-invoke goalkeeper:
```json
{ "token": "gk-a1b2c3-human-d4e5f6", "action": "ready" }
```

**CI-fix mode** (drive a single red command to green):
```js
fix: { command: "npm test -- auth.spec", shell: "pwsh" }   // synthesizes a one-item contract whose check IS this command
```
Goalkeeper captures the failing output to seed the first build and drives the real command to exit 0, without letting the builder edit or stub the command itself. Re-invoking with the same `fix` resumes the in-progress run.

**Human-proven diagnosis** (you did the diagnosis; the loop executes the fix without re-theorizing):
```js
diagnosis: "the status poll runs mid-reception and corrupts the frame; gate all diagnostic SPI reads to idle"
// or scoped to one item of a larger contract:
diagnosis: { text: "...", itemId: "rx-clean" }
```
The builder gets the finding as a trust-this block, re-planning is locked (`maxReplans` forced to 0), and the item stays single-builder. If reality contradicts the diagnosis, the builder reports `blocked` quoting the contradiction instead of improvising.

**Auto-retro** (grow an operating playbook from real runs):
```js
retro: true          // appends to LESSONS.md at libraryPath (cross-repo) when the pattern library is on, else <repo>/.goalkeeper/LESSONS.md
```
One dated line per lesson-worthy outcome about how the loop was driven (check authoring, scoping, diagnosis handling). Uneventful runs append nothing.

---

## Requirements

Goalkeeper drives Claude Code's **dynamic workflows** runtime (it ships a JavaScript orchestrator that the skill runs via the Workflow tool). That runtime is gated, so check the following before installing:

- **Claude Code v2.1.154 or later.** Verify with `claude --version`.
- **A paid plan** (Pro, Max, Team, or Enterprise), or Anthropic API access, or Amazon Bedrock / Google Cloud Vertex AI / Microsoft Foundry. Dynamic workflows are not available on the free tier.
- **Dynamic workflows enabled.** They are on by default for Max / Team / Enterprise. On **Pro you must turn them on**: `/config` then the "Dynamic workflows" row. They can also be disabled via `"disableWorkflows": true` in settings or `CLAUDE_CODE_DISABLE_WORKFLOWS=1`; either will prevent the skill from running.

A `git` repository to operate on (Goalkeeper commits each item it builds), and a project whose acceptance criteria are objective and machine-checkable (a test command, a file/grep assertion, etc.).

---

## Install

Goalkeeper is a folder-based skill. The simplest install is to clone it into your skills directory under the folder name `goalkeeper` (the folder name is what you invoke).

**macOS / Linux:**
```bash
git clone https://github.com/Mikhail-Za/Goalkeeper-Claude-skill.git ~/.claude/skills/goalkeeper
```

**Windows (PowerShell):**
```powershell
git clone https://github.com/Mikhail-Za/Goalkeeper-Claude-skill.git "$env:USERPROFILE\.claude\skills\goalkeeper"
```

If Claude Code was already running, restart it so the new skill is picked up. You can confirm it loaded by listing your skills or typing `/goalkeeper`.

**Project-level install (alternative).** To scope it to a single project (and commit it alongside that project), clone into `<your-project>/.claude/skills/goalkeeper` instead. Project skills require accepting the workspace-trust dialog.

> The skill references its bundled files with `${CLAUDE_SKILL_DIR}`, so paths resolve correctly regardless of where you install it. Just keep the folder named `goalkeeper`.

---

## Install as a plugin (alternative)

Goalkeeper can also be installed as a Claude Code **plugin** from its built-in marketplace. The two install paths differ only in how the command is named:

- **Copy-folder install (above)** gives you the bare `/goalkeeper` command.
- **Plugin install** namespaces the command, so it is invoked as `/goalkeeper:goalkeeper`.

To install as a plugin, add the marketplace and then install the plugin from it:

```
/plugin marketplace add Mikhail-Za/Goalkeeper-Claude-skill
/plugin install goalkeeper@goalkeeper-marketplace
```

Everything else (arguments, behavior, the bundled workflow and templates) is identical to the folder install.

**Maintainers.** The `plugin/` folder duplicates the root skill files (`SKILL.md`, `goalkeeper.workflow.js`, and `templates/`) because a plugin cannot reference files outside its own directory. After changing any of the root files, re-sync the copies by running `scripts/sync-plugin` (`scripts/sync-plugin.ps1` on Windows, `scripts/sync-plugin.sh` on macOS / Linux).

---

## Quick start

Goalkeeper takes a target `repo` and a `contract`. The contract can be a bare goal (the planner builds the rest) or a full list of items.

Ask Claude to run it, for example:

> "Use the **goalkeeper** skill on `/path/to/my-repo` to add CSV export to the report page until the tests pass. Run unattended with a 500k token cap."

Claude reads the skill and launches the loop. The smallest possible invocation is goal-only:

```js
Workflow({ scriptPath: "${CLAUDE_SKILL_DIR}/goalkeeper.workflow.js", args: {
  mode: "build",
  autonomy: "envelope",
  repo: "/path/to/your/repo",
  contract: { goal: "Add CSV export to the report page with full test coverage" },
  contractPath: null,            // optional: absolute path to a JSON file { goal, items[] }. Read at init, bypassing the args channel. Use for LARGE explicit contracts (inline args can truncate).
  checkPaths: ["tests/**"],
  caps: { maxIterations: 20, maxTokens: 500000,
          candidates: 1,         // opt-in best-of-N builders; default 1 = single builder (off)
          repoMap: "off" },      // opt-in repo map; 'off' (default) | 'tree' | 'symbols'
  memoize: false,                // opt-in call-granular crash-resume (skip re-running unchanged builder/verifier calls)
  approveToken: false,           // opt-in: resolve an escalation by writing .goalkeeper/resolution.json instead of re-invoking
  libraryPath: null,             // opt-in: cross-repo verified-pattern library (bank every pass, inject relevant patterns into later builds)
  humanGate: false,              // opt-in: suspend (awaiting-human) for a check's humanPrecondition until a person performs it and writes resolution.json
  fix: null,                     // opt-in: CI-fix mode. { command, shell?, cwd?, env? } -> drive that one red command to green
  diagnosis: null,               // opt-in: a human-proven finding (string or { text, itemId }); builder executes it, re-planning locked
  retro: false,                  // opt-in: append a dated driving-lesson line to LESSONS.md on converge / lesson-worthy halts
  denylist: ["git push","deploy","secrets","external-send"],
  freshStart: false              // optional: archive any existing goalkeeper state (even an unfinished run) and start this task on a clean slate
}})
```

Or hand it an explicit, dependency-ordered contract:

```js
contract: {
  goal: "Add CSV export to the report page with full test coverage",
  items: [
    { id: "export-endpoint", priority: 1, dependsOn: [],
      expectedOutput: "GET /report/export returns 200 with text/csv",
      check: { type: "command", command: "npm test -- export.endpoint" } },
    { id: "csv-formatter",   priority: 2, dependsOn: ["export-endpoint"],
      expectedOutput: "Rows serialize to RFC-4180 CSV, commas and quotes escaped",
      check: { type: "command", command: "npm test -- csv.format" } }
  ]
}
```

For large or explicit contracts, put the contract in a JSON file and pass `contractPath` (an absolute path) instead of inlining it; the file is read at init and never crosses the args channel, so it cannot be truncated. See [`examples/format-bytes/`](examples/format-bytes/) for a worked example that does exactly this.

See [`templates/`](templates/) for the contract schema and worked examples, and [`SKILL.md`](SKILL.md) for the full argument reference.

---

## How it works

A run moves through five phases: **Plan → Setup → Loop → Review → Escalate**.

1. **Plan** (only if you passed a bare goal): a planner decomposes the goal into atomic, independently-checkable items.
2. **Setup**: an adversarial spec-review attacks the contract for gaps before a line is built.
3. **Loop** (one item per round): pick the highest-priority item whose dependencies are green, optionally run a scope checkpoint, build it (with its own prior failures from the `attemptLog` ledger re-injected so it does not repeat them), optionally revise the contract if the builder finds the plan is wrong, verify it independently against the full suite (including an anti-gaming diff inspection), then persist state and revert the round if it regressed anything or gamed the check (saving the discarded diff to `last-attempt-<item>.patch` first).
4. **Review**: when every item passes, run a final full-suite check and an adversarial self-critique. A blocking weakness re-opens the loop (capped); otherwise it converges, possibly flagging minor caveats.
5. **Escalate**: any non-converged stop writes `ESCALATION.md` and pings Telegram if reachable.

State lives in two files under `<repo>/.goalkeeper/`: `plan.json` (runtime: passing items, attempts, fingerprint history, and the per-item `attemptLog` failure ledger) and `contract.json` (the durable working contract). They are separated deliberately so the per-round bookkeeper can never clobber the contract. Both are git-excluded automatically.

### Non-deterministic / hardware-in-the-loop checks

Some checks cannot be deterministic: their pass depends on hardware, timing, a peer device, or the network. For these, a check can declare `nondeterministic: true` with a `passPolicy` (`{ mode: "latch" }`, the default, passes if it succeeds at least once across retries; `{ mode: "k-of-n", k, n }` requires k of n) and an optional `precondition` command run before each attempt. The key idea is **latching**: a PASS proves the code is correct at that code state, so Goalkeeper banks (latches) the git tree-hash where the check passed. A later flaky miss at that *same* tree-hash is then treated as the environment not cooperating, not a code regression: it does not revert the round, does not count toward the 3-retry item-stuck budget, and does not un-converge the run. An item that genuinely never passes still escalates as normal, and the spec-review *requires* an environment-dependent check to carry this declaration so an environmental miss is never silently read as a code failure.

Two related per-check knobs harden the same hardware-in-the-loop case: **shell pinning** (`shell: "pwsh" | "bash" | "cmd" | "sh"`, plus optional `cwd`/`env`) runs the check under exactly that shell and environment, so a build that needs PowerShell is never broken by being run under MSYS; and **pipeline checks** (`{ type: "pipeline", build, deploy, verify, freshBuild? }`) run build → deploy → verify and short-circuit if the build fails, so a failed build is never deployed and a stale artifact cannot masquerade as a passing deploy.

### Reusing a repo / switching tasks

When a run converges it writes a completion report to `<repo>/.goalkeeper/REPORT.md` (the success analog of `ESCALATION.md`: the goal, the passing contract, the commits it made, the iteration count, a summary, and any minor caveats) and seals that run. So you can point Goalkeeper at a **new** task on the **same** repo and it starts fresh: the old converged run is archived under `.goalkeeper/archive/converged-<short-head>/` and the new task begins on a clean slate. Your committed work in the repo is untouched; only the goalkeeper state moves. Re-running with nothing new on a converged repo just returns `already-converged` (it does not redo the work). A halted or in-progress run auto-resumes on the next invocation **only when you hand it the same task**: resume is gated on contract identity (the normalized goal plus the sorted set of item *ids*, so wording tweaks are not a new contract). If you point Goalkeeper at a repo whose run is in-progress (or halted) but pass a **different** contract, it now halts with `contract-mismatch` and asks you to choose rather than silently resuming the wrong work: re-invoke with no contract (or the same one) to continue, `amendContract: true` to replace the contract in place, or `freshStart: true` to abandon and archive the old run and start the new task. (And if `contractPath` is set but the file cannot be read as JSON, the run fails fast with `contractPath-unreadable` rather than silently falling back.) To abandon an **unfinished** run and start a different task, pass `freshStart: true`, which archives whatever state is there and starts clean.

`SKILL.md` documents every stop condition, guard, escalation reason, and argument in detail.

---

## Safety and guarantees

- **Denylist enforced in all modes:** `git push`, `deploy`, `secrets`, and `external-send` are forbidden regardless of configuration. Goalkeeper works inside the target repo and does not reach outside it.
- **A bad round cannot corrupt good work:** any non-passing round is reset to the last known-green commit.
- **Set a `maxTokens` cap.** Each run spawns several agents per round (builder, verifier, bookkeeper, plus planner and self-critique). A small run can still cost a few hundred thousand tokens. The budget backstop is your hard ceiling.
- **Recommended for first runs:** point it at a feature branch, use `autonomy: "envelope"` with conservative caps, and review the commits it produces.

**Kill switch:** stop the workflow from `/workflows`. To reset Goalkeeper's state, delete the `<repo>/.goalkeeper/` directory; the next invocation starts fresh.

---

## Limitations

Three things are deferred, all sharing the same safety property (a bad round can never corrupt good work):

1. **Concurrent execution is deferred.** Scheduling is dependency-*aware* (items run in dependency order), but execution is **sequential**, one item per round (best-of-N, when enabled, also runs its N candidates for a single item sequentially). Running *different* items in parallel would need isolated worktrees, which the runtime does not provide for an arbitrary target repo.
2. **No per-round git worktree yet.** The loop uses snapshot-HEAD plus reset-on-fail on the live repo.
3. **The wall-clock cap is soft.** The hard backstops are the iteration count and the token budget.

This is a young skill. The core build/verify/converge loop, the planning front-end, and the durable two-file state are validated; some of the rarer branches (mid-run re-plan, self-critique adding work, scope-check recommending a stop) are reviewed but exercised less. Run it on a branch, with caps, and read what it commits.

---

## Repository layout

```
goalkeeper/
├── SKILL.md                 # the skill definition + full documentation
├── goalkeeper.workflow.js   # the deterministic orchestrator (the "brain")
├── templates/
│   ├── contract.schema.json     # JSON Schema for a done-contract
│   ├── contract.example.json    # a worked, dependency-ordered example
│   ├── contract.json.example    # the persisted working-contract shape
│   ├── plan.json.example        # the persisted runtime-state shape
│   ├── worklog.md.example       # the append-only per-round log
│   └── ESCALATION.md            # the human-escalation template
├── README.md
└── LICENSE
```

---

## Prior art

Goalkeeper's stop conditions and self-correction layer draw on published agentic-loop work: the "Ralph" autonomous loop technique, OpenHands' stuck-loop detection, Aider's reflection cap, the Self-Refine and evaluator-optimizer patterns, Reflexion's verbal-reflection memory, and Semantic Kernel's distinct terminal states. The "contract is the product" spec-review gate and the deterministic-caps-in-code design are the core ideas tying them together.

Built with [Claude Code](https://claude.com/claude-code).

## License

[MIT](LICENSE).
