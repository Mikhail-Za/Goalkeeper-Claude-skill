# The mutation cycle (phase 2)

Run this ONLY when the calibrated baseline shows gradient (verdict accuracy below 1.0 after failures have
been adjudicated as genuine rubric defects, not probe defects). Mutating against a saturated benchmark
optimizes noise.

## Status

2026-07-01: baseline of the shipped rubric scored **16/16** (block recall 10/10, approve rate 6/6) on the
calibrated suite, so the first mutation cycle was correctly NOT run. Notable: the four initial "failures"
were all adjudicated as probe defects; the production reviewer empirically out-audited the static probe
audit (it executed harnesses, stubbed binaries, and proved a pwsh exit-code hole). The suite was fixed to
its findings.

## Procedure

1. Confirm gradient: `node eval/score.mjs <results> eval/probes` fails, and each failure has been
   adjudicated once (see README calibration caveat) as a rubric defect.
2. Mutate. Give an agent (strongest available model) this brief plus the scorecard, the failing probes'
   prompts and verdicts, and LESSONS.md if present:

   > You are improving the adversarial spec-review rubric for an autonomous build loop. Here is the current
   > rubric core (rubrics/rubric-baseline.txt), the benchmark scorecard, and the failing probes with the
   > reviewer's verdicts. Propose N=3 REVISED rubric cores as complete replacement texts. Constraints: only
   > the rubric core may change (never the frame, the CONTRACT_REVIEW schema, or the resolution contract);
   > each variant must state a one-line hypothesis for why it fixes the failures WITHOUT sacrificing the
   > probes that currently pass (over-blocking and under-blocking are equally scored); keep or sharpen the
   > class rules (sentinel gameability, nondeterminism declaration, distrust-the-check); do not grow the
   > text by more than ~30 percent.

   Write each variant to `eval/rubrics/rubric-<name>.txt`.
3. Score each variant: materialize + run gepa-eval.workflow.js + score.mjs, exactly as the baseline
   (README "Scoring a rubric"). Roughly 500k tokens per variant.
4. Select on verdict accuracy first; break ties by (a) fewer spurious gaps on approve probes, (b) shorter
   rubric text. This is a Pareto choice; record the losing scorecards next to the winner.
5. Gate: patch the winning rubric into a SCRATCH copy of goalkeeper.workflow.js and run the Tier-B recipes
   (probes-tierB.md). Any Tier-B regression kills the variant.
6. Propose the winning rubric to a human as a diff against rubric-baseline.txt. A human applies it to the
   engine, regenerates rubric-baseline.txt, and re-runs `check-rubric-sync.mjs`. The loop never edits the
   live engine.

## Growing the benchmark instead

When the suite saturates (as it has), the productive move is usually new, harder probes rather than rubric
mutation: take real contracts from production runs that halted or converged surprisingly, strip them to
minimal form, bake the adjudicated verdict in as ground truth, and add them to eval/probes/. Every added
probe compounds the regression suite even if the rubric never changes.
