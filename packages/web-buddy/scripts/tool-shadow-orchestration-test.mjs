#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileSessionRecorder, FileSessionStore, readJsonLines } from '../dist/session/index.js'
import { runAgentLoop } from '../dist/runtime/local/agent-loop.js'
import { ToolRegistry } from '../dist/runtime/local/tool-registry.js'
import { TraceRecorder } from '../dist/sdk/trace.js'

const parallelPolicy = Object.freeze({
  schemaVersion: 'tool-execution-policy/v1', readOnly: true, foreground: 'parallel',
  resource: 'none', interruptBehavior: 'cancel', background: 'never',
})
const browserPolicy = Object.freeze({
  schemaVersion: 'tool-execution-policy/v1', readOnly: true, foreground: 'exclusive',
  resource: 'browser_session', interruptBehavior: 'block', background: 'never',
})

class FixtureLlm {
  constructor(calls) { this.calls = calls; this.turn = 0; this.hasKey = true; this.label = 'shadow-fixture' }
  async chatWithTools() {
    this.turn += 1
    return this.turn === 1
      ? { content: 'Run the fixture calls.', toolCalls: this.calls }
      : { content: 'fixture complete', toolCalls: [] }
  }
}

function profile() {
  return { name: 'Shadow', email: 'shadow@example.test', phone: '13800000000', location: 'test', summary: 'shadow test', skills: [], experience: [], education: [], keywords: [], source: 'json' }
}

function def(name, execution, run) {
  return { name, description: name, category: 'observation', parameters: { type: 'object', properties: {} }, inherentRisk: 'L0', execution, run }
}

async function runFixture({ calls, defs, toolOrchestration }) {
  const root = mkdtempSync(join(tmpdir(), 'web-buddy-shadow-'))
  const sessionId = 'shadow-session'
  const trace = new TraceRecorder(root, { runId: 'shadow-run', source: 'local-runtime', scenario: 'tool-shadow-orchestration', profile: 'test', goal: 'shadow fixture' })
  const store = new FileSessionStore({ rootDir: join(root, 'sessions') })
  const durable = await store.create({ sessionId, runId: trace.runId, source: 'test', goal: 'shadow fixture', mode: 'test', traceRunId: trace.runId })
  const session = new FileSessionRecorder(store, durable)
  try {
    const result = await runAgentLoop({
      goal: 'shadow fixture', resume: profile(), llm: new FixtureLlm(calls), registry: new ToolRegistry(defs),
      ctx: { sessionId, highlight: false, trace }, gate: { async confirm() { return 'approve' } },
      session, maxSteps: 3, toolOrchestration,
    })
    return { result, transcript: await readJsonLines(session.session.transcriptPath), events: await readJsonLines(session.session.eventsPath) }
  } finally {
    trace.finish()
    rmSync(root, { recursive: true, force: true })
  }
}

const calls = [
  { id: 'shadow-0', name: 'resume_query', arguments: {} },
  { id: 'shadow-1', name: 'browser_snapshot', arguments: {} },
  { id: 'shadow-2', name: 'resume_query', arguments: {} },
  { id: 'shadow-3', name: 'unknown_shadow_tool', arguments: {} },
]
const defs = [
  def('resume_query', parallelPolicy, async () => ({ observation: 'resume query', pageChanged: false })),
  def('browser_snapshot', browserPolicy, async () => ({ observation: 'browser observation', pageChanged: false })),
]

const shadow = await runFixture({ calls, defs, toolOrchestration: { mode: 'shadow', maxConcurrency: 3 } })
const planEvent = shadow.events.find((event) => event.type === 'tool_orchestration_plan')
assert(planEvent, 'shadow mode must persist one non-canonical plan diagnostic')
assert.equal(planEvent.data.canonical, false)
assert.equal(planEvent.data.effectiveExecutionMode, 'serial')
assert.equal(planEvent.data.maxConcurrency, 3)
assert.equal(planEvent.data.effectiveMaxConcurrency, 1)
assert.deepEqual(planEvent.data.batches.map((batch) => batch.mode), ['parallel', 'exclusive', 'parallel', 'exclusive'])
assert.deepEqual(planEvent.data.batches.map((batch) => batch.indexes), [[0], [1], [2], [3]])
assert.equal(planEvent.data.batches[1].calls[0].policy.resourceKey, 'browser:shadow-session')
assert.equal(planEvent.data.batches[3].calls[0].policy.source, 'default_fail_closed')
assert.deepEqual(planEvent.data.actual.processedIndexes, [0, 1, 2, 3])
assert.deepEqual(planEvent.data.actual.runIndexes, [0, 1, 2, 3])
assert.equal(planEvent.data.actual.processOrderMatchesPlannedPrefix, true)
assert.equal(planEvent.data.actual.runOrderMatchesPlannedOrder, true)
assert.equal(planEvent.data.actual.maxActive, 1)
assert.deepEqual(
  shadow.transcript.filter((entry) => entry.type === 'tool_result').map((entry) => entry.toolCallId),
  calls.map((call) => call.id),
)
assert.equal(shadow.events.filter((event) => event.type === 'tool_orchestration_plan').length, 1)

let active = 0
let maxActive = 0
const completionOrder = []
let invocation = 0
const startedAt = Date.now()
const parallelConfigured = await runFixture({
  calls: calls.slice(0, 2).map((call, index) => ({ ...call, id: `serial-${index}`, name: 'resume_query' })),
  defs: [def('resume_query', parallelPolicy, async () => {
    const invocationIndex = invocation++
    active += 1
    maxActive = Math.max(maxActive, active)
    await new Promise((resolve) => setTimeout(resolve, invocationIndex === 0 ? 70 : 20))
    active -= 1
    completionOrder.push(invocationIndex)
    return { observation: 'bounded parallel resume query', pageChanged: false }
  })],
  toolOrchestration: { mode: 'parallel', maxConcurrency: 4, parallelAllowlist: ['resume_query'] },
})
const wallClockMs = Date.now() - startedAt
assert(maxActive >= 2, 'Stage C must run allowlisted resume_query calls concurrently')
assert(wallClockMs < 120, `parallel wall clock (${wallClockMs}ms) must be less than serial delay (90ms) plus setup margin`)
assert.deepEqual(completionOrder, [1, 0], 'runs may settle out of declaration order')
assert.deepEqual(
  parallelConfigured.transcript.filter((entry) => entry.type === 'tool_result').map((entry) => entry.toolCallId),
  ['serial-0', 'serial-1'],
  'commit/transcript order must remain declaration order',
)
assert.equal(parallelConfigured.events.some((event) => event.type === 'tool_orchestration_plan'), false)

console.log(JSON.stringify({
  suite: 'tool-shadow-orchestration', ok: true,
  shadow: { planMode: planEvent.data.configuredMode, batches: planEvent.data.batches.length, actualMaxActive: planEvent.data.actual.maxActive },
  limitedResumeParallel: { maxActive, wallClockMs, completionOrder },
}, null, 2))
