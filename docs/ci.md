# Running Goalkeeper in CI (headless)

Goalkeeper is designed to run unattended, and that makes it a natural fit for CI. The pitch is simple: commit a contract, run Goalkeeper headless, and it either **builds the feature to green and commits its work**, or it **writes a structured `ESCALATION.md`** for a human to review on the PR. There is no silent failure and no half-finished "looks done" state: every non-converged stop is durable on disk.

This guide covers how to wire that up. A ready-to-adapt GitHub Actions workflow lives alongside it at [`.github/workflows/goalkeeper.yml.example`](../.github/workflows/goalkeeper.yml.example).

> **A note on certainty.** Goalkeeper's own behavior (its state files, its escalation contract, its caps and denylist) is documented here from the skill itself and is accurate. The headless invocation below was **confirmed by a live end-to-end run** (2026-07-02, Claude Code 2.1.198): the workflow runtime launched under `claude -p`, the least-privilege `--allowedTools` set sufficed with no permission wedge, the token cap held, and the halt path wrote `ESCALATION.md` exactly as the wrapper contract expects. Claude Code moves fast, so re-check `claude --help` in your runner if versions have moved on, but this recipe is no longer speculative.

---

## The concept: build-or-escalate

A Goalkeeper run in CI is a state machine with exactly two outcomes you care about:

- **Converged → work is committed.** Every contract item passed its independent check, the final full-suite check was green, and the adversarial self-critique found no blocking weakness. Goalkeeper has committed each item as it built it, so the new commits are sitting on the checked-out branch, ready for a CI wrapper to push or open a PR. A converged result can still carry `weaknesses[]` and a `selfCritiqueSummary` of *minor* flagged caveats, so read them, but the work is real and the tree is clean.

- **Halted → `ESCALATION.md` is written.** On any non-converged stop (a stuck item, no-progress, oscillation, budget exhaustion, a blocking spec gap, a dependency deadlock, a scope-checkpoint stop, an unactionable self-critique, and so on) Goalkeeper writes `<repo>/.goalkeeper/ESCALATION.md` to disk and stops. This file is the system of record. It restates the goal, shows progress so far, names the specific blocking item, includes the actual failing check output, lists what was already tried, and gives exact resume instructions.

The job of your CI wrapper is to **detect which of these two happened and surface it.** Concretely: after the run, check for `ESCALATION.md`. If it exists, the run halted, fail the job, and publish the file so a human sees it on the PR. If it does not exist, the run converged, and you inspect (and push) the new commits.

```
                    ┌─────────────────────────┐
   commit contract  │  claude -p  ->  goalkeeper │
   ───────────────► │     (headless build loop)  │
                    └───────────┬─────────────┘
                                │
              ┌─────────────────┴──────────────────┐
              ▼                                     ▼
   .goalkeeper/ESCALATION.md                 no ESCALATION.md
        EXISTS                                    present
              │                                     │
              ▼                                     ▼
     halted: fail the job,               converged: inspect new
     upload the file, human              commits; wrapper pushes
     reviews it on the PR                / opens the PR
```

Note the asymmetry that makes this safe: Goalkeeper commits its own *work*, but it never pushes, never opens a PR, and never deploys (those are on the hard denylist, see Caveats). The "build" half is Goalkeeper's; the "ship" half is your wrapper's. That separation is deliberate and you should preserve it.

---

## Prerequisites

Goalkeeper drives Claude Code's **dynamic workflows** runtime, which is gated. All of the following must hold in the runner:

- **Claude Code v2.1.154 or later** installed in the runner. Dynamic workflows were introduced in 2.1.154; earlier versions cannot run the skill. Verify with `claude --version`.
- **An API credential in the environment.** The standard choice for CI is an `ANTHROPIC_API_KEY` secret. Claude Code reads `ANTHROPIC_API_KEY` from the environment, and in non-interactive (`-p`) mode it is used when present. Other supported providers (Amazon Bedrock, Google Vertex AI, Microsoft Foundry) work too but are configured differently and are out of scope here. A long-lived OAuth token (`CLAUDE_CODE_OAUTH_TOKEN`, generated via `claude setup-token`) is an alternative credential, but the API-key path is the simplest for CI.
- **A paid or API plan.** Dynamic workflows are not available on the free tier. They are on by default for Max / Team / eligible Enterprise; an Anthropic API account works as well.
- **Dynamic workflows enabled.** On by default for Max / Team / Enterprise. On Pro they must be turned on (`/config`, the "Dynamic workflows" row), which is an interactive step and therefore awkward in CI, so prefer an API or Max/Team/Enterprise credential for headless use. The feature can also be force-disabled by `"disableWorkflows": true` in settings or `CLAUDE_CODE_DISABLE_WORKFLOWS=1` in the environment; make sure neither is set in the runner.
- **The git repository checked out.** Goalkeeper operates on a real working tree and commits each item it builds, so the repo must be checked out (with git history, not a shallow export that breaks commits) before the run. The skill itself must also be installed where Claude Code can find it (for example `~/.claude/skills/goalkeeper`, or committed into the project at `.claude/skills/goalkeeper`). See the repository README for install options.

---

## The invocation

You invoke Goalkeeper headless by giving `claude -p` a natural-language instruction that tells it to use the **goalkeeper** skill against a contract file you committed to the repo. The contract file is referenced through Goalkeeper's `contractPath` argument (an absolute path to a JSON file holding `{ goal, items[] }`), which is read straight from disk at init and is the robust way to pass a real, fully-specified contract.

### Commit a contract file

Put your done-contract in the repo, for example at `.goalkeeper-ci/contract.json`:

```json
{
  "goal": "Add CSV export to the report page with full test coverage",
  "items": [
    {
      "id": "export-endpoint",
      "priority": 1,
      "dependsOn": [],
      "expectedOutput": "GET /report/export returns 200 with text/csv",
      "check": { "type": "command", "command": "npm test -- export.endpoint" }
    },
    {
      "id": "csv-formatter",
      "priority": 2,
      "dependsOn": ["export-endpoint"],
      "expectedOutput": "Rows serialize to RFC-4180 CSV, commas and quotes escaped",
      "check": { "type": "command", "command": "npm test -- csv.format" }
    }
  ]
}
```

See `templates/contract.schema.json` and `templates/contract.example.json` in this repo for the full shape. Committing the contract means the run is reproducible and the contract is reviewable on the same PR as the result.

### The example prompt

Hand Claude a prompt that names the skill, points it at the committed contract via `contractPath`, and sets the run's autonomy and caps. The prompt is the instruction; Claude then calls the Workflow tool with the goalkeeper script under the hood.

```
Use the goalkeeper skill to build the feature defined by the contract in this
repository. Invoke it in build mode with envelope autonomy. Pass the contract by
file: set contractPath to the absolute path of .goalkeeper-ci/contract.json in
this checkout (do NOT inline the contract). Operate on this repository as the
target repo. Set caps.maxTokens to 400000 as a hard budget ceiling. Keep the
denylist at its defaults (git push, deploy, secrets, external-send). Run
unattended: do not pause for approval. If the run cannot converge, let Goalkeeper
write ESCALATION.md and stop; do not try to work around a halt.
```

A few things to keep right in that prompt:

- **`contractPath`, not inline.** Tell Claude to pass the contract by absolute path. A large inline contract can be truncated by the workflow arg channel; a file read from disk cannot.
- **`mode: build`, `autonomy: envelope`.** Build mode is the hardened path. Envelope autonomy runs unattended and halts only on the hard triggers, which is exactly what you want in CI. (Leash mode pauses for per-round approval and is not appropriate for an unattended run.)
- **A `maxTokens` cap is mandatory.** See Caveats. Set it in the prompt as shown, or via the skill's `caps.maxTokens`.

### The `claude -p` flags (confirmed by a live run, 2026-07-02)

The shape of the headless command is:

```bash
# CONFIRMED end-to-end on Claude Code 2.1.198 (Windows runner, user-level skill install).
claude -p "<the prompt above>" \
  --allowedTools "Read,Edit,Write,Bash,Glob,Grep,Workflow,TaskCreate,TaskUpdate,ToolSearch" \
  --output-format text
```

A wrap-safe variant that avoids shell-quoting a long prompt (and survives terminal line-wrapping): commit the prompt to a file and pipe it in. `claude -p` reads the prompt from stdin:

```bash
cat ci-prompt.txt | claude -p \
  --allowedTools "Read,Edit,Write,Bash,Glob,Grep,Workflow,TaskCreate,TaskUpdate,ToolSearch" \
  --output-format text
```

What the live confirmation run established:

- **The dynamic-workflows runtime works headless.** The goalkeeper Workflow launched under `claude -p`, spawned its agents, and enforced its caps (the run reported ~123k tokens against a 150k `caps.maxTokens` ceiling).
- **The least-privilege `--allowedTools` set above is sufficient.** No permission wedge, no hang, and no `--dangerously-skip-permissions` needed. The blunt fallback (`--dangerously-skip-permissions`, equivalently `--permission-mode bypassPermissions`) remains available for an **isolated, throwaway CI runner** whose environment differs, and should never be used on a developer machine.
- **The wrapper contract holds.** The confirmation run halted at spec-review (`contract-incomplete`), and the halt produced exactly what this guide promises: `ESCALATION.md` on disk naming the gaps, a clean tree, no commits, and durable state in `plan.json`. Build-or-escalate is real headless, in both directions.
- **There is no `--max-tokens` CLI flag.** Token budgeting for the *build loop* is not a Claude Code CLI flag; it is Goalkeeper's own `caps.maxTokens`, set in the prompt / skill args (above). (Claude Code's `--max-turns` bounds conversation turns, not workflow token spend, and is not the right lever here.)

Environments vary (auth method, OS, plan tier), so a first dry run on a scratch branch is still good hygiene, but the default expectation is now that the flag set above works as written.

---

## How to read the result

After the `claude -p` step returns, do not trust its exit code alone to mean "the feature is done." Read Goalkeeper's on-disk state, which is authoritative:

1. **Check for `<repo>/.goalkeeper/ESCALATION.md`.**
   - **If it exists, the run halted.** A human is needed. Do not push anything. Surface the file (print it to the log and/or upload it as a build artifact) and fail the job so the PR is clearly blocked. The file names the blocking item, shows the failing check output, and gives resume instructions; that is what the reviewer reads.
   - **If it does not exist, the run converged.** Inspect the new commits Goalkeeper produced on the branch (for example `git log` against the pre-run HEAD). The working tree will be clean (a pass with uncommitted changes is not a durable pass, so a clean tree is part of convergence). Your wrapper can then push the branch / open the PR.

2. **Read the converged caveats, if any.** Even on convergence, Goalkeeper may have flagged minor limitations in the run output (`weaknesses[]` / `selfCritiqueSummary`). These did not block convergence but are worth putting in front of the reviewer.

3. **Optionally inspect `<repo>/.goalkeeper/worklog.md`** for the per-round narrative, and `plan.json` / `contract.json` for the exact runtime state and the contract actually built (which can differ from what you committed if the planner or a re-plan revised it). These are written under the target repo and are git-excluded, so they will not pollute the diff.

The single most important rule: **presence of `ESCALATION.md` is the halt signal.** A green `claude -p` exit with an `ESCALATION.md` on disk still means "halted, human needed," and a CI wrapper that only checks the process exit code will miss it. Check the file.

---

## Caveats

- **Always set a `maxTokens` cap.** Each round spawns several agents (builder, verifier, bookkeeper, plus the planner and self-critic when they run). Without a cap a stuck-but-not-detected run can burn budget. `caps.maxTokens` is the hard ceiling and the budget backstop routes to a *distinct* "halted, not done" terminal state, never a fake success. Set it. (See cost note below for sizing.)

- **Goalkeeper does not push, deploy, or send. Your wrapper does.** The denylist (`git push`, `deploy`, `secrets`, `external-send`) is enforced in every mode and cannot be configured off. That is a feature: it means the autonomous loop physically cannot push to a remote, ship a deploy, or exfiltrate. The consequence for CI is that **opening the PR / pushing the branch is the CI wrapper's job, not Goalkeeper's.** Goalkeeper builds and commits locally; the surrounding workflow step (running with its own, scoped credentials) is what moves that work off the runner. Do not try to get Goalkeeper to push.

- **Cost.** A real build is not cheap. Expect on the order of **250k to 360k tokens per real build** as a rough planning figure, more for larger or harder contracts. Size your `maxTokens` cap with headroom above the build you expect, but low enough to stop a runaway. Budget the API spend accordingly before wiring this into a frequently-triggered workflow. (This range is a rough guide from typical runs, not a guarantee; your contract's size and difficulty dominate.)

- **The runtime is gated.** The whole thing depends on the dynamic-workflows runtime being available: the right Claude Code version (2.1.154+), a non-free plan, and the feature enabled (not disabled by setting or env var). If any of those is off in the runner, the skill will not run. Treat "is the runtime available in this runner" as a precondition you verify, not an assumption.

- **Run it on a branch first.** As with any autonomous-build tool, point it at a feature branch, use envelope autonomy with conservative caps, and review what it commits before you trust it on anything that matters. The recommended posture for a first CI integration is `workflow_dispatch` (manual trigger) on a scratch branch, reading the result by hand, before considering any automatic trigger.

---

## See also

- [`.github/workflows/goalkeeper.yml.example`](../.github/workflows/goalkeeper.yml.example): a sample GitHub Actions workflow implementing exactly this flow (manual trigger, install, run, then upload-`ESCALATION.md`-and-fail-on-halt).
- [`../SKILL.md`](../SKILL.md): the full argument reference, every stop condition, every escalation reason, and the on-disk state contract.
- [`../README.md`](../README.md): install, requirements, and the quick start.
