#!/usr/bin/env node
import assert from 'node:assert/strict'
import {
  orchestrateToolCalls,
  partitionToolCalls,
  ToolBatchPlanError,
} from '../dist/tools/tool-orchestrator.js'

const parallelPolicy = {
  schemaVersion: 'tool-execution-policy/v1',
  readOnly: true,
  foreground: 'parallel',
  resource: 'none',
  interruptBehavior: 'cancel',
  background: 'never',
  source: 'catalog',
}
const exclusivePolicy = {
  schemaVersion: 'tool-execution-policy/v1',
  readOnly: true,
  foreground: 'exclusive',
  resource: 'browser_session',
  resourceKey: 'browser:s-1',
  interruptBehavior: 'block',
  background: 'never',
  source: 'catalog',
}

function calls(...names) {
  return names.map((name, index) => ({ id: `call-${index}`, name, arguments: { index } }))
}

function plan(names, mode = 'parallel', overrides = {}) {
  return partitionToolCalls(calls(...names), {
    turnId: 'turn-1',
    mode,
    maxConcurrency: 2,
    resolvePolicy: (call) => call.name === 'parallel' ? parallelPolicy : exclusivePolicy,
    ...overrides,
  })
}

const partitioned = plan(['parallel', 'parallel', 'exclusive', 'parallel'])
assert.deepEqual(partitioned.batches.map((batch) => [batch.mode, batch.calls.map((item) => item.index)]), [
  ['parallel', [0, 1]],
  ['exclusive', [2]],
  ['parallel', [3]],
])
assert.deepEqual(partitioned.batches.map((batch) => batch.batchId), ['turn-1:0-1', 'turn-1:2-2', 'turn-1:3-3'])
assert.deepEqual(plan(['parallel', 'parallel'], 'serial').batches.map((batch) => batch.calls.length), [1, 1])
assert.deepEqual(plan(['parallel', 'parallel'], 'shadow').batches.map((batch) => batch.calls.length), [2])

const diagnostics = []
const fallback = plan(['parallel', 'parallel', 'parallel'], 'parallel', {
  resolvePolicy(_call, index) {
    if (index === 0) throw new Error('resolver exploded')
    if (index === 1) return { ...parallelPolicy, resource: 'browser_session' }
    return parallelPolicy
  },
  onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
})
assert.deepEqual(fallback.batches.map((batch) => [batch.mode, batch.calls.map((item) => item.index)]), [
  ['exclusive', [0]],
  ['exclusive', [1]],
  ['parallel', [2]],
])
assert.equal(diagnostics.length, 2)
assert.throws(
  () => partitionToolCalls([{ id: 'same', name: 'a', arguments: {} }, { id: 'same', name: 'b', arguments: {} }], {
    turnId: 'turn-1', mode: 'parallel', resolvePolicy: () => parallelPolicy,
  }),
  ToolBatchPlanError,
)
assert.equal(plan(['parallel'], 'parallel', { maxConcurrency: 99, maxConcurrencyUpperBound: 3 }).maxConcurrency, 3)
assert.equal(plan(['parallel'], 'parallel', { maxConcurrency: 0 }).maxConcurrency, 1)

function normalized(call, status = 'succeeded', extra = {}) {
  const now = new Date().toISOString()
  return {
    schemaVersion: 'normalized-tool-result/v1',
    toolCallId: call.id,
    name: call.name,
    args: call.arguments,
    ok: status === 'succeeded',
    status,
    observation: status === 'succeeded' ? 'ok' : 'blocked',
    pageChanged: false,
    done: false,
    state: {
      version: 1,
      toolCallId: call.id,
      name: call.name,
      turnId: 'turn-1',
      step: 1,
      status,
      attempts: status === 'blocked' ? 0 : 1,
      queuedAt: now,
      completedAt: now,
      durationMs: 0,
    },
    queuedAt: now,
    completedAt: now,
    durationMs: 0,
    ...extra,
  }
}

function prepared(call, index, policy) {
  return {
    schemaVersion: 'prepared-tool-call/v1',
    index,
    call,
    executionPolicy: policy,
    policyDecision: { action: 'allow' },
    permissionRequest: { id: `permission-${index}` },
    permissionDecision: { decision: 'allow' },
    preparedAt: new Date().toISOString(),
    context: {
      schemaVersion: 'tool-use-context/v1',
      runId: 'run-1',
      sessionId: 's-1',
      turnId: 'turn-1',
      step: 1,
      toolCallId: call.id,
      local: { sessionId: 's-1', highlight: false, trace: {} },
    },
  }
}

function terminalFromProposal(proposal) {
  return {
    schemaVersion: 'tool-prepare-outcome/v1',
    kind: 'terminal',
    index: proposal.index,
    call: proposal.call,
    result: normalized(proposal.call, 'blocked'),
    stop: { stopBatch: false, stopTurn: false },
  }
}

async function execute(names, mode, hooks = {}) {
  const input = calls(...names)
  const timeline = []
  let active = 0
  let maxActive = 0
  const result = await orchestrateToolCalls(input, {
    async prepare(call, index) {
      timeline.push(`prepare:${index}`)
      if (hooks.prepare) return hooks.prepare(call, index)
      return {
        schemaVersion: 'tool-prepare-outcome/v1',
        kind: 'ready',
        index,
        prepared: prepared(call, index, call.name === 'parallel' ? parallelPolicy : exclusivePolicy),
      }
    },
    async run(item) {
      active += 1
      maxActive = Math.max(maxActive, active)
      timeline.push(`run-start:${item.index}`)
      await new Promise((resolve) => setTimeout(resolve, hooks.delays?.[item.index] ?? 1))
      timeline.push(`run-end:${item.index}`)
      active -= 1
      if (hooks.throwAt === item.index) throw new Error('run rejected')
      return {
        schemaVersion: 'tool-run-outcome/v1',
        index: item.index,
        prepared: item,
        execution: normalized(item.call),
      }
    },
    async commit(outcome) {
      timeline.push(`commit:${outcome.index}`)
      hooks.onCommit?.(outcome.index)
      const committed = {
        schemaVersion: 'tool-commit-outcome/v1',
        index: outcome.index,
        committedToolCallId: 'prepared' in outcome ? outcome.prepared.call.id : outcome.call.id,
        continueTurn: true,
        done: false,
        blocked: false,
      }
      return { ...committed, ...hooks.commitOutcome?.(outcome) }
    },
  }, {
    turnId: 'turn-1',
    mode,
    maxConcurrency: hooks.maxConcurrency ?? 2,
    abortSignal: hooks.abortSignal,
    resolvePolicy: (call) => call.name === 'parallel' ? parallelPolicy : exclusivePolicy,
    materializeTerminal: async (proposal) => terminalFromProposal(proposal),
  })
  return { result, timeline, maxActive }
}

const parallel = await execute(['parallel', 'parallel', 'exclusive', 'parallel'], 'parallel', {
  delays: { 0: 30, 1: 5 },
})
assert.equal(parallel.maxActive, 2)
assert(parallel.timeline.indexOf('run-end:1') < parallel.timeline.indexOf('run-end:0'))
assert.deepEqual(parallel.timeline.filter((entry) => entry.startsWith('commit:')), ['commit:0', 'commit:1', 'commit:2', 'commit:3'])
assert(parallel.timeline.indexOf('commit:1') < parallel.timeline.indexOf('run-start:2'))
assert(parallel.timeline.indexOf('commit:2') < parallel.timeline.indexOf('run-start:3'))

const bounded = await execute(['parallel', 'parallel', 'parallel', 'parallel'], 'parallel', { maxConcurrency: 2, delays: { 0: 10, 1: 10, 2: 10, 3: 10 } })
assert.equal(bounded.maxActive, 2)
const shadow = await execute(['parallel', 'parallel'], 'shadow', { delays: { 0: 5, 1: 5 } })
assert.equal(shadow.result.plan.batches[0].mode, 'parallel')
assert.equal(shadow.maxActive, 1)

const rejected = await execute(['parallel', 'parallel'], 'parallel', { throwAt: 0, delays: { 0: 2, 1: 5 } })
assert.equal(rejected.maxActive, 2)
assert(rejected.timeline.includes('run-end:1'))
assert.deepEqual(rejected.result.terminalProposals.map((proposal) => proposal.index), [1])

const abortController = new AbortController()
const aborted = await execute(['exclusive', 'parallel', 'parallel'], 'parallel', {
  abortSignal: abortController.signal,
  onCommit(index) {
    if (index === 0) abortController.abort('stop after first barrier')
  },
})
assert.deepEqual(aborted.timeline.filter((entry) => entry.startsWith('run-start:')), ['run-start:0'])
assert.deepEqual(aborted.result.terminalProposals.map((proposal) => [proposal.index, proposal.code]), [
  [1, 'SESSION_ABORTED'],
  [2, 'SESSION_ABORTED'],
])
assert.deepEqual(aborted.timeline.filter((entry) => entry.startsWith('commit:')), ['commit:0', 'commit:1', 'commit:2'])

const stopped = await execute(['parallel', 'parallel', 'parallel', 'exclusive'], 'parallel', {
  prepare(call, index) {
    if (index !== 1) {
      return {
        schemaVersion: 'tool-prepare-outcome/v1', kind: 'ready', index,
        prepared: prepared(call, index, call.name === 'parallel' ? parallelPolicy : exclusivePolicy),
      }
    }
    return {
      schemaVersion: 'tool-prepare-outcome/v1', kind: 'terminal', index, call,
      result: normalized(call, 'blocked'),
      stop: { stopBatch: true, stopTurn: true, reason: 'POLICY_DENIED' },
    }
  },
  commitOutcome(outcome) {
    return outcome.index === 1 ? { blocked: true } : undefined
  },
})
assert.deepEqual(stopped.timeline.filter((entry) => entry.startsWith('prepare:')), ['prepare:0', 'prepare:1'])
assert.deepEqual(stopped.timeline.filter((entry) => entry.startsWith('run-start:')), ['run-start:0'])
assert.deepEqual(stopped.timeline.filter((entry) => entry.startsWith('commit:')), ['commit:0', 'commit:1', 'commit:2', 'commit:3'])
assert.deepEqual(stopped.result.terminalProposals.map((proposal) => [proposal.index, proposal.code]), [
  [2, 'EARLIER_TOOL_BLOCKED'],
  [3, 'EARLIER_TOOL_BLOCKED'],
])
assert.equal(stopped.result.terminalProposals.filter((proposal) => proposal.index === 2).length, 1)
assert.equal(stopped.result.terminalProposals.filter((proposal) => proposal.index === 3).length, 1)

console.log('tool-orchestrator-test: PASS')
