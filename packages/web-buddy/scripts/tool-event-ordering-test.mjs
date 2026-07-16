#!/usr/bin/env node
import assert from 'node:assert/strict'
import { orchestrateToolCalls } from '../dist/tools/tool-orchestrator.js'

const CANONICAL_OWNER = Object.freeze({
  batch_planned: 'ToolOrchestrator',
  batch_started: 'ToolOrchestrator',
  batch_completed: 'ToolOrchestrator',
  orchestration_downgraded: 'ToolOrchestrator',
  tool_queued: 'ToolExecutionService',
  tool_running: 'ToolExecutionService',
  tool_terminal: 'ToolExecutionService',
  permission_requested: 'PermissionHumanGatePipeline',
  permission_resolved: 'PermissionHumanGatePipeline',
  tool_commit_started: 'OrderedCommitStage',
  tool_commit_completed: 'OrderedCommitStage',
  tool_commit_failed: 'OrderedCommitStage',
})

const calls = ['A', 'B'].map((id, originalIndex) => ({
  id: `call-${id.toLowerCase()}`,
  name: 'resume_query',
  originalIndex,
}))

function canonical(eventKind, patch = {}) {
  return {
    schemaVersion: 'tool-event-ordering/v1',
    eventId: `event-${eventKind}-${patch.toolCallId ?? patch.batchId ?? 'turn'}-${patch.originalIndex ?? 'x'}`,
    eventKind,
    sessionId: 'session-1',
    runId: 'run-1',
    turnId: 'turn-1',
    occurredAt: '2026-07-10T00:00:00.000Z',
    correlationId: 'turn-1',
    canonical: true,
    owner: CANONICAL_OWNER[eventKind],
    ...patch,
  }
}

function eventKey(event) {
  return [
    event.schemaVersion,
    event.eventKind,
    event.sessionId,
    event.turnId,
    event.batchId ?? '',
    event.toolCallId ?? '',
    event.originalIndex ?? '',
  ].join('|')
}

function assertCanonicalOwnership(events) {
  const keys = new Set()
  for (const event of events) {
    if (event.canonical !== true) continue
    assert.equal(event.owner, CANONICAL_OWNER[event.eventKind], `wrong canonical owner for ${event.eventKind}`)
    const key = eventKey(event)
    assert(!keys.has(key), `duplicate canonical event: ${key}`)
    keys.add(key)
  }
}

function assertBefore(events, first, second) {
  const left = events.findIndex(first)
  const right = events.findIndex(second)
  assert(left >= 0, 'first event is missing')
  assert(right >= 0, 'second event is missing')
  assert(left < right, `event order violation at positions ${left}/${right}`)
}

function assertOrdering(events, declaredCalls, committedResults) {
  assertCanonicalOwnership(events)
  assertBefore(events, (event) => event.eventKind === 'batch_planned', (event) => event.eventKind === 'batch_started')

  for (const call of declaredCalls) {
    assertBefore(
      events,
      (event) => event.eventKind === 'tool_queued' && event.toolCallId === call.id,
      (event) => event.eventKind === 'tool_terminal' && event.toolCallId === call.id,
    )
    const running = events.find((event) => event.eventKind === 'tool_running' && event.toolCallId === call.id)
    if (running) {
      assertBefore(
        events,
        (event) => event.eventKind === 'tool_queued' && event.toolCallId === call.id,
        (event) => event.eventKind === 'tool_running' && event.toolCallId === call.id,
      )
      assertBefore(
        events,
        (event) => event.eventKind === 'tool_running' && event.toolCallId === call.id,
        (event) => event.eventKind === 'tool_terminal' && event.toolCallId === call.id,
      )
    }
    assert.equal(events.filter((event) => event.eventKind === 'tool_terminal' && event.toolCallId === call.id).length, 1)
  }

  const commitIndices = events
    .filter((event) => event.eventKind === 'tool_commit_completed')
    .map((event) => event.originalIndex)
  assert.deepEqual(commitIndices, [...commitIndices].sort((a, b) => a - b))
  assert.deepEqual(committedResults.map((result) => result.toolCallId), declaredCalls.map((call) => call.id))
  assert.equal(new Set(committedResults.map((result) => result.toolCallId)).size, declaredCalls.length)
  assertBefore(events, (event) => event.eventKind === 'tool_commit_completed' && event.originalIndex === 1, (event) => event.eventKind === 'batch_completed')
}

const batchId = 'turn-1:0-1'
const orderedFixture = [
  canonical('batch_planned', { batchId }),
  canonical('batch_started', { batchId }),
  canonical('tool_queued', { batchId, toolCallId: calls[0].id, originalIndex: 0 }),
  canonical('tool_running', { batchId, toolCallId: calls[0].id, originalIndex: 0 }),
  canonical('tool_queued', { batchId, toolCallId: calls[1].id, originalIndex: 1 }),
  canonical('tool_running', { batchId, toolCallId: calls[1].id, originalIndex: 1 }),
  canonical('tool_terminal', { batchId, toolCallId: calls[1].id, originalIndex: 1, terminalStatus: 'succeeded' }),
  canonical('tool_terminal', { batchId, toolCallId: calls[0].id, originalIndex: 0, terminalStatus: 'succeeded' }),
  canonical('tool_commit_started', { batchId, toolCallId: calls[0].id, originalIndex: 0 }),
  canonical('tool_commit_completed', { batchId, toolCallId: calls[0].id, originalIndex: 0 }),
  canonical('tool_commit_started', { batchId, toolCallId: calls[1].id, originalIndex: 1 }),
  canonical('tool_commit_completed', { batchId, toolCallId: calls[1].id, originalIndex: 1 }),
  canonical('batch_completed', { batchId }),
]

const orderedResults = calls.map((call) => ({ toolCallId: call.id, name: call.name, originalIndex: call.originalIndex }))
assertOrdering(orderedFixture, calls, orderedResults)
assert.deepEqual(
  orderedFixture.filter((event) => event.eventKind === 'tool_terminal').map((event) => event.toolCallId),
  ['call-b', 'call-a'],
)
assert.deepEqual(
  orderedFixture.filter((event) => event.eventKind === 'tool_commit_completed').map((event) => event.toolCallId),
  ['call-a', 'call-b'],
)

const projection = {
  ...orderedFixture.find((event) => event.eventKind === 'tool_terminal'),
  eventId: 'legacy-projection',
  canonical: false,
  legacyAliasOf: orderedFixture.find((event) => event.eventKind === 'tool_terminal').eventId,
}
assert.doesNotThrow(() => assertCanonicalOwnership([...orderedFixture, projection]))
assert.throws(
  () => assertCanonicalOwnership([...orderedFixture, { ...orderedFixture[6], eventId: 'duplicate-terminal' }]),
  /duplicate canonical event/,
)

function terminalizeDeclaredCalls(trigger) {
  const declared = ['A', 'B', 'C'].map((id, originalIndex) => ({
    id: `call-${id.toLowerCase()}`,
    name: id === 'A' && trigger === 'done' ? 'agent_done' : 'resume_query',
    originalIndex,
  }))
  const currentStatus = trigger === 'abort' ? 'cancelled' : trigger === 'deny' ? 'blocked' : 'succeeded'
  const remainingCode = trigger === 'abort'
    ? 'SESSION_ABORTED'
    : trigger === 'deny'
      ? 'EARLIER_TOOL_BLOCKED'
      : 'EARLIER_TOOL_COMPLETED'
  const results = declared.map((call, index) => ({
    toolCallId: call.id,
    name: call.name,
    originalIndex: index,
    status: index === 0 ? currentStatus : 'blocked',
    attempts: index === 0 && trigger !== 'deny' ? 1 : 0,
    ...(index > 0 ? { syntheticCode: remainingCode } : {}),
  }))
  return { declared, results }
}

for (const trigger of ['deny', 'abort', 'done']) {
  const { declared, results } = terminalizeDeclaredCalls(trigger)
  assert.deepEqual(results.map((result) => result.toolCallId), declared.map((call) => call.id))
  assert.equal(new Set(results.map((result) => result.toolCallId)).size, declared.length)
  assert(results.slice(1).every((result) => result.status === 'blocked' && result.attempts === 0))
}
assert.deepEqual(terminalizeDeclaredCalls('deny').results.slice(1).map((result) => result.syntheticCode), ['EARLIER_TOOL_BLOCKED', 'EARLIER_TOOL_BLOCKED'])
assert.deepEqual(terminalizeDeclaredCalls('abort').results.slice(1).map((result) => result.syntheticCode), ['SESSION_ABORTED', 'SESSION_ABORTED'])
assert.deepEqual(terminalizeDeclaredCalls('done').results.slice(1).map((result) => result.syntheticCode), ['EARLIER_TOOL_COMPLETED', 'EARLIER_TOOL_COMPLETED'])

// Real O4 API regression: a prepare-stop already materializes the unprepared
// suffix. A blocked commit for the stopping terminal must not materialize that
// same suffix a second time, because materialization owns synthetic terminal
// lifecycle publication under S004.
const parallelPolicy = {
  schemaVersion: 'tool-execution-policy/v1',
  readOnly: true,
  foreground: 'parallel',
  resource: 'none',
  interruptBehavior: 'cancel',
  background: 'never',
  source: 'catalog',
}
const o4Calls = ['A', 'B', 'C', 'D'].map((id, index) => ({
  id: `o4-${id.toLowerCase()}`,
  name: 'resume_query',
  arguments: { index },
}))

function normalizedResult(call, status, attempts) {
  const now = '2026-07-10T00:00:00.000Z'
  return {
    schemaVersion: 'normalized-tool-result/v1',
    toolCallId: call.id,
    name: call.name,
    args: call.arguments,
    ok: status === 'succeeded',
    status,
    observation: status,
    pageChanged: false,
    done: false,
    state: {
      version: 1,
      toolCallId: call.id,
      name: call.name,
      turnId: 'o4-turn',
      step: 1,
      status,
      attempts,
      queuedAt: now,
      completedAt: now,
      durationMs: 0,
    },
    queuedAt: now,
    completedAt: now,
    durationMs: 0,
  }
}

function o4Prepared(call, index) {
  return {
    schemaVersion: 'prepared-tool-call/v1',
    index,
    call,
    executionPolicy: parallelPolicy,
    policyDecision: { action: 'allow' },
    permissionRequest: {},
    permissionDecision: {},
    preparedAt: '2026-07-10T00:00:00.000Z',
    context: {
      schemaVersion: 'tool-use-context/v1',
      runId: 'o4-run',
      sessionId: 'o4-session',
      turnId: 'o4-turn',
      step: 1,
      toolCallId: call.id,
      local: {},
    },
  }
}

const materializedIndices = []
const committedIndices = []
const o4BlockedCommit = await orchestrateToolCalls(o4Calls, {
  async prepare(call, index) {
    if (index === 1) {
      return {
        schemaVersion: 'tool-prepare-outcome/v1',
        kind: 'terminal',
        index,
        call,
        result: normalizedResult(call, 'blocked', 0),
        stop: { stopBatch: true, stopTurn: true, reason: 'POLICY_DENIED' },
      }
    }
    return {
      schemaVersion: 'tool-prepare-outcome/v1',
      kind: 'ready',
      index,
      prepared: o4Prepared(call, index),
    }
  },
  async run(prepared) {
    return {
      schemaVersion: 'tool-run-outcome/v1',
      index: prepared.index,
      prepared,
      execution: normalizedResult(prepared.call, 'succeeded', 1),
    }
  },
  async commit(outcome) {
    committedIndices.push(outcome.index)
    const call = 'prepared' in outcome ? outcome.prepared.call : outcome.call
    return {
      schemaVersion: 'tool-commit-outcome/v1',
      index: outcome.index,
      committedToolCallId: call.id,
      continueTurn: outcome.index !== 1,
      done: false,
      blocked: outcome.index === 1,
      ...(outcome.index === 1 ? { stopReason: 'POLICY_DENIED' } : {}),
    }
  },
}, {
  turnId: 'o4-turn',
  sessionId: 'o4-session',
  mode: 'parallel',
  maxConcurrency: 2,
  resolvePolicy: () => parallelPolicy,
  async materializeTerminal(proposal) {
    materializedIndices.push(proposal.index)
    return {
      schemaVersion: 'tool-prepare-outcome/v1',
      kind: 'terminal',
      index: proposal.index,
      call: proposal.call,
      result: normalizedResult(proposal.call, 'blocked', 0),
      stop: { stopBatch: false, stopTurn: false },
    }
  },
})

assert.deepEqual(committedIndices, [0, 1, 2, 3], 'each call must commit exactly once in index order')
assert.deepEqual(materializedIndices, [2, 3], 'each never-run call must materialize exactly one synthetic terminal')
assert.deepEqual(o4BlockedCommit.terminalProposals.map((proposal) => proposal.index), [2, 3])

console.log(JSON.stringify({
  test: 'tool-event-ordering-test',
  status: 'PASS',
  evidenceKind: 'pure-contract-harness-not-production-integration',
  completionOrder: ['call-b', 'call-a'],
  commitOrder: ['call-a', 'call-b'],
  canonicalOwnersChecked: Object.keys(CANONICAL_OWNER).length,
  pairingTriggersChecked: ['deny', 'abort', 'done'],
  o4BlockedCommitFixture: 'PASS',
  unpairedToolCallCount: 0,
}))
