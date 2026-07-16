#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BackgroundToolBridge,
  BackgroundToolBridgeError,
  createTraceSummarizationMappingV1,
} from '../dist/tools/background-tool-bridge.js'
import { AsyncTaskRuntime } from '../dist/agents/async-task-runtime.js'
import { FileTaskGraphStore } from '../dist/agents/task-graph-store.js'
import { AgentTaskScheduler } from '../dist/agents/task-scheduler.js'
import { TaskNotificationQueue } from '../dist/agents/task-notification-queue.js'
import { RunnerRegistry } from '../dist/agents/runner-registry.js'

const sessionId = 'session-background-bridge'
const runId = 'run-background-bridge'
const traceRef = artifactRef('trace-42', 'trace')
class FakePage {}

await unitBoundaryTests()
await existingRuntimeIntegrationTest()

console.log(JSON.stringify({
  ok: true,
  contract: 'background-tool-bridge/v1',
  assertions: [
    'trusted exact-name mapping and stable task id',
    'idempotency reuse and conflict are delegated to runtime',
    'browser/human/run-state/control-plane tools are rejected',
    'live objects, DOM refs, invalid/cross-session artifacts, and non-JSON input are rejected',
    'spawn is called exactly once and bridge owns no task/notification state',
    'real AsyncTaskRuntime delivers one scheduler-owned terminal notification',
    'session abort remains an AsyncTaskRuntime/AgentTaskScheduler responsibility',
  ],
}, null, 2))

async function unitBoundaryTests() {
  const calls = []
  const runtime = {
    async spawn(input) {
      calls.push(structuredClone(input))
      return {
        schemaVersion: 'task-spawn-resolution/v1',
        outcome: calls.length === 1 ? 'created' : 'existing_same_digest',
        task: pendingTask('task-stable', input),
      }
    },
  }
  const bridge = new BackgroundToolBridge({ runtime, mappings: [createTraceSummarizationMappingV1()] })
  const prepared = preparedCall('trace_summarization', { traceArtifactRef: traceRef })
  const first = await bridge.start(prepared)
  const duplicate = await bridge.start(prepared)
  assert.equal(first.taskId, 'task-stable')
  assert.equal(first.spawnOutcome, 'created')
  assert.equal(first.status, 'pending')
  assert.deepEqual(first.outputRefs, [])
  assert.equal(first.requiresMainWorkflowVerification, true)
  assert.equal(first.authoritativeCompletionEvidence, false)
  assert.equal(duplicate.taskId, first.taskId)
  assert.equal(duplicate.spawnOutcome, 'existing_same_digest')
  assert.equal(calls.length, 2)
  assert.deepEqual(calls[0], calls[1])
  assert.equal(calls[0].kind, 'trace_summarization')
  assert.equal(calls[0].inputs[0].artifactRef.artifactId, traceRef.artifactId)
  assert.match(calls[0].idempotencyKey, /trace-42/)

  await rejectsCode(
    () => bridge.start(preparedCall('trace_summarization', { traceArtifactRef: traceRef }, { background: 'never' })),
    'BACKGROUND_NOT_ELIGIBLE',
  )
  await rejectsCode(
    () => bridge.start(preparedCall('trace_summarization', { traceArtifactRef: traceRef }, { resource: 'browser_session', resourceKey: `browser:${sessionId}` })),
    'BACKGROUND_RESOURCE_FORBIDDEN',
  )
  await rejectsCode(
    () => bridge.start(preparedCall('trace_summarization', { traceArtifactRef: traceRef }, { resourceKey: 'unexpected-lock' })),
    'BACKGROUND_RESOURCE_FORBIDDEN',
  )
  await rejectsCode(
    () => bridge.start(preparedCall('browser_snapshot', {})),
    'BACKGROUND_RESOURCE_FORBIDDEN',
  )
  await rejectsCode(
    () => bridge.start(preparedCall('agent_task_spawn', {})),
    'BACKGROUND_RESOURCE_FORBIDDEN',
  )
  await rejectsCode(
    () => bridge.start(preparedCall('unmapped_analysis', {})),
    'BACKGROUND_MAPPING_NOT_FOUND',
  )
  await rejectsCode(
    () => bridge.start(preparedCall('trace_summarization', { traceArtifactRef: traceRef, domRef: 'e12' })),
    'BACKGROUND_RESOURCE_FORBIDDEN',
  )
  await rejectsCode(
    () => bridge.start(preparedCall('trace_summarization', { traceArtifactRef: traceRef, page: new FakePage() })),
    'BACKGROUND_INPUT_NOT_CLONEABLE',
  )
  await rejectsCode(
    () => bridge.start(preparedCall('trace_summarization', { traceArtifactRef: { ...traceRef, sessionId: 'other-session' } })),
    'BACKGROUND_INPUT_NOT_IMMUTABLE',
  )
  await rejectsCode(
    () => bridge.start(preparedCall('trace_summarization', { traceArtifactRef: { ...traceRef, sha256: 'not-integral' } })),
    'BACKGROUND_INPUT_NOT_IMMUTABLE',
  )

  const conflictBridge = new BackgroundToolBridge({
    runtime: {
      async spawn() {
        return {
          schemaVersion: 'task-spawn-resolution/v1',
          outcome: 'conflict',
          error: taskError('IDEMPOTENCY_CONFLICT', 'same key, different digest'),
        }
      },
    },
    mappings: [createTraceSummarizationMappingV1()],
  })
  await rejectsCode(() => conflictBridge.start(prepared), 'BACKGROUND_IDEMPOTENCY_CONFLICT')

  const abortedBridge = new BackgroundToolBridge({
    runtime: {
      async spawn() {
        const contractError = taskError('SESSION_ABORTED', 'session stopped')
        throw Object.assign(new Error(contractError.message), { code: contractError.code, contractError })
      },
    },
    mappings: [createTraceSummarizationMappingV1()],
  })
  await rejectsCode(() => abortedBridge.start(prepared), 'SESSION_ABORTED')

  const forbiddenKindBridge = new BackgroundToolBridge({
    runtime,
    mappings: [{
      schemaVersion: 'background-tool-bridge/v1',
      toolName: 'delivery_analysis',
      taskKind: 'delivery_probe',
      async toSpawnInput() {
        return { kind: 'delivery_probe', title: 'Probe', idempotencyKey: 'probe:v1' }
      },
    }],
  })
  await rejectsCode(
    () => forbiddenKindBridge.start(preparedCall('delivery_analysis', {})),
    'BACKGROUND_TASK_KIND_FORBIDDEN',
  )
  assert.equal(calls.length, 2, 'invalid inputs must reject before runtime.spawn')
}

async function existingRuntimeIntegrationTest() {
  const root = await mkdtemp(join(tmpdir(), 'web-buddy-background-bridge-'))
  const store = new FileTaskGraphStore({ rootDir: root })
  const notifications = new TaskNotificationQueue()
  try {
    const runner = {
      contractVersion: 'agent-task-runner/v1',
      runnerId: 'bridge-trace-runner',
      runnerVersion: '1.0.0',
      kinds: ['trace_summarization'],
      capacityClass: 'read_only_llm',
      runnerKind: 'read_only_llm',
      async run(request) {
        return {
          schemaVersion: 'agent-task-run-outcome/v1',
          outcome: 'succeeded',
          result: {
            schemaVersion: 'read-only-subagent-result/v1',
            runIdentity: request.runIdentity,
            runnerId: this.runnerId,
            runnerVersion: this.runnerVersion,
            envelopeId: request.contextEnvelope.envelopeId,
            sourceGraphRevision: request.graphRevision,
            freshness: { kind: 'not_action_bound', validity: 'not_applicable' },
            summary: 'Frozen trace summarized.',
            recommendations: ['Main workflow verifies current state.'],
            evidenceRefs: [],
            uncertainties: ['No live page access.'],
            sidechainTranscriptRef: artifactRef(`sidechain-${request.task.id}`, 'sidechain_transcript'),
            requiresMainWorkflowVerification: true,
            authoritativeCompletionEvidence: false,
          },
        }
      },
    }
    const registry = new RunnerRegistry([runner])
    const runtime = new AsyncTaskRuntime({
      sessionId,
      runId,
      store,
      notifications,
      scheduler: ({ requestFactory, resolveContextEnvelopeRef }) => new AgentTaskScheduler({
        store,
        notifications,
        registry,
        schedulerId: 'bridge-scheduler',
        requestFactory,
        resolveContextEnvelopeRef,
        materializeLlmResult: (outcome) => ({
          outputRefs: [outcome.result.sidechainTranscriptRef],
          freshness: outcome.result.freshness,
        }),
      }),
      contextEnvelopeProvider: async (request) => contextEnvelopeBinding(request),
      defaultTimeoutMs: 1_000,
      defaultLeaseDurationMs: 2_000,
    })
    await runtime.initialize()
    const bridge = new BackgroundToolBridge({ runtime, mappings: [createTraceSummarizationMappingV1()] })
    const started = await bridge.start(preparedCall('trace_summarization', { traceArtifactRef: traceRef }))
    assert(['pending', 'running'].includes(started.status))
    const terminal = await waitUntilTerminal(runtime, started.taskId)
    assert.equal(terminal.status, 'completed')
    const claimed = await runtime.drainNotifications({ claimantId: 'bridge-main-loop' })
    assert.equal(claimed.length, 1)
    assert.equal(claimed[0].notification.taskId, started.taskId)
    assert.equal(claimed[0].notification.requiresMainWorkflowVerification, true)
    assert.equal(claimed[0].notification.authoritativeCompletionEvidence, false)
    assert.equal((await runtime.drainNotifications({ claimantId: 'bridge-second-consumer' })).length, 0)
    await runtime.abortSession()
    await rejectsCode(
      () => bridge.start(preparedCall('trace_summarization', { traceArtifactRef: traceRef })),
      'SESSION_ABORTED',
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

function contextEnvelopeBinding(request) {
  return {
    envelope: {
      schemaVersion: 'subagent-context-envelope/v1',
      envelopeId: `envelope-${request.task.id}`,
      taskId: request.task.id,
      taskKind: request.task.kind,
      parentRunId: runId,
      parentSessionId: sessionId,
      createdAt: new Date().toISOString(),
      sourceGraphRevision: request.graph.revision,
      currentActionBinding: request.task.actionBinding,
      objective: projection(request.task.title),
      outputSchemaRef: artifactRef(`schema-${request.task.id}`, 'schema'),
      selectorPolicyVersion: 'context-selector-policy/v1',
      catalogManifest: {
        schemaVersion: 'context-catalog-manifest/v1',
        catalogRevision: 1,
        catalogDigest: createHash('sha256').update('empty-catalog').digest('hex'),
        canonicalization: 'context-catalog-item-ids-jcs/v1',
        candidateItemIds: [],
        candidateCount: 0,
      },
      allowedTools: ['artifact_read_text'],
      authorityBoundary: {
        browserWrite: false,
        livePageAccess: false,
        authoritativeCompletionEvidence: false,
        requiresMainWorkflowVerification: true,
        gates: { login: false, captcha: false, upload: false, save: false, finalSubmit: false },
      },
      sensitiveDisclosureGrants: [],
      selectedContext: [],
      omittedContext: [],
      tokenBudget: {
        estimator: 'web-buddy-token-estimator/v1',
        maxInputTokens: 2_000,
        fixedEnvelopeTokens: 100,
        selectedContextTokens: 0,
        usedInputTokens: 100,
        reservedOutputTokens: 500,
      },
      parentHistoryIncluded: false,
    },
    artifactRef: artifactRef(`envelope-ref-${request.task.id}`, 'context_envelope'),
  }
}

function projection(text) {
  return {
    schemaVersion: 'sanitized-text-projection/v1',
    text,
    projectionPolicy: 'no_react_history/v1',
    sourceArtifactRefs: [],
    sourceItemCount: 0,
    maxChars: 1_000,
    contentDigest: createHash('sha256').update(text).digest('hex'),
  }
}

function preparedCall(name, args, policyPatch = {}) {
  const id = `call-${name}`
  return {
    schemaVersion: 'prepared-tool-call/v1',
    index: 0,
    call: { id, name, arguments: args },
    executionPolicy: {
      schemaVersion: 'tool-execution-policy/v1',
      readOnly: true,
      foreground: 'exclusive',
      resource: 'none',
      interruptBehavior: 'cancel',
      background: 'eligible',
      source: 'catalog',
      ...policyPatch,
    },
    policyDecision: {},
    permissionRequest: {},
    permissionDecision: {},
    preparedAt: new Date().toISOString(),
    context: {
      schemaVersion: 'tool-use-context/v1',
      runId,
      sessionId,
      turnId: 'turn-background',
      step: 1,
      toolCallId: id,
      local: {},
    },
  }
}

function pendingTask(id, input) {
  return {
    id,
    kind: input.kind,
    status: 'pending',
    outputs: [],
  }
}

function artifactRef(artifactId, artifactKind) {
  const bytes = Buffer.from(`${artifactKind}:${artifactId}`)
  return {
    schemaVersion: 'immutable-artifact-ref/v1',
    artifactId,
    artifactKind,
    runId,
    sessionId,
    storage: { store: 'session_artifacts', relativeSegments: [artifactKind, `${artifactId}.json`] },
    mediaType: 'application/json',
    byteLength: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    createdAt: new Date().toISOString(),
    actionBinding: { kind: 'not_action_bound' },
    immutable: true,
  }
}

function taskError(code, message) {
  return {
    schemaVersion: 'async-task-contract-error/v1',
    code,
    category: code === 'SESSION_ABORTED' ? 'cancelled' : 'conflict',
    retryDisposition: 'never_retry',
    message,
    occurredAt: new Date().toISOString(),
  }
}

async function rejectsCode(operation, expectedCode) {
  await assert.rejects(operation, (error) => {
    assert(error instanceof BackgroundToolBridgeError)
    assert.equal(error.schemaVersion, 'background-tool-bridge-error/v1')
    assert.equal(error.code, expectedCode)
    return true
  })
}

async function waitUntilTerminal(runtime, taskId) {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    const result = await runtime.wait(taskId, 200)
    if (['completed', 'failed', 'killed'].includes(result.task.status)) return result.task
  }
  throw new Error(`Task ${taskId} did not reach terminal status.`)
}
