// Mechanical scorecard: compare collected reviewer verdicts against each probe's ground truth.
// Primary metric is VERDICT ACCURACY (block probes must be rejected, approve probes must be approved) -- fully
// mechanical, no LLM judge, so the score cannot be Goodharted by eloquent gap text. mustFlagAny keyword hits are
// reported as ADVISORY quality only and never affect the score.
// Usage: node eval/score.mjs <resultsPath> [probesDir] [scorecardOutPath]
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const here = path.dirname(fileURLToPath(import.meta.url))
const resultsPath = process.argv[2]
const probesDir = process.argv[3] || path.join(here, 'probes')
const outPath = process.argv[4] || null
if (!resultsPath) { console.error('usage: node score.mjs <resultsPath> [probesDir] [outPath]'); process.exit(1) }

const results = JSON.parse(fs.readFileSync(resultsPath, 'utf8'))
const byId = {}
for (const r of results.verdicts || []) byId[r.id] = r

const probes = fs.readdirSync(probesDir).filter(f => f.endsWith('.json'))
  .map(f => JSON.parse(fs.readFileSync(path.join(probesDir, f), 'utf8')))
  .filter(p => p.tier === 'A')

const rows = []
let blockOK = 0, blockN = 0, approveOK = 0, approveN = 0
for (const p of probes) {
  const r = byId[p.name]
  const got = r && r.verdict ? (r.verdict.approved ? 'approve' : 'block') : 'MISSING'
  const ok = got === p.expect
  if (p.expect === 'block') { blockN++; if (ok) blockOK++ } else { approveN++; if (ok) approveOK++ }
  const gapsText = r && r.verdict ? (r.verdict.blockingGaps || []).join(' | ').toLowerCase() : ''
  const flagHits = (p.mustFlagAny || []).filter(k => gapsText.includes(String(k).toLowerCase()))
  rows.push({
    probe: p.name, expect: p.expect, got: got, ok: ok,
    gaps: r && r.verdict ? (r.verdict.blockingGaps || []).length : -1,
    flagHits: flagHits.length + '/' + (p.mustFlagAny || []).length,
  })
}
rows.sort((a, b) => (a.ok === b.ok ? a.probe.localeCompare(b.probe) : a.ok ? 1 : -1))

const scorecard = {
  resultsPath: resultsPath,
  probes: rows.length,
  verdictAccuracy: rows.length ? +(((blockOK + approveOK) / rows.length).toFixed(3)) : 0,
  blockRecall: blockN ? +((blockOK / blockN).toFixed(3)) : null,      // caught the planted flaws
  approveRate: approveN ? +((approveOK / approveN).toFixed(3)) : null, // did not over-block good contracts
  failures: rows.filter(r => !r.ok).map(r => r.probe),
  rows: rows,
}
console.log('VERDICT ACCURACY: ' + scorecard.verdictAccuracy +
  '  (block recall ' + scorecard.blockRecall + ' on ' + blockN + '; approve rate ' + scorecard.approveRate + ' on ' + approveN + ')')
for (const r of rows) console.log((r.ok ? 'OK  ' : 'FAIL') + '  ' + r.probe.padEnd(28) + ' expect=' + r.expect.padEnd(7) + ' got=' + r.got.padEnd(7) + ' gaps=' + String(r.gaps).padEnd(3) + ' flags=' + r.flagHits)
if (outPath) { fs.writeFileSync(outPath, JSON.stringify(scorecard, null, 2)); console.log('scorecard -> ' + outPath) }
process.exit(scorecard.failures.length ? 1 : 0)
