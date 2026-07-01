// Materialize review probes into runnable form: for each eval/probes/*.json, write (a) the probe's repo files
// into <out>/repos/<name>/ and (b) a reviewer prompt into <out>/prompts/<name>.prompt.txt that mirrors the
// engine's specReviewPrompt frame EXACTLY (same frame lines, same rubric core from the given rubric file), so a
// score against these prompts measures the rubric as production runs it. check-rubric-sync.mjs guards drift.
// Usage: node eval/materialize.mjs <outDir> [rubricPath] [probesDir]
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const here = path.dirname(fileURLToPath(import.meta.url))
const outDir = process.argv[2]
const rubricPath = process.argv[3] || path.join(here, 'rubrics', 'rubric-baseline.txt')
const probesDir = process.argv[4] || path.join(here, 'probes')
if (!outDir) { console.error('usage: node materialize.mjs <outDir> [rubricPath] [probesDir]'); process.exit(1) }

const rubric = fs.readFileSync(rubricPath, 'utf8').trimEnd()
const probes = fs.readdirSync(probesDir).filter(f => f.endsWith('.json'))
  .map(f => JSON.parse(fs.readFileSync(path.join(probesDir, f), 'utf8')))
  .filter(p => p.tier === 'A')

fs.mkdirSync(path.join(outDir, 'prompts'), { recursive: true })
const ids = []
for (const p of probes) {
  const repoDir = path.join(outDir, 'repos', p.name)
  fs.mkdirSync(repoDir, { recursive: true })
  for (const [rel, content] of Object.entries(p.repoFiles || {})) {
    const fp = path.join(repoDir, rel)
    fs.mkdirSync(path.dirname(fp), { recursive: true })
    fs.writeFileSync(fp, content)
  }
  // Mirror of the engine's specReviewPrompt: frame + rubric core + tail. Keep in lockstep with the engine.
  const prompt = [
    'You are an ADVERSARIAL reviewer of a done-contract for an autonomous build loop.',
    'The single most dangerous failure is a loop that converges PERFECTLY on the WRONG target because an item was',
    'underspecified. Hunt for that.',
    'Goal: ' + p.contract.goal,
    'Items: ' + JSON.stringify(p.contract.items),
    'RESOLUTION CONTRACT (guaranteed by the harness -- do NOT flag it as a gap): every check is evaluated with the',
    'repository root "' + repoDir + '" as the working directory. Relative paths and commands resolve there; the cwd is NOT undefined.',
    'WRITE-PROTECTED CHECK FILES (checkPaths): ' + JSON.stringify(p.checkPaths || []) + ' -- builder edits under these globs are detected and',
    'auto-reverted. An EMPTY list means NO files are protected, so any file a check reads is builder-writable evidence.',
    rubric,
    'Return CONTRACT_REVIEW. approved=true ONLY if there are zero blocking gaps. List every blocking gap.',
    'This is review only -- do NOT modify any files.',
  ].join('\n')
  fs.writeFileSync(path.join(outDir, 'prompts', p.name + '.prompt.txt'), prompt)
  ids.push(p.name)
}
fs.writeFileSync(path.join(outDir, 'ids.json'), JSON.stringify(ids, null, 2))
console.log('materialized ' + ids.length + ' Tier-A probes to ' + outDir)
console.log(ids.join(', '))
