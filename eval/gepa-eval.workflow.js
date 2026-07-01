export const meta = {
  name: 'gepa-eval',
  description: 'Score a spec-review rubric variant against the materialized Tier-A probe suite (one reviewer agent per probe, verdicts collected to a results file)',
  whenToUse: 'After eval/materialize.mjs has built prompts for a rubric variant; pass {promptsDir, ids, resultsPath}.',
  phases: [
    { title: 'Review', detail: 'one reviewer agent per probe prompt' },
    { title: 'Persist', detail: 'write collected verdicts to resultsPath' },
  ],
}

// args: { promptsDir: "<abs dir with <id>.prompt.txt>", ids: ["probe-name", ...], resultsPath: "<abs file to write>" }
// Deterministic scorer harness: the script only fans out and aggregates; reviewer agents do the reading/judging, a
// final agent persists. Verdict schema mirrors the engine's CONTRACT_REVIEW so results are comparable to production.
// Defensive args unwrap: the Workflow arg channel can deliver args as a JSON-encoded STRING (sometimes doubly so);
// unwrap up to two layers, same as the goalkeeper engine does.
var cfg = args || {}
for (var u = 0; u < 2 && typeof cfg === 'string'; u++) { try { cfg = JSON.parse(cfg) } catch (e) { break } }
if (!cfg || typeof cfg !== 'object') cfg = {}
const promptsDir = String(cfg.promptsDir || '')
const ids = Array.isArray(cfg.ids) ? cfg.ids : []
const resultsPath = String(cfg.resultsPath || '')
if (!promptsDir || !ids.length || !resultsPath) return { error: 'need promptsDir, ids[], resultsPath' }

const VERDICT = {
  type: 'object',
  properties: {
    approved: { type: 'boolean' },
    blockingGaps: { type: 'array', items: { type: 'string' } },
    ambiguities: { type: 'array', items: { type: 'string' } },
  },
  required: ['approved', 'blockingGaps'],
}

phase('Review')
const verdicts = await parallel(ids.map(function (id) {
  return function () {
    return agent([
      'Read the file ' + promptsDir + '/' + id + '.prompt.txt and follow it EXACTLY as your task instructions:',
      'it makes you an adversarial reviewer of a done-contract; the repository it names is on disk for you to inspect.',
      'Inspect the repo files it points to before judging (the review depends on what is actually there).',
      'Return the verdict via the structured output: approved, blockingGaps (every blocking gap, one string each),',
      'ambiguities. approved=true ONLY if there are zero blocking gaps. Do NOT modify any files.',
    ].join('\n'), { label: 'review:' + id, phase: 'Review', effort: 'high', schema: VERDICT })
      .then(function (v) { return { id: id, verdict: v } })
      .catch(function (e) { return { id: id, verdict: null, error: String(e) } })
  }
}))

phase('Persist')
const results = { promptsDir: promptsDir, count: verdicts.filter(Boolean).length, verdicts: verdicts.filter(Boolean) }
const PERSIST = { type: 'object', properties: { persisted: { type: 'boolean' } }, required: ['persisted'] }
try {
  await agent('Write EXACTLY this JSON (nothing else) to the file ' + resultsPath + ' (create parent dirs if needed):\n' +
    JSON.stringify(results) + '\nReturn { persisted: true } only on success.',
  { label: 'persist-results', phase: 'Persist', effort: 'low', schema: PERSIST })
} catch (e) { log('persist failed: ' + String(e)) }
return { reviewed: results.count, of: ids.length, resultsPath: resultsPath }
