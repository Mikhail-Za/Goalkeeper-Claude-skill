# Goalkeeper eval harness (GEPA-style rubric optimization)

A benchmark suite for goalkeeper's adversarial **spec-review rubric**, plus the machinery to score rubric
variants against it. The design rule that makes the results trustworthy: **synthetic tasks, real executions**.
Probes are hand-authored with known ground truth; every verdict comes from a real reviewer agent running the
real prompt shape. No traces are ever fabricated.

## Layout

- `probes/*.json` -- Tier-A probes. Each is a tiny repo + done-contract with baked-in ground truth:
  `expect: "block"` (one deliberately planted flaw the reviewer must catch) or `expect: "approve"`
  (a well-authored contract a miscalibrated reviewer would wrongly block). The approve side matters as much
  as the block side: it measures over-blocking, which is a real production failure mode.
- `probes-tierB.md` -- Tier-B probes: full goalkeeper runs (build/verify/anti-gaming). Expensive, so they run
  once as a no-regression gate on a winning variant, not per-variant.
- `rubrics/rubric-baseline.txt` -- the engine's current rubric core, extracted verbatim. Variants are siblings
  (`rubric-<name>.txt`).
- `check-rubric-sync.mjs` -- drift guard: fails if the baseline no longer matches the engine source. Run first.
- `materialize.mjs` -- builds, for one rubric file, the per-probe repos and reviewer prompts (an exact mirror
  of the engine's `specReviewPrompt` frame).
- `gepa-eval.workflow.js` -- Claude Code dynamic workflow: one reviewer agent per probe, verdicts collected to
  a results JSON.
- `score.mjs` -- mechanical scorecard. Primary metric is verdict accuracy (block recall + approve rate);
  keyword hits are advisory only. No LLM judge anywhere in the score, so the metric cannot be Goodharted.

## Scoring a rubric (one variant)

```bash
node eval/check-rubric-sync.mjs                                   # drift guard (baseline only)
node eval/materialize.mjs C:/tmp/gk-eval-baseline eval/rubrics/rubric-baseline.txt
# then, from Claude Code, run the workflow:
#   Workflow({ scriptPath: "eval/gepa-eval.workflow.js", args: {
#     promptsDir: "C:/tmp/gk-eval-baseline/prompts",
#     ids: <contents of C:/tmp/gk-eval-baseline/ids.json>,
#     resultsPath: "C:/tmp/gk-eval-baseline/results.json" } })
node eval/score.mjs C:/tmp/gk-eval-baseline/results.json eval/probes C:/tmp/gk-eval-baseline/scorecard.json
```

## The GEPA loop (phase 2)

1. Score the baseline. If it is already perfect on every probe there is no gradient: either harden the probes
   or accept the rubric as locally optimal. Do not mutate against a saturated benchmark.
2. A mutator agent reads the scorecard failures (plus LESSONS.md if present) and proposes 2-3 rubric variants
   as `rubrics/rubric-<name>.txt`. Only the rubric core mutates; the frame, schema, and resolution contract
   are fixed.
3. Materialize + score each variant. Select on verdict accuracy first, gap quality and prompt length second
   (a Pareto choice, not a single number).
4. A winning variant must pass the Tier-B no-regression gate (full goalkeeper runs on a scratch engine copy
   with the variant patched in) before it is proposed, as a diff, for a human to approve into the engine.
   The loop never edits the live engine itself.

## Baseline result (2026-07-01)

The shipped rubric scored **16/16** on the calibrated suite (block recall 10/10, approve rate 6/6);
`baseline-scorecard-2026-07-01.json` is the reference scorecard. Calibration history: the first run scored
12/16, and all four failures were adjudicated as PROBE defects (wrong ground truth or broken fixture
internals) that the reviewer had caught correctly, including empirical findings (an unrunnable harness, a
pwsh native-exit-code hole, a PATH-hijackable binary). The probes were fixed to the reviewer's findings and
the suite re-scored clean. Mutation is therefore parked until the suite grows harder probes (see
MUTATION.md).

## Calibration caveat

A baseline failure can mean the probe is wrong rather than the rubric (mis-planted flaw, an approve probe with
a genuine unnoticed gap). First baseline run: adjudicate every failure once, fix probe defects, and only then
treat the suite as ground truth. Reviewer verdicts also carry some run-to-run variance; near-threshold probes
deserve a second opinion before being trusted to discriminate.
