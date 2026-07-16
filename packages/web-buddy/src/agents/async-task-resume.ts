import type {
  AgentTask,
  AgentTaskCompactFactV1,
  AgentTaskEvent,
  AgentTaskGraphV2,
  AgentTaskResumeAttachmentV1,
  AgentTaskStatus,
  IsoUtcTimestamp,
  TaskGraphCheckpointRefV1,
  TaskLeaseRecoveryDecisionV1,
  TaskNotificationPromptAttachmentV1,
  TaskNotificationQueueV1,
  TaskRunIdentity,
} from './async-task-contracts.js'
import type { TaskGraphStore } from './task-graph-store.js'

export type AsyncTaskResumeStore = Pick<TaskGraphStore, 'load' | 'readEvents'>
export type AsyncTaskResumeNotificationQueue = Pick<TaskNotificationQueueV1, 'reconcilePersistedPromptAttachments'>

export interface AsyncTaskResumeScheduler {
  tick(sessionId: string): Promise<void>
}

export interface ExpiredAgentTaskLeaseV1 {
  schemaVersion: 'expired-agent-task-lease/v1'
  taskId: string
  runIdentity: TaskRunIdentity
  accessMode: AgentTask['accessMode']
  maxAttemptsReached: boolean
}

export interface BuildAgentTaskCompactFactsOptions {
  includeTaskIds?: readonly string[]
  maxRecentCompletedTasks?: number
}

export interface ResumeAgentTasksInput {
  sessionId: string
  checkpoint: TaskGraphCheckpointRefV1
  persistedPromptAttachments?: readonly TaskNotificationPromptAttachmentV1[]
  store: AsyncTaskResumeStore
  scheduler: AsyncTaskResumeScheduler
  notificationQueue: AsyncTaskResumeNotificationQueue
  resumedAt?: IsoUtcTimestamp
  maxRecentCompletedTasks?: number
}

const DEFAULT_RECENT_COMPLETED_FACTS = 8

export function findExpiredAgentTaskLeases(
  graph: AgentTaskGraphV2,
  now: IsoUtcTimestamp,
): ExpiredAgentTaskLeaseV1[] {
  const nowMs = requireTimestamp(now, 'now')
  return graph.tasks
    .filter((task): task is Extract<AgentTask, { status: 'running' }> => (
      task.status === 'running' && requireTimestamp(task.lease.expiresAt, `lease ${task.lease.leaseId}`) <= nowMs
    ))
    .sort((left, right) => compareText(left.id, right.id))
    .map((task) => ({
      schemaVersion: 'expired-agent-task-lease/v1',
      taskId: task.id,
      runIdentity: {
        taskId: task.id,
        attempt: task.attempt,
        leaseId: task.lease.leaseId,
        leaseOwnerId: task.lease.ownerId,
      },
      accessMode: task.accessMode,
      maxAttemptsReached: task.attempt >= task.maxAttempts,
    }))
}

export function buildAgentTaskCompactFacts(
  graph: AgentTaskGraphV2,
  options: BuildAgentTaskCompactFactsOptions = {},
): AgentTaskCompactFactV1[] {
  const maxRecent = nonNegativeInteger(
    options.maxRecentCompletedTasks ?? DEFAULT_RECENT_COMPLETED_FACTS,
    'maxRecentCompletedTasks',
  )
  const explicitlyIncluded = new Set(options.includeTaskIds ?? [])
  const required = graph.tasks.filter((task) => task.requiredForCompletion).sort(compactTaskOrder)
  const running = graph.tasks.filter((task) => task.status === 'running').sort(compactTaskOrder)
  const included = graph.tasks.filter((task) => explicitlyIncluded.has(task.id)).sort(compactTaskOrder)
  const recentCompleted = graph.tasks
    .filter((task) => task.status === 'completed')
    .sort(recentCompletedOrder)
    .slice(0, maxRecent)

  return uniqueTasks([...required, ...running, ...included, ...recentCompleted]).map((task) => ({
    schemaVersion: 'agent-task-compact-fact/v1',
    graphRevision: graph.revision,
    taskId: task.id,
    taskKind: task.kind,
    status: task.status,
    completionRequirement: task.requiredForCompletion
      ? { requiredForCompletion: true, terminalPolicy: task.terminalPolicy }
      : { requiredForCompletion: false, terminalPolicy: 'does_not_block' },
    actionBinding: structuredClone(task.actionBinding),
    outputs: task.outputs.map((output) => structuredClone(output)),
    attemptRecords: task.attempts.map((attempt) => structuredClone(attempt)),
    requiresMainWorkflowVerification: true,
    authoritativeCompletionEvidence: false,
  }))
}

export async function resumeAgentTasks(
  input: ResumeAgentTasksInput,
): Promise<AgentTaskResumeAttachmentV1> {
  const resumedAt = input.resumedAt ?? new Date().toISOString()
  requireTimestamp(resumedAt, 'resumedAt')
  const initialGraph = await input.store.load(input.sessionId)
  if (!initialGraph) throw resumeError('GRAPH_NOT_FOUND', `Task graph not found for session ${input.sessionId}.`)
  assertGraphIdentity(initialGraph, input.sessionId)
  assertCheckpoint(input.checkpoint, initialGraph)

  const persistedPromptAttachments = normalizePromptAttachments(
    input.persistedPromptAttachments ?? [],
    input.sessionId,
  )
  const eventsBefore = await input.store.readEvents(input.sessionId)
  const lastEventSeqBefore = eventsBefore.reduce((highest, event) => Math.max(highest, event.eventSeq), 0)
  const expiredLeases = findExpiredAgentTaskLeases(initialGraph, resumedAt)

  await input.scheduler.tick(input.sessionId)
  await input.notificationQueue.reconcilePersistedPromptAttachments(persistedPromptAttachments)

  const [recoveredGraph, eventsAfter] = await Promise.all([
    input.store.load(input.sessionId),
    input.store.readEvents(input.sessionId),
  ])
  if (!recoveredGraph) {
    throw resumeError('GRAPH_NOT_FOUND', `Task graph disappeared while resuming session ${input.sessionId}.`)
  }
  assertGraphIdentity(recoveredGraph, input.sessionId, initialGraph.runId, initialGraph.graphId)

  const invocationRecoveryEvents = recoveryEventsForInvocation(eventsAfter, lastEventSeqBefore, expiredLeases)
  assertEveryExpiredLeaseRecovered(expiredLeases, invocationRecoveryEvents)
  const leaseRecoveryDecisions = eventsAfter
    .filter((event): event is LeaseRecoveryEvent => event.eventType === 'task_lease_expired')
    .filter((event) => event.eventSeq > input.checkpoint.lastEventSeq)
    .sort((left, right) => left.eventSeq - right.eventSeq)
    .map((event) => structuredClone(event.payload.recovery))
  const recoveredTaskIds = leaseRecoveryDecisions.map((decision) => decision.expiredRunIdentity.taskId)
  const persistedNotificationIds = new Set(
    persistedPromptAttachments.flatMap((attachment) => attachment.notificationIds),
  )
  const notificationReplayIds = uniqueStrings(
    recoveredGraph.notificationOutbox
      .filter((entry) => entry.state === 'pending_delivery')
      .filter((entry) => !persistedNotificationIds.has(entry.notification.notificationId))
      .sort((left, right) => left.sourceEventSeq - right.sourceEventSeq
        || compareText(left.notification.notificationId, right.notification.notificationId))
      .map((entry) => entry.notification.notificationId),
  )

  return {
    schemaVersion: 'agent-task-resume-attachment/v1',
    sessionId: recoveredGraph.sessionId,
    runId: recoveredGraph.runId,
    resumedAt,
    checkpoint: structuredClone(input.checkpoint),
    actionClock: structuredClone(recoveredGraph.actionClock),
    taskFacts: buildAgentTaskCompactFacts(recoveredGraph, {
      includeTaskIds: recoveredTaskIds,
      maxRecentCompletedTasks: input.maxRecentCompletedTasks,
    }),
    leaseRecoveryDecisions,
    notificationReplayIds,
    persistedPromptAttachments,
    sidechainHistoryMergedIntoParent: false,
  }
}

type LeaseRecoveryEvent = Extract<AgentTaskEvent, { eventType: 'task_lease_expired' }>

function recoveryEventsForInvocation(
  events: readonly AgentTaskEvent[],
  lastEventSeqBefore: number,
  expiredLeases: readonly ExpiredAgentTaskLeaseV1[],
): LeaseRecoveryEvent[] {
  const expected = new Set(expiredLeases.map((item) => runIdentityKey(item.runIdentity)))
  return events
    .filter((event): event is LeaseRecoveryEvent => event.eventType === 'task_lease_expired')
    .filter((event) => event.eventSeq > lastEventSeqBefore && expected.has(runIdentityKey(event.runIdentity)))
    .sort((left, right) => left.eventSeq - right.eventSeq)
}

function assertEveryExpiredLeaseRecovered(
  expiredLeases: readonly ExpiredAgentTaskLeaseV1[],
  recoveryEvents: readonly LeaseRecoveryEvent[],
): void {
  const recovered = new Set(recoveryEvents.map((event) => runIdentityKey(event.runIdentity)))
  const missing = expiredLeases.filter((item) => !recovered.has(runIdentityKey(item.runIdentity)))
  if (missing.length > 0) {
    throw resumeError(
      'LEASE_EXPIRED',
      `Scheduler tick did not record recovery for expired task lease(s): ${missing.map((item) => item.taskId).join(', ')}.`,
    )
  }
}

function normalizePromptAttachments(
  attachments: readonly TaskNotificationPromptAttachmentV1[],
  sessionId: string,
): TaskNotificationPromptAttachmentV1[] {
  const promptMessageIds = new Set<string>()
  return attachments
    .map((attachment) => {
      if (attachment.sessionId !== sessionId) {
        throw new Error(`Prompt attachment ${attachment.promptMessageId} belongs to a different session.`)
      }
      if (attachment.authoritativeCompletionEvidence !== false) {
        throw new Error(`Prompt attachment ${attachment.promptMessageId} violates the authority boundary.`)
      }
      if (promptMessageIds.has(attachment.promptMessageId)) {
        throw new Error(`Duplicate persisted prompt attachment ${attachment.promptMessageId}.`)
      }
      promptMessageIds.add(attachment.promptMessageId)
      return structuredClone(attachment)
    })
    .sort((left, right) => compareText(left.persistedAt, right.persistedAt)
      || compareText(left.promptMessageId, right.promptMessageId))
}

function assertCheckpoint(checkpoint: TaskGraphCheckpointRefV1, graph: AgentTaskGraphV2): void {
  if (checkpoint.graphRevision > graph.revision) {
    throw new Error(`Checkpoint revision ${checkpoint.graphRevision} is ahead of graph revision ${graph.revision}.`)
  }
  if (checkpoint.lastEventSeq > graph.nextEventSeq - 1) {
    throw new Error(`Checkpoint event sequence ${checkpoint.lastEventSeq} is ahead of the task graph event sequence.`)
  }
  const ref = checkpoint.graphSnapshotRef
  if (ref.artifactKind !== 'task_graph_checkpoint'
    || ref.sessionId !== graph.sessionId
    || ref.runId !== graph.runId
    || ref.immutable !== true) {
    throw new Error('Task graph checkpoint ref does not belong to the current immutable run.')
  }
}

function assertGraphIdentity(
  graph: AgentTaskGraphV2,
  sessionId: string,
  runId = graph.runId,
  graphId = graph.graphId,
): void {
  if (graph.schemaVersion !== 'agent-task-graph/v2'
    || graph.sessionId !== sessionId
    || graph.runId !== runId
    || graph.graphId !== graphId) {
    throw new Error(`Task graph identity does not match resumed session ${sessionId}.`)
  }
}

function compactTaskOrder(left: AgentTask, right: AgentTask): number {
  return statusPriority(left.status) - statusPriority(right.status)
    || right.priority - left.priority
    || compareText(left.createdAt, right.createdAt)
    || compareText(left.id, right.id)
}

function recentCompletedOrder(left: AgentTask, right: AgentTask): number {
  const leftAt = left.status === 'completed' ? left.terminalAt : left.updatedAt
  const rightAt = right.status === 'completed' ? right.terminalAt : right.updatedAt
  return compareText(rightAt, leftAt) || compareText(left.id, right.id)
}

function statusPriority(status: AgentTaskStatus): number {
  switch (status) {
    case 'running': return 0
    case 'pending': return 1
    case 'blocked': return 2
    case 'failed': return 3
    case 'killed': return 4
    case 'completed': return 5
  }
}

function uniqueTasks(tasks: AgentTask[]): AgentTask[] {
  const seen = new Set<string>()
  return tasks.filter((task) => {
    if (seen.has(task.id)) return false
    seen.add(task.id)
    return true
  })
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)]
}

function runIdentityKey(identity: TaskRunIdentity): string {
  return `${identity.taskId}\u0000${identity.attempt}\u0000${identity.leaseId}\u0000${identity.leaseOwnerId}`
}

function requireTimestamp(value: string, name: string): number {
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be a valid ISO timestamp.`)
  return parsed
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer.`)
  return value
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function resumeError(code: 'GRAPH_NOT_FOUND' | 'LEASE_EXPIRED', message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code })
}
