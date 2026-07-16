#!/usr/bin/env node
import assert from 'node:assert/strict'
import { BackgroundToolBridge, BackgroundToolBridgeError } from '../dist/tools/background-tool-bridge.js'
import { listLocalToolDefs, listToolDefs } from '../dist/tools/catalog.js'
import { classifySafetyInvariant } from '../dist/policy/safety-invariants.js'
import { PermissionEngine } from '../dist/permission/permission-engine.js'
import { persistentPermissionRuleFromDecision } from '../dist/permission/persistent-rules.js'
import { createToolPermissionRequest } from '../dist/permission/permission-types.js'
import { orchestrateToolCalls, partitionToolCalls } from '../dist/tools/tool-orchestrator.js'
import { CompletionGate } from '../dist/workflow/completion-gate.js'
import {
  FAIL_CLOSED_TOOL_EXECUTION_POLICY_V1,
  resolveToolExecutionPolicy,
} from '../dist/tools/tool-execution-policy.js'

const results = []

async function check(name, maturity, test) {
  try {
    const evidence = await test()
    results.push({ name, maturity, status: 'PASS', evidence })
  } catch (error) {
    results.push({ name, maturity, status: 'FAIL', error: error instanceof Error ? error.message : String(error) })
  }
}

const parallelPolicy = Object.freeze({
  schemaVersion: 'tool-execution-policy/v1', readOnly: true, foreground: 'parallel', resource: 'none',
  interruptBehavior: 'cancel', background: 'never', source: 'catalog',
})
const browserPolicy = Object.freeze({
  schemaVersion: 'tool-execution-policy/v1', readOnly: true, foreground: 'exclusive', resource: 'browser_session',
  resourceKey: 'browser:safety-session', interruptBehavior: 'block', background: 'never', source: 'catalog',
})

function calls(names) {
  return names.map((name, index) => ({ id: `safety-call-${index}`, name, arguments: { index } }))
}

async function browserSingleWriter() {
  const observed = { active: 0, maxActive: 0 }
  const input = calls(['browser_snapshot', 'browser_wait', 'browser_screenshot'])
  const { result } = await execute(input, {
    resolvePolicy: () => browserPolicy,
    async run(item) {
      observed.active += 1
      observed.maxActive = Math.max(observed.maxActive, observed.active)
      await delay(8)
      observed.active -= 1
      return runOutcome(item)
    },
  })
  assert.equal(observed.maxActive, 1)
  assert.deepEqual(result.plan.batches.map((batch) => batch.mode), ['exclusive', 'exclusive', 'exclusive'])
  return { browserMaxActive: observed.maxActive, commitIndices: result.commits.map((commit) => commit.index) }
}

async function prepareGateSerialization() {
  const permission = { active: 0, maxActive: 0 }
  const human = { active: 0, maxActive: 0 }
  const input = calls(['resume_query', 'resume_query', 'resume_query'])
  const { result } = await execute(input, {
    resolvePolicy: () => parallelPolicy,
    async prepare(call, index) {
      permission.active += 1
      permission.maxActive = Math.max(permission.maxActive, permission.active)
      await delay(4)
      permission.active -= 1
      human.active += 1
      human.maxActive = Math.max(human.maxActive, human.active)
      await delay(4)
      human.active -= 1
      return ready(call, index, parallelPolicy)
    },
  })
  assert.equal(permission.maxActive, 1)
  assert.equal(human.maxActive, 1)
  assert.deepEqual(result.commits.map((commit) => commit.index), [0, 1, 2])
  return { permissionMaxActive: 1, humanMaxActive: 1 }
}

function readOnlyIsNotConcurrencyAuthority() {
  const missing = resolveToolExecutionPolicy({
    toolName: 'legacy_read_only', arguments: {}, sessionId: 'safety-session', catalogPolicy: undefined,
  })
  assert.strictEqual(missing, FAIL_CLOSED_TOOL_EXECUTION_POLICY_V1)
  const resolvedBrowser = resolveToolExecutionPolicy({
    toolName: 'browser_form_audit', arguments: {}, sessionId: 'safety-session',
    catalogPolicy: { ...browserPolicy, resourceKey: undefined, source: undefined },
  })
  assert.equal(resolvedBrowser.foreground, 'exclusive')
  assert.equal(resolvedBrowser.resourceKey, 'browser:safety-session')
  const plan = partitionToolCalls(calls([
    'browser_form_audit', 'browser_inspect_options', 'browser_wait', 'browser_screenshot',
  ]), {
    turnId: 'turn-read-only-browser', mode: 'parallel', maxConcurrency: 4, resolvePolicy: () => resolvedBrowser,
  })
  assert(plan.batches.every((batch) => batch.mode === 'exclusive' && batch.calls.length === 1))
  return { failClosedWithoutTypedPolicy: true, exclusiveReadOnlyBrowserTools: 4 }
}

function hardBoundaryRegression() {
  const cases = [
    ['final_submit', { toolName: 'browser_click_text', args: { text: 'Submit application' }, risk: 'L4' }],
    ['upload_resume', { toolName: 'browser_upload_file', args: { text: 'Upload resume' }, risk: 'L3' }],
    ['login', { toolName: 'browser_click_text', args: { text: 'Sign in with SSO' }, risk: 'L3' }],
    ['captcha', { toolName: 'browser_click_text', args: { text: 'Verify you are human captcha' }, risk: 'L3' }],
    ['save_resume', { toolName: 'browser_click_text', args: { text: 'Save profile' }, risk: 'L3' }],
  ]
  const engine = new PermissionEngine({ permissionMode: 'autopilot', allowFinalSubmit: true })
  for (const [gateKind, input] of cases) {
    const classification = classifySafetyInvariant(input)
    assert.equal(classification.action, 'gate', gateKind)
    assert.equal(classification.gateKind, gateKind)
    const request = permissionRequest(gateKind, input.toolName, input.args)
    const decision = engine.evaluate(request)
    assert.equal(decision.action, 'ask', `${gateKind} must not auto-allow`)
    assert.equal(decision.gateKind, gateKind)
    assert.equal(persistentPermissionRuleFromDecision({
      id: `remember-${gateKind}`, request, decision: { ...decision, action: 'allow' }, rememberScope: 'always',
    }), undefined, `${gateKind} must not be rememberable`)
  }
  return { gated: cases.map(([gateKind]) => gateKind), rememberedHardGateAllows: 0 }
}

function backgroundSummaryHasNoCompletionAuthority() {
  const decision = CompletionGate.evaluate({
    done: true,
    blocked: false,
    summary: 'Background worker claims the workflow is complete.',
    summaryAuthority: 'read_only_subagent',
    source: 'agent_done',
    taskType: 'fill_form',
  })
  assert.notEqual(decision.action, 'allow')
  assert.equal(decision.recommendedStatus, 'unchanged')
  assert.match(decision.reason, /Non-authoritative subagent summary \(not completion evidence\)/)
  return { action: decision.action, recommendedStatus: decision.recommendedStatus }
}

function waveSixBackgroundPilotIsExactAndDefaultOff() {
  const catalog = new Map(listToolDefs().map((tool) => [tool.name, tool]))
  const defaultLocal = new Map(listLocalToolDefs().map((tool) => [tool.name, tool]))
  const enabledLocal = new Map(listLocalToolDefs({ traceSummarizationBackground: true }).map((tool) => [tool.name, tool]))
  const trace = catalog.get('trace_summarization')
  const spawn = catalog.get('agent_task_spawn')
  assert(trace, 'trace_summarization must remain explicit and auditable')
  assert.equal(trace.execution.background, 'never')
  assert.equal(trace.execution.foreground, 'exclusive')
  assert.equal(trace.execution.resource, 'run_state')
  assert.equal(trace.local.enabled, false, 'Wave 5 must not register the future background pilot locally')
  assert.equal(trace.metadata?.backgroundPilot, true)
  assert.equal(defaultLocal.has('trace_summarization'), false, 'default-off registry must expose no trace pilot')
  const enabledTrace = enabledLocal.get('trace_summarization')
  assert(enabledTrace, 'exact enabled pilot must expose trace_summarization')
  assert.deepEqual({
    background: enabledTrace.execution.background,
    foreground: enabledTrace.execution.foreground,
    resource: enabledTrace.execution.resource,
    resourceKey: enabledTrace.execution.resourceKey,
  }, { background: 'eligible', foreground: 'exclusive', resource: 'none', resourceKey: undefined })
  assert.deepEqual(
    [...enabledLocal.values()].filter((tool) => tool.execution.background === 'eligible').map((tool) => tool.name),
    ['trace_summarization'],
  )
  assert(spawn)
  assert.equal(spawn.execution.background, 'never', 'control-plane spawn must never recursively background itself')
  return {
    defaultTraceState: 'background_never_local_disabled',
    enabledEligibleTools: ['trace_summarization'],
    agentTaskSpawnBackground: spawn.execution.background,
  }
}

async function backgroundBoundaryRegression() {
  let spawnCalls = 0
  const mapping = {
    schemaVersion: 'background-tool-bridge/v1', toolName: 'browser_snapshot', taskKind: 'trace_summarization',
    async toSpawnInput() { return { kind: 'trace_summarization', title: 'forbidden', idempotencyKey: 'forbidden' } },
  }
  const bridge = new BackgroundToolBridge({
    runtime: { async spawn() { spawnCalls += 1; throw new Error('must not spawn') } }, mappings: [mapping],
  })
  await rejectsBridge(() => bridge.start(backgroundPrepared('browser_snapshot', {})), 'BACKGROUND_RESOURCE_FORBIDDEN')
  const analysisBridge = new BackgroundToolBridge({
    runtime: { async spawn() { spawnCalls += 1; throw new Error('must not spawn') } },
    mappings: [{ ...mapping, toolName: 'trace_summarization' }],
  })
  await rejectsBridge(
    () => analysisBridge.start(backgroundPrepared('trace_summarization', { page: new FakePage() })),
    'BACKGROUND_INPUT_NOT_CLONEABLE',
  )
  await rejectsBridge(
    () => analysisBridge.start(backgroundPrepared('trace_summarization', { domRef: 'e12' })),
    'BACKGROUND_RESOURCE_FORBIDDEN',
  )
  await rejectsBridge(
    () => analysisBridge.start(backgroundPrepared('trace_summarization', {}, { resource: 'human' })),
    'BACKGROUND_RESOURCE_FORBIDDEN',
  )
  await rejectsBridge(
    () => analysisBridge.start(backgroundPrepared('trace_summarization', {}, { resource: 'run_state' })),
    'BACKGROUND_RESOURCE_FORBIDDEN',
  )
  await rejectsBridge(
    () => analysisBridge.start(backgroundPrepared('agent_task_spawn', {})),
    'BACKGROUND_RESOURCE_FORBIDDEN',
  )
  await rejectsBridge(
    () => analysisBridge.start(backgroundPrepared('memory_retrieval', {})),
    'BACKGROUND_MAPPING_NOT_FOUND',
  )
  assert.equal(spawnCalls, 0)
  return { spawnCalls, rejected: ['browser_resource', 'live_page', 'dom_ref', 'human', 'run_state', 'agent_task_spawn', 'memory_retrieval'] }
}

async function backgroundStartIsAdvisoryOnly() {
  const bridge = new BackgroundToolBridge({
    runtime: {
      async spawn(input) {
        return { schemaVersion: 'task-spawn-resolution/v1', outcome: 'created', task: { id: 'task-advisory', status: 'pending', outputs: [], kind: input.kind } }
      },
    },
    mappings: [{
      schemaVersion: 'background-tool-bridge/v1', toolName: 'trace_summarization', taskKind: 'trace_summarization',
      async toSpawnInput() { return { kind: 'trace_summarization', title: 'Safe trace', idempotencyKey: 'safe-trace:v1' } },
    }],
  })
  const started = await bridge.start(backgroundPrepared('trace_summarization', {}))
  assert.equal(started.requiresMainWorkflowVerification, true)
  assert.equal(started.authoritativeCompletionEvidence, false)
  return { taskId: started.taskId, requiresMainWorkflowVerification: true, authoritativeCompletionEvidence: false }
}

async function abortHasNoDetachedBrowserWork() {
  const controller = new AbortController()
  const timeline = []
  let active = 0
  const input = calls(['browser_wait', 'browser_snapshot'])
  const promise = execute(input, {
    abortSignal: controller.signal,
    resolvePolicy: () => browserPolicy,
    async run(item) {
      active += 1
      timeline.push(`start:${item.index}`)
      await delay(25)
      timeline.push(`end:${item.index}`)
      active -= 1
      return runOutcome(item)
    },
  })
  setTimeout(() => controller.abort('safety fixture abort'), 5)
  const { result } = await promise
  timeline.push('orchestrator-resolved')
  assert.equal(active, 0)
  assert.deepEqual(timeline.filter((item) => item.startsWith('start:')), ['start:0'])
  assert(timeline.indexOf('end:0') < timeline.indexOf('orchestrator-resolved'))
  assert.deepEqual(result.commits.map((commit) => commit.index), [0, 1])
  return { activeAtResolution: active, timeline }
}

async function prepareDenyPairingExactlyOnce() {
  const input = calls(['resume_query', 'resume_query', 'resume_query', 'browser_snapshot'])
  const terminalized = []
  const committed = []
  const terminalProduced = []
  const result = await orchestrateToolCalls(input, {
    async prepare(call, index) {
      if (index !== 1) return ready(call, index, index === 3 ? browserPolicy : parallelPolicy)
      terminalProduced.push(index)
      return terminal(call, index, 'POLICY_DENIED')
    },
    async run(item) {
      terminalProduced.push(item.index)
      return runOutcome(item)
    },
    async commit(outcome) {
      committed.push(outcome.index)
      const blocked = !('execution' in outcome) || outcome.execution.status === 'blocked'
      return commitOutcome(outcome, { blocked, continueTurn: !blocked, stopReason: blocked ? 'POLICY_DENIED' : undefined })
    },
  }, {
    turnId: 'turn-safety', sessionId: 'safety-session', mode: 'parallel', maxConcurrency: 2,
    resolvePolicy: (_call, index) => index === 3 ? browserPolicy : parallelPolicy,
    async materializeTerminal(proposal) {
      terminalized.push(proposal.index)
      terminalProduced.push(proposal.index)
      return terminal(proposal.call, proposal.index)
    },
  })
  assert.deepEqual(committed, [0, 1, 2, 3], 'every index must commit exactly once in model order')
  assert.deepEqual(terminalized, [2, 3], 'each never-run call must be materialized exactly once')
  assert.deepEqual(terminalProduced.sort((a, b) => a - b), [0, 1, 2, 3], 'each call must produce exactly one terminal result')
  assert.deepEqual(result.terminalProposals.map((proposal) => proposal.index), [2, 3])
  return { committed, terminalized, terminalProduced }
}

async function execute(input, hooks = {}) {
  const result = await orchestrateToolCalls(input, {
    prepare: hooks.prepare ?? (async (call, index) => ready(call, index, hooks.resolvePolicy(call, index))),
    run: hooks.run ?? (async (item) => runOutcome(item)),
    commit: hooks.commit ?? (async (outcome) => commitOutcome(outcome)),
  }, {
    turnId: 'turn-safety', sessionId: 'safety-session', mode: 'parallel', maxConcurrency: 4,
    abortSignal: hooks.abortSignal,
    resolvePolicy: hooks.resolvePolicy,
    materializeTerminal: async (proposal) => terminal(proposal.call, proposal.index),
  })
  return { result }
}

function ready(call, index, policy) {
  return {
    schemaVersion: 'tool-prepare-outcome/v1', kind: 'ready', index,
    prepared: {
      schemaVersion: 'prepared-tool-call/v1', index, call, executionPolicy: policy,
      policyDecision: { action: 'allow' }, permissionRequest: { requestId: `permission-${index}` },
      permissionDecision: { action: 'allow' }, preparedAt: new Date().toISOString(),
      context: toolContext(call),
    },
  }
}

function terminal(call, index, reason) {
  return {
    schemaVersion: 'tool-prepare-outcome/v1', kind: 'terminal', index, call,
    result: normalized(call, 'blocked'),
    stop: reason ? { stopBatch: true, stopTurn: true, reason } : { stopBatch: false, stopTurn: false },
  }
}

function runOutcome(item) {
  return { schemaVersion: 'tool-run-outcome/v1', index: item.index, prepared: item, execution: normalized(item.call) }
}

function commitOutcome(outcome, patch = {}) {
  return {
    schemaVersion: 'tool-commit-outcome/v1', index: outcome.index,
    committedToolCallId: 'prepared' in outcome ? outcome.prepared.call.id : outcome.call.id,
    continueTurn: true, done: false, blocked: false, ...patch,
  }
}

function normalized(call, status = 'succeeded') {
  const now = new Date().toISOString()
  return {
    schemaVersion: 'normalized-tool-result/v1', toolCallId: call.id, name: call.name, args: call.arguments,
    ok: status === 'succeeded', status, observation: status, pageChanged: false, done: false,
    state: { version: 1, toolCallId: call.id, name: call.name, turnId: 'turn-safety', step: 1, status,
      attempts: status === 'blocked' ? 0 : 1, queuedAt: now, completedAt: now, durationMs: 0 },
    queuedAt: now, completedAt: now, durationMs: 0,
  }
}

function toolContext(call) {
  return {
    schemaVersion: 'tool-use-context/v1', runId: 'run-safety', sessionId: 'safety-session',
    turnId: call.id.startsWith('safety-call-') ? 'turn-safety' : 'turn-pairing', step: 1, toolCallId: call.id,
    local: { sessionId: 'safety-session', highlight: false, trace: {} },
  }
}

function permissionRequest(gateKind, toolName, args) {
  return createToolPermissionRequest({
    call: { id: `hard-${gateKind}`, name: toolName, arguments: args },
    policyDecision: {
      schemaVersion: 'policy-decision/v1', action: 'gate', riskLevel: 'critical', gateKind,
      policyCode: `policy.safety.${gateKind}`, ruleId: `policy.safety.${gateKind}.v1`, reason: `${gateKind} requires a gate.`,
      auditTags: [`gate:${gateKind}`],
    },
    risk: 'L4', currentUrl: 'https://example.test/apply', runId: 'run-safety', sessionId: 'safety-session',
    turnId: 'turn-hard-boundary', step: 1,
  })
}

function backgroundPrepared(name, arguments_, policyPatch = {}) {
  const call = { id: `background-${name}`, name, arguments: arguments_ }
  return {
    ...ready(call, 0, {
      schemaVersion: 'tool-execution-policy/v1', readOnly: true, foreground: 'exclusive', resource: 'none',
      interruptBehavior: 'cancel', background: 'eligible', source: 'catalog',
      ...policyPatch,
    }).prepared,
    context: { ...toolContext(call), turnId: 'turn-background' },
  }
}

async function rejectsBridge(operation, code) {
  await assert.rejects(operation, (error) => {
    assert(error instanceof BackgroundToolBridgeError)
    assert.equal(error.code, code)
    return true
  })
}

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)) }
class FakePage {}

await check('same-session browser single-writer', 'implemented_module', browserSingleWriter)
await check('permission and Human Gate prepare serialization', 'implemented_module', prepareGateSerialization)
await check('readOnly does not authorize browser parallelism', 'implemented_module', readOnlyIsNotConcurrencyAuthority)
await check('final-submit/upload/login/captcha hard boundaries', 'current_runtime_regression', hardBoundaryRegression)
await check('background rejects browser, live objects, and DOM refs', 'implemented_module', backgroundBoundaryRegression)
await check('background summary has no CompletionGate authority', 'current_runtime_regression', backgroundSummaryHasNoCompletionAuthority)
await check('Wave 6 trace pilot is exact and default off', 'current_runtime_regression', waveSixBackgroundPilotIsExactAndDefaultOff)
await check('background start output is advisory only', 'implemented_module', backgroundStartIsAdvisoryOnly)
await check('abort leaves no detached browser work', 'implemented_module', abortHasNoDetachedBrowserWork)
await check('prepare-deny terminal pairing is exactly once', 'expected_contract', prepareDenyPairingExactlyOnce)

const failed = results.filter((result) => result.status === 'FAIL')
console.log(JSON.stringify({
  ok: failed.length === 0,
  suite: 'tool-safety-invariants',
  results,
  veto: failed.some((result) => result.name.includes('pairing'))
    ? 'TOOL_PAIRING_VIOLATION: remain serial; parallel release blocked'
    : null,
}, null, 2))
if (failed.length > 0) process.exitCode = 1
