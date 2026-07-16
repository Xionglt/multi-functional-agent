#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AsyncTaskRuntime } from '../dist/agents/async-task-runtime.js'
import { FileTaskGraphStore } from '../dist/agents/task-graph-store.js'
import { AgentTaskScheduler } from '../dist/agents/task-scheduler.js'
import { RunnerRegistry } from '../dist/agents/runner-registry.js'
import { TaskNotificationQueue } from '../dist/agents/task-notification-queue.js'
import { FakeRunner } from '../dist/agents/task-runner.js'

const root = await mkdtemp(join(tmpdir(), 'web-buddy-async-runtime-'))
const sessionId = 'session-runtime-focused'
const runId = 'run-runtime-focused'
const store = new FileTaskGraphStore({ rootDir: root })
const notifications = new TaskNotificationQueue()
const envelopeRequests = []
const llmRequests = []

try {
  const deterministicRunner = new FakeRunner({
    runnerId: 'runtime-deterministic',
    kinds: ['memory_retrieval', 'workflow_evaluation', 'delivery_probe'],
    plan: (request) => ({
      delayMs: request.task.id.startsWith('abort-') ? 500
        : request.task.id === 'cancel-me' ? 400
          : request.task.id === 'required-slow' ? 220
            : 20,
      outputRefs: [artifactRef(`result-${request.task.id}`, 'runner_result')],
    }),
  })
  const llmRunner = {
    contractVersion: 'agent-task-runner/v1',
    runnerId: 'runtime-read-only-llm',
    runnerVersion: '1.0.0',
    kinds: ['trace_summarization'],
    capacityClass: 'read_only_llm',
    runnerKind: 'read_only_llm',
    async run(request, control) {
      llmRequests.push(structuredClone(request))
      const outcome = await abortableDelay(60, control.abortSignal)
      if (outcome === 'aborted') {
        return { schemaVersion: 'agent-task-run-outcome/v1', outcome: 'aborted', reason: 'signal' }
      }
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
  const registry = new RunnerRegistry([deterministicRunner, llmRunner])

  const runtime = createRuntime({ store, notifications, registry, envelopeRequests, llmRequests })
  const initial = await runtime.initialize()
  assert.equal(initial.schemaVersion, 'agent-task-graph/v2')
  assert.equal(initial.sessionId, sessionId)
  assert.equal(initial.revision, 0)
  const detachedSnapshot = await runtime.snapshot()
  detachedSnapshot.tasks.push({ id: 'mutated-outside-runtime' })
  assert.equal((await runtime.snapshot()).tasks.length, 0)

  const requiredInput = {
    taskId: 'required-slow',
    kind: 'memory_retrieval',
    title: 'Retrieve required memory',
    inputs: [{ kind: 'memory_artifact', artifactRef: artifactRef('memory-required', 'memory') }],
    idempotencyKey: 'required-memory:v1',
    completionRequirement: { requiredForCompletion: true, terminalPolicy: 'must_complete_successfully' },
  }
  const startedAt = Date.now()
  const spawned = await runtime.spawn(requiredInput)
  const spawnElapsedMs = Date.now() - startedAt
  assert.equal(spawned.outcome, 'created')
  assert(spawnElapsedMs < 160, `spawn waited ${spawnElapsedMs}ms for a 220ms runner`)
  assert.equal(deterministicRunner.finishedTaskIds.includes('required-slow'), false)

  const duplicate = await runtime.spawn(requiredInput)
  assert.equal(duplicate.outcome, 'existing_same_digest')
  assert.equal(duplicate.task.id, 'required-slow')
  const conflict = await runtime.spawn({ ...requiredInput, title: 'Different semantic input' })
  assert.equal(conflict.outcome, 'conflict')
  assert.equal(conflict.error.code, 'IDEMPOTENCY_CONFLICT')

  await assert.rejects(
    runtime.spawn({ taskId: 'browser-write', kind: 'main_browser_step', title: 'Click', idempotencyKey: 'browser:v1' }),
    (error) => error?.code === 'POLICY_VIOLATION',
  )

  const blocked = await runtime.completionReadiness()
  assert.equal(blocked.state, 'blocked_required_tasks')
  assert.deepEqual(blocked.pendingOrRunningTaskIds, ['required-slow'])

  const waited = await waitUntilTerminal(runtime, 'required-slow')
  assert.equal(waited.status, 'completed')
  const result = await runtime.result('required-slow')
  assert.equal(result.available, true)
  assert.equal(result.outputRefs.length, 1)
  assert.equal(result.requiresMainWorkflowVerification, true)
  assert.equal(result.authoritativeCompletionEvidence, false)
  assert.deepEqual(await runtime.resultRefs('required-slow'), result.outputRefs)

  const eligible = await runtime.completionReadiness()
  assert.equal(eligible.state, 'eligible_for_main_verification')
  assert.equal(eligible.mainWorkflowEvidenceRefs[0].artifactId, 'main-workflow-evidence')
  assert.equal(eligible.verifiedAgainstActionSeq, 0)

  const listed = await runtime.list({ statuses: ['completed'] })
  assert(listed.some((task) => task.taskId === 'required-slow'))
  const facts = await runtime.compactFacts()
  const requiredFact = facts.find((fact) => fact.taskId === 'required-slow')
  assert.equal(requiredFact.completionRequirement.requiredForCompletion, true)
  assert.equal(requiredFact.outputs.length, 1)
  assert.equal(requiredFact.authoritativeCompletionEvidence, false)

  const claimed = await runtime.drainNotifications({ claimantId: 'main-loop', claimLeaseMs: 10_000 })
  assert.equal(claimed.length, 1)
  assert.equal(claimed[0].notification.taskId, 'required-slow')
  assert.equal(claimed[0].delivery.state, 'claimed')
  assert.equal((await runtime.drainNotifications({ claimantId: 'other-main-loop' })).length, 0)
  const acknowledgement = {
    schemaVersion: 'agent-task-notification-ack/v1',
    acknowledgementId: 'ack-required',
    notificationId: claimed[0].notification.notificationId,
    deliveryId: claimed[0].delivery.deliveryId,
    claimId: claimed[0].delivery.claimId,
    injectedPromptMessageId: 'prompt-required',
    acknowledgedAt: new Date().toISOString(),
  }
  await runtime.acknowledgeNotification(acknowledgement)
  const acknowledgedGraph = await store.load(sessionId)
  assert.equal(acknowledgedGraph.notificationOutbox[0].state, 'acknowledged')

  const traceSpawn = await runtime.spawn({
    taskId: 'trace-context',
    kind: 'trace_summarization',
    title: 'Summarize immutable trace',
    inputs: [{ kind: 'trace_artifact', artifactRef: artifactRef('trace-context-input', 'trace') }],
    idempotencyKey: 'trace-context:v1',
  })
  assert.equal(traceSpawn.outcome, 'created')
  await waitUntilTerminal(runtime, 'trace-context')
  assert.equal(envelopeRequests.length, 1)
  assert.equal(Object.hasOwn(envelopeRequests[0], 'messages'), false)
  assert.equal(Object.hasOwn(envelopeRequests[0], 'parentMessages'), false)
  assert.equal(llmRequests.length, 1)
  assert.equal(llmRequests[0].contextEnvelope.parentHistoryIncluded, false)
  assert.equal(llmRequests[0].contextEnvelope.taskId, 'trace-context')

  const pendingTraceNotification = (await store.load(sessionId)).notificationOutbox
    .find((entry) => entry.notification.taskId === 'trace-context' && entry.state === 'pending_delivery')
  assert(pendingTraceNotification)

  const restoredNotifications = new TaskNotificationQueue()
  const restoredRuntime = createRuntime({
    store,
    notifications: restoredNotifications,
    registry,
    envelopeRequests,
    llmRequests,
  })
  const persistedAttachment = {
    schemaVersion: 'task-notification-prompt-attachment/v1',
    sessionId,
    promptMessageId: 'prompt-restored-trace',
    notificationIds: [pendingTraceNotification.notification.notificationId],
    persistedAt: new Date().toISOString(),
    authoritativeCompletionEvidence: false,
  }
  const restored = await restoredRuntime.restore({ persistedPromptAttachments: [persistedAttachment] })
  assert.equal(restored.reconciledPromptAttachments, 1)
  assert.equal(
    restored.graph.notificationOutbox.find((entry) => entry.notification.taskId === 'trace-context').state,
    'acknowledged',
  )
  assert.equal((await restoredRuntime.drainNotifications({ claimantId: 'restored-main-loop' })).length, 0)

  const resume = await restoredRuntime.resumeAttachment({ persistedPromptAttachments: [persistedAttachment] })
  assert.equal(resume.sidechainHistoryMergedIntoParent, false)
  assert.equal(resume.checkpoint.graphRevision, restored.graph.revision)
  assert.equal(resume.taskFacts.length, 2)
  assert.deepEqual(resume.notificationReplayIds, [])

  await restoredRuntime.spawn({
    taskId: 'cancel-me',
    kind: 'delivery_probe',
    title: 'Cancel this task',
    inputs: [{ kind: 'goal', structuredValue: { cancel: true } }],
    idempotencyKey: 'cancel:v1',
  })
  await waitForStatus(restoredRuntime, 'cancel-me', 'running')
  const cancelled = await restoredRuntime.cancel('cancel-me', 'user')
  assert.equal(cancelled.changed, true)
  assert.equal(cancelled.task.status, 'killed')
  assert.equal((await restoredRuntime.result('cancel-me')).available, false)

  for (const taskId of ['abort-one', 'abort-two']) {
    await restoredRuntime.spawn({
      taskId,
      kind: 'workflow_evaluation',
      title: taskId,
      inputs: [{ kind: 'workflow_state', structuredValue: { taskId } }],
      idempotencyKey: `${taskId}:v1`,
    })
  }
  const racingSpawn = restoredRuntime.spawn({
    taskId: 'abort-race',
    kind: 'workflow_evaluation',
    title: 'Concurrent spawn vs abort',
    inputs: [{ kind: 'workflow_state', structuredValue: { race: true } }],
    idempotencyKey: 'abort-race:v1',
  })
  const [racingResolution, abortedCount] = await Promise.all([racingSpawn, restoredRuntime.abortSession()])
  assert.equal(racingResolution.outcome, 'created')
  assert.equal(abortedCount, 3)
  assert.equal((await restoredRuntime.status('abort-one')).status, 'killed')
  assert.equal((await restoredRuntime.status('abort-two')).status, 'killed')
  assert.equal((await restoredRuntime.status('abort-race')).status, 'killed')
  assert.equal((await restoredRuntime.list()).some((task) => ['pending', 'blocked', 'running'].includes(task.status)), false)
  await assert.rejects(
    restoredRuntime.spawn({ taskId: 'after-abort', kind: 'delivery_probe', title: 'No', idempotencyKey: 'after-abort:v1' }),
    (error) => error?.code === 'SESSION_ABORTED',
  )

  console.log(JSON.stringify({
    schemaVersion: 'async-task-runtime-focused-test/v1',
    passed: true,
    assertions: [
      'session initialize/restore',
      'detached graph snapshot',
      'spawn immediate return and idempotency',
      'background-kind policy and main_browser_step rejection',
      'required completion readiness and result refs',
      'claim-only notification drain and explicit acknowledgement',
      'injected Context Envelope without parent messages',
      'compact/resume projections',
      'cancel and spawn/wake/session-abort linearization',
    ],
  }, null, 2))
} finally {
  await rm(root, { recursive: true, force: true })
}

function createRuntime({ store, notifications, registry, envelopeRequests }) {
  return new AsyncTaskRuntime({
    sessionId,
    runId,
    store,
    notifications,
    scheduler: ({ requestFactory, resolveContextEnvelopeRef }) => new AgentTaskScheduler({
      store,
      notifications,
      registry,
      schedulerId: `scheduler-${Math.random()}`,
      requestFactory,
      resolveContextEnvelopeRef,
      materializeLlmResult: (outcome) => ({
        outputRefs: [outcome.result.sidechainTranscriptRef],
        freshness: outcome.result.freshness,
      }),
    }),
    contextEnvelopeProvider: async (request) => {
      envelopeRequests.push(structuredClone(request))
      return contextEnvelopeBinding(request)
    },
    mainVerificationProvider: async () => ({
      mainWorkflowEvidenceRefs: [artifactRef('main-workflow-evidence', 'runner_result')],
      verifiedAgainstActionSeq: 0,
    }),
    checkpointProvider: async ({ graph, lastEventSeq, unacknowledgedNotificationIds }) => ({
      schemaVersion: 'task-graph-checkpoint-ref/v1',
      graphRevision: graph.revision,
      graphSnapshotRef: artifactRef(`checkpoint-${graph.revision}`, 'task_graph_checkpoint'),
      lastEventSeq,
      unacknowledgedNotificationIds,
    }),
    defaultTimeoutMs: 2_000,
    defaultLeaseDurationMs: 3_000,
    maxWaitMs: 1_000,
  })
}

function contextEnvelopeBinding(request) {
  const outputSchemaRef = artifactRef(`schema-${request.task.id}`, 'schema')
  const envelope = {
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
    outputSchemaRef,
    selectorPolicyVersion: 'context-selector-policy/v1',
    catalogManifest: {
      schemaVersion: 'context-catalog-manifest/v1',
      catalogRevision: 1,
      catalogDigest: sha256('empty-catalog'),
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
  }
  return {
    envelope,
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
    contentDigest: sha256(text),
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

async function waitUntilTerminal(runtime, taskId) {
  const deadline = Date.now() + 3_000
  while (Date.now() < deadline) {
    const waited = await runtime.wait(taskId, 500)
    if (['completed', 'failed', 'killed'].includes(waited.task.status)) return waited.task
  }
  throw new Error(`Task ${taskId} did not become terminal.`)
}

async function waitForStatus(runtime, taskId, status) {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    const task = await runtime.status(taskId)
    if (task.status === status) return task
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`Task ${taskId} did not reach ${status}.`)
}

async function abortableDelay(ms, signal) {
  if (signal.aborted) return 'aborted'
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve('elapsed')
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      resolve('aborted')
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function sha256(value) { return createHash('sha256').update(value).digest('hex') }
