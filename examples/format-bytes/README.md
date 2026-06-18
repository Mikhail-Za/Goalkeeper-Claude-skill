# Worked example: `format_bytes`

This is a runnable, real example of goalkeeper building a feature to a
write-protected test suite. It is not a mock-up. The files here are exactly
what came out of an actual `mode: "build"` run: the contract that was supplied,
the test suite that defined "done," and the implementation goalkeeper wrote to
make every check pass.

## What it does

goalkeeper implements `format_bytes(num_bytes)` in `format_bytes.py`. The
function turns a raw byte count into a human-readable size string:

- `format_bytes(512)` returns `"512 B"`
- `format_bytes(1024)` returns `"1.0 KB"`
- `format_bytes(1536)` returns `"1.5 KB"`
- `format_bytes(5242880)` returns `"5.0 MB"`

The goal is to make the `unittest` suite in `tests/` pass. The critical
constraint: `tests/` is WRITE-PROTECTED. The build run sets
`checkPaths: ["tests"]`, which tells goalkeeper that everything under `tests/`
is the spec and may not be touched. goalkeeper therefore has to write the
implementation to satisfy the assertions. It cannot edit, weaken, or delete a
test to make the run go green. The only path to "done" is real code that
actually produces the expected strings.

## The contract

The done-contract is supplied via a FILE, `contract.json`, passed with the
`contractPath` argument. Passing the contract as a file is the robust way to
hand goalkeeper a full, explicit contract: the entire JSON object travels on
disk and bypasses the `args` channel, so there is no escaping or truncation to
worry about for anything non-trivial.

The contract has three items, each with a machine-checkable command and an
explicit `dependsOn` ordering:

| id | priority | dependsOn | check |
| --- | --- | --- | --- |
| `basic-units` | 1 | (none) | `python -m unittest -q tests.test_format_bytes.TestBasic` |
| `rounding` | 2 | `basic-units` | `python -m unittest -q tests.test_format_bytes.TestRounding` |
| `error-handling` | 3 | `basic-units` | `python -m unittest -q tests.test_format_bytes.TestErrors` |

`basic-units` covers the byte/unit boundaries (`0 B`, `512 B`, `1023 B`, and
`1.0 KB` / `1.0 MB` / `1.0 GB` at the 1024-power lines). `rounding` and
`error-handling` both depend on it, so they are only attempted once the base
behavior holds: `rounding` pins the one-decimal formatting, and
`error-handling` requires a `ValueError` on `None`, on negative input, and on a
non-integer input. Each item carries `allowTestEdit: false`, reinforcing the
write-protection at the contract level.

## How to run

```js
Workflow({ scriptPath: "${CLAUDE_SKILL_DIR}/goalkeeper.workflow.js", args: {
  mode: "build", autonomy: "envelope",
  repo: "/absolute/path/to/examples/format-bytes",
  contractPath: "/absolute/path/to/examples/format-bytes/contract.json",
  checkPaths: ["tests"],
  caps: { maxIterations: 15, maxTokens: 600000 },
  denylist: ["git push","deploy","secrets","external-send"]
}})
```

To try it yourself: copy this folder somewhere, run `git init` and commit, then
run the call above with the real absolute paths substituted in. The included
`format_bytes.py` is already the finished result. If you want to watch
goalkeeper rebuild it from scratch, first delete its body back to a
`raise NotImplementedError` stub, then run the build.

## The result

The run converged in a single build round. All three contract items
(`basic-units`, `rounding`, `error-handling`) passed, and all 12 tests in the
suite came up green.

## Self-critique in action

Green is not the same as good, but you also do not want goalkeeper inventing
busywork. This run is a clean example of that line.

Once everything was passing, goalkeeper's adversarial self-critique probed
beyond the contract and found a real edge case the tests never covered:

- `format_bytes(float('nan'))` returns `'nan B'`
- `format_bytes(float('inf'))` returns `'inf YB'`

Neither raises. The reason is structural: `NaN` fails both the `< 0` and the
`< 1024` comparisons (every comparison against `NaN` is false), so it slips past
the validation guards and falls through the scaling loop, and `inf` runs the
scaling loop all the way to the largest unit.

goalkeeper correctly judged this NON-blocking. The contract only specified
`None`, negative, and non-integer inputs. It never mentioned `NaN` or `inf`, so
hardening against them is out of scope for "done" on this run. Rather than fail
a converged build over an unspecified case, or silently edit the spec to chase
it, goalkeeper surfaced it as an OPTIONAL hardening item for a human to decide
on. That is the intended judgment: ship what the contract asked for, and report
the thing it honestly found, without conflating the two.
