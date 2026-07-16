#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildAgentTasksPromptSummary,
  buildMainCompletionReadiness,
  renderAgentTasksPrompt,
  renderAgentTasksPromptContent,
  renderTaskNotificationPromptAttachment,
} from '../dist/agents/async-task-prompt.js'
import {
  findExpiredAgentTaskLeases,
  resumeAgentTasks,
} from '../dist/agents/async-task-resume.js'
import { FileTaskGraphStore } from '../dist/agents/task-graph-store.js'
import {
  createAgentTaskGraphV2,
  createAgentTaskV2,
  finalizeAgentTaskGraphMutationV2,
} from '../dist/agents/task-graph.js'
import { TaskNotificationQueue } from '../dist/agents/task-notification-queue.js'

const cases = []
await check('budgeted AgentTasks prompt is stable and history-free', testBudgetedTaskPrompt)
await check('notification attachment preserves stale authority and evidence refs', testNotificationRenderer)
await check('completion readiness enforces terminal policy and current main evidence', testCompletionReadiness)
await check('resume recovers expired lease and reconciles notification replay once', testResumeRecovery)

console.log(`async-task prompt/resume focused test: ${cases.length} passed`)

async function check(name, fn) {
  await fn()
  cases.push(name)
  console.log(`ok - ${name}`)
}

function artifactRef(artifactId, options = {}) {
  const bytes = Buffer.from(`artifact:${artifactId}`)
  return {
    schemaVersion: 'immutable-artifact-ref/v1',
    artifactId,
    artifactKind: options.artifactKind ?? 'trace',
    runId: options.runId ?? 'run-prompt',
    sessionId: options.sessionId ?? 'session-prompt',
    storage: { store: 'session_artifacts', relativeSegments: ['async', `${artifactId}.json`] },
    mediaType: 'application/json',
    byteLength: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    createdAt: options.createdAt ?? '2026-07-10T00:00:00.000Z',
    actionBinding: options.actionBinding ?? { kind: 'not_action_bound' },
    immutable: true,
  }
}

function idempotency(id) {
  return {
    schemaVersion: 'agent-task-idempotency/v1',
    scope: 'session',
    key: `key:${id}`,
    canonicalization: 'web-buddy-task-input-jcs/v1',
    digestAlgorithm: 'sha256',
    inputDigest: createHash('sha256').update(id).digest('hex'),
  }
}

function task(id, options = {}) {
  return createAgentTaskV2({
    id,
    kind: options.kind ?? 'memory_retrieval',
    title: options.title ?? id,
    priority: options.priority ?? 0,
    idempotency: idempotency(id),
    completionRequirement: options.completionRequirement,
    maxAttempts: options.maxAttempts ?? 2,
    now: options.now ?? '2026-07-10T00:00:00.000Z',
  })
}

function output(outputId, ref, freshness, leaseId = 'lease-output') {
  return {
    schemaVersion: 'agent-task-output/v1',
    outputId,
    kind: ref.artifactKind === 'sidechain_transcript' ? 'transcript_ref' : 'artifact_ref',
    artifactRef: ref,
    attempt: 1,
    leaseId,
    freshness,
    appendToMainTranscript: false,
    requiresMainWorkflowVerification: true,
    authoritativeCompletionEvidence: false,
  }
}

function completed(base, completedAt, outputs = []) {
  return {
    ...base,
    status: 'completed',
    terminalAt: completedAt,
    updatedAt: completedAt,
    outputs,
  }
}

function failed(base, completedAt, terminalPolicy = base.terminalPolicy) {
  return {
    ...base,
    status: 'failed',
    terminalAt: completedAt,
    updatedAt: completedAt,
    terminalPolicy,
  }
}

function running(base, options = {}) {
  const attempt = options.attempt ?? 1
  const leaseId = options.leaseId ?? `lease-${base.id}`
  const ownerId = options.ownerId ?? 'scheduler-old'
  const startedAt = options.startedAt ?? '2026-01-01T00:00:00.000Z'
  const runIdentity = { taskId: base.id, attempt, leaseId, leaseOwnerId: ownerId }
  return {
    ...base,
    status: 'running',
    attempt,
    lastStartedAt: startedAt,
    updatedAt: startedAt,
    lease: {
      schemaVersion: 'agent-task-lease/v1',
      leaseId,
      ownerId,
      acquiredAt: startedAt,
      expiresAt: options.expiresAt ?? '2026-01-01T00:00:01.000Z',
      attempt,
      claimedAtGraphRevision: 0,
    },
    attempts: [{
      schemaVersion: 'agent-task-attempt-record/v1',
      runIdentity,
      startedAt,
      runnerKind: 'deterministic',
      outcome: 'running',
    }],
  }
}

function testBudgetedTaskPrompt() {
  const graph = createAgentTaskGraphV2({
    graphId: 'graph-prompt', runId: 'run-prompt', sessionId: 'session-prompt', currentActionSeq: 4,
    now: '2026-07-10T00:00:00.000Z',
  })
  const required = task('required-running', {
    completionRequirement: { requiredForCompletion: true, terminalPolicy: 'must_complete_successfully' },
    priority: 10,
  })
  const active = running(required, { expiresAt: '2026-07-11T00:00:00.000Z' })
  const optionalRunning = running(task('optional-running', { priority: 5 }), {
    expiresAt: '2026-07-11T00:00:00.000Z',
  })
  const stale = { kind: 'assessed', sourceActionSeq: 2, assessedAgainstActionSeq: 4, validity: 'stale' }
  const recent = completed(task('recent-completed'), '2026-07-10T02:00:00.000Z', [
    output('result-output', artifactRef('result-ref'), stale),
    output('sidechain-output', artifactRef('sidechain-ref', { artifactKind: 'sidechain_transcript' }), stale),
  ])
  const irrelevant = task('optional-pending', { title: 'FULL_PARENT_HISTORY_SHOULD_NOT_APPEAR' })
  const promptGraph = { ...graph, revision: 7, tasks: [irrelevant, recent, optionalRunning, active] }

  const summary = buildAgentTasksPromptSummary(promptGraph)
  assert.deepEqual(summary.recent.map((item) => item.taskId), [
    'required-running', 'optional-running', 'recent-completed',
  ])
  assert.equal(summary.parentHistoryIncluded, false)
  assert.equal(summary.sidechainHistoryIncluded, false)
  assert.deepEqual(summary.recent[2].sidechainTranscriptArtifactIds, ['sidechain-ref'])

  const first = renderAgentTasksPrompt(promptGraph, { maxChars: 620 })
  const second = renderAgentTasksPrompt(promptGraph, { maxChars: 620 })
  assert.equal(first, second)
  assert(first.length <= 620)
  assert.match(first, /^AGENT_TASKS\n/)
  assert.match(first, /authoritativeCompletionEvidence=false/)
  assert.match(first, /omittedRelevantTasks=/)
  assert.doesNotMatch(first, /FULL_PARENT_HISTORY_SHOULD_NOT_APPEAR/)
  const sectionContent = renderAgentTasksPromptContent(summary, { maxChars: 620 })
  assert.match(sectionContent, /^graphRevision=7 /)
  assert.doesNotMatch(sectionContent, /^AGENT_TASKS/)
}

function testNotificationRenderer() {
  const evidence = artifactRef('evidence-001')
  const completedNotification = {
    schemaVersion: 'agent-task-notification/v1',
    notificationId: 'notification-completed',
    sourceEventId: 'event-completed',
    dedupeKey: 'dedupe-completed',
    sessionId: 'session-prompt',
    graphId: 'graph-prompt',
    graphRevision: 9,
    sourceEventSeq: 9,
    taskId: 'task-completed',
    taskKind: 'trace_summarization',
    terminalStatus: 'completed',
    terminalIdentity: {
      kind: 'run',
      runIdentity: { taskId: 'task-completed', attempt: 1, leaseId: 'lease-completed', leaseOwnerId: 'scheduler' },
    },
    summary: 'Bounded summary\nwithout multiline history.',
    outputRefs: [evidence],
    freshness: { kind: 'assessed', sourceActionSeq: 3, assessedAgainstActionSeq: 5, validity: 'stale' },
    createdAt: '2026-07-10T01:00:00.000Z',
    requiresMainWorkflowVerification: true,
    authoritativeCompletionEvidence: false,
  }
  const failedNotification = {
    ...completedNotification,
    notificationId: 'notification-failed',
    sourceEventId: 'event-failed',
    dedupeKey: 'dedupe-failed',
    sourceEventSeq: 10,
    taskId: 'task-failed',
    terminalStatus: 'failed',
    terminalIdentity: {
      kind: 'run',
      runIdentity: { taskId: 'task-failed', attempt: 1, leaseId: 'lease-failed', leaseOwnerId: 'scheduler' },
    },
    outputRefs: [],
    error: {
      schemaVersion: 'async-task-contract-error/v1',
      code: 'MAX_ATTEMPTS_EXCEEDED',
      category: 'validation',
      retryDisposition: 'never_retry',
      message: 'No more attempts.',
      occurredAt: '2026-07-10T01:00:00.000Z',
      taskId: 'task-failed',
    },
  }
  delete failedNotification.freshness
  const attachment = {
    schemaVersion: 'task-notification-prompt-attachment/v1',
    sessionId: 'session-prompt',
    promptMessageId: 'prompt-updates-1',
    notificationIds: ['notification-failed', 'notification-completed'],
    persistedAt: '2026-07-10T01:01:00.000Z',
    authoritativeCompletionEvidence: false,
  }

  const rendered = renderTaskNotificationPromptAttachment(
    attachment,
    [completedNotification, failedNotification],
  )
  assert.match(rendered, /^ASYNC_TASK_UPDATES\n/)
  assert(rendered.indexOf('notification-failed') < rendered.indexOf('notification-completed'))
  assert.match(rendered, /freshness=stale sourceActionSeq=3 assessedAgainstActionSeq=5/)
  assert.match(rendered, /evidenceRefs=evidence-001:trace/)
  assert.match(rendered, /authoritativeCompletionEvidence=false/)
  assert.match(rendered, /stale, non-authoritative evidence/)
  assert.match(rendered, /summary=Bounded summary without multiline history\./)
  assert.throws(
    () => renderTaskNotificationPromptAttachment(attachment, [completedNotification]),
    /notification-failed.*missing/,
  )
}

function testCompletionReadiness() {
  const graph = createAgentTaskGraphV2({
    graphId: 'graph-readiness', runId: 'run-readiness', sessionId: 'session-readiness', currentActionSeq: 7,
    now: '2026-07-10T00:00:00.000Z',
  })
  const mustComplete = { requiredForCompletion: true, terminalPolicy: 'must_complete_successfully' }
  const terminalEnough = { requiredForCompletion: true, terminalPolicy: 'terminal_is_sufficient' }
  const pending = task('required-pending', { completionRequirement: mustComplete })
  const requiredFailure = failed(task('required-failed', { completionRequirement: mustComplete }), '2026-07-10T01:00:00.000Z')
  const sufficientFailure = failed(
    task('terminal-sufficient', { completionRequirement: terminalEnough }),
    '2026-07-10T01:00:00.000Z',
    'terminal_is_sufficient',
  )
  const blocked = buildMainCompletionReadiness({
    ...graph,
    tasks: [task('optional-pending'), sufficientFailure, requiredFailure, pending],
  })
  assert.deepEqual(blocked, {
    schemaVersion: 'main-completion-readiness/v1',
    state: 'blocked_required_tasks',
    pendingOrRunningTaskIds: ['required-pending'],
    failedOrKilledTaskIds: ['required-failed'],
  })

  const satisfiedGraph = {
    ...graph,
    tasks: [
      task('optional-pending'),
      sufficientFailure,
      completed(pending, '2026-07-10T02:00:00.000Z'),
    ],
  }
  const mainEvidence = artifactRef('main-evidence', {
    artifactKind: 'page_snapshot',
    runId: graph.runId,
    sessionId: graph.sessionId,
    actionBinding: { kind: 'browser_action', sourceActionSeq: 7 },
  })
  const eligible = buildMainCompletionReadiness(satisfiedGraph, {
    mainWorkflowEvidenceRefs: [mainEvidence],
    verifiedAgainstActionSeq: 7,
  })
  assert.equal(eligible.state, 'eligible_for_main_verification')
  assert.equal(eligible.mainWorkflowEvidenceRefs[0].artifactId, 'main-evidence')
  assert.throws(
    () => buildMainCompletionReadiness(satisfiedGraph, {
      mainWorkflowEvidenceRefs: [mainEvidence],
      verifiedAgainstActionSeq: 6,
    }),
    /does not match current action sequence 7/,
  )
}

async function testResumeRecovery() {
  const root = await mkdtemp(join(tmpdir(), 'web-buddy-a7-'))
  try {
    const sessionId = 'session-resume'
    const runId = 'run-resume'
    const graph = createAgentTaskGraphV2({
      graphId: 'graph-resume', runId, sessionId, currentActionSeq: 11,
      now: '2026-07-10T00:00:00.000Z',
    })
    const expired = running(task('expired-read-only', { maxAttempts: 2 }), {
      leaseId: 'lease-expired',
      expiresAt: '2026-07-10T00:00:01.000Z',
    })
    const completedDelivered = completed(task('completed-delivered'), '2026-07-10T00:01:00.000Z')
    const completedReplay = completed(task('completed-replay'), '2026-07-10T00:02:00.000Z')
    const deliveredNotification = terminalNotification(completedDelivered, 'notification-delivered', 1, sessionId, runId)
    const replayNotification = terminalNotification(completedReplay, 'notification-replay', 2, sessionId, runId)
    const initialGraph = {
      ...graph,
      tasks: [expired, completedDelivered, completedReplay],
      notificationOutbox: [
        outbox(deliveredNotification, 1),
        outbox(replayNotification, 2),
      ],
    }
    const store = new FileTaskGraphStore({ rootDir: root })
    await store.create(initialGraph)
    const queue = new TaskNotificationQueue()
    let tickCalls = 0
    const scheduler = {
      async tick(candidateSessionId) {
        tickCalls += 1
        const current = await store.load(candidateSessionId)
        for (const entry of current.notificationOutbox) {
          if (entry.state === 'pending_delivery') queue.enqueue(entry.notification)
        }
        const taskToRecover = current.tasks.find((item) => item.status === 'running' && item.lease.expiresAt <= '2026-07-10T03:00:00.000Z')
        if (!taskToRecover) return
        await store.transact(candidateSessionId, (authoritative) => leaseRecoveryMutation(authoritative, taskToRecover.id))
      },
    }
    const persistedAttachment = {
      schemaVersion: 'task-notification-prompt-attachment/v1',
      sessionId,
      promptMessageId: 'persisted-prompt-message',
      notificationIds: ['notification-delivered'],
      persistedAt: '2026-07-10T02:00:00.000Z',
      authoritativeCompletionEvidence: false,
    }
    const checkpoint = {
      schemaVersion: 'task-graph-checkpoint-ref/v1',
      graphRevision: 0,
      graphSnapshotRef: artifactRef('checkpoint-resume', {
        artifactKind: 'task_graph_checkpoint', runId, sessionId,
      }),
      lastEventSeq: 0,
      unacknowledgedNotificationIds: ['notification-delivered', 'notification-replay'],
    }

    const expiredLeases = findExpiredAgentTaskLeases(initialGraph, '2026-07-10T03:00:00.000Z')
    assert.deepEqual(expiredLeases.map((item) => item.taskId), ['expired-read-only'])

    const first = await resumeAgentTasks({
      sessionId,
      checkpoint,
      persistedPromptAttachments: [persistedAttachment],
      store,
      scheduler,
      notificationQueue: queue,
      resumedAt: '2026-07-10T03:00:00.000Z',
    })
    assert.equal(tickCalls, 1)
    assert.equal(first.leaseRecoveryDecisions[0].disposition, 'requeue_read_only')
    assert.equal(first.taskFacts.find((fact) => fact.taskId === 'expired-read-only').status, 'pending')
    assert.deepEqual(first.notificationReplayIds, ['notification-replay'])
    assert.equal(first.sidechainHistoryMergedIntoParent, false)
    assert.equal(queue.snapshot(sessionId).find((item) => item.notification.notificationId === 'notification-delivered').delivery.state, 'acknowledged')
    assert.equal(queue.snapshot(sessionId).find((item) => item.notification.notificationId === 'notification-replay').delivery.state, 'available')
    assert.equal((await store.load(sessionId)).notificationOutbox.length, 2)

    const second = await resumeAgentTasks({
      sessionId,
      checkpoint,
      persistedPromptAttachments: [persistedAttachment],
      store,
      scheduler,
      notificationQueue: queue,
      resumedAt: '2026-07-10T03:01:00.000Z',
    })
    assert.equal(tickCalls, 2)
    assert.equal(second.leaseRecoveryDecisions[0].disposition, 'requeue_read_only')
    assert.deepEqual(second.notificationReplayIds, ['notification-replay'])
    const finalGraph = await store.load(sessionId)
    assert.equal(finalGraph.notificationOutbox.length, 2)
    assert.equal(new Set(finalGraph.notificationOutbox.map((entry) => entry.notification.notificationId)).size, 2)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

function terminalNotification(completedTask, notificationId, sourceEventSeq, sessionId, runId) {
  return {
    schemaVersion: 'agent-task-notification/v1',
    notificationId,
    sourceEventId: `event-${notificationId}`,
    dedupeKey: `dedupe-${notificationId}`,
    sessionId,
    graphId: 'graph-resume',
    graphRevision: 0,
    sourceEventSeq,
    taskId: completedTask.id,
    taskKind: completedTask.kind,
    summary: `Completed ${completedTask.id}.`,
    createdAt: completedTask.terminalAt,
    requiresMainWorkflowVerification: true,
    authoritativeCompletionEvidence: false,
    terminalStatus: 'completed',
    terminalIdentity: {
      kind: 'run',
      runIdentity: {
        taskId: completedTask.id,
        attempt: 1,
        leaseId: `lease-${completedTask.id}`,
        leaseOwnerId: 'scheduler-old',
      },
    },
    outputRefs: [artifactRef(`result-${completedTask.id}`, { sessionId, runId })],
    freshness: { kind: 'not_action_bound', validity: 'not_applicable' },
  }
}

function outbox(notification, sourceEventSeq) {
  return {
    schemaVersion: 'agent-task-notification-outbox-entry/v1',
    sourceEventId: notification.sourceEventId,
    sourceEventSeq,
    notification,
    state: 'pending_delivery',
  }
}

function leaseRecoveryMutation(graph, taskId) {
  const taskToRecover = graph.tasks.find((item) => item.id === taskId)
  assert.equal(taskToRecover.status, 'running')
  const now = '2026-07-10T03:00:00.000Z'
  const identity = {
    taskId: taskToRecover.id,
    attempt: taskToRecover.attempt,
    leaseId: taskToRecover.lease.leaseId,
    leaseOwnerId: taskToRecover.lease.ownerId,
  }
  const error = {
    schemaVersion: 'async-task-contract-error/v1',
    code: 'LEASE_EXPIRED',
    category: 'transient',
    retryDisposition: 'retry_same_task',
    message: `Lease expired for task ${taskId}.`,
    occurredAt: now,
    taskId,
    attempt: identity.attempt,
    leaseId: identity.leaseId,
  }
  const recovered = {
    ...taskToRecover,
    status: 'pending',
    lease: undefined,
    updatedAt: now,
    lastError: error,
    attempts: taskToRecover.attempts.map((attempt) => attempt.runIdentity.leaseId === identity.leaseId
      ? { ...attempt, outcome: 'lease_expired', finishedAt: now, error }
      : attempt),
  }
  const draft = {
    ...graph,
    tasks: graph.tasks.map((item) => item.id === taskId ? recovered : item),
  }
  const recovery = {
    schemaVersion: 'task-lease-recovery-decision/v1',
    disposition: 'requeue_read_only',
    expiredRunIdentity: identity,
    releasedLockIds: [],
  }
  const event = {
    schemaVersion: 'agent-task-event/v1',
    eventId: 'event-lease-recovery',
    eventSeq: graph.nextEventSeq,
    eventType: 'task_lease_expired',
    sessionId: graph.sessionId,
    graphId: graph.graphId,
    taskId,
    occurredAt: now,
    revisionBefore: graph.revision,
    revisionAfter: graph.revision + 1,
    actionBinding: taskToRecover.actionBinding,
    correlationId: 'resume-recovery',
    runIdentity: identity,
    payload: { expiredLeaseId: identity.leaseId, recovery },
    authoritativeTaskState: true,
    authoritativeCompletionEvidence: false,
  }
  return finalizeAgentTaskGraphMutationV2(graph, draft, event, now)
}
