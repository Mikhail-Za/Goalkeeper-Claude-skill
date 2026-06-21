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
 *
 * HARDWARE-IN-THE-LOOP HARDENING (slow / non-deterministic checks)
 *   - NON-DETERMINISTIC checks: a check may declare {nondeterministic:true, passPolicy:{mode:"latch"|"k-of-n",k,n}}.
 *     A PASS proves the code is correct at that tree state; a later MISS at the SAME tree is only the environment not
 *     cooperating. The engine LATCHES the tree-hash where such a check passed and does not let a flaky miss un-converge
 *     or revert; the verifier also retries these checks up to n times. A genuinely-wrong (never-passing) item still halts.
 *   - SHELL/ENV: a check may pin shell ("pwsh"|"bash"|"cmd"|"sh") + cwd + env so it runs in the right environment
 *     (e.g. a Windows build that must run under PowerShell, never MSYS/git-bash).
 *   - PIPELINE checks: {type:"pipeline", build, deploy, verify, freshBuild?} short-circuit to FAIL on a build error
 *     BEFORE deploy, so a stale/failed artifact can never masquerade as a passing or regressing deploy.
 *   - RESUME identity: a halted run only auto-resumes for the SAME contract; a different contract halts asking the human.
 *
 * INTEGRITY + MEMORY HARDENING
 *   - ANTI-GAMING: the verifier inspects the builder's diff and rejects a "pass" that only games the check (hardcoded
 *     output, stub, no-op/exit-0, sentinel-without-work); the spec-review distrusts the check ITSELF (a wrong or gameable
 *     check is a blocking gap; mechanical-over-subjective).
 *   - FAILURE LEDGER: each failed attempt's why-it-failed + what-to-change is persisted per item (plan.json attemptLog)
 *     and re-injected into the next builder attempt (Reflexion); the last retry before item-stuck demands a different approach.
 *   - BEST-PARTIAL: a failed attempt's diff is saved as .goalkeeper/last-attempt-<id>.patch before the reset, so the
 *     discarded work stays inspectable; the best-good tree remains committed at prevGoodHead.
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
var approvals = cfg.approvals || [] // var (not const): the durable-approval-token path may push gates onto it (only when TOKEN_ON)
const MEMO_ON = cfg.memoize === true       // C1: call-granular step memoization (opt-in, default OFF)
const TOKEN_ON = cfg.approveToken === true // C2: durable approval token (opt-in, default OFF)
const caps = Object.assign(
  {
    maxIterations: 20, maxItemRetries: 3, maxStalls: 3, maxTokens: null,
    maxReplans: 2,        // living re-plan: cap contract revisions so the plan cannot grow forever
    maxCritiqueRounds: 1, // self-critique: cap critique passes so green->critique->add cannot loop forever
    scopeCheckEvery: 4,   // scope checkpoint cadence (rounds); 0 disables
    candidates: 1,           // best-of-N builders: default 1 => single-builder path, byte-for-byte as before (OPT-IN)
    candidatesHardOnly: true,// when fanning out, the FIRST try of an item stays single-builder; only retries fan out
    maxCandidates: 6,        // hard ceiling on N regardless of per-item or caps.candidates request
    maxPlateau: 8,        // best-of-N can churn HEAD without new passes; stop if the passing-count plateaus this many rounds (margin above maxItemRetries/maxStalls so it stays a best-of-N-only backstop)
    repoMap: 'off',          // repo-map grounding (opt-in): 'off' (default) | 'tree' (ranked file tree) | 'symbols' (ctags/grep symbols)
    repoMapTokens: 1500,     // token budget for the generated .goalkeeper/repomap.md
    repoMapRefreshEvery: 0,  // 0 = build once; N = also rebuild every N rounds (a re-plan/critique always refreshes)
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
    status: { type: 'string' },
    latched: { type: 'object' },
    attemptLog: { type: 'object' },
    repoMapHead: { type: 'string' },
    repoMapIteration: { type: 'number' },
    fileContract: { type: 'object', properties: { goal: { type: 'string' }, items: { type: 'array', items: ITEM_SHAPE } } },
    workingTreeDirty: { type: 'boolean' },
    notes: { type: 'string' },
    resultLedger: { type: 'object' }, // C1: replayable per-call results from <statePath>/results.json (empty unless MEMO_ON + contractId match)
    resolution: { type: 'object' },   // C2: parsed <statePath>/resolution.json (a human-written {token,action,...}) or null
    activeToken: { type: 'string' },  // C2: the outstanding approval token persisted in plan.json (or null)
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
// best-of-N: one candidate builder's result, built SEQUENTIALLY on the LIVE target repo (reset to prevGoodHead first, then
// implement + commit). The commit persists in git by SHA (reachable even after a later reset), which is how the winner is
// promoted. worktreePath is gone -- candidates no longer run in isolated worktrees (that isolation can't target an arbitrary repo).
const CANDIDATE_BUILD_RESULT = {
  type: 'object',
  properties: {
    candidateIndex: { type: 'number' },
    itemId: { type: 'string' },
    summary: { type: 'string' },
    committed: { type: 'boolean' },
    headSha: { type: 'string' },     // the live repo HEAD sha after this candidate's commit (reachable later by SHA)
    treeHash: { type: 'string' },    // git rev-parse HEAD^{tree} -- identical content => identical hash (the dedup + selector key)
    touchedCheckPaths: { type: 'boolean' },
    selfReportedPass: { type: 'boolean' },
    blocked: { type: 'boolean' },
    blockerReason: { type: 'string' },
  },
  required: ['candidateIndex', 'committed', 'headSha', 'treeHash', 'blocked'],
}
// best-of-N: result of promoting the winning candidate's commit onto the MAIN working tree (cherry-pick / materialize-tree).
const PROMOTE_RESULT = {
  type: 'object',
  properties: {
    promoted: { type: 'boolean' },
    headSha: { type: 'string' },   // the MAIN-line HEAD after promotion
    treeHash: { type: 'string' },  // the MAIN-line HEAD^{tree} after promotion (must equal the winner's treeHash)
    error: { type: 'string' },
  },
  required: ['promoted', 'headSha'],
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
    suspectedGaming: { type: 'boolean' },
    gamingReason: { type: 'string' },
    failureAnalysis: { type: 'string' },
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
const CLOSEOUT_RESULT = { type: 'object', properties: { reportWritten: { type: 'boolean' }, path: { type: 'string' } }, required: ['reportWritten'] }
const ARCHIVE_RESULT = { type: 'object', properties: { archived: { type: 'boolean' }, path: { type: 'string' } }, required: ['archived'] }
const REPOMAP_RESULT = {
  type: 'object',
  properties: {
    written: { type: 'boolean' }, tier: { type: 'string' }, fileCount: { type: 'number' },
    omittedCount: { type: 'number' }, headShort: { type: 'string' }, approxTokens: { type: 'number' },
  },
  required: ['written', 'tier'],
}

// ----------------------------------------------------------------------------
// best-of-N: candidate approach hints (diversity discriminator; index k = APPROACH_HINTS[k % len]).
// Index 0 is the conventional/direct approach so a single fan-out round still tries the obvious thing.
// ----------------------------------------------------------------------------
const APPROACH_HINTS = [
  'Take the most CONVENTIONAL, direct, idiomatic implementation: the obvious approach a careful engineer reaches for first.',
  'Optimize for SIMPLICITY and the fewest moving parts: the smallest change that fully satisfies the check, minimal new abstraction.',
  'Optimize for ROBUSTNESS: handle edge cases and error/failure paths explicitly, validate inputs, and fail loudly rather than silently.',
  'Reuse EXISTING code and patterns already in this repo (helpers, conventions, libraries) instead of introducing anything new.',
  'Take a from-FIRST-PRINCIPLES approach: re-derive what the check actually requires and implement the cleanest design that meets it, even if unconventional.',
]

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

// best-of-N plateau: count trailing rounds whose passing-count did NOT increase over the prior round. Unlike computeStall
// this ignores HEAD, so a run that keeps changing the tree (e.g. promoting candidates) but never adds a passing item is
// still recognized as plateaued. Pure; derived from fpHistory so it round-trips on resume.
function computePlateau (history) {
  var s = 0
  for (var i = history.length - 1; i > 0; i--) {
    if (history[i].pass <= history[i - 1].pass) s++
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

// --- non-deterministic check helpers ---
// A check may declare {nondeterministic:true, passPolicy:{mode:"latch"|"k-of-n",k,n}}. For such checks a PASS proves the
// code is correct at that tree state; a later MISS at the SAME tree proves only that the environment did not cooperate.
function isNondet (it) { return !!(it && it.check && it.check.nondeterministic === true) }
function passMode (it) { return (it && it.check && it.check.passPolicy && it.check.passPolicy.mode) || 'latch' }

// --- contract identity (for the resume gate) ---
// Stable identity = normalized goal + sorted item ids. ids (not descriptions) so wording tweaks are not a "new contract".
function normGoal (g) { return String(g || '').trim().replace(/\s+/g, ' ').toLowerCase() }
function contractIdentity (goal, items) {
  const ids = (items || []).map(function (it) { return it && it.id }).filter(Boolean).sort()
  return normGoal(goal) + '|' + ids.join(',')
}

// --- deterministic hashing for memoization + token minting (C1/C2). No clock, no RNG. ---
// 32-bit FNV-1a -> 8 lowercase hex chars. Stable across runs for identical input.
function fnv1a (str) {
  var h = 0x811c9dc5
  const s = String(str)
  for (var i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0
  }
  return ('0000000' + h.toString(16)).slice(-8)
}
// JSON.stringify with object keys sorted recursively, so semantically-identical inputs always hash the same.
function stableStringify (obj) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj)
  if (Array.isArray(obj)) return '[' + obj.map(stableStringify).join(',') + ']'
  const keys = Object.keys(obj).sort()
  return '{' + keys.map(function (k) { return JSON.stringify(k) + ':' + stableStringify(obj[k]) }).join(',') + '}'
}
function shortFp (obj) { return fnv1a(stableStringify(obj)).slice(0, 7) }
// Deterministic memo key from loop state. candidateIdx is forward-compat for a future best-of-N (normally omitted).
function memoKey (role, itemId, iter, inputObj, candidateIdx) {
  return role + ':' + itemId + '#' + iter + (typeof candidateIdx === 'number' ? (':cand' + candidateIdx) : '') + ':' + shortFp(inputObj)
}
// Structural validity of a stored result for its role -- only a result with the required schema fields may be replayed.
function validMemo (role, r) {
  if (!r || typeof r !== 'object') return false
  if (role === 'build') return typeof r.committed === 'boolean' && typeof r.headSha === 'string' && typeof r.blocked === 'boolean'
  if (role === 'verify') return typeof r.itemPassed === 'boolean' && typeof r.fullSuitePassed === 'boolean' && typeof r.headSha === 'string' && typeof r.artifactHash === 'string'
  return false
}

// ----------------------------------------------------------------------------
// best-of-N pure helpers (deterministic; k is the diversity discriminator, no clock/RNG)
// ----------------------------------------------------------------------------
// Resolve how many candidate builders to fan out for THIS item. Default caps.candidates=1 => always 1 => exact no-op.
// Per-item override item.candidates wins when numeric. With candidatesHardOnly, the FIRST try of an item (retries==0,
// not an explicit per-item request) stays single-builder so only retries fan out.
function candidatesFor (item) {
  let n = (typeof item.candidates === 'number') ? item.candidates : caps.candidates
  n = Math.max(1, Math.min(n, caps.maxCandidates))
  if (n <= 1) return 1
  if (caps.candidatesHardOnly && (retries[item.id] || 0) === 0 && typeof item.candidates !== 'number') return 1
  return n
}

// Group COMMITTED candidates by their tree hash (identical content => identical work); keep the lowest candidateIndex per
// tree as the representative to verify (so we never verify the same tree twice). Uncommitted/blocked candidates are not
// promotable -> collected as failures. Works on the SEQUENTIAL candidate records (each a live-repo commit, no worktree).
// Returns { representatives:[build...], failures:[{candidateIndex,reason}...] }. (Kept available for aggregation; the
// sequential loop de-dups inline by reusing a stored verdict per treeHash so it never re-verifies an identical tree.)
function dedupeCandidatesByTree (results) {
  const byTree = {}
  const failures = []
  ;(results || []).forEach(function (b) {
    if (!b) return
    if (!b.committed || b.blocked || !b.treeHash) {
      failures.push({ candidateIndex: (typeof b.candidateIndex === 'number') ? b.candidateIndex : -1, reason: b.blocked ? ('blocked: ' + (b.blockerReason || 'builder reported blocked')) : 'no committed work' })
      return
    }
    const prev = byTree[b.treeHash]
    if (!prev || b.candidateIndex < prev.candidateIndex) byTree[b.treeHash] = b
  })
  const representatives = Object.keys(byTree).map(function (t) { return byTree[t] })
  representatives.sort(function (a, b) { return a.candidateIndex - b.candidateIndex })
  return { representatives: representatives, failures: failures }
}

// Pick the winning candidate index from a {candidateIndex -> VERIFY_RESULT} map. Promotable = the item check passed, the
// tree is clean, and it is not a tamper/gaming reject (unless the item authors its own check). Tie-break: lowest index
// (so APPROACH_HINTS[0], the conventional approach, wins ties). Returns the winning candidateIndex or null.
function selectWinner (verifyByIndex, item) {
  const allow = !!(item && item.allowTestEdit)
  var winner = null
  Object.keys(verifyByIndex || {}).forEach(function (k) {
    const idx = Number(k)
    const v = verifyByIndex[k]
    if (!v) return
    const promotable = v.itemPassed === true &&
      v.workingTreeClean !== false &&
      (v.checksTampered !== true || allow) &&
      (v.suspectedGaming !== true || allow)
    if (!promotable) return
    if (winner === null || idx < winner) winner = idx
  })
  return winner
}

// Build a one-line-per-candidate failure summary for the ledger when NO candidate wins (or promotion fails). Combines
// build-stage failures (blocked/uncommitted/dup-dropped) with verify-stage rejects, so the next attempt sees every path tried.
function aggregateCandidateFailures (builds, verifyByIndex) {
  const lines = []
  ;(builds || []).forEach(function (b) {
    if (!b) { lines.push('cand ?: crashed/null (no result)'); return }
    const k = (typeof b.candidateIndex === 'number') ? b.candidateIndex : '?'
    if (b.blocked) { lines.push('cand ' + k + ': blocked: ' + (b.blockerReason || 'builder reported blocked')); return }
    if (!b.committed || !b.treeHash) { lines.push('cand ' + k + ': produced no committed work'); return }
    const v = verifyByIndex && verifyByIndex[b.candidateIndex]
    if (!v) { lines.push('cand ' + k + ': committed but not verified (duplicate tree or verify skipped)'); return }
    if (v.itemPassed !== true) { lines.push('cand ' + k + ': check failed -- ' + String(v.failureAnalysis || v.summary || (v.checkOutputTail || 'check not satisfied')).replace(/\s+/g, ' ').slice(0, 120)); return }
    if (v.workingTreeClean === false) { lines.push('cand ' + k + ': passed but left the worktree dirty (not durable)'); return }
    if (v.checksTampered === true) { lines.push('cand ' + k + ': edited write-protected check files (tamper)'); return }
    if (v.suspectedGaming === true) { lines.push('cand ' + k + ': gamed the check -- ' + String(v.gamingReason || 'see verifier').replace(/\s+/g, ' ').slice(0, 100)); return }
    lines.push('cand ' + k + ': passed but was not selected')
  })
  return lines.join(' | ')
}

// ----------------------------------------------------------------------------
// Prompt builders
// ----------------------------------------------------------------------------
// Shared check-execution semantics, injected into every prompt that RUNS a contract check (builder, verifier, final).
const CHECK_SEMANTICS_NOTE = [
  'CHECK EXECUTION SEMANTICS (honor these for EVERY check object you run):',
  '- shell/cwd/env: if a check declares shell ("pwsh"|"bash"|"cmd"|"sh"), cwd, or env, run its command through THAT',
  '  exact shell, in THAT cwd (default: the repo root), with THOSE env vars set -- never your own default shell. On',
  '  Windows shell:"pwsh" = PowerShell (e.g. pwsh -NoProfile -Command "..." or pwsh -NoProfile -File x.ps1), NEVER',
  '  git-bash/MSYS; shell:"cmd" = cmd.exe. Running a check in the wrong shell is a SETUP error, not a real failure.',
  '- nondeterministic: a check may declare nondeterministic:true with passPolicy:{mode:"latch"|"k-of-n",k,n}. The',
  '  ENVIRONMENT (not the code) can make it miss. Run it up to n attempts (default n=3); if it declares a precondition',
  '  command, run that first on each attempt to set up the environment. It PASSES if it succeeds at least once (mode',
  '  "latch", the default) or at least k of n times (mode "k-of-n"); report it FAILING only after all n attempts miss.',
  '- pipeline: a check may be {type:"pipeline", build, deploy, verify, freshBuild?}. Run BUILD first; if build exits',
  '  non-zero the check FAILS immediately -- do NOT run deploy or verify (never deploy a failed build). To avoid',
  '  deploying a STALE artifact from an incremental build that did not pick up new sources, do a clean/reconfigured build',
  '  when freshBuild:true is set OR whenever you cannot otherwise confirm the artifact was rebuilt from current source.',
  '  Only a clean build proceeds to deploy then verify; the check passes only if verify passes.',
].join('\n')

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
    'CHECK CAPABILITIES (use when they fit): a check may pin its shell with shell:"pwsh"|"bash"|"cmd"|"sh" (+ optional',
    'cwd, env) so it runs in the right environment; declare nondeterministic:true with passPolicy:{mode:"latch"|"k-of-n",',
    'k,n} (+ optional precondition command) when a pass depends on an external event/timing rather than the code; or be',
    '{type:"pipeline", build, deploy, verify, freshBuild?} for build-and-deploy work so a build failure short-circuits',
    'BEFORE deploy (never deploy a stale/failed artifact). Declare nondeterministic for ANY check whose result can vary',
    'with the environment, so an environmental miss is not mistaken for a code failure.',
    (caps.repoMap !== 'off'
      ? 'REPO MAP: a compact structural map of this repo is at ' + statePath + '/repomap.md -- read it FIRST for grounding on key files and where things live (ranked, token-bounded, not exhaustive). If absent, proceed without it.'
      : ''),
    'Return PLAN_RESULT { items }.',
  ].filter(Boolean).join('\n')
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
    'NON-DETERMINISM: if a check\'s pass can depend on an external event or timing (not just the code), it MUST declare',
    'nondeterministic:true with a passPolicy; an environment-dependent check WITHOUT that declaration IS a blocking gap,',
    'because the loop would treat an environmental miss as a real code failure. BUILD/DEPLOY: a check that builds then',
    'deploys/measures should short-circuit on build failure (a {type:"pipeline"} check does); flag any deploy/measure',
    'check that could act on a stale artifact after a failed or no-op build.',
    'DISTRUST THE CHECK ITSELF (a check can be WRONG or GAMEABLE, not just incomplete): for each check ask (a) is it',
    'CORRECT -- does it actually test the goal, with no inverted/trivial/always-true assertion that would pass buggy code',
    'or fail correct code? and (b) is it CHEAT-RESISTANT -- would a trivial cheat pass it (hardcoding the exact expected',
    'output, special-casing the check\'s specific inputs, stubbing a constant return, exit 0/no-op, writing an expected',
    'sentinel without doing the work)? A check a cheat can pass is a BLOCKING gap; it must exercise behavior a cheat cannot',
    'fake (multiple/edge inputs, properties, round-trips, real error paths). MECHANICAL-ONLY: prefer objective pass/fail or',
    'numeric checks; a "judge"/subjective check with a vague "looks good" rubric is a blocking gap unless its rubric is',
    'concrete and falsifiable.',
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
    '   iteration as startIteration, attempts{} (per-item failed-attempt counts), fpHistory[] ({hash,pass,head} per round),',
    '   latched{} (per-nondeterministic-item: the git tree-hash at which its check last passed), attemptLog{} (per-item',
    '   recent failed-attempt reflections = the failure ledger), repoMapHead (git short-sha the repo map was last built at)',
    '   and repoMapIteration (the iteration it was built at) if present, and status (the plan.json "status" field, usually',
    '   "in-progress" or "converged").',
    '   If it does not exist, seed: passing=[], startIteration=0, attempts={}, fpHistory=[], latched={}, attemptLog={}, repoMapHead=null, repoMapIteration=0, status="fresh", and',
    '   set prevGoodHead to the current git HEAD sha (git -C "' + repo + '" rev-parse HEAD).',
    '4. WORKING CONTRACT -- if ' + statePath + '/contract.json exists, read it and return its items[], goal, replanCount,',
    '   critiqueRounds. If it does not exist, return items=[], goal="", replanCount=0, critiqueRounds=0.',
    '   All of these MUST round-trip so the anti-spin guards, the mutable contract, and the re-plan/critique caps survive resume.',
    '5. CONTRACT FILE -- ' + (cfg.contractPath
      ? ('read the JSON file at "' + cfg.contractPath + '" and return its parsed { goal, items } as fileContract. This lets a caller supply a large explicit contract by FILE instead of through args (which can truncate). If the file is missing or not valid JSON, return fileContract=null and note it.')
      : 'no contractPath was provided; return fileContract=null.'),
    '6. Report whether the working tree is dirty (git -C "' + repo + '" status --porcelain, ignoring .goalkeeper/).',
    (MEMO_ON
      ? ('7. RESULT LEDGER -- if ' + statePath + '/results.json exists, parse it. Compute the ACTIVE contract identity from ' +
         'the working contract you read in step 4 (contract.json) as: lowercase(trim(goal) with runs of whitespace collapsed ' +
         'to single spaces) + "|" + the item ids sorted ascending and joined with commas. Return resultLedger = the file\'s ' +
         '"entries" object ONLY IF the file parses AND its "contractId" string equals that computed identity EXACTLY; ' +
         'otherwise (missing, unparseable, or contractId mismatch) return resultLedger = {} (an empty object). Never return ' +
         'a ledger from a different contract.')
      : ''),
    (TOKEN_ON
      ? ('8. DURABLE APPROVAL -- if ' + statePath + '/resolution.json exists and parses, return it as resolution (the parsed ' +
         'object); else resolution = null. Also return activeToken = the "activeToken" field from plan.json (the outstanding ' +
         'approval token) if present, else null.')
      : ''),
    'Return STATE_INIT. Do not modify source files. Do not run the contract checks.',
  ].filter(Boolean).join('\n')
}

function persistContractPrompt (items, goalText, counters) {
  return [
    'Persist the working contract and its counters to ' + statePath + '/contract.json (OVERWRITE this file).',
    'Write EXACTLY this JSON object: ' + j({ goal: goalText, items: items, replanCount: counters.replanCount, critiqueRounds: counters.critiqueRounds }),
    'This file is the durable working contract, SEPARATE from plan.json (runtime state); the bookkeeper never touches it.',
    'Create the dir/file if missing. Return PERSIST_RESULT { persisted: true } only on success.',
  ].join('\n')
}

// C1: persist the call-result ledger so a crash/resume can REPLAY a completed expensive call instead of re-running it.
function ledgerWritePrompt (ledger, contractId) {
  return [
    'Persist the goalkeeper call-result ledger (memoization) to ' + statePath + '/results.json (OVERWRITE this file).',
    'Create the directory ' + statePath + ' if missing. Write EXACTLY this JSON object and nothing else:',
    '  ' + j({ version: 1, contractId: contractId, entries: ledger }),
    'This lets a crash/resume return a completed builder/verifier result instead of re-running it; it is keyed by',
    'deterministic loop state and is only ever trusted when its contractId matches the active contract.',
    'Return PERSIST_RESULT { persisted: true } only on success.',
  ].join('\n')
}

function builderPrompt (item, goalText, priorAttempts, attemptNum, maxRetries) {
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
    ((priorAttempts && priorAttempts.length)
      ? ('YOUR PRIOR FAILED ATTEMPTS on this exact item (most recent last) -- do NOT repeat any of these approaches:\n' +
         priorAttempts.map(function (a) { return '  - round ' + a.iteration + ' (' + a.outcome + '): ' + (a.reflection || '') }).join('\n'))
      : 'No prior failed attempts on this item yet.'),
    'Further per-round detail is in ' + statePath + '/worklog.md.',
    (caps.repoMap !== 'off'
      ? 'REPO MAP: a compact structural map of this repo is at ' + statePath + '/repomap.md -- read it FIRST for grounding on where things live (key files + top-level symbols, ranked, token-bounded). It is a guide, not exhaustive; open the actual files you need. If absent, proceed without it.'
      : ''),
    ((attemptNum && maxRetries && attemptNum >= (maxRetries - 1))
      ? ('LAST ATTEMPT: you have already failed this item ' + attemptNum + ' time(s); after this it is ESCALATED to a human. ' +
         'Do NOT iterate on the same approach -- take a FUNDAMENTALLY different one. If you are genuinely blocked, set ' +
         'blocked=true with a precise, specific blockerReason (exactly what is missing or impossible) -- that is more useful ' +
         'to the human than another failed guess.')
      : ''),
    CHECK_SEMANTICS_NOTE,
    'WHEN DONE: run the item check yourself (honoring the semantics above), then commit ONLY your changes with message "goalkeeper: ' + item.id + '".',
    'Return BUILD_RESULT with the new git HEAD sha, whether you touched any checkPaths, and selfReportedPass.',
    'If you cannot proceed, set blocked=true with a clear blockerReason instead of faking progress.',
    'LIVING RE-PLAN: ONLY if you discover the CONTRACT itself is wrong (this item needs an unlisted prerequisite, or',
    'should be split into smaller items), set replanRequest={requested:true, reason, proposedItems:[...], splitItemId,',
    'splitInto:[...]} with fully-formed items (id, description, objective check, dependsOn). Do NOT use this to dodge a',
    'hard item -- only when the plan genuinely does not match reality.',
  ].filter(Boolean).join('\n')
}

// best-of-N: one of N candidate builders, run SEQUENTIALLY on the LIVE target repo, each exploring a DISTINCT approach.
// Like builderPrompt but (a) it FIRST resets the live repo to the clean last-good baseline (prevGoodHead) so every
// candidate starts from the same tree, (b) appends a per-candidate approach hint, (c) uses a candidate-tagged commit
// message, (d) returns treeHash (no worktreePath -- candidates run on the live repo, not a worktree), (e) NO living-re-plan
// block (a single candidate must not mutate the shared contract). priorAttempts/last-chance ledger + HARD RULES preserved.
function candidateBuilderPrompt (item, goalText, priorAttempts, attemptNum, maxRetries, candidateIndex, n, prevGoodHead) {
  const hint = APPROACH_HINTS[candidateIndex % APPROACH_HINTS.length]
  const g = 'git -C "' + repo + '"'
  return [
    'You are BUILDER CANDIDATE ' + candidateIndex + ' of ' + n + ' in an autonomous build loop. Stay strictly on task.',
    'LIVE-REPO BASELINE CONTRACT (read first):',
    '  - You operate on the LIVE repository at "' + repo + '" (NOT a worktree). Other candidates run one-at-a-time before/',
    '    after you on this same repo; do not assume any leftover working state from them.',
    '  - FIRST run:  ' + g + ' reset --hard ' + prevGoodHead + '  so you start from the clean last-good baseline tree',
    '    (this also discards any previous candidate\'s uncommitted/working changes). Every candidate begins from this SAME baseline.',
    '  - The commit you make here PERSISTS in git by its SHA and stays reachable even after a later reset, which is how a',
    '    winning candidate is promoted (cherry-picked by SHA). So you MUST commit your work.',
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
    ((priorAttempts && priorAttempts.length)
      ? ('PRIOR FAILED ATTEMPTS on this exact item (most recent last) -- do NOT repeat any of these approaches:\n' +
         priorAttempts.map(function (a) { return '  - round ' + a.iteration + ' (' + a.outcome + '): ' + (a.reflection || '') }).join('\n'))
      : 'No prior failed attempts on this item yet.'),
    ((attemptNum && maxRetries && attemptNum >= (maxRetries - 1))
      ? ('LAST ATTEMPT: this item has already failed ' + attemptNum + ' time(s); after this round it is ESCALATED to a human. ' +
         'Take a FUNDAMENTALLY different approach from the prior attempts. If you are genuinely blocked, set blocked=true with a ' +
         'precise, specific blockerReason -- that is more useful than another failed guess.')
      : ''),
    CHECK_SEMANTICS_NOTE,
    'YOUR DISTINCT APPROACH (candidate ' + candidateIndex + ' of ' + n + ', exploring a DISTINCT approach from the others): ' + hint,
    'WHEN DONE: run the item check yourself (honoring the semantics above), then commit ONLY your changes with the commit',
    '  message EXACTLY:  goalkeeper: ' + item.id + ' [cand ' + candidateIndex + ']',
    'Then report, all computed on the live repo:',
    '  - headSha: ' + g + ' rev-parse HEAD',
    '  - treeHash: ' + g + ' rev-parse HEAD^{tree}   (the TREE id, so identical content => identical hash)',
    '  - candidateIndex: ' + candidateIndex + ', committed:true (if you committed), touchedCheckPaths, selfReportedPass.',
    'Return CANDIDATE_BUILD_RESULT. If you cannot proceed, set blocked=true with a clear blockerReason and committed=false',
    'instead of faking progress (a blocked/uncommitted candidate is simply dropped; another candidate may still win).',
  ].filter(Boolean).join('\n')
}

function verifierPrompt (item, prevGoodHead, passingIds, items) {
  return [
    'You are the INDEPENDENT VERIFIER. Do NOT trust the builder. In repo ' + repo + ':',
    'All checks resolve against the repo root: run commands with "' + repo + '" as the working directory; file_exists/grep paths are relative to "' + repo + '".',
    CHECK_SEMANTICS_NOTE,
    '1. Run THIS item check and set itemPassed: ' + j(item.check),
    '1b. ANTI-GAMING (a passing check is necessary but NOT sufficient): inspect the builder\'s actual change with',
    '    git -C "' + repo + '" diff ' + prevGoodHead + ' HEAD. Set suspectedGaming=true (+ a one-line gamingReason) if it',
    '    passes by CHEATING rather than implementing: hardcoding the exact expected output/answer, special-casing the',
    '    check\'s specific inputs, stubbing a constant return, a no-op / exit-0 / trivial pass, deleting or weakening',
    '    assertions, or writing the check\'s expected sentinel without doing the real work. A genuine implementation',
    '    generalizes beyond the check\'s literal inputs; if so, suspectedGaming=false.',
    '1c. If itemPassed is false, set failureAnalysis: 1-3 sentences on WHY it failed plus a concrete WHAT-TO-CHANGE for the',
    '    next attempt (more actionable than the raw output tail).',
    '2. REGRESSION check: these items were already passing: ' + j(passingIds) + '. Re-run THEIR checks at the current',
    '   HEAD and list by id any that now FAIL (those are regressions). If that list is empty, regressions=[]. When a',
    '   re-checked item is nondeterministic, apply its retry/passPolicy (above) so a flaky environmental miss is NOT',
    '   reported as a regression.',
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

// best-of-N: verify ONE candidate on the LIVE repo (its commit is the current HEAD when this runs). Like verifierPrompt but
// every git command is pinned to the live repo (git -C "<repo>"), and REGRESSIONS are explicitly NOT this verifier's job
// (return []), because regressions are measured AFTER the winner is promoted onto the main line (the authoritative re-check there).
function candidateVerifierPrompt (item, prevGoodHead) {
  const g = 'git -C "' + repo + '"'
  return [
    'You are the INDEPENDENT VERIFIER for ONE best-of-N candidate. Do NOT trust the builder.',
    'This candidate has just been built and committed on the LIVE repo at: ' + repo + ' (its commit is the current HEAD).',
    'PIN EVERY git command to that repo with  ' + g + '  ... and run the item check with the repo root "' + repo + '" as the',
    'working directory (the current checkout is what you are validating).',
    CHECK_SEMANTICS_NOTE,
    '1. Run THIS item check and set itemPassed: ' + j(item.check),
    '1b. ANTI-GAMING (a passing check is necessary but NOT sufficient): inspect the candidate\'s actual change with',
    '    ' + g + ' diff ' + prevGoodHead + ' HEAD. Set suspectedGaming=true (+ a one-line gamingReason) if it passes by',
    '    CHEATING rather than implementing: hardcoding the exact expected output, special-casing the check\'s specific',
    '    inputs, stubbing a constant return, a no-op / exit-0 / trivial pass, deleting or weakening assertions, or writing',
    '    the check\'s expected sentinel without doing the real work. A genuine implementation generalizes beyond the',
    '    check\'s literal inputs; if so, suspectedGaming=false.',
    '1c. If itemPassed is false, set failureAnalysis: 1-3 sentences on WHY it failed plus a concrete WHAT-TO-CHANGE.',
    '2. REGRESSIONS ARE NOT YOUR JOB: do NOT re-run other items here. Regressions are measured on the MAIN line after this',
    '   candidate (if it wins) is promoted. ALWAYS return regressions:[] (an empty array).',
    '3. fullSuitePassed: not meaningful when verifying a single candidate -- set it to the same value as itemPassed.',
    '4. Tamper check: ' + g + ' diff --name-only ' + prevGoodHead + ' HEAD' +
      (checkPaths.length
        ? ' -- ' + checkPaths.join(' ') + ' . If any of those write-protected check files changed, set checksTampered=true.'
        : ' . No write-protected checkPaths are configured, so set checksTampered=false.'),
    '5. headSha: ' + g + ' rev-parse HEAD',
    '6. artifactHash: ' + g + ' rev-parse HEAD^{tree}  (the TREE id, so identical content => identical hash).',
    '7. workingTreeClean: ' + g + ' status --porcelain ; IGNORE any entry under .goalkeeper/. Set true if there are no',
    '   OTHER uncommitted changes. A pass on a tree with uncommitted SOURCE changes is not durable.',
    '8. checkOutputTail: the last ~30 lines of any failing check output.',
    'Return VERIFY_RESULT. Do not modify files.',
  ].join('\n')
}

// best-of-N: promote the winning candidate's commit onto the MAIN working tree. The candidates were built sequentially on
// THIS repo, so the live tree may currently sit at the LAST candidate's tree; step 1 resets to the baseline first. Then
// cherry-pick the winner by SHA (its commit persists in git, reachable even after the reset); if that is not clean,
// materialize the winner's exact tree. Asserts the resulting tree hash equals the winner's (content-verified, not just "ran").
function promoteWinnerPrompt (prevGoodHead, winnerHeadSha, winnerTreeHash) {
  const g = 'git -C "' + repo + '"'
  return [
    'PROMOTE the winning best-of-N candidate onto the MAIN working tree, in repo ' + repo + '.',
    'The winner\'s commit was made on this same repo and persists in git BY ITS SHA (still reachable even though the live',
    'tree may now sit at a LATER candidate -- step 1 resets back to the clean baseline before replaying the winner).',
    '1. Ensure the main tree is CLEAN at the baseline first: ' + g + ' status --porcelain (IGNORE entries under',
    '   .goalkeeper/). If there are other uncommitted SOURCE changes, run  ' + g + ' reset --hard ' + prevGoodHead + '  so',
    '   HEAD is exactly the baseline ' + prevGoodHead + ' with a clean tree. (Never promote on top of stray changes.)',
    '2. PROMOTE the winner commit ' + winnerHeadSha + ' :',
    '   - PREFERRED: ' + g + ' cherry-pick --allow-empty ' + winnerHeadSha + '  (this replays the winner\'s change onto the',
    '     baseline). If cherry-pick conflicts or fails, run  ' + g + ' cherry-pick --abort  and use the fallback.',
    '   - FALLBACK (materialize the winner\'s exact tree ' + winnerTreeHash + '): ' + g + ' read-tree ' + winnerTreeHash +
      ' && ' + g + ' checkout-index -a -f && ' + g + ' add -A && ' + g + ' commit -m "goalkeeper: promote ' + winnerHeadSha.slice(0, 12) + '"',
    '     (this reconstructs the winning content directly, independent of cherry-pick mechanics).',
    '3. ASSERT the result is content-correct:  ' + g + ' rev-parse HEAD^{tree}  MUST equal ' + winnerTreeHash + '. If it does',
    '   NOT match, the promotion FAILED: set promoted=false and put the mismatch in error (do not leave a half-applied tree;',
    '   reset --hard ' + prevGoodHead + ' if needed so the main tree stays at the known-good baseline).',
    '4. On success return promoted=true, headSha = ' + g + ' rev-parse HEAD, treeHash = the asserted ' + winnerTreeHash + '.',
    'Return PROMOTE_RESULT. Touch ONLY git state on the main tree as described; do not edit source files by hand.',
  ].join('\n')
}

function finalVerifyPrompt (items) {
  return [
    'FINAL verification before declaring the contract done, in repo ' + repo + '.',
    'All checks resolve against the repo root: run commands with "' + repo + '" as the working directory; file_exists/grep paths are relative to "' + repo + '".',
    CHECK_SEMANTICS_NOTE,
    'Run the FULL check suite for every contract item: ' + j(items.map(function (i) { return { id: i.id, check: i.check } })),
    'Set fullSuitePassed=true ONLY if every item check passes. In regressions[], list the ID of every item whose check',
    'FAILS (use the item id, not prose); empty if all pass. For a nondeterministic check, apply its retry/passPolicy',
    '(above) before deciding it failed -- a flaky environmental miss is not a failure.',
    'Do NOT stamp any status yourself: the ENGINE decides convergence (self-critique may still re-open the loop, and a',
    'nondeterministic item can latch-converge without a green suite). Just report the suite result.',
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
    '1. If doRevert is true: FIRST preserve the discarded work best-effort (do NOT fail the task if this errors):',
    '   git -C "' + repo + '" diff ' + data.revertTo + ' > "' + statePath + '/last-attempt-' + (data.item ? data.item.id : 'item') + '.patch"',
    '   (this diffs last-good against the CURRENT working tree, so it captures the failed attempt whether it was committed OR',
    '   left uncommitted; it may be empty if the attempt changed nothing). THEN run  git -C "' + repo + '" reset --hard ' +
    '   ' + data.revertTo + '  and capture the resulting HEAD.',
    '   (Anti-destruction reset: ANY non-passing round rolls back to last-good; the saved .patch keeps the discarded attempt inspectable.)',
    '2. Read ' + statePath + '/plan.json if present, then write it (RUNTIME state only) merged with: passing=' + j(data.passing) +
      ', attempts=' + j(data.attempts) + ', iteration=' + data.iteration + ', prevGoodHead=' + j(data.prevGoodHead) +
      ', latched=' + j(data.latched) + ' (per-nondeterministic-item tree-hash where its check last passed),' +
      ' attemptLog=' + j(data.attemptLog) + ' (per-item recent failed-attempt reflections = the failure ledger),' +
      ' repoMapHead=' + j(data.repoMapHead) + ', repoMapIteration=' + j(data.repoMapIteration) + ' (repo-map staleness key),' +
      ' and APPEND this fingerprint (shape {hash,pass,head}) to fpHistory: ' + j(data.fingerprint) + '. Keep status="in-progress".',
    '   (The working contract lives in the SEPARATE contract.json -- do NOT read or write it here.)',
    '3. APPEND one entry to ' + statePath + '/worklog.md:  round ' + data.iteration + ', item ' + data.item.id +
      ', outcome ' + data.outcome + ', reflection: ' + (data.reflection || '') + '  (be specific about WHY).',
    'Return BOOKKEEP_RESULT (reverted, headSha, persisted).',
  ].join('\n')
}

// C2: a deterministic, human-resolvable token for a halt. Same halt (same contract + blocking item + iteration) -> same
// token, so the human can resolve it via <statePath>/resolution.json and goalkeeper consumes it once on the next run.
function mintToken (reason, detail) {
  return 'gk-' + fnv1a(contractIdentity(goalText, workingItems)).slice(0, 6) + '-' + reason + '-' +
    fnv1a(stableStringify({ itemId: (detail && detail.item && detail.item.id) || null, iteration: iteration })).slice(0, 6)
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
    // C2: when TOKEN_ON, surface a durable token + a file-based resolution lever; otherwise the payload is byte-for-byte as before.
    token: TOKEN_ON ? mintToken(reason, detail) : undefined,
    options: [
      '1) skip this item (mark out-of-scope and continue)',
      '2) relax or replace this item check',
      '3) provide a hint, then resume',
      '4) revise the contract (amendContract:true with new items)',
      '5) abort the run',
    ].concat(TOKEN_ON
      ? ['6) write .goalkeeper/resolution.json {token, action} where action is approve|redirect|abandon|hint -- goalkeeper consumes it next run, no args needed']
      : []),
    resume: 'State persisted in ' + statePath + '/plan.json. Re-invoke goalkeeper to continue, or resume with updated args (approvals / amended contract / resetAttempts).',
  }
}

function escalationWritePrompt (payload) {
  return [
    'Write a HUMAN ESCALATION. The on-disk file is the SYSTEM OF RECORD; Telegram is best-effort only.',
    '1. Write ' + statePath + '/ESCALATION.md from this payload (render sections clearly: Goal restated, Reason,',
    '   Progress, Blocking item, Last check output / detail, Decision needed, Options, Resume instructions):',
    '   ' + j(payload),
    (TOKEN_ON && payload.token
      ? ('1b. Render the resolution TOKEN prominently near the top of ESCALATION.md (e.g. a "Resolution token: ' +
         payload.token + '" line) so the human can resolve this halt by writing ' + statePath + '/resolution.json ' +
         'containing {"token":"' + payload.token + '","action":"approve|redirect|abandon|hint", ...} -- goalkeeper ' +
         'consumes it automatically on the next run with no args needed.')
      : ''),
    (TOKEN_ON && payload.token
      ? ('1c. ALSO record the outstanding token in plan.json: read ' + statePath + '/plan.json, set its "activeToken" ' +
         'field to "' + payload.token + '", and write it back (read-merge-write; keep every other field unchanged).')
      : ''),
    '2. If telegram.chatId is set (' + j(telegram) + ') AND a telegram reply/send tool is reachable via ToolSearch,',
    '   send a one-paragraph summary ending with "see ESCALATION.md". If not reachable, skip silently -- do NOT fail',
    '   the task over Telegram being down.',
    'Return ESCALATION_RESULT.',
  ].filter(Boolean).join('\n')
}

function closeOutPrompt (data) {
  return [
    'The goalkeeper run CONVERGED (success). Write the completion report, in repo ' + repo + ' (state dir ' + statePath + ').',
    'Run data: ' + j(data),
    'Write ' + statePath + '/REPORT.md -- the success analog of ESCALATION.md. Read ' + statePath + '/contract.json for the',
    'goal + items, and ' + statePath + '/worklog.md for the build narrative. Render clear sections: Goal; Outcome',
    '(converged); each contract item id with its check (all passing); Final HEAD ' + data.head + '; the commits goalkeeper',
    'made (run git -C "' + repo + '" log --oneline -' + ((data.iterations || 0) + 5) + ' and include the lines whose message',
    'starts with "goalkeeper:"); Iterations (' + data.iterations + '); a short Summary of what was built (from the worklog);',
    'and any minor non-blocking weaknesses the self-critique flagged (may be empty): ' + j(data.weaknesses || []) + '.',
    'Do NOT touch git or source files. Return CLOSEOUT_RESULT { reportWritten: true, path: "' + statePath + '/REPORT.md" }.',
  ].join('\n')
}

function markConvergedPrompt () {
  return [
    'Stamp the goalkeeper run as CONVERGED in repo ' + repo + ' (state dir ' + statePath + ').',
    'Read ' + statePath + '/plan.json, set its "status" field to "converged", and write it back (read-merge-write; keep',
    'every other field). This durable stamp is what tells a later invocation the run finished, so it does NOT re-run the',
    'whole (possibly slow) check suite. Do NOT touch git or source files. Return PERSIST_RESULT { persisted: true } only on success.',
  ].join('\n')
}

function archiveStalePrompt (reason) {
  return [
    'Archive a finished/abandoned goalkeeper run so the NEW run starts clean, in repo ' + repo + ' (state dir ' + statePath + ').',
    'Reason: ' + reason + ' (the previous run converged, or an explicit freshStart).',
    'Steps:',
    '1. Compute a short id: git -C "' + repo + '" rev-parse --short HEAD .',
    '2. Create directory ' + statePath + '/archive/' + reason + '-<short> .',
    '3. MOVE (not copy) these files from ' + statePath + '/ into that archive dir IF they exist: plan.json, contract.json,',
    '   worklog.md, REPORT.md, ESCALATION.md' +
      ((MEMO_ON || TOKEN_ON) ? ', results.json, resolution.json' : '') + '.' +
      ((MEMO_ON || TOKEN_ON) ? ' (Moving results.json/resolution.json prevents a stale memo ledger or approval from carrying into a new task.)' : ''),
    '4. Afterward the active ' + statePath + '/ MUST contain NO plan.json and NO contract.json (only the archive/ subdir).',
    'Do NOT touch git or source files. Return ARCHIVE_RESULT { archived: true, path: "<archive dir>" }.',
  ].join('\n')
}

function repoMapPrompt () {
  const mapPath = statePath + '/repomap.md'
  const budget = caps.repoMapTokens
  const treeOnly = (caps.repoMap === 'tree')
  return [
    'Build a COMPACT, TOKEN-BOUNDED structural map of the repo for grounding other agents, and write it to ' + mapPath + '.',
    'Repo root (run all commands here): ' + repo + '. ALWAYS exclude .git/, .goalkeeper/, and build/vendor dirs (node_modules, dist, build, target, .venv).',
    'TOKEN BUDGET: keep the file at or under ~' + budget + ' tokens (~' + (budget * 4) + ' chars). Hard target.',
    treeOnly
      ? 'MODE=tree: emit ONLY a ranked file tree/list (NO symbol extraction) from git -C "' + repo + '" ls-files (or `tree -if` if present), excluding the dirs above. tier="tree".'
      : 'MODE=symbols: extract key files + their TOP-LEVEL symbols/signatures via the FIRST tool that works: (1) ctags -- if `ctags --version` (universal-ctags) works, run it recursively over tracked files, group symbols per file (tier="symbols-ctags"); (2) FALLBACK git+grep -- git ls-files, then per source file grep top-level declarations (function|class|def|interface|type|struct|enum|impl|fn|func|module|const NAME = ( ) (tier="symbols-grep"); (3) LAST RESORT -- just the ranked file tree (tier="tree").',
    'If git is unavailable, do a bounded directory walk (same exclusions); if even that fails, write one line "repo map unavailable: <reason>" and return tier="none". NEVER fail this task over the map -- it is grounding, not a gate.',
    'RANKING (cheap, no full PageRank): order files by how many OTHER tracked files reference the file basename/module (one grep pass), tie-broken by recency (files in git -C "' + repo + '" log --name-only -20), then symbol count, then shallower path; boost entry points (index/main/app/cli/mod/lib/__init__/server, manifests).',
    'FILL TO BUDGET top-down in rank order: per file emit its path then up to ~12 top symbols (one-line signatures, truncated). STOP at the budget so only the LEAST important files drop. If any dropped, end with a single line "... (N more files omitted to fit the ' + budget + '-token map; see git ls-files)". Never truncate silently.',
    'FIRST line must be a header: "# Repo map (goalkeeper) -- tier: <tier>, budget: ' + budget + ' tok, head: <git short sha>" (git -C "' + repo + '" rev-parse --short HEAD, empty if not a git repo).',
    'OVERWRITE ' + mapPath + ' (create the dir if missing). Do NOT modify source files, run checks, or commit. Read-only survey + one file write.',
    'Return REPOMAP_RESULT { written, tier, fileCount, omittedCount, headShort, approxTokens }.',
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

// On convergence: write the completion report (the success analog of ESCALATION.md). Best-effort.
async function closeOut (data) {
  try {
    const r = await agent(closeOutPrompt(data), { label: 'close-out', phase: 'Review', effort: 'low', schema: CLOSEOUT_RESULT })
    return r || { reportWritten: false }
  } catch (e) { return { reportWritten: false, note: 'close-out failed (non-fatal): ' + String(e) } }
}

// Stamp durable status="converged". The ENGINE is the authority on convergence (the final-verify agent cannot know
// self-critique may re-open the loop, and a latch-converge happens without the agent seeing a green suite). Kept SEPARATE
// from the cosmetic REPORT.md so a report failure can never leave the run un-stamped (which would make the next run
// re-verify the whole suite). Bounded retry; non-fatal -- the work IS converged either way, this only affects re-verify cost.
async function markConverged () {
  for (var a = 0; a < 2; a++) {
    try {
      const r = await agent(markConvergedPrompt(), { label: 'mark-converged', phase: 'Review', effort: 'low', schema: PERSIST_RESULT })
      if (r && r.persisted) return { ok: true }
    } catch (e) { /* retry once */ }
  }
  log('WARNING: could not stamp status=converged; the next invocation may re-run the final suite before recognizing completion.')
  return { ok: false }
}

// Seal a finished/abandoned run by moving its state into .goalkeeper/archive so the next run starts clean. Best-effort:
// even if the move fails, the caller wipes the in-memory resume fields, so the new run still starts fresh.
async function archiveStale (reason) {
  try {
    const r = await agent(archiveStalePrompt(reason), { label: 'archive:' + reason, phase: 'Plan', effort: 'low', schema: ARCHIVE_RESULT })
    return r || { archived: false }
  } catch (e) { log('archiveStale failed (non-fatal): ' + String(e)); return { archived: false } }
}

// ----------------------------------------------------------------------------
// C1: call-granular step memoization (opt-in via cfg.memoize). On a crash/resume a COMPLETED expensive agent() call
// (builder, verifier) returns its STORED result instead of re-running. Keyed by deterministic loop state; a stored
// result is only ever replayed when it is structurally valid (validMemo). When MEMO_ON is false this is a pure
// pass-through and results.json is never read or written -- byte-for-byte identical to the unmemoized engine.
// ----------------------------------------------------------------------------
async function memoAgent (role, itemId, iter, inputObj, prompt, opts, candidateIdx) {
  if (!MEMO_ON) return await agent(prompt, opts)
  const key = memoKey(role, itemId, iter, inputObj, candidateIdx)
  if (resultLedger[key] && resultLedger[key].result && validMemo(role, resultLedger[key].result)) {
    log('memo HIT ' + key)
    return resultLedger[key].result // replay: NO agent call
  }
  const res = await agent(prompt, opts)
  resultLedger[key] = { callId: key, role: role, itemId: itemId, iteration: iter, result: res }
  ledgerDirty = true
  await flushLedger()
  return res
}

// Durably persist the result ledger (best-effort; a flush failure only costs a re-run, never a wrong result).
async function flushLedger () {
  if (!MEMO_ON || !ledgerDirty) return
  try {
    await agent(ledgerWritePrompt(resultLedger, contractIdentity(goalText, workingItems)), { label: 'memo-flush', phase: 'Loop', effort: 'low', schema: PERSIST_RESULT })
    ledgerDirty = false
  } catch (e) { log('memo flush failed (non-fatal): ' + String(e)) }
}

// ----------------------------------------------------------------------------
// C2: durable approval token (opt-in via cfg.approveToken). A human resolves a halt by writing a small
// resolution.json; goalkeeper consumes it once at init and MAPS it onto the existing in-memory resume levers
// (approvals / retries / attemptLog / amend) BEFORE they are used. Every failure path degrades to "stay halted".
// ----------------------------------------------------------------------------
// Map a durable resolution onto the in-memory levers. Returns a terminal object only for 'abandon'; otherwise mutates
// state in place and returns null/undefined so the run continues through the normal resume/seed logic.
async function applyResolution (res) {
  const action = res && res.action
  const itemId = res && res.itemId // the blocking item id (the human copies it from ESCALATION.md's Blocking item)
  if (action === 'approve') {
    // unblock the gated step(s): push both gate names defensively (harmless if one is irrelevant).
    if (approvals.indexOf('start') < 0) approvals.push('start')
    if (approvals.indexOf('contract-gaps') < 0) approvals.push('contract-gaps')
    if (itemId) { delete retries[itemId]; delete attemptLog[itemId] } // reset the blocking item's attempt count + stale ledger
    log('resolution: approve' + (itemId ? (' (reset ' + itemId + ')') : ''))
    return null
  }
  if (action === 'hint') {
    if (itemId) {
      delete retries[itemId]                                   // give the item a fresh attempt budget
      delete attemptLog[itemId]                                // drop stale "do not repeat" reflections
      ;(attemptLog[itemId] = attemptLog[itemId] || []).push({ iteration: iteration, outcome: 'human-hint', reflection: res.hint || '' })
    }
    log('resolution: hint' + (itemId ? (' -> ' + itemId) : ''))
    return null
  }
  if (action === 'redirect') {
    // equivalent to cfg.amendContract=true with res.amendItems as the new contract items (consumed before working-contract
    // determination, so the determination naturally seeds from these). Mutate the SAME objects the determination reads.
    cfg.amendContract = true
    if (res.amendItems && res.amendItems.length) {
      contract.items = res.amendItems
      contract.goal = res.amendGoal || (init && init.goal) || contract.goal || ''
    }
    repoMapDirty = true // contract replaced -> refresh the repo map next loop entry (parity with re-plan/self-critique)
    log('resolution: redirect (' + ((res.amendItems && res.amendItems.length) || 0) + ' item(s))')
    return null
  }
  if (action === 'abandon') {
    await archiveStale('abandoned')
    log('resolution: abandon')
    return { status: 'abandoned', reason: 'human-abandoned-via-token', note: 'Resolution token requested abandon; prior run archived under ' + statePath + '/archive.' }
  }
  log('resolution: unrecognized action "' + String(action) + '"; ignoring (staying halted)')
  return null
}

// Best-effort: delete resolution.json and clear plan.json activeToken once a resolution has been applied.
async function consumeResolution (token) {
  if (!TOKEN_ON) return
  try {
    await agent(resolutionConsumePrompt(token), { label: 'resolution-consume', phase: 'Plan', effort: 'low', schema: PERSIST_RESULT })
  } catch (e) { log('resolution consume failed (non-fatal): ' + String(e)) }
}

function resolutionConsumePrompt (token) {
  return [
    'A durable goalkeeper approval token has been CONSUMED; clear it so it cannot be re-applied, in repo ' + repo + ' (state dir ' + statePath + ').',
    'Token: ' + token,
    '1. Delete the file ' + statePath + '/resolution.json if it exists (it has been applied).',
    '2. Read ' + statePath + '/plan.json, clear its "activeToken" field (set it to null or remove it), and write it back',
    '   (read-merge-write; keep every other field unchanged).',
    'Do NOT touch git or source files. Return PERSIST_RESULT { persisted: true } only on success.',
  ].join('\n')
}

// Build/refresh the bounded repo map (opt-in via caps.repoMap). Idempotent + self-bounding: only spends an agent call
// when a rebuild is actually due (missing, contract-churned, or refreshEvery elapsed). Best-effort; on failure the
// builder/planner just proceed without it (grounding, not a gate).
async function ensureRepoMap (reason) {
  if (caps.repoMap === 'off') return { skipped: true }
  const due = !repoMapExists || repoMapDirty ||
    (caps.repoMapRefreshEvery > 0 && (iteration - lastRepoMapIteration) >= caps.repoMapRefreshEvery)
  if (!due) return { skipped: true }
  try {
    const r = await agent(repoMapPrompt(), { label: 'repomap:' + (reason || 'build'), phase: 'Setup', effort: 'low', schema: REPOMAP_RESULT })
    if (r && r.written) { repoMapExists = true; repoMapDirty = false; repoMapHead = r.headShort || repoMapHead; lastRepoMapIteration = iteration }
    return r || { written: false }
  } catch (e) { log('repomap build failed (non-fatal): ' + String(e)); return { written: false } }
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

// If the caller asked for a FILE contract but it could not be read, fail clearly here rather than silently falling back
// to an inline/planner contract (or later mis-reporting it as a contract mismatch).
if (cfg.contractPath && !init.fileContract) {
  return {
    status: 'error', reason: 'contractPath-unreadable',
    note: 'contractPath was set to "' + cfg.contractPath + '" but it could not be read as JSON {goal,items}. Fix the path or the JSON, or pass the contract inline.' + (init.notes ? (' init note: ' + init.notes) : ''),
  }
}

// CLOSE-OUT AWARE RESUME. A previous run that CONVERGED, or an explicit cfg.freshStart, must NOT be auto-resumed as if
// still in progress -- otherwise re-running goalkeeper on the same repo for a NEW task just re-examines the finished
// contract and "converges" again. A HALTED/in-progress run still auto-resumes by design (use freshStart to abandon it).
const priorStatus = init.status || null
const hasPriorState = !!((init.items && init.items.length) || (init.startIteration && init.startIteration > 0) || (init.passing && init.passing.length))
const hasNewWork = !!(cfg.contractPath || (contract.items && contract.items.length) || (contract.goal && String(contract.goal).trim().length))
if (priorStatus === 'converged' && !cfg.freshStart && !cfg.amendContract && !hasNewWork) {
  return {
    status: 'already-converged', passing: init.passing || [],
    note: 'The previous goalkeeper run on this repo already converged; see ' + statePath + '/REPORT.md. To start a NEW task pass a new goal/contract (or freshStart:true); to wipe, delete ' + statePath + '.',
  }
}
if ((cfg.freshStart === true || priorStatus === 'converged') && hasPriorState) {
  await archiveStale(priorStatus === 'converged' ? 'converged' : 'freshStart')
  init.items = []; init.goal = ''; init.passing = []; init.attempts = {}; init.fpHistory = []
  init.startIteration = 0; init.replanCount = 0; init.critiqueRounds = 0
}

// CONTRACT-IDENTITY RESUME GATE. A HALTED/in-progress run auto-resumes ONLY when the incoming invocation is the SAME
// task. If a DIFFERENT contract is passed (different goal, or different item ids), silently resuming the stale contract
// would re-escalate the wrong work (an observed footgun). Halt and make the human choose -- safer than discarding a
// halted run that may have an ESCALATION.md a human is mid-acting-on. freshStart abandons it; amendContract replaces it.
// Only gate when there is an actual persisted CONTRACT to compare; a started-but-contract-lost run falls through to its
// dedicated contract-lost escalation below.
const hasPersistedContract = !!(init.items && init.items.length)
if (hasPersistedContract && hasNewWork && !cfg.freshStart && !cfg.amendContract) {
  const incFile = init.fileContract || null
  const incItems = (incFile && incFile.items && incFile.items.length) ? incFile.items
    : (contract.items && contract.items.length) ? contract.items : null
  const incGoal = (incFile && incFile.goal) || contract.goal || ''
  const persistedCmp = incItems ? contractIdentity(init.goal, init.items) : contractIdentity(init.goal, [])
  const incomingCmp = incItems ? contractIdentity(incGoal || init.goal, incItems) : contractIdentity(incGoal, [])
  if (incomingCmp !== persistedCmp) {
    return {
      status: 'halted', reason: 'contract-mismatch', passing: init.passing || [], persistedGoal: init.goal || '',
      note: 'The persisted in-progress contract on this repo differs from the contract you passed, so goalkeeper did NOT ' +
        'silently resume the old one. To CONTINUE the existing run, re-invoke with no contract (or the same goal/items). ' +
        'To REPLACE it with the new contract, pass amendContract:true. To ABANDON it and start the new task fresh, pass ' +
        'freshStart:true (archives the old run). Or delete ' + statePath + ' to wipe. See ' + statePath + '/ESCALATION.md ' +
        'for the halted run\'s state.',
    }
  }
}

var prevGoodHead = init.prevGoodHead
passingSet = new Set(init.passing || [])
passingCount = passingSet.size
const retries = Object.assign({}, init.attempts || {})
const humanAmended = (cfg.resetAttempts || []).length > 0
;(cfg.resetAttempts || []).forEach(function (id) { delete retries[id] })
const fpHistory = (init.fpHistory || []).slice()
var latched = Object.assign({}, init.latched || {}) // per-nondeterministic-item: tree-hash where its check last passed
var attemptLog = Object.assign({}, init.attemptLog || {}) // per-item recent failed-attempt reflections (the failure ledger)
;(cfg.resetAttempts || []).forEach(function (id) { delete attemptLog[id] }) // a human attempt-reset clears the ledger too, so stale "do not repeat" guidance cannot contradict the human's fix
var resultLedger = (MEMO_ON && init.resultLedger) ? init.resultLedger : {} // C1: replayable per-call results (empty unless MEMO_ON + contractId matched at init)
var ledgerDirty = false                              // C1: set when memoAgent stores a new result, cleared on flush
var repoMapHead = init.repoMapHead || null           // git short-sha the current repo map was built at (staleness key)
var lastRepoMapIteration = init.repoMapIteration || 0
var repoMapDirty = false                             // set when a re-plan/critique changes the contract -> rebuild next loop entry
var repoMapExists = !!init.repoMapHead               // did init see a prior repomap.md (via its persisted head)?
var stallCount = humanAmended ? 0 : computeStall(fpHistory)
// best-of-N plateau: rounds since the passing-count last INCREASED. Derived from fpHistory so it survives resume.
// Distinct from no-progress (which also needs a flat HEAD); best-of-N can churn HEAD via promotions without new passes.
var plateauCount = humanAmended ? 0 : computePlateau(fpHistory)
var iteration = init.startIteration || 0
var replanCount = init.replanCount || 0
var critiqueRounds = init.critiqueRounds || 0

// C2: DURABLE-APPROVAL CONSUMPTION. If TOKEN_ON and the human left a resolution.json whose token matches the
// outstanding activeToken persisted at the last halt, apply it onto the in-memory resume levers (approvals / retries /
// attemptLog / amend) BEFORE the contract-lost check and working-contract determination read them, then consume it once.
// A token MISMATCH (or no resolution) is ignored -- the run stays halted via the normal gates. Guarded entirely by TOKEN_ON.
if (TOKEN_ON && init.resolution && init.resolution.token && init.activeToken && init.resolution.token === init.activeToken) {
  const _rr = await applyResolution(init.resolution)
  if (_rr && _rr.status) return _rr            // 'abandon' is terminal (prior run already archived)
  await consumeResolution(init.resolution.token) // delete resolution.json + clear activeToken (best-effort)
} else if (TOKEN_ON && init.resolution && init.resolution.token && init.activeToken && init.resolution.token !== init.activeToken) {
  log('resolution token "' + init.resolution.token + '" does not match outstanding "' + init.activeToken + '"; ignoring (staying halted).')
}

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
const fileContract = init.fileContract || null
var seededFromArgs = false
// goalText follows the SAME source that wins for items (least surprise): resume -> file -> inline -> goal-only.
if (init.items && init.items.length && !cfg.amendContract) {
  workingItems = init.items                                       // resume: persisted contract wins
  goalText = init.goal || contract.goal || (fileContract && fileContract.goal) || ''
} else if (fileContract && fileContract.items && fileContract.items.length) {
  workingItems = dedupeById(fileContract.items.map(function (it, k) { return normalizeItem(it, (it.priority || k + 1)) }))
  goalText = fileContract.goal || contract.goal || init.goal || ''
  seededFromArgs = true                                           // seed from a contract FILE (args.contractPath)
} else if (contract.items && contract.items.length) {
  workingItems = dedupeById(contract.items.map(function (it, k) { return normalizeItem(it, (it.priority || k + 1)) }))
  goalText = contract.goal || (fileContract && fileContract.goal) || init.goal || ''
  seededFromArgs = true                                           // seed from inline args.contract.items
} else {
  workingItems = null                                             // -> planner
  goalText = contract.goal || (fileContract && fileContract.goal) || init.goal || ''
}
// C1: an amend/redirect REPLACES the contract, so a memo ledger loaded under the OLD contract id must be dropped -- else
// stale entries get re-stamped under the new id and could (at a same-coordinate input) replay foreign work. (archiveStale
// already handles the converged/freshStart case; this covers in-place amend.)
if (cfg.amendContract && MEMO_ON) { resultLedger = {}; ledgerDirty = true }

// Repo map (opt-in): build once before planning so the planner can name real files; also covers the seeded-from-args path.
await ensureRepoMap('setup')

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
  const byId = {}; workingItems.forEach(function (it) { byId[it.id] = it })
  await ensureRepoMap('loop') // no-op unless caps.repoMap!=='off' AND (dirty OR refreshEvery elapsed)

  // ---- all items passing -> SELF-CRITIQUE gate, then converge ----
  if (pending.length === 0) {
    const finalV = await agent(finalVerifyPrompt(workingItems), { label: 'final-verify', phase: 'Loop', effort: 'high', schema: VERIFY_RESULT })
    // LATCH: a nondeterministic+latch item that already passed at the CURRENT final tree is latched-green; a flaky
    // environmental miss on the re-run does NOT un-converge the run. A failure is "real" only for a non-excused item.
    const finalFailing = finalV.regressions || []
    const realFinalFail = finalFailing.filter(function (id) {
      const it = byId[id]; if (!it) return true
      // any nondeterministic item (latch OR k-of-n) that already met its check at the final tree: a flaky miss is excused.
      if (isNondet(it) && latched[id] && latched[id] === finalV.artifactHash) return false
      return true
    })
    const suiteOk = (finalV.fullSuitePassed && finalFailing.length === 0) || (finalFailing.length > 0 && realFinalFail.length === 0)
    if (!suiteOk) {
      return await escalate('final-suite-failed', { finalV: finalV, realFailures: realFinalFail })
    }
    if (finalFailing.length > 0) log('final suite: ' + finalFailing.length + ' nondeterministic item(s) latched-green despite a flaky miss')

    if (critiqueRounds < caps.maxCritiqueRounds) {
      phase('Review')
      const crit = await agent(selfCritiquePrompt(goalText, workingItems), { label: 'self-critique', phase: 'Review', effort: 'high', schema: SELF_CRITIQUE })
      critiqueRounds++
      const blocking = (crit.weaknesses || []).filter(function (w) { return w.severity === 'blocking' && w.suggestedItem && w.suggestedItem.check })
      if (!crit.satisfied && blocking.length > 0) {
        const newItems = blocking.map(function (w, k) { return normalizeItem(w.suggestedItem, workingItems.length + 1 + k) })
        workingItems = dedupeById(workingItems.concat(newItems))
        repoMapDirty = true // contract grew -> repo structure may have changed; refresh the map on the next loop entry
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
      // satisfied (no blocking weaknesses) -> converge: stamp status (authoritative), write the report, then return (fable step 4)
      const conv1 = await markConverged()
      const report1 = await closeOut({ head: finalV.headSha, iterations: iteration, weaknesses: crit.weaknesses || [] })
      return {
        status: 'converged', passing: Array.from(passingSet), head: finalV.headSha, iterations: iteration,
        weaknesses: crit.weaknesses || [], selfCritiqueSummary: crit.summary || '', report: report1, statusStamped: conv1.ok,
        summary: 'All ' + workingItems.length + ' contract items pass, the full suite is green, and self-critique found no blocking weaknesses. Completion report written to ' + statePath + '/REPORT.md.',
      }
    }

    // critique budget spent -> converge: stamp status (authoritative), write the report, then return (do not loop forever)
    const conv2 = await markConverged()
    const report2 = await closeOut({ head: finalV.headSha, iterations: iteration, weaknesses: [] })
    return {
      status: 'converged', passing: Array.from(passingSet), head: finalV.headSha, iterations: iteration,
      note: 'self-critique budget (maxCritiqueRounds=' + caps.maxCritiqueRounds + ') reached.', report: report2, statusStamped: conv2.ok,
      summary: 'All ' + workingItems.length + ' contract items pass and the full suite is green. Completion report written to ' + statePath + '/REPORT.md.',
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
  const tokenOut = budgetExhausted()
  if (iteration >= caps.maxIterations || tokenOut) {
    const spentDelta = (budget && typeof budget.spent === 'function') ? (budget.spent() - tokenBaseline) : null
    const perRunToken = !!(caps.maxTokens && spentDelta !== null && spentDelta >= caps.maxTokens)
    // Distinguish the three limiters: the iteration cap, the per-RUN caps.maxTokens, and the shared turn/session budget
    // (budget.remaining()<=0 with no per-run cap). Raising caps.maxTokens only helps the second; the third needs a fresh turn.
    const budgetKind = (iteration >= caps.maxIterations) ? 'iteration' : (perRunToken ? 'token' : 'session')
    const advice = budgetKind === 'iteration' ? 'raise caps.maxIterations, then re-invoke to resume'
      : budgetKind === 'token' ? 'raise caps.maxTokens, then re-invoke to resume'
      : 'the shared turn/session budget is exhausted -- re-invoke in a fresh turn to resume (raising caps.maxTokens will not help)'
    return await escalate('budget-exhausted', {
      budgetKind: budgetKind, iteration: iteration, maxIterations: caps.maxIterations,
      tokensSpent: spentDelta, maxTokens: caps.maxTokens, item: item,
      note: 'Halted (' + budgetKind + '-budget). Best-good state is committed at HEAD ' + prevGoodHead + '; the last failed attempt (if any) is saved as ' + statePath + '/last-attempt-*.patch (may be empty if it changed nothing). To continue: ' + advice + '.',
    })
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

  // best-of-N gate: resolve how many candidate builders to fan out. Default caps.candidates=1 => N=1 => the EXISTING
  // single-builder path runs unchanged below. Only N>1 (opt-in) activates the worktree fan-out branch.
  const N = candidatesFor(item)

  // Tail-consumed locals, declared at loop scope so BOTH branches converge to the shared tail (reset/bookkeep/stop):
  //   outcome, head, hash, reflection, build (build is read for the bookkeeper's builderHead best-partial save).
  var outcome, head = prevGoodHead, hash = '', reflection = '', build = null

  if (N <= 1) {
    // ======== EXISTING SINGLE-BUILDER PATH (unchanged: same memoAgent('build')/memoAgent('verify'), same logic) ========
    // ---- build (one item; sequential by design) ----
    const priorAttempts = (attemptLog[item.id] || []).slice(-3)
    // C1: structural memo key inputs -- on a crash/resume an identical build situation replays the stored result.
    const buildInput = { goal: goalText, tree: prevGoodHead, check: item.check, description: item.description, expectedOutput: item.expectedOutput, allowTestEdit: item.allowTestEdit, priorAttempts: priorAttempts, attemptNum: (retries[item.id] || 0) }
    build = await memoAgent('build', item.id, iteration, buildInput, builderPrompt(item, goalText, priorAttempts, (retries[item.id] || 0), caps.maxItemRetries), { label: 'build:' + item.id + '#' + iteration, phase: 'Loop', schema: BUILD_RESULT })

    // ---- LIVING RE-PLAN: builder discovered the contract is wrong ----
    if (build.replanRequest && build.replanRequest.requested) {
      if (replanCount >= caps.maxReplans) {
        return await escalate('replan-budget', { item: item, request: build.replanRequest, replanCount: replanCount })
      }
      replanCount++
      workingItems = dedupeById(applyReplan(workingItems, build.replanRequest))
      repoMapDirty = true // contract changed -> refresh the map on the next loop entry
      { const p = await persistContract({ replanCount: replanCount, critiqueRounds: critiqueRounds }); if (!p.ok) return await escalate('persist-failed', { where: 'replan', error: p.error }) }
      log('re-plan #' + replanCount + ': ' + (build.replanRequest.reason || ''))
      if (autonomy === 'leash') {
        return await escalate('replan', { item: item, request: build.replanRequest, replanCount: replanCount })
      }
      ranThisRun++ // structural churn counts against a leash batch (iteration intentionally not advanced)
      continue // re-evaluate the revised contract
    }

    if (build.blocked) {
      outcome = 'blocked'
      reflection = build.blockerReason || 'builder reported blocked'
    } else {
      // C1: verify is keyed on the builder's resulting tree (build.headSha), so a memoized build chains to a memoized verify on resume.
      const verifyInput = { goal: goalText, tree: build.headSha, prevGoodHead: prevGoodHead, check: item.check, passingIds: Array.from(passingSet).sort(), allItemChecks: workingItems.map(function (i) { return { id: i.id, check: i.check } }) }
      const v = await memoAgent('verify', item.id, iteration, verifyInput, verifierPrompt(item, prevGoodHead, Array.from(passingSet), workingItems), { label: 'verify:' + item.id + '#' + iteration, phase: 'Loop', effort: 'high', schema: VERIFY_RESULT })
      hash = v.artifactHash
      const curTree = v.artifactHash
      // LATCH (nondeterministic, latch mode): a miss on an item that already passed at THIS exact tree is environmental.
      // (For the focal item this mainly guards resume/partial-state edges, since a passed item is normally not re-selected.)
      const focalLatchHit = isNondet(item) && passMode(item) === 'latch' && latched[item.id] && latched[item.id] === curTree
      // Regressions: drop any nondeterministic item (latch OR k-of-n) that already met its check at THIS exact tree -- a
      // later miss at the same code state is environmental, not a real regression.
      const realRegr = (v.regressions || []).filter(function (id) {
        const it = byId[id]; if (!it) return true
        if (isNondet(it) && latched[id] && latched[id] === curTree) return false
        return true
      })
      if (v.checksTampered && !item.allowTestEdit) {
        outcome = 'revert-tamper'; reflection = 'builder modified write-protected check files'
      } else if (realRegr.length > 0) {
        outcome = 'revert-regression'; reflection = 'regressed: ' + realRegr.join('; ')
      } else if (v.itemPassed && v.suspectedGaming && !item.allowTestEdit) {
        // the check passed but the verifier judges it GAMED (hardcoded/stubbed/sentinel), not a real implementation -> not durable.
        outcome = 'revert-gaming'; reflection = 'suspected check-gaming, not a real implementation: ' + (v.gamingReason || 'see verifier')
      } else if ((v.itemPassed || focalLatchHit) && (v.workingTreeClean !== false)) {
        outcome = 'passed'; head = v.headSha
        reflection = (focalLatchHit && !v.itemPassed) ? 'nondeterministic check latched-green at this tree (environmental miss excused)' : (v.summary || 'item check green; no regressions')
        if (isNondet(item)) latched[item.id] = curTree // record/refresh the tree where this nondeterministic check passed
      } else if (v.itemPassed && v.workingTreeClean === false) {
        outcome = 'failed'; reflection = 'item check passed but the working tree has uncommitted source changes; not a durable pass'
      } else {
        outcome = 'failed'; reflection = v.failureAnalysis || (v.checkOutputTail || 'check not satisfied').slice(0, 400)
      }
    }
    // ======== END SINGLE-BUILDER PATH ========
  } else {
    // ======== best-of-N FAN-OUT (opt-in; only reached when resolved N>1) ========
    // The deterministic CONTRACT is the selector -- no LLM judge. N candidates build SEQUENTIALLY on the LIVE target repo
    // (worktree isolation is unusable here: the workflow cwd is often not a git repo, and isolation:'worktree' isolates the
    // SESSION repo, not goalkeeper's arbitrary TARGET repo). Each candidate FIRST resets to the same baseline (prevGoodHead)
    // for a clean start; its commit persists in git by SHA (reachable even after the next candidate's reset). Each distinct
    // tree is verified once on the live repo; the lowest-index promotable candidate wins, is promoted onto the main line by
    // cherry-pick, and re-verified there (the authority) through the SAME outcome classification as the single path. We lose
    // wall-clock parallelism only. FAIL-SAFE preserved: all-candidates-fail -> null winner -> failed round -> reset -> item-stuck.
    const priorAttempts = (attemptLog[item.id] || []).slice(-3)
    var effN = N

    // (a) BUDGET-DEGRADE: never let best-of-N overshoot caps.maxTokens. If a conservative estimate of N more builders'
    // spend would blow the per-RUN budget, fall back to N=1 for THIS round (one builder, the conventional approach).
    if (caps.maxTokens && budget && typeof budget.spent === 'function') {
      const spentSoFar = budget.spent() - tokenBaseline
      const remainingRunBudget = caps.maxTokens - spentSoFar
      // Conservative per-candidate reserve: roughly the average per-round burn so far (floored), so a near-empty budget
      // degrades to single-builder instead of running N sequential candidates it cannot pay for.
      const perRoundFloor = 4000
      const perRoundEst = Math.max(perRoundFloor, (iteration > 0) ? Math.ceil(spentSoFar / iteration) : perRoundFloor)
      // Need headroom for effN candidates (each ~ a build + a verify) PLUS the promote + the main-line re-verify. Rather
      // than all-or-nothing drop to 1, CLAMP effN down to the largest fan-out that fits (>=1): a moderate budget keeps some
      // breadth, a tiny budget degrades to 1. perRoundEst ~= one full single-builder round (build+verify).
      const affordableRounds = Math.floor(remainingRunBudget / perRoundEst)
      const fits = Math.max(1, affordableRounds - 2) // reserve ~2 round-equivalents for the promote + main-line re-verify
      if (fits < effN) {
        log('best-of-N budget-degrade: remaining per-run budget ~' + remainingRunBudget + ' fits ~' + fits + ' candidate(s), not ' + N + '; using N=' + fits + ' this round')
        effN = fits
      }
    }

    // (b) SEQUENTIAL candidate loop on the LIVE repo. Each candidate's builder FIRST resets to prevGoodHead (so it starts
    //     clean AND wipes the prior candidate's working/committed-on-top state); its commit persists by SHA. We verify each
    //     DISTINCT tree once (reusing a stored verdict for a duplicate tree) and pick the LOWEST-index promotable as winner.
    //     A thrown/failed/blocked/uncommitted candidate is recorded as a failure and the loop continues -- never throws out.
    const rawBuilds = []                 // CANDIDATE_BUILD_RESULT per candidate (incl. failures), for aggregateCandidateFailures
    const verifyByIndex = {}             // candidateIndex -> VERIFY_RESULT (consumed by promote/no-winner aggregation)
    const verdictByTree = {}             // treeHash -> VERIFY_RESULT (de-dup: never re-verify an identical tree)
    var winnerRep = null                 // the winning candidate's build record (lowest-index promotable)
    var winnerIndex = null
    for (var k = 0; k < effN; k++) {
      // (b.1) build candidate k on the live repo (builder resets to prevGoodHead first). Failure must not throw out of the loop.
      var cb = null
      try {
        cb = await agent(candidateBuilderPrompt(item, goalText, priorAttempts, (retries[item.id] || 0), caps.maxItemRetries, k, effN, prevGoodHead),
          { label: 'build:' + item.id + '#' + iteration + '~cand' + k, phase: 'Loop', schema: CANDIDATE_BUILD_RESULT })
      } catch (e) { cb = null }

      // (b.2) blocked / uncommitted / null -> record a failure and continue (the NEXT candidate's reset-to-baseline cleans
      //       up any partial tree; for the LAST candidate, the bookkeeper reset-on-fail / the promotion's reset handles it).
      if (!cb || cb.blocked || cb.committed === false || !cb.headSha || !cb.treeHash) {
        rawBuilds.push(cb || { candidateIndex: k, committed: false, blocked: false, blockerReason: 'candidate crashed or produced no result' })
        continue
      }
      if (typeof cb.candidateIndex !== 'number') cb.candidateIndex = k // normalize so aggregation/selection keys are stable
      rawBuilds.push(cb)

      // (b.3) verify this candidate on the live repo (its commit is the current HEAD). DE-DUP: reuse a stored verdict for an
      //       identical tree instead of re-verifying it.
      var cv = verdictByTree[cb.treeHash]
      if (!cv) {
        try {
          cv = await agent(candidateVerifierPrompt(item, prevGoodHead),
            { label: 'verify:' + item.id + '#' + iteration + '~cand' + cb.candidateIndex, phase: 'Loop', effort: 'high', schema: VERIFY_RESULT })
        } catch (e) { cv = null }
        if (cv) verdictByTree[cb.treeHash] = cv
      }
      if (cv) verifyByIndex[cb.candidateIndex] = cv

      // (b.4) deterministic promotability against the contract (passed + clean + not tamper/gaming unless the item authors
      //       its own check). Lowest index wins: record the FIRST promotable candidate and stop selecting (but keep building
      //       the remaining candidates is pointless once we have the lowest-index winner -> break to save cost).
      const promotable = cv && cv.itemPassed === true &&
        cv.workingTreeClean !== false &&
        (cv.checksTampered !== true || item.allowTestEdit) &&
        (cv.suspectedGaming !== true || item.allowTestEdit)
      if (promotable && winnerRep === null) {
        winnerRep = { candidateIndex: cb.candidateIndex, headSha: cb.headSha, treeHash: cb.treeHash }
        winnerIndex = cb.candidateIndex
        break // candidate k is the lowest-index promotable; no later candidate can beat it (k only increases)
      }
    }

    if (winnerRep) {
      // (f) PROMOTE the winner onto the MAIN tree (cherry-pick by SHA; materialize-tree fallback; assert tree hash).
      var promote = null
      try {
        promote = await agent(promoteWinnerPrompt(prevGoodHead, winnerRep.headSha, winnerRep.treeHash),
          { label: 'promote:' + item.id + '#' + iteration, phase: 'Loop', schema: PROMOTE_RESULT })
      } catch (e) { promote = { promoted: false, error: 'promote agent failed: ' + String(e) } }

      if (promote && promote.promoted && promote.headSha) {
        // The winner is now on the main line. Run the EXISTING live verifier (memoAgent('verify')) on the MAIN tree so the
        // canonical VERIFY_RESULT (regressions / tamper / artifactHash on the real branch) drives the SAME classification
        // used by the single path -- a regression-on-merge correctly becomes a non-pass + reset.
        const promotedHead = promote.headSha
        build = { headSha: promotedHead, committed: true } // for the bookkeeper's builderHead best-partial save
        const verifyInput = { goal: goalText, tree: promotedHead, prevGoodHead: prevGoodHead, check: item.check, passingIds: Array.from(passingSet).sort(), allItemChecks: workingItems.map(function (i) { return { id: i.id, check: i.check } }) }
        const v = await memoAgent('verify', item.id, iteration, verifyInput, verifierPrompt(item, prevGoodHead, Array.from(passingSet), workingItems), { label: 'verify:' + item.id + '#' + iteration + '~main', phase: 'Loop', effort: 'high', schema: VERIFY_RESULT })
        hash = v.artifactHash
        const curTree = v.artifactHash
        const focalLatchHit = isNondet(item) && passMode(item) === 'latch' && latched[item.id] && latched[item.id] === curTree
        const realRegr = (v.regressions || []).filter(function (id) {
          const it = byId[id]; if (!it) return true
          if (isNondet(it) && latched[id] && latched[id] === curTree) return false
          return true
        })
        if (v.checksTampered && !item.allowTestEdit) {
          outcome = 'revert-tamper'; reflection = 'promoted winner modified write-protected check files'
        } else if (realRegr.length > 0) {
          outcome = 'revert-regression'; reflection = 'regressed on promote: ' + realRegr.join('; ')
        } else if (v.itemPassed && v.suspectedGaming && !item.allowTestEdit) {
          outcome = 'revert-gaming'; reflection = 'suspected check-gaming on promoted winner: ' + (v.gamingReason || 'see verifier')
        } else if ((v.itemPassed || focalLatchHit) && (v.workingTreeClean !== false)) {
          outcome = 'passed'; head = v.headSha
          reflection = (focalLatchHit && !v.itemPassed) ? 'nondeterministic check latched-green at this tree (environmental miss excused)' : ('best-of-' + effN + ': cand ' + winnerIndex + ' won + promoted; ' + (v.summary || 'item check green; no regressions'))
          if (isNondet(item)) latched[item.id] = curTree
        } else if (v.itemPassed && v.workingTreeClean === false) {
          outcome = 'failed'; reflection = 'promoted winner passed but the working tree has uncommitted source changes; not a durable pass'
        } else {
          outcome = 'failed'; reflection = v.failureAnalysis || (v.checkOutputTail || 'check not satisfied on promoted winner').slice(0, 400)
        }
      } else {
        // promotion failed -> failed round. The live tree may sit at a candidate's tree, but promoteWinnerPrompt resets to
        // the baseline on failure and the bookkeeper reset-on-fail (doReset, below) restores prevGoodHead regardless.
        outcome = 'failed'; build = { headSha: '' }
        reflection = ('best-of-' + effN + ': cand ' + winnerIndex + ' selected but promotion FAILED (' + ((promote && promote.error) || 'unknown') + '); ' + aggregateCandidateFailures(rawBuilds, verifyByIndex)).slice(0, 300)
      }
    } else {
      // (g) NO winner: failed round. One aggregated ledger entry across all N candidates. The live tree may sit at the last
      //     candidate's tree, but the bookkeeper reset-on-fail (doReset, below) restores prevGoodHead -- the proven fail-safe.
      outcome = 'failed'; build = { headSha: '' }
      reflection = ('best-of-' + effN + ': no candidate passed. ' + aggregateCandidateFailures(rawBuilds, verifyByIndex)).slice(0, 300)
    }
    // ======== END best-of-N FAN-OUT ========
  }

  // Reset to last-good on ANY non-passing round (tree never ratchets backward; head advances only on a pass).
  const doReset = (outcome !== 'passed')
  if (outcome === 'passed') {
    passingSet.add(item.id); retries[item.id] = 0; prevGoodHead = head
    delete attemptLog[item.id] // item done; drop its failure ledger to keep state small
  } else {
    retries[item.id] = (retries[item.id] || 0) + 1
    const ledger = (attemptLog[item.id] = attemptLog[item.id] || [])
    ledger.push({ iteration: iteration, outcome: outcome, reflection: String(reflection || '').slice(0, 300) })
    if (ledger.length > 5) attemptLog[item.id] = ledger.slice(-5) // keep only the most recent few
  }
  passingCount = passingSet.size
  const effHead = (outcome === 'passed') ? head : prevGoodHead

  const bk = await agent(bookkeeperPrompt({
    item: { id: item.id }, outcome: outcome, doRevert: doReset, revertTo: prevGoodHead,
    passing: Array.from(passingSet), attempts: retries, iteration: iteration, latched: latched, attemptLog: attemptLog,
    repoMapHead: repoMapHead, repoMapIteration: lastRepoMapIteration,
    builderHead: (build && build.headSha) ? build.headSha : '',
    prevGoodHead: prevGoodHead, fingerprint: { hash: hash, pass: passingCount, head: effHead }, reflection: reflection,
  }), { label: 'book:' + item.id + '#' + iteration, phase: 'Loop', effort: 'low', schema: BOOKKEEP_RESULT })

  // ---- per-item retry cap ----
  if (outcome !== 'passed' && retries[item.id] >= caps.maxItemRetries) {
    return await escalate('item-stuck', {
      item: item, attempts: retries[item.id], lastOutcome: outcome, lastReflection: reflection,
      attemptLog: (attemptLog[item.id] || []),
      lastAttemptPatch: statePath + '/last-attempt-' + item.id + '.patch',
    })
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

  // ---- plateau (best-of-N): the passing-count has not INCREASED for too many rounds. Distinct from no-progress: this
  // trips even when HEAD keeps changing (e.g. promotions churn the tree) but no new item ever passes, which sequential
  // single-builder runs rarely hit (item-stuck dominates first), so it is effectively a best-of-N safety net.
  if (passingCount > (fpHistory.length >= 2 ? fpHistory[fpHistory.length - 2].pass : -1)) plateauCount = 0; else plateauCount++
  if (caps.maxPlateau > 0 && plateauCount >= caps.maxPlateau) {
    return await escalate('plateau', { rounds: plateauCount, item: item, passing: Array.from(passingSet), note: 'passing-count has not increased for ' + plateauCount + ' rounds (HEAD may still be churning); raise caps.maxPlateau to allow more, or unblock the remaining item(s).' })
  }

  iteration++; ranThisRun++
}
