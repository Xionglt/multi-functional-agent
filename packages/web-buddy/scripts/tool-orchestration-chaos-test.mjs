#!/usr/bin/env node
/**
 * O9 independent Wave 5 limited-parallel QA.
 *
 * Exercises the built Agent Loop rather than the O4 callback harness.  This
 * remains intentionally serial: it proves the Wave 3 extraction preserves
 * pairing, permission ordering, and the block-interrupt settlement fence.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { observationManager } from '../dist/observation/observation-manager.js'
import { FileSessionRecorder, FileSessionStore, readJsonLines } from '../dist/session/index.js'
import { sessionManager } from '../dist/session/manager.js'
import { runAgentLoop } from '../dist/runtime/local/agent-loop.js'
import { ToolRegistry } from '../dist/runtime/local/tool-registry.js'
import { TraceRecorder } from '../dist/sdk/trace.js'
import { partitionToolCalls } from '../dist/tools/tool-orchestrator.js'

const serialPolicy = Object.freeze({
  schemaVersion: 'tool-execution-policy/v1', readOnly: false, foreground: 'exclusive',
  resource: 'run_state', interruptBehavior: 'block', background: 'never',
})
const browserPolicy = Object.freeze({
  schemaVersion: 'tool-execution-policy/v1', readOnly: true, foreground: 'exclusive',
  resource: 'browser_session', interruptBehavior: 'block', background: 'never',
})

const results = []
async function check(name, test) {
  try {
    results.push({ name, status: 'PASS', evidence: await test() })
  } catch (error) {
    results.push({ name, status: 'FAIL', error: error instanceof Error ? error.stack ?? error.message : String(error) })
  }
}

class OneBatchLlm {
  constructor(calls) { this.calls = calls; this.turn = 0; this.hasKey = true; this.label = 'o9-chaos-llm' }
  async chatWithTools() {
    this.turn += 1
    return this.turn === 1
      ? { content: 'Run the declared fixture tools.', toolCalls: this.calls }
      : { content: 'fixture complete', toolCalls: [] }
  }
}

class DelayedGate {
  constructor(decision = 'approve') { this.decision = decision; this.active = 0; this.maxActive = 0; this.timeline = [] }
  async confirm(kind) {
    this.active += 1
    this.maxActive = Math.max(this.maxActive, this.active)
    this.timeline.push(`start:${kind}:${this.active}`)
    await delay(12)
    this.active -= 1
    this.timeline.push(`end:${kind}:${this.active}`)
    return this.decision
  }
}

class AllowCompletionGate {
  evaluate(input) {
    return {
      schemaVersion: 'completion-gate-decision/v1', action: 'allow', recommendedStatus: 'completed',
      reason: 'O9 fixture completion gate allow.', missingCriteria: input.workflowEvaluation?.missingCriteria ?? [],
      blockers: input.workflowEvaluation?.blockers ?? [], workflowPhase: input.workflowEvaluation?.state?.phase,
      evidenceIds: input.workflowEvaluation?.evidenceIds ?? [],
    }
  }
}

function profile() {
  return { name: 'O9', email: 'o9@example.test', phone: '13800000000', location: 'test', summary: 'qa', skills: [], experience: [], education: [], keywords: [], source: 'json' }
}

function fresh(sessionId) {
  observationManager.refreshPageState({
    sessionId,
    snapshot: {
      snapshotId: `o9-${sessionId}`, url: 'https://example.test/apply', title: 'Application form',
      textSummary: 'Application form with safe draft actions.',
      elements: [
        { ref: 'e0', tag: 'input', name: 'Applicant name', risk: 'L1' },
        { ref: 'e1', tag: 'button', name: 'Open details', risk: 'L3' },
        { ref: 'e2', tag: 'button', name: 'Save draft', risk: 'L1' },
      ],
      stats: { elementCount: 2, interactiveCount: 2, formCount: 1, linkCount: 0, buttonCount: 2, inputCount: 1, truncated: false },
    },
  })
}

function def(name, run, options = {}) {
  return {
    name, description: `O9 ${name}`, category: options.category ?? 'action', parameters: { type: 'object', properties: {} },
    inherentRisk: options.risk ?? 'L1', execution: options.execution ?? serialPolicy, run,
  }
}

async function scenario(name, calls, defs, options = {}) {
  const root = mkdtempSync(join(tmpdir(), `web-buddy-o9-${name}-`))
  const sessionId = `o9-${name}`
  const trace = new TraceRecorder(root, { runId: `o9-${name}`, source: 'local-runtime', scenario: 'o9-tool-orchestration-chaos', profile: 'test', goal: name })
  const store = new FileSessionStore({ rootDir: join(root, 'sessions') })
  const durable = await store.create({ sessionId, runId: trace.runId, source: 'test', goal: name, mode: 'test', traceRunId: trace.runId })
  const session = new FileSessionRecorder(store, durable)
  options.onSessionCreated?.(session)
  if (options.fresh !== false) fresh(sessionId)
  try {
    const result = await runAgentLoop({
      goal: name, resume: profile(), llm: new OneBatchLlm(calls), registry: new ToolRegistry(defs),
      ctx: { sessionId, highlight: false, trace }, session, gate: options.gate,
      completionGate: options.completionGate, maxSteps: 3, abortSignal: options.abortSignal,
      toolOrchestration: options.toolOrchestration,
      backgroundToolBridge: options.backgroundToolBridge,
    })
    return {
      result,
      transcript: await readJsonLines(session.session.transcriptPath),
      events: await readJsonLines(session.session.eventsPath),
    }
  } finally {
    trace.finish()
    await sessionManager.closeAll().catch(() => {})
    rmSync(root, { recursive: true, force: true })
  }
}

function pairedResultIds(transcript) { return transcript.filter((entry) => entry.type === 'tool_result').map((entry) => entry.toolCallId) }
function callIds(calls) { return calls.map((call) => call.id) }
function assertPaired(transcript, calls) { assert.deepEqual(pairedResultIds(transcript), callIds(calls)) }
function synthetic(transcript, id) { return transcript.find((entry) => entry.type === 'tool_result' && entry.toolCallId === id) }
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)) }
async function waitUntil(predicate, timeoutMs = 500) {
  const deadline = performance.now() + timeoutMs
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error('Timed out waiting for fixture execution to start.')
    await delay(1)
  }
}

await check('deterministic chaos: 100 random partition/barrier sequences preserve coverage and order', async () => {
  let state = 0x5eed1234
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 0x100000000
  }
  for (let iteration = 0; iteration < 100; iteration += 1) {
    const count = 1 + Math.floor(random() * 20)
    const calls = Array.from({ length: count }, (_, index) => ({ id: `r${iteration}-${index}`, name: random() < 0.55 ? 'parallel' : 'exclusive', arguments: {} }))
    const plan = partitionToolCalls(calls, {
      turnId: `random-${iteration}`, mode: 'parallel', maxConcurrency: 1 + Math.floor(random() * 4),
      resolvePolicy: (call) => call.name === 'parallel' ? { ...serialPolicy, readOnly: true, foreground: 'parallel', resource: 'none', interruptBehavior: 'cancel' } : browserPolicy,
    })
    const flattened = plan.batches.flatMap((batch) => batch.calls.map((item) => item.index))
    assert.deepEqual(flattened, Array.from({ length: count }, (_, index) => index))
    for (const batch of plan.batches) {
      if (batch.mode === 'exclusive') assert.equal(batch.calls.length, 1)
      if (batch.mode === 'parallel') assert(batch.calls.every((item) => item.call.name === 'parallel'))
    }
  }
  return { seed: '0x5eed1234', iterations: 100 }
})

await check('real Agent Loop background pilot returns immediate advisory task reference without awaiting completion', async () => {
  const calls = [{ id: 'background-0', name: 'trace_summarization', arguments: { traceArtifactRef: { artifactId: 'trace-0' } } }]
  let completionResolved = false
  const completion = delay(250).then(() => { completionResolved = true })
  const startedAt = performance.now()
  const run = await scenario('background-immediate', calls, [def('trace_summarization', async () => ({ observation: 'foreground handler must not execute' }), {
    execution: Object.freeze({
      schemaVersion: 'tool-execution-policy/v1', readOnly: true, foreground: 'exclusive',
      resource: 'none', interruptBehavior: 'cancel', background: 'eligible',
    }),
  })], {
    backgroundToolBridge: {
      contractVersion: 'background-tool-bridge/v1',
      async start(prepared) {
        assert.equal(prepared.call.name, 'trace_summarization')
        return {
          schemaVersion: 'tool-background-start/v1', toolCallId: prepared.call.id,
          taskId: 'task-immediate', spawnOutcome: 'created', status: 'pending', outputRefs: [],
          requiresMainWorkflowVerification: true, authoritativeCompletionEvidence: false,
        }
      },
    },
  })
  const elapsedMs = Math.round(performance.now() - startedAt)
  assert.equal(completionResolved, false, 'foreground result must not await task completion')
  assertPaired(run.transcript, calls)
  const result = synthetic(run.transcript, 'background-0')?.result
  assert.match(String(result?.observation), /BACKGROUND_TASK_STARTED taskId=task-immediate status=pending/)
  assert.deepEqual(result?.data?.keys, [
    'schemaVersion', 'toolCallId', 'taskId', 'spawnOutcome', 'status', 'outputRefs',
    'requiresMainWorkflowVerification', 'authoritativeCompletionEvidence',
  ])
  await completion
  return { elapsedMs, taskId: 'task-immediate', status: 'pending', completionResolvedAtForegroundReturn: false }
})

await check('real Agent Loop: permission deny pairs declared suffix exactly once', async () => {
  const calls = [
    { id: 'deny-0', name: 'browser_click_text', arguments: { text: 'Submit application' } },
    { id: 'deny-1', name: 'after_deny', arguments: {} },
  ]
  const gate = new DelayedGate('decline')
  const run = await scenario('deny', calls, [
    def('browser_click_text', async () => ({ observation: 'must not execute' }), { risk: 'L3', execution: browserPolicy }),
    def('after_deny', async () => ({ observation: 'must not execute' })),
  ], { gate })
  assertPaired(run.transcript, calls)
  assert.equal(gate.maxActive, 1)
  assert.match(String(synthetic(run.transcript, 'deny-0')?.result?.observation), /FINAL_SUBMIT_NOT_EXECUTED_AUTOMATICALLY/)
  assert.match(String(synthetic(run.transcript, 'deny-1')?.result?.observation), /EARLIER_TOOL_BLOCKED/)
  return { resultIds: pairedResultIds(run.transcript), gateMaxActive: gate.maxActive }
})

await check('real Agent Loop: committed done pairs declared suffix exactly once', async () => {
  const calls = [
    { id: 'done-0', name: 'agent_done', arguments: { summary: 'fixture done', blocked: false } },
    { id: 'done-1', name: 'after_done', arguments: {} },
  ]
  const run = await scenario('done', calls, [
    def('agent_done', async (args) => ({ observation: String(args.summary), done: true, data: { blocked: false }, pageChanged: false })),
    def('after_done', async () => ({ observation: 'must not execute' })),
  ], { completionGate: new AllowCompletionGate() })
  assertPaired(run.transcript, calls)
  assert.match(String(synthetic(run.transcript, 'done-1')?.result?.observation), /EARLIER_TOOL_COMPLETED/)
  return { resultIds: pairedResultIds(run.transcript) }
})

await check('real Agent Loop: fatal tool pairs declared suffix before rethrow', async () => {
  const calls = [
    { id: 'fatal-0', name: 'fatal_tool', arguments: {} },
    { id: 'fatal-1', name: 'after_fatal', arguments: {} },
  ]
  const root = mkdtempSync(join(tmpdir(), 'web-buddy-o9-fatal-'))
  const sessionId = 'o9-fatal'
  const trace = new TraceRecorder(root, { runId: 'o9-fatal', source: 'local-runtime', scenario: 'o9-tool-orchestration-chaos', profile: 'test', goal: 'fatal' })
  const store = new FileSessionStore({ rootDir: join(root, 'sessions') })
  const durable = await store.create({ sessionId, runId: trace.runId, source: 'test', goal: 'fatal', mode: 'test', traceRunId: trace.runId })
  const session = new FileSessionRecorder(store, durable)
  fresh(sessionId)
  try {
    await assert.rejects(() => runAgentLoop({
      goal: 'fatal', resume: profile(), llm: new OneBatchLlm(calls),
      registry: new ToolRegistry([def('fatal_tool', async () => { throw new Error('O9 injected fatal') }), def('after_fatal', async () => ({ observation: 'must not execute' }))]),
      ctx: { sessionId, highlight: false, trace }, session, maxSteps: 3,
    }), /O9 injected fatal/)
    const transcript = await readJsonLines(session.session.transcriptPath)
    assertPaired(transcript, calls)
    assert.match(String(synthetic(transcript, 'fatal-1')?.result?.observation), /FATAL_TOOL_ERROR/)
    return { resultIds: pairedResultIds(transcript) }
  } finally {
    trace.finish(); await sessionManager.closeAll().catch(() => {}); rmSync(root, { recursive: true, force: true })
  }
})

await check('real Agent Loop: block abort waits for browser settlement and pairs suffix', async () => {
  const calls = [
    { id: 'abort-0', name: 'browser_blocking_wait', arguments: {} },
    { id: 'abort-1', name: 'after_abort', arguments: {} },
  ]
  const controller = new AbortController()
  let active = 0
  const timeline = []
  const pending = scenario('abort', calls, [
    def('browser_blocking_wait', async () => {
      active += 1; timeline.push('start:0'); await delay(35); active -= 1; timeline.push('end:0')
      return { observation: 'browser settled', pageChanged: false }
    }, { execution: browserPolicy }),
    def('after_abort', async () => ({ observation: 'must not execute' })),
  ], { abortSignal: controller.signal })
  await waitUntil(() => timeline.includes('start:0'))
  controller.abort('O9 abort')
  const run = await pending
  timeline.push('loop-resolved')
  assert.equal(active, 0)
  assert(timeline.indexOf('end:0') < timeline.indexOf('loop-resolved'))
  assertPaired(run.transcript, calls)
  assert.match(String(synthetic(run.transcript, 'abort-1')?.result?.observation), /SESSION_ABORTED/)
  return { resultIds: pairedResultIds(run.transcript), activeAtResolution: active, timeline }
})

await check('real Agent Loop: browser and permission operations remain single-writer', async () => {
  const browserCalls = [
    { id: 'browser-0', name: 'browser_probe_a', arguments: {} },
    { id: 'browser-1', name: 'browser_probe_b', arguments: {} },
  ]
  let active = 0; let maxActive = 0
  const browserRun = await scenario('browser-serial', browserCalls, browserCalls.map((call) => def(call.name, async () => {
    active += 1; maxActive = Math.max(maxActive, active); await delay(10); active -= 1; return { observation: call.name, pageChanged: false }
  }, { execution: browserPolicy })))
  assert.equal(maxActive, 1)
  assertPaired(browserRun.transcript, browserCalls)

  const permissionCalls = [
    { id: 'permission-0', name: 'risk_action_a', arguments: {} },
    { id: 'permission-1', name: 'risk_action_b', arguments: {} },
  ]
  const gate = new DelayedGate('approve')
  const permissionRun = await scenario('permission-serial', permissionCalls, permissionCalls.map((call) => def(call.name, async () => ({ observation: call.name }), { risk: 'L3' })), { gate })
  assert.equal(gate.maxActive, 1)
  assertPaired(permissionRun.transcript, permissionCalls)
  return { browserMaxActive: maxActive, permissionMaxActive: gate.maxActive }
})

await check('real Agent Loop shadow: diagnostic plan is non-canonical and execution stays serial', async () => {
  const calls = [
    { id: 'shadow-0', name: 'resume_query', arguments: {} },
    { id: 'shadow-1', name: 'browser_shadow_a', arguments: {} },
    { id: 'shadow-2', name: 'resume_query', arguments: {} },
    { id: 'shadow-3', name: 'unknown_shadow_tool', arguments: {} },
  ]
  let active = 0; let maxActive = 0
  const resume = async () => {
    active += 1; maxActive = Math.max(maxActive, active); await delay(10); active -= 1
    return { observation: 'resume query', pageChanged: false }
  }
  const run = await scenario('shadow-plan', calls, [
    def('resume_query', resume, { execution: Object.freeze({
      schemaVersion: 'tool-execution-policy/v1', readOnly: true, foreground: 'parallel',
      resource: 'none', interruptBehavior: 'cancel', background: 'never',
    }) }),
    def('browser_shadow_a', async () => ({ observation: 'browser observation', pageChanged: false }), { execution: browserPolicy }),
  ], { toolOrchestration: { mode: 'shadow', maxConcurrency: 4, parallelAllowlist: ['resume_query'] } })
  assertPaired(run.transcript, calls)
  assert.equal(maxActive, 1, 'shadow must retain actual serial execution despite configured capacity')
  const plans = run.events.filter((event) => event.type === 'tool_orchestration_plan')
  assert.equal(plans.length, 1)
  const plan = plans[0].data
  assert.equal(plan.canonical, false)
  assert.equal(plan.effectiveExecutionMode, 'serial')
  assert.equal(plan.effectiveMaxConcurrency, 1)
  assert.deepEqual(plan.batches.map((batch) => batch.indexes), [[0], [1], [2], [3]])
  assert.deepEqual(plan.batches.map((batch) => batch.mode), ['parallel', 'exclusive', 'parallel', 'exclusive'])
  assert.equal(plan.batches[1].calls[0].policy.resource, 'browser_session')
  assert.equal(plan.batches[1].calls[0].policy.resourceKey, 'browser:o9-shadow-plan')
  assert.equal(plan.batches[3].calls[0].policy.source, 'default_fail_closed')
  assert.deepEqual(plan.actual.processedIndexes, [0, 1, 2, 3])
  assert.deepEqual(plan.actual.runIndexes, [0, 1, 2, 3])
  assert.equal(plan.actual.maxActive, 1)
  const lifecycle = run.events.filter((event) => /^(tool_call_created|tool_started|tool_completed|tool_failed)$/.test(event.type))
  for (const id of callIds(calls)) {
    assert.equal(lifecycle.filter((event) => event.toolCallId === id && event.type === 'tool_call_created').length, 1)
    assert.equal(lifecycle.filter((event) => event.toolCallId === id && /^(tool_completed|tool_failed)$/.test(event.type)).length, 1)
  }
  assert.equal(run.events.some((event) => event.type !== 'tool_orchestration_plan' && event.data?.canonical === true), false)
  return { maxActive, shadowPlanEvents: plans.length, diagnosticCanonical: plan.canonical, lifecycleEvents: lifecycle.length }
})

await check('real Agent Loop legacy and serial modes remain serial without shadow plans', async () => {
  const evidence = {}
  for (const mode of ['legacy', 'serial']) {
    const calls = [
      { id: `${mode}-0`, name: `${mode}_a`, arguments: {} },
      { id: `${mode}-1`, name: `${mode}_b`, arguments: {} },
    ]
    let active = 0; let maxActive = 0
    const run = await scenario(`${mode}-mode`, calls, calls.map((call) => def(call.name, async () => {
      active += 1; maxActive = Math.max(maxActive, active); await delay(10); active -= 1
      return { observation: call.name, pageChanged: false }
    })), { toolOrchestration: { mode, maxConcurrency: 4, parallelAllowlist: ['resume_query'] } })
    assertPaired(run.transcript, calls)
    assert.equal(maxActive, 1)
    assert.equal(run.events.filter((event) => event.type === 'tool_orchestration_plan').length, 0)
    evidence[mode] = { maxActive, resultIds: pairedResultIds(run.transcript) }
  }
  return evidence
})

await check('real Agent Loop shadow: browser writer and permission ordering remain serial', async () => {
  const calls = [
    { id: 'shadow-browser-0', name: 'browser_shadow_a', arguments: {} },
    { id: 'shadow-risk-0', name: 'shadow_risk_a', arguments: {} },
    { id: 'shadow-browser-1', name: 'browser_shadow_b', arguments: {} },
    { id: 'shadow-risk-1', name: 'shadow_risk_b', arguments: {} },
  ]
  let browserActive = 0; let browserMaxActive = 0
  const browser = async () => {
    browserActive += 1; browserMaxActive = Math.max(browserMaxActive, browserActive); await delay(10); browserActive -= 1
    return { observation: 'browser done', pageChanged: false }
  }
  const gate = new DelayedGate('approve')
  const run = await scenario('shadow-safety', calls, [
    def('browser_shadow_a', browser, { execution: browserPolicy }),
    def('browser_shadow_b', browser, { execution: browserPolicy }),
    def('shadow_risk_a', async () => ({ observation: 'risk a' }), { risk: 'L3' }),
    def('shadow_risk_b', async () => ({ observation: 'risk b' }), { risk: 'L3' }),
  ], {
    gate,
    toolOrchestration: { mode: 'shadow', maxConcurrency: 4, parallelAllowlist: ['resume_query'] },
  })
  assertPaired(run.transcript, calls)
  assert.equal(browserMaxActive, 1)
  assert.equal(gate.maxActive, 1)
  return { browserMaxActive, permissionMaxActive: gate.maxActive, resultIds: pairedResultIds(run.transcript) }
})

await check('real Agent Loop limited parallel: exact resume_query overlaps and commits stay ordered', async () => {
  const calls = [
    { id: 'parallel-0', name: 'resume_query', arguments: {} },
    { id: 'parallel-1', name: 'resume_query', arguments: {} },
    { id: 'parallel-browser', name: 'browser_parallel_barrier', arguments: {} },
    { id: 'parallel-risk', name: 'parallel_risk_action', arguments: {} },
  ]
  let resumeActive = 0; let resumeMaxActive = 0; let resumeInvocation = 0
  const resumeCompletionOrder = []
  let browserActive = 0; let browserMaxActive = 0
  const gate = new DelayedGate('approve')
  const started = performance.now()
  const run = await scenario('stage-c-parallel', calls, [
    def('resume_query', async () => {
      const invocation = resumeInvocation++
      resumeActive += 1; resumeMaxActive = Math.max(resumeMaxActive, resumeActive)
      await delay(invocation === 0 ? 200 : 80)
      resumeActive -= 1
      resumeCompletionOrder.push(invocation)
      return { observation: `resume ${invocation}`, pageChanged: false }
    }, { execution: Object.freeze({
      schemaVersion: 'tool-execution-policy/v1', readOnly: true, foreground: 'parallel',
      resource: 'none', interruptBehavior: 'cancel', background: 'never',
    }) }),
    def('browser_parallel_barrier', async () => {
      browserActive += 1; browserMaxActive = Math.max(browserMaxActive, browserActive)
      await delay(8); browserActive -= 1
      return { observation: 'browser barrier', pageChanged: false }
    }, { execution: browserPolicy }),
    def('parallel_risk_action', async () => ({ observation: 'risk action', pageChanged: false }), { risk: 'L3' }),
  ], { gate, toolOrchestration: { mode: 'parallel', maxConcurrency: 4, parallelAllowlist: ['resume_query'] } })
  const wallClockMs = Math.round(performance.now() - started)
  assert(resumeMaxActive >= 2)
  assert.deepEqual(resumeCompletionOrder, [1, 0], 'parallel runs must be able to settle B/A')
  assert.equal(browserMaxActive, 1)
  assert.equal(gate.maxActive, 1)
  assertPaired(run.transcript, calls)
  const lifecycle = run.events.filter((event) => /^(tool_call_created|tool_started|tool_completed|tool_failed)$/.test(event.type))
  for (const id of callIds(calls)) {
    assert.equal(lifecycle.filter((event) => event.toolCallId === id && event.type === 'tool_call_created').length, 1)
    assert.equal(lifecycle.filter((event) => event.toolCallId === id && /^(tool_completed|tool_failed)$/.test(event.type)).length, 1)
  }
  assert.equal(run.events.some((event) => event.data?.canonical === true), false, 'Stage C must not claim a second canonical lifecycle owner')
  return {
    resumeMaxActive, browserMaxActive, permissionMaxActive: gate.maxActive,
    wallClockMs, completionOrder: resumeCompletionOrder,
    lifecycleEvents: lifecycle.length, resultIds: pairedResultIds(run.transcript),
  }
})

await check('real Agent Loop limited parallel: capacity is bounded and non-exact allowlists fail closed', async () => {
  const policy = Object.freeze({
    schemaVersion: 'tool-execution-policy/v1', readOnly: true, foreground: 'parallel',
    resource: 'none', interruptBehavior: 'cancel', background: 'never',
  })
  const runCase = async (label, toolOrchestration, execution = policy) => {
    const calls = [
      { id: `${label}-0`, name: 'resume_query', arguments: {} },
      { id: `${label}-1`, name: 'resume_query', arguments: {} },
    ]
    let active = 0; let maxActive = 0; const completionOrder = []
    const started = performance.now()
    const run = await scenario(label, calls, [def('resume_query', async () => {
      const ordinal = completionOrder.length + active
      active += 1; maxActive = Math.max(maxActive, active)
      await delay(75)
      active -= 1; completionOrder.push(ordinal)
      return { observation: `${label}:${ordinal}`, pageChanged: false }
    }, { execution })], { toolOrchestration })
    return {
      maxActive,
      wallClockMs: Math.round(performance.now() - started),
      completionOrder,
      resultIds: pairedResultIds(run.transcript),
    }
  }

  const capacity1 = await runCase('capacity-1', { mode: 'parallel', maxConcurrency: 1, parallelAllowlist: ['resume_query'] })
  const capacity2 = await runCase('capacity-2', { mode: 'parallel', maxConcurrency: 2, parallelAllowlist: ['resume_query'] })
  const capacity4 = await runCase('capacity-4', { mode: 'parallel', maxConcurrency: 4, parallelAllowlist: ['resume_query'] })
  const missingAllowlist = await runCase('allowlist-missing', { mode: 'parallel', maxConcurrency: 4 })
  const widenedAllowlist = await runCase('allowlist-widened', { mode: 'parallel', maxConcurrency: 4, parallelAllowlist: ['resume_query', 'browser_snapshot'] })
  const duplicatedAllowlist = await runCase('allowlist-duplicated', { mode: 'parallel', maxConcurrency: 4, parallelAllowlist: ['resume_query', 'resume_query'] })
  const invalidPolicy = await runCase('policy-invalid', { mode: 'parallel', maxConcurrency: 4, parallelAllowlist: ['resume_query'] }, Object.freeze({
    ...policy, resource: 'browser_session',
  }))

  assert.equal(capacity1.maxActive, 1)
  assert(capacity2.maxActive >= 2)
  assert(capacity4.maxActive >= 2)
  assert(capacity2.wallClockMs < capacity1.wallClockMs, `capacity=2 (${capacity2.wallClockMs}ms) must improve on capacity=1 (${capacity1.wallClockMs}ms)`)
  assert(capacity4.wallClockMs < capacity1.wallClockMs, `capacity=4 (${capacity4.wallClockMs}ms) must improve on capacity=1 (${capacity1.wallClockMs}ms)`)
  for (const rejected of [missingAllowlist, widenedAllowlist, duplicatedAllowlist, invalidPolicy]) {
    assert.equal(rejected.maxActive, 1, 'missing, widened, duplicate allowlists, or invalid policies must remain serial')
  }
  for (const [label, evidence] of [
    ['capacity-1', capacity1], ['capacity-2', capacity2], ['capacity-4', capacity4],
    ['allowlist-missing', missingAllowlist], ['allowlist-widened', widenedAllowlist], ['allowlist-duplicated', duplicatedAllowlist], ['policy-invalid', invalidPolicy],
  ]) {
    assert.deepEqual(evidence.resultIds, [`${label}-0`, `${label}-1`])
  }
  return { capacity1, capacity2, capacity4, missingAllowlist, widenedAllowlist, duplicatedAllowlist, invalidPolicy }
})

await check('real Agent Loop serial gate: abort fences prepare, block-run, and ordered commit', async () => {
  const parallelPolicy = Object.freeze({
    schemaVersion: 'tool-execution-policy/v1', readOnly: true, foreground: 'parallel',
    resource: 'none', interruptBehavior: 'cancel', background: 'never',
  })
  const orchestration = { mode: 'parallel', maxConcurrency: 4, parallelAllowlist: ['resume_query'] }

  const prepareController = new AbortController()
  const prepareGate = new DelayedGate('approve')
  const prepareCalls = [
    { id: 'prepare-abort-0', name: 'prepare_abort_risk', arguments: {} },
    { id: 'prepare-abort-1', name: 'after_prepare_abort', arguments: {} },
  ]
  const preparePending = scenario('stage-c-prepare-abort', prepareCalls, [
    def('prepare_abort_risk', async () => ({ observation: 'must not execute' }), { risk: 'L3' }),
    def('after_prepare_abort', async () => ({ observation: 'must not execute' })),
  ], { gate: prepareGate, abortSignal: prepareController.signal, toolOrchestration: orchestration })
  await waitUntil(() => prepareGate.timeline.some((entry) => entry.startsWith('start:')))
  prepareController.abort('abort during permission prepare')
  const prepareRun = await preparePending
  assert.equal(prepareGate.maxActive, 1)
  assertPaired(prepareRun.transcript, prepareCalls)

  const runController = new AbortController()
  const runCalls = [
    { id: 'run-abort-0', name: 'resume_query', arguments: {} },
    { id: 'run-abort-1', name: 'resume_query', arguments: {} },
    { id: 'run-abort-browser', name: 'browser_block_after_parallel', arguments: {} },
    { id: 'run-abort-after', name: 'after_run_abort', arguments: {} },
  ]
  let browserActive = 0; const runTimeline = []
  const runPending = scenario('stage-c-run-abort', runCalls, [
    def('resume_query', async () => { await delay(8); return { observation: 'resume complete', pageChanged: false } }, { execution: parallelPolicy }),
    def('browser_block_after_parallel', async () => {
      browserActive += 1; runTimeline.push('browser-start'); await delay(35); browserActive -= 1; runTimeline.push('browser-end')
      return { observation: 'browser settled', pageChanged: false }
    }, { execution: browserPolicy }),
    def('after_run_abort', async () => ({ observation: 'must not execute' })),
  ], { abortSignal: runController.signal, toolOrchestration: orchestration })
  await waitUntil(() => runTimeline.includes('browser-start'))
  runController.abort('abort during block browser run')
  const runResult = await runPending
  runTimeline.push('loop-resolved')
  assert.equal(browserActive, 0)
  assert(runTimeline.indexOf('browser-end') < runTimeline.indexOf('loop-resolved'))
  assertPaired(runResult.transcript, runCalls)

  const commitController = new AbortController()
  const commitCalls = [
    { id: 'commit-abort-0', name: 'resume_query', arguments: {} },
    { id: 'commit-abort-1', name: 'resume_query', arguments: {} },
    { id: 'commit-abort-after', name: 'after_commit_abort', arguments: {} },
  ]
  let toolResultWrites = 0
  const commitRun = await scenario('stage-c-commit-abort', commitCalls, [
    def('resume_query', async () => ({ observation: 'commit fixture', pageChanged: false }), { execution: parallelPolicy }),
    def('after_commit_abort', async () => ({ observation: 'must not execute' })),
  ], {
    abortSignal: commitController.signal,
    toolOrchestration: orchestration,
    onSessionCreated(session) {
      const transcript = session.transcript.bind(session)
      session.transcript = async (entry) => {
        if (entry.type === 'tool_result' && toolResultWrites++ === 0) commitController.abort('abort during ordered commit')
        await transcript(entry)
      }
    },
  })
  assert.equal(toolResultWrites >= 1, true)
  assertPaired(commitRun.transcript, commitCalls)
  return {
    prepare: { gateMaxActive: prepareGate.maxActive, resultIds: pairedResultIds(prepareRun.transcript) },
    run: { activeAtResolution: browserActive, timeline: runTimeline, resultIds: pairedResultIds(runResult.transcript) },
    commit: { toolResultWrites, resultIds: pairedResultIds(commitRun.transcript) },
  }
})

const failed = results.filter((result) => result.status === 'FAIL')
console.log(JSON.stringify({
  suite: 'tool-orchestration-chaos', stage: 'O10-5C-limited-parallel', ok: failed.length === 0, results,
  veto: failed.length === 0 ? null : 'STAGE_C_RUNTIME_INVARIANT_FAILURE: roll back effective execution to serial',
}, null, 2))
if (failed.length) process.exitCode = 1
