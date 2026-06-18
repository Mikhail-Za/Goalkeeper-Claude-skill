/*
 * goalkeeper.workflow.js  --  the deterministic brain of the goalkeeper skill.
 *
 * WHAT THIS IS
 *   A Workflow script (run via the Workflow tool) that drives an autonomous
 *   build/audit/verify loop until a machine-checkable "done-contract" passes,
 *   with anti-spin stop conditions enforced in CODE and human escalation written
 *   to disk as the system of record.
 *
 * FABLE-MODE WORKFLOW BUILT IN (v2)
 *   1. PLAN     -- if given only a goal, a planner decomposes it into a contract
 *                  (items with expected outputs + failable checks + dependsOn).
 *   2. VERIFY   -- the independent verifier + done-contract (already the core).
 *   3. SELF-CRITIQUE -- when every check is green, an adversarial critic hunts for
 *                  what the checks missed; green != good. It opens remediation
 *                  items (capped) or flags the weaknesses in the result.
 *   + SCOPE CHECKPOINT -- periodically asks "is finishing still worth it?".
 *   + LIVING RE-PLAN -- a builder that discovers the plan is wrong can request the
 *                  contract be revised (add/split items), capped.
 *   The contract is therefore MUTABLE and DURABLE: it lives in plan.json and can be
 *   generated, critiqued, and revised mid-run, surviving resume.
 *
 * WHY A SCRIPT
 *   The stop conditions (no-progress, per-item 3-retry, oscillation, budget) and
 *   the caps on the new loop-extending features (maxReplans, maxCritiqueRounds)
 *   must be deterministic. The script decides; agents only do I/O.
 *
 * STATE IS ON DISK (the spine)
 *   plan.json (now incl. the working contract + counters) + worklog.md under
 *   <repo>/.goalkeeper are durable. A fresh invocation reads them and continues.
 *
 * HONEST v2 DEFERRALS (same safety property, fully-understood semantics)
 *   1. Dependency-aware scheduling is in; CONCURRENT execution is deferred -- it
 *      needs per-round git worktrees (the standing deferral), because concurrent
 *      commits to one repo would break reset-on-fail. Execution stays sequential
 *      but dependency-ordered.
 *   2. No per-round git worktree yet: snapshot-HEAD + reset-on-fail on the live repo.
 *   3. Wall-clock cap is soft; hard backstops are maxIterations + token budget.
 */

export const meta = {
  name: 'goalkeeper',
  description: 'Autonomous build/audit/verify loop with fable-mode workflow built in: plan a contract, build to green, self-critique, scope-check, and re-plan -- with deterministic anti-spin stop conditions and on-disk human escalation.',
  phases: [
    { title: 'Plan' },
    { title: 'Setup' },
    { title: 'Loop' },
    { title: 'Review' },
    { title: 'Escalate' },
  ],
}

// ----------------------------------------------------------------------------
// Config (from args, with safe defaults)
// ----------------------------------------------------------------------------
let cfg = args || {}
// Some invocation paths deliver args as a JSON string, occasionally double-encoded; unwrap until it is an object.
for (var _p = 0; _p < 4 && typeof cfg === 'string'; _p++) {
  try { cfg = JSON.parse(cfg) } catch (e) { break }
}
if (typeof cfg !== 'object' || cfg === null) cfg = {}
const mode = cfg.mode || 'build'
const autonomy = cfg.autonomy || 'envelope'
const repo = cfg.repo
const contract = cfg.contract || { goal: '', items: [] }
const checkPaths = cfg.checkPaths || []
const denylist = cfg.denylist || ['git push', 'deploy', 'secrets', 'external-send']
const telegram = cfg.telegram || { chatId: null }
const statePath = cfg.statePath || (repo ? repo + '/.goalkeeper' : '.goalkeeper')
const approvals = cfg.approvals || []
const caps = Object.assign(
  {
    maxIterations: 20, maxItemRetries: 3, maxStalls: 3, maxTokens: null,
    maxReplans: 2,        // living re-plan: cap contract revisions so the plan cannot grow forever
    maxCritiqueRounds: 1, // self-critique: cap critique passes so green->critique->add cannot loop forever
    scopeCheckEvery: 4,   // scope checkpoint cadence (rounds); 0 disables
  },
  cfg.caps || {}
)
const roundsThisRun = (autonomy === 'leash') ? (cfg.runRounds || 1) : caps.maxIterations
// budget.spent() is the SHARED token meter for the whole turn, not just this run. Snapshot it at
// run start so caps.maxTokens bounds THIS run's spend (the delta), not the cumulative session total.
const tokenBaseline = (budget && typeof budget.spent === 'function') ? budget.spent() : 0

const j = function (o) { return JSON.stringify(o) }
function approved (gate) { return approvals.indexOf(gate) >= 0 }

// ----------------------------------------------------------------------------
// Structured-output schemas
// ----------------------------------------------------------------------------
const ITEM_SHAPE = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    priority: { type: 'number' },
    description: { type: 'string' },
    expectedOutput: { type: 'string' },
    check: { type: 'object' },
    dependsOn: { type: 'array', items: { type: 'string' } },
    allowTestEdit: { type: 'boolean' },
  },
  required: ['id', 'description', 'check'],
}
const PLAN_RESULT = {
  type: 'object',
  properties: { items: { type: 'array', items: ITEM_SHAPE }, notes: { type: 'string' } },
  required: ['items'],
}
const CONTRACT_REVIEW = {
  type: 'object',
  properties: {
    approved: { type: 'boolean' },
    blockingGaps: { type: 'array', items: { type: 'string' } },
    ambiguities: { type: 'array', items: { type: 'string' } },
    suggestions: { type: 'array', items: { type: 'string' } },
  },
  required: ['approved', 'blockingGaps'],
}
const STATE_INIT = {
  type: 'object',
  properties: {
    initialized: { type: 'boolean' },
    prevGoodHead: { type: 'string' },
    passing: { type: 'array', items: { type: 'string' } },
    startIteration: { type: 'number' },
    attempts: { type: 'object' },
    fpHistory: { type: 'array', items: { type: 'object', properties: { hash: { type: 'string' }, pass: { type: 'number' }, head: { type: 'string' } } } },
    items: { type: 'array', items: ITEM_SHAPE },
    goal: { type: 'string' },
    replanCount: { type: 'number' },
    critiqueRounds: { type: 'number' },
    workingTreeDirty: { type: 'boolean' },
    notes: { type: 'string' },
  },
  required: ['initialized', 'prevGoodHead'],
}
const BUILD_RESULT = {
  type: 'object',
  properties: {
    itemId: { type: 'string' },
    summary: { type: 'string' },
    filesChanged: { type: 'array', items: { type: 'string' } },
    committed: { type: 'boolean' },
    headSha: { type: 'string' },
    touchedCheckPaths: { type: 'boolean' },
    selfReportedPass: { type: 'boolean' },
    blocked: { type: 'boolean' },
    blockerReason: { type: 'string' },
    replanRequest: {
      type: 'object',
      properties: {
        requested: { type: 'boolean' },
        reason: { type: 'string' },
        proposedItems: { type: 'array', items: ITEM_SHAPE },
        splitItemId: { type: 'string' },
        splitInto: { type: 'array', items: ITEM_SHAPE },
      },
    },
  },
  required: ['itemId', 'committed', 'headSha', 'blocked'],
}
const VERIFY_RESULT = {
  type: 'object',
  properties: {
    itemId: { type: 'string' },
    itemPassed: { type: 'boolean' },
    fullSuitePassed: { type: 'boolean' },
    regressions: { type: 'array', items: { type: 'string' } },
    checksTampered: { type: 'boolean' },
    headSha: { type: 'string' },
    artifactHash: { type: 'string' },
    workingTreeClean: { type: 'boolean' },
    checkOutputTail: { type: 'string' },
    summary: { type: 'string' },
  },
  required: ['itemPassed', 'fullSuitePassed', 'checksTampered', 'headSha', 'artifactHash'],
}
const BOOKKEEP_RESULT = {
  type: 'object',
  properties: { reverted: { type: 'boolean' }, headSha: { type: 'string' }, persisted: { type: 'boolean' } },
  required: ['headSha', 'persisted'],
}
const PERSIST_RESULT = { type: 'object', properties: { persisted: { type: 'boolean' } }, required: ['persisted'] }
const SELF_CRITIQUE = {
  type: 'object',
  properties: {
    satisfied: { type: 'boolean' },
    summary: { type: 'string' },
    weaknesses: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string' }, // 'blocking' | 'minor'
          description: { type: 'string' },
          suggestedItem: ITEM_SHAPE,
        },
        required: ['severity', 'description'],
      },
    },
  },
  required: ['satisfied', 'weaknesses'],
}
const SCOPE_CHECK = {
  type: 'object',
  properties: {
    recommendation: { type: 'string' }, // continue | stop-good-enough | stop-goal-stale | escalate
    reason: { type: 'string' },
    confidence: { type: 'number' },
  },
  required: ['recommendation', 'reason'],
}
const ESCALATION_RESULT = {
  type: 'object',
  properties: { written: { type: 'boolean' }, path: { type: 'string' }, telegramSent: { type: 'boolean' } },
  required: ['written'],
}

// ----------------------------------------------------------------------------
// Pure decision helpers (deterministic, no I/O)
// ----------------------------------------------------------------------------
// Dependency-aware: ready = not-yet-passing items whose dependsOn are all passing.
function pickReadySet (items, passingSet) {
  const ready = items.filter(function (it) {
    if (passingSet.has(it.id)) return false
    const deps = it.dependsOn || []
    return deps.every(function (d) { return passingSet.has(d) })
  })
  ready.sort(function (a, b) { return (a.priority || 99) - (b.priority || 99) })
  return ready
}

function detectCycle (history, currentHash, currentPass) {
  if (!currentHash) return false
  const lookback = 4
  for (var i = history.length - 1; i >= 0 && i >= history.length - lookback; i--) {
    if (history[i].hash === currentHash && currentPass <= history[i].pass) return true
  }
  return false
}

function computeStall (history) {
  var s = 0
  for (var i = history.length - 1; i > 0; i--) {
    if (history[i].pass === history[i - 1].pass && history[i].head === history[i - 1].head) s++
    else break
  }
  return s
}

function budgetExhausted () {
  if (caps.maxTokens && budget && typeof budget.spent === 'function') {
    if ((budget.spent() - tokenBaseline) >= caps.maxTokens) return true
  }
  if (budget && budget.total && typeof budget.remaining === 'function') {
    if (budget.remaining() <= 0) return true
  }
  return false
}

// Normalize an agent-proposed item into a full item with safe defaults.
function normalizeItem (raw, fallbackPriority) {
  return {
    id: raw.id || ('item-' + fallbackPriority),
    priority: (typeof raw.priority === 'number') ? raw.priority : fallbackPriority,
    description: raw.description || '',
    expectedOutput: raw.expectedOutput || '',
    check: raw.check || {},
    dependsOn: raw.dependsOn || [],
    allowTestEdit: !!raw.allowTestEdit,
  }
}

// First-wins de-dup by id, so a duplicate id can never make pickReadySet/passingSet ambiguous.
function dedupeById (items) {
  const seen = {}
  const out = []
  items.forEach(function (it) { if (!seen[it.id]) { seen[it.id] = true; out.push(it) } })
  return out
}

// Apply a re-plan request to the working item list (add and/or split). Pure.
function applyReplan (items, req) {
  var out = items.slice()
  const base = out.length
  if (req.splitItemId && req.splitInto && req.splitInto.length) {
    out = out.filter(function (it) { return it.id !== req.splitItemId })
    req.splitInto.forEach(function (s, k) { out.push(normalizeItem(s, base + k)) })
  }
  if (req.proposedItems && req.proposedItems.length) {
    const existing = {}
    out.forEach(function (it) { existing[it.id] = true })
    req.proposedItems.forEach(function (p, k) {
      const n = normalizeItem(p, base + 100 + k)
      if (!existing[n.id]) out.push(n)
    })
  }
  return out
}

// ----------------------------------------------------------------------------
// Prompt builders
// ----------------------------------------------------------------------------
function plannerPrompt (goalText) {
  return [
    'You are the PLANNER. Decompose this goal into a done-contract for an autonomous ' + mode + ' loop in repo ' + repo + '.',
    'GOAL: ' + goalText,
    'Produce an ordered list of atomic, independently-checkable items. Each item:',
    '  id (kebab-case, unique), priority (1 = do first), description,',
    '  expectedOutput (the concrete artifact/observable result that proves this item is done),',
    '  check (objective + machine-runnable: {type:"command"|"file_exists"|"grep"|"judge", command|path|pattern|rubric}),',
    '  dependsOn (array of item ids that MUST pass before this one; [] if independent),',
    '  allowTestEdit (false unless the item itself authors that check).',
    'RULES: checks resolve against the repo root "' + repo + '"; each check must exercise REAL behavior including',
    'error/failure paths, not just the happy path; no check that is trivially gameable or only asserts existence when',
    'behavior is what matters. Prefer test-first where it applies. Keep items small enough to build in one round.',
    'Return PLAN_RESULT { items }.',
  ].join('\n')
}

function specReviewPrompt (goalText, items) {
  return [
    'You are an ADVERSARIAL reviewer of a done-contract for an autonomous ' + mode + ' loop.',
    'The single most dangerous failure is a loop that converges PERFECTLY on the WRONG target because an item was',
    'underspecified. Hunt for that.',
    'Goal: ' + goalText,
    'Items: ' + j(items),
    'RESOLUTION CONTRACT (guaranteed by the harness -- do NOT flag it as a gap): every check is evaluated with the',
    'repository root "' + repo + '" as the working directory. Relative paths and commands resolve there; the cwd is NOT undefined.',
    'For each item ask: is the check concrete and machine-checkable? could an agent satisfy the LETTER of the check while',
    'missing the intent? does the check exercise ERROR/failure paths or only the happy path? is anything ambiguous,',
    'unverifiable, or does any dependsOn reference a missing id?',
    'Return CONTRACT_REVIEW. approved=true ONLY if there are zero blocking gaps. List every blocking gap.',
    'This is review only -- do NOT modify any files.',
  ].join('\n')
}

function initPrompt () {
  return [
    'Initialize goalkeeper durable state for repo: ' + repo,
    'Steps:',
    '1. Ensure directory ' + statePath + ' exists.',
    '2. Ensure git IGNORES the state directory so it never pollutes "git status" or gets committed: append a line',
    '   ".goalkeeper/" to ' + repo + '/.git/info/exclude if not already present (create that file if needed).',
    '3. RUNTIME state -- if ' + statePath + '/plan.json exists, read it and return: passing[] item ids, prevGoodHead,',
    '   iteration as startIteration, attempts{} (per-item failed-attempt counts), fpHistory[] ({hash,pass,head} per round).',
    '   If it does not exist, seed: passing=[], startIteration=0, attempts={}, fpHistory=[], and set prevGoodHead to the',
    '   current git HEAD sha (git -C "' + repo + '" rev-parse HEAD).',
    '4. WORKING CONTRACT -- if ' + statePath + '/contract.json exists, read it and return its items[], goal, replanCount,',
    '   critiqueRounds. If it does not exist, return items=[], goal="", replanCount=0, critiqueRounds=0.',
    '   All of these MUST round-trip so the anti-spin guards, the mutable contract, and the re-plan/critique caps survive resume.',
    '5. Report whether the working tree is dirty (git -C "' + repo + '" status --porcelain, ignoring .goalkeeper/).',
    'Return STATE_INIT. Do not modify source files. Do not run the contract checks.',
  ].join('\n')
}

function persistContractPrompt (items, goalText, counters) {
  return [
    'Persist the working contract and its counters to ' + statePath + '/contract.json (OVERWRITE this file).',
    'Write EXACTLY this JSON object: ' + j({ goal: goalText, items: items, replanCount: counters.replanCount, critiqueRounds: counters.critiqueRounds }),
    'This file is the durable working contract, SEPARATE from plan.json (runtime state); the bookkeeper never touches it.',
    'Create the dir/file if missing. Return PERSIST_RESULT { persisted: true } only on success.',
  ].join('\n')
}

function builderPrompt (item, goalText) {
  return [
    'You are the BUILDER in an autonomous build loop. Stay strictly on task.',
    'OVERALL GOAL (restated so you do not drift): ' + goalText,
    'Implement EXACTLY this one item and nothing else:',
    '  id: ' + item.id,
    '  description: ' + item.description,
    (item.expectedOutput ? '  expected output: ' + item.expectedOutput : ''),
    '  acceptance check: ' + j(item.check),
    '  (the check resolves against the repo root "' + repo + '": relative paths and commands run there.)',
    'HARD RULES:',
    '  - Work only within ' + repo + '.',
    '  - You MUST NOT modify the write-protected check files at: ' + j(checkPaths) +
      ' (allowTestEdit=' + (!!item.allowTestEdit) + '). Editing a check to make it pass is cheating and will be reverted.',
    '  - NO placeholder, stub, mock-of-the-thing-under-test, or TODO implementations. Full real implementation only.',
    '  - FORBIDDEN actions, never perform: ' + j(denylist) + '.',
    'PRIOR ATTEMPTS on this item and why they failed are in ' + statePath + '/worklog.md -- read it first; do NOT repeat a failed approach.',
    'WHEN DONE: run the item check yourself, then commit ONLY your changes with message "goalkeeper: ' + item.id + '".',
    'Return BUILD_RESULT with the new git HEAD sha, whether you touched any checkPaths, and selfReportedPass.',
    'If you cannot proceed, set blocked=true with a clear blockerReason instead of faking progress.',
    'LIVING RE-PLAN: ONLY if you discover the CONTRACT itself is wrong (this item needs an unlisted prerequisite, or',
    'should be split into smaller items), set replanRequest={requested:true, reason, proposedItems:[...], splitItemId,',
    'splitInto:[...]} with fully-formed items (id, description, objective check, dependsOn). Do NOT use this to dodge a',
    'hard item -- only when the plan genuinely does not match reality.',
  ].filter(Boolean).join('\n')
}

function verifierPrompt (item, prevGoodHead, passingIds, items) {
  return [
    'You are the INDEPENDENT VERIFIER. Do NOT trust the builder. In repo ' + repo + ':',
    'All checks resolve against the repo root: run commands with "' + repo + '" as the working directory; file_exists/grep paths are relative to "' + repo + '".',
    '1. Run THIS item check and set itemPassed: ' + j(item.check),
    '2. REGRESSION check: these items were already passing: ' + j(passingIds) + '. Re-run THEIR checks at the current',
    '   HEAD and list by id any that now FAIL (those are regressions). If that list is empty, regressions=[].',
    '3. fullSuitePassed: true ONLY if EVERY current contract item check passes right now. Items: ' +
      j(items.map(function (i) { return { id: i.id, check: i.check } })) + '. Informational per-round; authoritative only at convergence.',
    '4. Tamper check: git -C "' + repo + '" diff --name-only ' + prevGoodHead + ' HEAD' +
      (checkPaths.length
        ? ' -- ' + checkPaths.join(' ') + ' . If any of those write-protected check files changed, set checksTampered=true.'
        : ' . No write-protected checkPaths are configured, so set checksTampered=false.'),
    '5. headSha: git -C "' + repo + '" rev-parse HEAD',
    '6. artifactHash: git -C "' + repo + '" rev-parse HEAD^{tree}  (the TREE id, so identical content => identical hash).',
    '7. workingTreeClean: git -C "' + repo + '" status --porcelain ; IGNORE any entry under .goalkeeper/. Set true if',
    '   there are no OTHER uncommitted changes. A pass on a tree with uncommitted SOURCE changes is not durable.',
    '8. checkOutputTail: the last ~30 lines of any failing check output.',
    'Return VERIFY_RESULT. Do not modify files.',
  ].join('\n')
}

function finalVerifyPrompt (items) {
  return [
    'FINAL verification before declaring the contract done, in repo ' + repo + '.',
    'All checks resolve against the repo root: run commands with "' + repo + '" as the working directory; file_exists/grep paths are relative to "' + repo + '".',
    'Run the FULL check suite for every contract item: ' + j(items.map(function (i) { return { id: i.id, check: i.check } })),
    'Set fullSuitePassed=true ONLY if every item check passes with zero regressions. List any failures as regressions.',
    'If (and ONLY if) every item check passes, stamp ' + statePath + '/plan.json status to "converged" (read-merge-write).',
    'Return headSha (rev-parse HEAD) and artifactHash (rev-parse HEAD^{tree}). Do not modify SOURCE files.',
  ].join('\n')
}

function selfCritiquePrompt (goalText, items) {
  return [
    'You are an ADVERSARIAL SELF-CRITIC. Every contract check is currently GREEN, but green is not the same as good.',
    'In repo ' + repo + ', read the completed work against the GOAL: ' + goalText,
    'The contract items were: ' + j(items.map(function (i) { return { id: i.id, description: i.description, check: i.check } })),
    'Hunt for what the checks MISSED: unhandled error paths, edge cases, race conditions, performance cliffs, security',
    'gaps, fragile or near-placeholder implementations, missing tests for failure modes, or ways the work satisfies the',
    'LETTER of the checks while missing the goal\'s intent.',
    'For each REAL weakness return { severity: "blocking"|"minor", description, suggestedItem: {id, description,',
    'expectedOutput, check (objective + machine-runnable), dependsOn:[]} }. Only "blocking" weaknesses will re-open the',
    'loop, so reserve "blocking" for things that genuinely mean the goal is not actually met; everything else is "minor".',
    'satisfied=true ONLY if there are zero blocking weaknesses. Be a tough but fair reviewer; do not invent work.',
    'This is review only -- do NOT modify files. Return SELF_CRITIQUE.',
  ].join('\n')
}

function scopeCheckPrompt (goalText, items, passingCnt, iter) {
  // Per-RUN token delta (budget.spent() is cumulative across the whole turn, not this run).
  const spent = (budget && typeof budget.spent === 'function') ? (budget.spent() - tokenBaseline) : null
  return [
    'You are a SCOPE checkpoint for a long autonomous run. Answer briefly and conservatively.',
    'The repository is at "' + repo + '" and DEFINITELY exists; the builder and verifier operate inside it. Do NOT try to',
    'locate the repo, glob/find files, or run file-existence checks -- that is not your job, and your working directory may',
    'differ from the repo. An INDEPENDENT verifier already confirms each item check, so TRUST the progress numbers below.',
    'Your ONLY job is a high-level judgment about whether continuing is still worthwhile.',
    'GOAL: ' + goalText,
    'Progress: ' + passingCnt + '/' + items.length + ' items pass after ' + iter + ' build rounds.' +
      (spent !== null ? ' THIS run has spent ~' + spent + ' output tokens (not the session total).' : ''),
    'Decide: (a) is the original goal still the right target; (b) is finishing the remaining work worth the remaining',
    'cost; (c) is what is already done good enough to stop here?',
    'recommendation: "continue" (default) | "stop-good-enough" | "stop-goal-stale" | "escalate" (genuinely unsure).',
    'Default to "continue" unless there is a CLEAR, well-founded reason to stop (a missing/unfindable repo is NOT such a',
    'reason -- the repo exists). Return SCOPE_CHECK { recommendation, reason, confidence }.',
  ].join('\n')
}

function bookkeeperPrompt (data) {
  return [
    'Apply this round outcome to durable goalkeeper state in repo ' + repo + ' (state dir ' + statePath + ').',
    'Outcome data: ' + j(data),
    'Steps:',
    '1. If doRevert is true: run  git -C "' + repo + '" reset --hard ' + data.revertTo + '  and capture the resulting HEAD.',
    '   (Anti-destruction reset: ANY non-passing round rolls back to last-good so the tree never ratchets backward.)',
    '2. Read ' + statePath + '/plan.json if present, then write it (RUNTIME state only) merged with: passing=' + j(data.passing) +
      ', attempts=' + j(data.attempts) + ', iteration=' + data.iteration + ', prevGoodHead=' + j(data.prevGoodHead) +
      ', and APPEND this fingerprint (shape {hash,pass,head}) to fpHistory: ' + j(data.fingerprint) + '. Keep status="in-progress".',
    '   (The working contract lives in the SEPARATE contract.json -- do NOT read or write it here.)',
    '3. APPEND one entry to ' + statePath + '/worklog.md:  round ' + data.iteration + ', item ' + data.item.id +
      ', outcome ' + data.outcome + ', reflection: ' + (data.reflection || '') + '  (be specific about WHY).',
    'Return BOOKKEEP_RESULT (reverted, headSha, persisted).',
  ].join('\n')
}

function buildEscalationPayload (reason, detail) {
  const item = (detail && detail.item) ? detail.item : null
  return {
    reason: reason,
    goal: goalText,
    mode: mode,
    autonomy: autonomy,
    progress: passingCount + '/' + workingItems.length + ' items passing',
    passing: Array.from(passingSet),
    blockingItem: item ? { id: item.id, description: item.description, check: item.check } : null,
    detail: detail || {},
    decisionNeeded: 'Choose how to unblock this run.',
    options: [
      '1) skip this item (mark out-of-scope and continue)',
      '2) relax or replace this item check',
      '3) provide a hint, then resume',
      '4) revise the contract (amendContract:true with new items)',
      '5) abort the run',
    ],
    resume: 'State persisted in ' + statePath + '/plan.json. Re-invoke goalkeeper to continue, or resume with updated args (approvals / amended contract / resetAttempts).',
  }
}

function escalationWritePrompt (payload) {
  return [
    'Write a HUMAN ESCALATION. The on-disk file is the SYSTEM OF RECORD; Telegram is best-effort only.',
    '1. Write ' + statePath + '/ESCALATION.md from this payload (render sections clearly: Goal restated, Reason,',
    '   Progress, Blocking item, Last check output / detail, Decision needed, Options, Resume instructions):',
    '   ' + j(payload),
    '2. If telegram.chatId is set (' + j(telegram) + ') AND a telegram reply/send tool is reachable via ToolSearch,',
    '   send a one-paragraph summary ending with "see ESCALATION.md". If not reachable, skip silently -- do NOT fail',
    '   the task over Telegram being down.',
    'Return ESCALATION_RESULT.',
  ].join('\n')
}

// ----------------------------------------------------------------------------
// Mutable run state (declared before escalate() so payloads can read them)
// ----------------------------------------------------------------------------
var passingSet = new Set()
var passingCount = 0
var workingItems = []
var goalText = ''

async function escalate (reason, detail) {
  log('ESCALATING: ' + reason)
  const payload = buildEscalationPayload(reason, detail)
  var res = null
  try {
    res = await agent(escalationWritePrompt(payload), { label: 'escalate:' + reason, phase: 'Escalate', effort: 'low', schema: ESCALATION_RESULT })
  } catch (e) {
    res = { written: false, note: 'escalation agent failed: ' + String(e) }
  }
  return { status: 'halted', reason: reason, progress: payload.progress, passing: Array.from(passingSet), escalation: res, payload: payload }
}

async function persistContract (counters) {
  // Contract durability is load-bearing: it is what keeps the re-plan/critique caps from resetting on resume.
  // So a persist failure is FATAL (the caller escalates), not swallowed.
  try {
    const r = await agent(persistContractPrompt(workingItems, goalText, counters), { label: 'persist-contract', phase: 'Plan', effort: 'low', schema: PERSIST_RESULT })
    return { ok: !!(r && r.persisted) }
  } catch (e) { return { ok: false, error: String(e) } }
}

// ----------------------------------------------------------------------------
// Main
// ----------------------------------------------------------------------------
if (!repo) {
  return {
    status: 'error', reason: 'bad-input', message: 'goalkeeper requires args.repo.',
    got: {
      argsType: typeof args, cfgType: typeof cfg,
      cfgKeys: (cfg && typeof cfg === 'object') ? Object.keys(cfg) : null,
      preview: (typeof args === 'string') ? args.slice(0, 200) : null,
    },
  }
}

phase('Plan')

// Initialize / resume durable state first (it carries any persisted working contract).
const init = await agent(initPrompt(), { label: 'init-state', phase: 'Plan', effort: 'low', schema: STATE_INIT })
if (!init.initialized) {
  return await escalate('init-failed', { init: init })
}
var prevGoodHead = init.prevGoodHead
passingSet = new Set(init.passing || [])
passingCount = passingSet.size
const retries = Object.assign({}, init.attempts || {})
const humanAmended = (cfg.resetAttempts || []).length > 0
;(cfg.resetAttempts || []).forEach(function (id) { delete retries[id] })
const fpHistory = (init.fpHistory || []).slice()
var stallCount = humanAmended ? 0 : computeStall(fpHistory)
var iteration = init.startIteration || 0
var replanCount = init.replanCount || 0
var critiqueRounds = init.critiqueRounds || 0

// A run that has already progressed but has NO persisted contract = lost contract state. Refuse to silently
// re-seed a (possibly stale) caller contract over lost revisions; require an explicit amend or a reset.
if ((init.startIteration > 0 || passingSet.size > 0) && (!init.items || !init.items.length) && !cfg.amendContract) {
  return await escalate('contract-lost', {
    startIteration: init.startIteration || 0, passing: Array.from(passingSet),
    note: 'A started run has no contract.json. Re-invoke with amendContract:true and the contract, or reset state (delete .goalkeeper).',
  })
}

// Determine the working contract. Precedence:
//   persisted (init.items) wins on resume, UNLESS the caller explicitly amends (cfg.amendContract);
//   else a caller-provided contract.items seeds a fresh run; else the planner generates one from the goal.
goalText = contract.goal || init.goal || ''
var seededFromArgs = false
if (init.items && init.items.length && !cfg.amendContract) {
  workingItems = init.items
} else if (contract.items && contract.items.length) {
  workingItems = dedupeById(contract.items.map(function (it, k) { return normalizeItem(it, (it.priority || k + 1)) }))
  seededFromArgs = true
} else {
  workingItems = null
}

// PLANNING front-end (fable step 1): no items given -> decompose the goal into a contract.
if (!workingItems) {
  if (!goalText) {
    return { status: 'error', reason: 'bad-input', message: 'goalkeeper requires either contract.items[] or a contract.goal to plan from.' }
  }
  const plan = await agent(plannerPrompt(goalText), { label: 'planner', phase: 'Plan', effort: 'high', schema: PLAN_RESULT })
  workingItems = dedupeById((plan.items || []).map(function (it, k) { return normalizeItem(it, (it.priority || k + 1)) }))
  if (!workingItems.length) {
    return await escalate('planning-failed', { plan: plan })
  }
  { const p = await persistContract({ replanCount: replanCount, critiqueRounds: critiqueRounds }); if (!p.ok) return await escalate('persist-failed', { where: 'planner', error: p.error }) }
} else if (seededFromArgs) {
  { const p = await persistContract({ replanCount: replanCount, critiqueRounds: critiqueRounds }); if (!p.ok) return await escalate('persist-failed', { where: 'seed', error: p.error }) }
}

passingCount = passingSet.size

phase('Setup')

// Adversarial contract review -- the contract IS the product.
const review = await agent(specReviewPrompt(goalText, workingItems), { label: 'spec-critic', phase: 'Setup', effort: 'high', schema: CONTRACT_REVIEW })
log('spec review: approved=' + review.approved + ', blockingGaps=' + (review.blockingGaps ? review.blockingGaps.length : 0))
if (review.blockingGaps && review.blockingGaps.length > 0 && !approved('contract-gaps')) {
  return await escalate('contract-incomplete', { review: review })
}

if (autonomy === 'leash' && !approved('start')) {
  return {
    status: 'paused', reason: 'leash-start', review: review, prevGoodHead: prevGoodHead, items: workingItems,
    note: 'Leash mode: approve the contract to begin. Re-invoke with approvals:["start"] (state persists in plan.json).',
  }
}

phase('Loop')
var ranThisRun = 0
var lastScopeCheck = -1

while (true) {
  const pending = workingItems.filter(function (it) { return !passingSet.has(it.id) })

  // ---- all items passing -> SELF-CRITIQUE gate, then converge ----
  if (pending.length === 0) {
    const finalV = await agent(finalVerifyPrompt(workingItems), { label: 'final-verify', phase: 'Loop', effort: 'high', schema: VERIFY_RESULT })
    if (!(finalV.fullSuitePassed && (!finalV.regressions || finalV.regressions.length === 0))) {
      return await escalate('final-suite-failed', { finalV: finalV })
    }

    if (critiqueRounds < caps.maxCritiqueRounds) {
      phase('Review')
      const crit = await agent(selfCritiquePrompt(goalText, workingItems), { label: 'self-critique', phase: 'Review', effort: 'high', schema: SELF_CRITIQUE })
      critiqueRounds++
      const blocking = (crit.weaknesses || []).filter(function (w) { return w.severity === 'blocking' && w.suggestedItem && w.suggestedItem.check })
      if (!crit.satisfied && blocking.length > 0) {
        const newItems = blocking.map(function (w, k) { return normalizeItem(w.suggestedItem, workingItems.length + 1 + k) })
        workingItems = dedupeById(workingItems.concat(newItems))
        { const p = await persistContract({ replanCount: replanCount, critiqueRounds: critiqueRounds }); if (!p.ok) return await escalate('persist-failed', { where: 'self-critique', error: p.error }) }
        log('self-critique opened ' + newItems.length + ' remediation item(s)')
        if (autonomy === 'leash') {
          return await escalate('self-critique', { weaknesses: crit.weaknesses, addedItems: newItems.map(function (i) { return i.id }) })
        }
        phase('Loop')
        continue
      }
      // The critic is NOT satisfied but produced no actionable remediation items -> do NOT launder "not satisfied"
      // into a false "converged". Escalate so a human sees the unactionable concern.
      if (!crit.satisfied) {
        return await escalate('self-critique-unactionable', { weaknesses: crit.weaknesses || [], summary: crit.summary || '' })
      }
      // satisfied (no blocking weaknesses) -> converge and FLAG any minor weaknesses (fable step 4)
      return {
        status: 'converged', passing: Array.from(passingSet), head: finalV.headSha, iterations: iteration,
        weaknesses: crit.weaknesses || [], selfCritiqueSummary: crit.summary || '',
        summary: 'All ' + workingItems.length + ' contract items pass, the full suite is green, and self-critique found no blocking weaknesses.',
      }
    }

    // critique budget spent -> converge (do not loop forever on critique)
    return {
      status: 'converged', passing: Array.from(passingSet), head: finalV.headSha, iterations: iteration,
      note: 'self-critique budget (maxCritiqueRounds=' + caps.maxCritiqueRounds + ') reached.',
      summary: 'All ' + workingItems.length + ' contract items pass and the full suite is green.',
    }
  }

  // ---- dependency-aware selection ----
  const ready = pickReadySet(workingItems, passingSet)
  if (ready.length === 0) {
    const known = {}; workingItems.forEach(function (it) { known[it.id] = true })
    const unresolvableDeps = []
    pending.forEach(function (p) { (p.dependsOn || []).forEach(function (d) { if (!known[d] && unresolvableDeps.indexOf(d) < 0) unresolvableDeps.push(d) }) })
    return await escalate('dependency-deadlock', {
      pending: pending.map(function (p) { return { id: p.id, dependsOn: p.dependsOn || [] } }),
      unresolvableDeps: unresolvableDeps,
    })
  }
  const item = ready[0] // sequential, dependency-ordered (concurrent execution deferred to worktrees)

  // ---- hard backstops ----
  if (iteration >= caps.maxIterations || budgetExhausted()) {
    return await escalate('budget-exhausted', { iteration: iteration, maxIterations: caps.maxIterations, item: item })
  }

  // ---- leash batch boundary ----
  if (ranThisRun >= roundsThisRun) {
    return {
      status: 'paused', reason: 'leash-batch-complete', progress: passingCount + '/' + workingItems.length,
      passing: Array.from(passingSet), note: 'Leash batch done. Re-invoke to run the next round(s); state persisted.',
    }
  }

  // ---- SCOPE CHECKPOINT (fable): periodic "is finishing still worth it?" ----
  if (caps.scopeCheckEvery > 0 && iteration > 0 && (iteration % caps.scopeCheckEvery === 0) && iteration !== lastScopeCheck) {
    lastScopeCheck = iteration
    const scope = await agent(scopeCheckPrompt(goalText, workingItems, passingCount, iteration), { label: 'scope-check#' + iteration, phase: 'Loop', effort: 'low', schema: SCOPE_CHECK })
    if (scope.recommendation && scope.recommendation !== 'continue') {
      return await escalate('scope-checkpoint', { recommendation: scope.recommendation, reason: scope.reason, item: item })
    }
  }

  log('round ' + iteration + ' -> item ' + item.id)

  // ---- build (one item; sequential by design) ----
  const build = await agent(builderPrompt(item, goalText), { label: 'build:' + item.id + '#' + iteration, phase: 'Loop', schema: BUILD_RESULT })

  // ---- LIVING RE-PLAN: builder discovered the contract is wrong ----
  if (build.replanRequest && build.replanRequest.requested) {
    if (replanCount >= caps.maxReplans) {
      return await escalate('replan-budget', { item: item, request: build.replanRequest, replanCount: replanCount })
    }
    replanCount++
    workingItems = dedupeById(applyReplan(workingItems, build.replanRequest))
    { const p = await persistContract({ replanCount: replanCount, critiqueRounds: critiqueRounds }); if (!p.ok) return await escalate('persist-failed', { where: 'replan', error: p.error }) }
    log('re-plan #' + replanCount + ': ' + (build.replanRequest.reason || ''))
    if (autonomy === 'leash') {
      return await escalate('replan', { item: item, request: build.replanRequest, replanCount: replanCount })
    }
    ranThisRun++ // structural churn counts against a leash batch (iteration intentionally not advanced)
    continue // re-evaluate the revised contract
  }

  var outcome, head = prevGoodHead, hash = '', reflection = ''

  if (build.blocked) {
    outcome = 'blocked'
    reflection = build.blockerReason || 'builder reported blocked'
  } else {
    const v = await agent(verifierPrompt(item, prevGoodHead, Array.from(passingSet), workingItems), { label: 'verify:' + item.id + '#' + iteration, phase: 'Loop', effort: 'high', schema: VERIFY_RESULT })
    hash = v.artifactHash
    if (v.checksTampered && !item.allowTestEdit) {
      outcome = 'revert-tamper'; reflection = 'builder modified write-protected check files'
    } else if (v.regressions && v.regressions.length > 0) {
      outcome = 'revert-regression'; reflection = 'regressed: ' + v.regressions.join('; ')
    } else if (v.itemPassed && (v.workingTreeClean !== false)) {
      outcome = 'passed'; head = v.headSha; reflection = v.summary || 'item check green; no regressions'
    } else if (v.itemPassed && v.workingTreeClean === false) {
      outcome = 'failed'; reflection = 'item check passed but the working tree has uncommitted source changes; not a durable pass'
    } else {
      outcome = 'failed'; reflection = (v.checkOutputTail || 'check not satisfied').slice(0, 400)
    }
  }

  // Reset to last-good on ANY non-passing round (tree never ratchets backward; head advances only on a pass).
  const doReset = (outcome !== 'passed')
  if (outcome === 'passed') {
    passingSet.add(item.id); retries[item.id] = 0; prevGoodHead = head
  } else {
    retries[item.id] = (retries[item.id] || 0) + 1
  }
  passingCount = passingSet.size
  const effHead = (outcome === 'passed') ? head : prevGoodHead

  const bk = await agent(bookkeeperPrompt({
    item: { id: item.id }, outcome: outcome, doRevert: doReset, revertTo: prevGoodHead,
    passing: Array.from(passingSet), attempts: retries, iteration: iteration,
    prevGoodHead: prevGoodHead, fingerprint: { hash: hash, pass: passingCount, head: effHead }, reflection: reflection,
  }), { label: 'book:' + item.id + '#' + iteration, phase: 'Loop', effort: 'low', schema: BOOKKEEP_RESULT })

  // ---- per-item retry cap ----
  if (outcome !== 'passed' && retries[item.id] >= caps.maxItemRetries) {
    return await escalate('item-stuck', { item: item, attempts: retries[item.id], lastOutcome: outcome, lastReflection: reflection })
  }

  // ---- oscillation ----
  if (detectCycle(fpHistory, hash, passingCount)) {
    return await escalate('oscillation', { item: item, hash: hash })
  }

  // ---- no-progress ----
  if (fpHistory.length > 0) {
    const prev = fpHistory[fpHistory.length - 1]
    if (prev.pass === passingCount && prev.head === effHead) stallCount++; else stallCount = 0
  }
  fpHistory.push({ hash: hash, pass: passingCount, head: effHead })
  if (stallCount >= caps.maxStalls) {
    return await escalate('no-progress', { rounds: stallCount, item: item, passing: Array.from(passingSet) })
  }

  iteration++; ranThisRun++
}
