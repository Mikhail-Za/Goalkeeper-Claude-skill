# Goalkeeper

**An autonomous build / audit / verify loop for [Claude Code](https://claude.com/claude-code) that runs until a machine-checkable contract passes, and stops itself the moment it stops making real progress.**

Goalkeeper is a Claude Code skill. You hand it a repository and either a goal or a full "done-contract" (a list of items, each with an objective pass/fail check). It then loops: build one item, verify it with an independent check, and repeat, refusing to declare victory on anything but an external check passing. Its defining feature is the opposite of laziness: an eager agentic loop will happily run forever, cheat its own tests, or converge perfectly on the wrong target, so Goalkeeper is built to **fail loudly and on disk** instead, with deterministic stop conditions wired into code rather than into a model's good intentions.

---

## Why this exists

Most "agent in a loop" setups share the same failure mode: nothing in the loop ever asks *"am I actually making progress?"*. The agent keeps going, retries the same broken approach, edits the test to make it pass, or quietly decides it is done when it is not. Goalkeeper addresses that head-on:

- **"Done" is always an external check passing,** never the builder agent's self-report. A separate verifier runs the checks.
- **The loop cannot spin forever.** Item-stuck (3 retries), no-progress, oscillation, and a hard iteration/token budget are all evaluated in code at the end of every round.
- **It cannot cheat.** The builder may not edit its own check files; any round that regresses a previously-green check is reset.
- **When it gets stuck, it tells you.** It writes a structured `ESCALATION.md` to disk (and optionally pings Telegram) with the blocking item, what was tried, and one-tap options to unblock it.

It also has a planning and self-correction layer built in (a "fable-mode" workflow): give it just a goal and it plans the contract; once everything is green it runs an adversarial self-critique to catch what the checks missed; it periodically asks whether finishing is still worth it; and a builder that discovers the plan is wrong can request the contract be revised mid-run. Every one of those loop-extending features is capped so the skill that prevents infinite loops does not grow one.

---

## Key features

| Feature | What it does |
| --- | --- |
| **Deterministic stop conditions** | item-stuck (3 retries), no-progress, oscillation, and a budget backstop are enforced in code, not prompts. A "ran out of budget" state is kept distinct from "converged". |
| **Contract-is-the-product spec review** | Before any code is written, an adversarial critic attacks the contract for gaps and ambiguity, because a perfectly-green run against the wrong checks is worse than a failed one. |
| **Independent verifier** | A separate agent, which does not trust the builder, runs each item's check plus the full suite and a regression re-run of every passing item. |
| **Anti-destruction guards** | Write-protected check files, a no-placeholder rule, and reset-to-last-good on any non-passing round. The working tree never ratchets backward into a broken state. |
| **Durable on-disk state** | Two state files under the target repo survive crashes, `/clear`, dropped channels, and reboots. A fresh invocation resumes exactly where the last one stopped. |
| **Human escalation** | Any non-converged stop writes a structured `ESCALATION.md` (system of record) and best-effort pings Telegram (a doorbell, never the record). |
| **Planning front-end** | Hand it a bare goal and a planner decomposes it into an ordered contract with expected outputs, checks, and dependencies. |
| **Self-critique gate** | When all checks are green, an adversarial critic hunts for what the checks missed. Green is not the same as good. |
| **Scope checkpoint** | Periodically steps back and asks whether finishing is still worth the remaining cost. |
| **Living re-plan + dependency scheduling** | The contract is mutable and durable; items can declare `dependsOn` and are scheduled in dependency order. |

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
  caps: { maxIterations: 20, maxTokens: 500000 },
  denylist: ["git push","deploy","secrets","external-send"]
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
3. **Loop** (one item per round): pick the highest-priority item whose dependencies are green, optionally run a scope checkpoint, build it, optionally revise the contract if the builder finds the plan is wrong, verify it independently against the full suite, then persist state and revert the round if it regressed anything.
4. **Review**: when every item passes, run a final full-suite check and an adversarial self-critique. A blocking weakness re-opens the loop (capped); otherwise it converges, possibly flagging minor caveats.
5. **Escalate**: any non-converged stop writes `ESCALATION.md` and pings Telegram if reachable.

State lives in two files under `<repo>/.goalkeeper/`: `plan.json` (runtime: passing items, attempts, fingerprint history) and `contract.json` (the durable working contract). They are separated deliberately so the per-round bookkeeper can never clobber the contract. Both are git-excluded automatically.

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

1. **Concurrent execution is deferred.** Scheduling is dependency-*aware* (items run in dependency order), but execution is **sequential**, one item per round. Running independent items in parallel needs per-round git worktrees.
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
