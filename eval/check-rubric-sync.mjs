// Drift guard: every line of the baseline rubric must still exist verbatim in the engine's specReviewPrompt.
// If this fails, the engine rubric changed without regenerating rubric-baseline.txt (or vice versa), and any
// eval scored against the stale baseline is measuring the wrong thing. Run before every eval.
// Usage: node eval/check-rubric-sync.mjs [enginePath] [rubricPath]
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const here = path.dirname(fileURLToPath(import.meta.url))
const enginePath = process.argv[2] || path.join(here, '..', 'goalkeeper.workflow.js')
const rubricPath = process.argv[3] || path.join(here, 'rubrics', 'rubric-baseline.txt')

// The engine embeds rubric lines as single-quoted JS strings, so apostrophes appear as \' in source.
const engine = fs.readFileSync(enginePath, 'utf8').replace(/\\'/g, "'")
const lines = fs.readFileSync(rubricPath, 'utf8').split(/\r?\n/).filter(l => l.trim().length > 0)

let missing = 0
for (const line of lines) {
  if (!engine.includes(line)) {
    console.error('MISSING FROM ENGINE: ' + line)
    missing++
  }
}
if (missing) {
  console.error('RUBRIC DRIFT: ' + missing + '/' + lines.length + ' baseline lines not found in ' + enginePath)
  process.exit(1)
}
console.log('RUBRIC IN SYNC: all ' + lines.length + ' baseline lines present in the engine')
