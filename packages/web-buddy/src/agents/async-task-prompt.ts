import type {
  ActionBinding,
  AgentTask,
  AgentTaskGraphV2,
  AgentTaskKind,
  AgentTaskStatus,
  ImmutableArtifactRef,
  MainCompletionReadinessV1,
  ResultFreshnessVerdict,
  TaskCompletionRequirement,
  TaskNotificationPromptAttachmentV1,
  TaskNotificationV1,
} from './async-task-contracts.js'

export interface AgentTasksPromptSummaryOptions {
  maxTasks?: number
  recentCompletedLimit?: number
}

export interface AgentTaskPromptFactV1 {
  schemaVersion: 'agent-task-prompt-fact/v1'
  taskId: string
  taskKind: AgentTaskKind
  status: AgentTaskStatus
  title: string
  completionRequirement: TaskCompletionRequirement
  attempt: number
  maxAttempts: number
  actionBinding: ActionBinding
  outputArtifactIds: string[]
  sidechainTranscriptArtifactIds: string[]
  outputFreshness: ResultFreshnessVerdict[]
  requiresMainWorkflowVerification: true
  authoritativeCompletionEvidence: false
}

export interface AgentTasksPromptSummaryV1 {
  schemaVersion: 'agent-tasks-prompt-summary/v1'
  graphRevision: number
  currentActionSeq: number
  totalTaskCount: number
  pendingCount: number
  blockedCount: number
  runningCount: number
  requiredTaskIds: string[]
  recent: AgentTaskPromptFactV1[]
  omittedRelevantTaskCount: number
  requiresMainWorkflowVerification: true
  authoritativeCompletionEvidence: false
  sidechainHistoryIncluded: false
  parentHistoryIncluded: false
}

export interface RenderAgentTasksPromptOptions {
  maxChars?: number
  maxArtifactRefsPerTask?: number
  maxRequiredTaskIds?: number
}

export interface MainCompletionVerificationInputV1 {
  mainWorkflowEvidenceRefs: readonly [ImmutableArtifactRef, ...ImmutableArtifactRef[]]
  verifiedAgainstActionSeq: number
}

const DEFAULT_MAX_PROMPT_TASKS = 12
const DEFAULT_RECENT_COMPLETED = 6
const DEFAULT_MAX_PROMPT_CHARS = 2_600

export function buildAgentTasksPromptSummary(
  graph: AgentTaskGraphV2,
  options: AgentTasksPromptSummaryOptions = {},
): AgentTasksPromptSummaryV1 {
  const maxTasks = nonNegativeInteger(options.maxTasks ?? DEFAULT_MAX_PROMPT_TASKS, 'maxTasks')
  const recentCompletedLimit = nonNegativeInteger(
    options.recentCompletedLimit ?? DEFAULT_RECENT_COMPLETED,
    'recentCompletedLimit',
  )
  const required = graph.tasks
    .filter((task) => task.requiredForCompletion)
    .sort(requiredTaskOrder)
  const running = graph.tasks
    .filter((task) => !task.requiredForCompletion && task.status === 'running')
    .sort(activeTaskOrder)
  const recentCompleted = graph.tasks
    .filter((task) => !task.requiredForCompletion && task.status === 'completed')
    .sort(recentTerminalOrder)
    .slice(0, recentCompletedLimit)
  const relevant = uniqueTasks([...required, ...running, ...recentCompleted])
  const selected = relevant.slice(0, maxTasks)

  return {
    schemaVersion: 'agent-tasks-prompt-summary/v1',
    graphRevision: graph.revision,
    currentActionSeq: graph.actionClock.currentActionSeq,
    totalTaskCount: graph.tasks.length,
    pendingCount: countStatus(graph.tasks, 'pending'),
    blockedCount: countStatus(graph.tasks, 'blocked'),
    runningCount: countStatus(graph.tasks, 'running'),
    requiredTaskIds: required.map((task) => task.id).sort(compareText),
    recent: selected.map(toPromptFact),
    omittedRelevantTaskCount: relevant.length - selected.length,
    requiresMainWorkflowVerification: true,
    authoritativeCompletionEvidence: false,
    sidechainHistoryIncluded: false,
    parentHistoryIncluded: false,
  }
}

export function renderAgentTasksPromptSummary(
  summary: AgentTasksPromptSummaryV1,
  options: RenderAgentTasksPromptOptions = {},
): string {
  return renderAgentTasksPromptText(summary, options, true)
}

export function renderAgentTasksPromptContent(
  summary: AgentTasksPromptSummaryV1,
  options: RenderAgentTasksPromptOptions = {},
): string {
  return renderAgentTasksPromptText(summary, options, false)
}

function renderAgentTasksPromptText(
  summary: AgentTasksPromptSummaryV1,
  options: RenderAgentTasksPromptOptions,
  includeSectionLabel: boolean,
): string {
  const maxChars = positiveInteger(options.maxChars ?? DEFAULT_MAX_PROMPT_CHARS, 'maxChars')
  const maxArtifactRefs = nonNegativeInteger(options.maxArtifactRefsPerTask ?? 8, 'maxArtifactRefsPerTask')
  const maxRequiredTaskIds = nonNegativeInteger(options.maxRequiredTaskIds ?? 24, 'maxRequiredTaskIds')
  const requiredIds = boundedList(summary.requiredTaskIds, maxRequiredTaskIds)
  const header = [
    ...(includeSectionLabel ? ['AGENT_TASKS'] : []),
    `graphRevision=${summary.graphRevision} currentActionSeq=${summary.currentActionSeq} total=${summary.totalTaskCount} pending=${summary.pendingCount} blocked=${summary.blockedCount} running=${summary.runningCount}`,
    `requiredTaskIds=${requiredIds}`,
    'requiresMainWorkflowVerification=true authoritativeCompletionEvidence=false',
    'sidechainHistoryIncluded=false parentHistoryIncluded=false',
  ]
  const blocks = summary.recent.map((fact) => renderTaskFact(fact, maxArtifactRefs))
  const rendered = [...header]
  let omittedByCharBudget = 0

  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index]
    const remainingAfter = blocks.length - index - 1 + summary.omittedRelevantTaskCount
    const reserve = remainingAfter > 0 ? `\n- omittedRelevantTasks=${remainingAfter}`.length : 0
    if ([...rendered, block].join('\n').length + reserve <= maxChars) rendered.push(block)
    else omittedByCharBudget += 1
  }

  const omitted = summary.omittedRelevantTaskCount + omittedByCharBudget
  if (omitted > 0) rendered.push(`- omittedRelevantTasks=${omitted}`)
  return truncateStable(rendered.join('\n'), maxChars)
}

export function renderAgentTasksPrompt(
  graph: AgentTaskGraphV2,
  options: AgentTasksPromptSummaryOptions & RenderAgentTasksPromptOptions = {},
): string {
  return renderAgentTasksPromptSummary(buildAgentTasksPromptSummary(graph, options), options)
}

export function renderTaskNotificationPromptAttachment(
  attachment: TaskNotificationPromptAttachmentV1,
  notifications: readonly TaskNotificationV1[],
): string {
  const requestedIds = new Set<string>()
  for (const notificationId of attachment.notificationIds) {
    if (requestedIds.has(notificationId)) {
      throw new Error(`Task notification attachment contains duplicate notification ${notificationId}.`)
    }
    requestedIds.add(notificationId)
  }

  const byId = new Map<string, TaskNotificationV1>()
  for (const notification of notifications) {
    const existing = byId.get(notification.notificationId)
    if (existing && JSON.stringify(existing) !== JSON.stringify(notification)) {
      throw new Error(`Conflicting task notification bytes for ${notification.notificationId}.`)
    }
    byId.set(notification.notificationId, notification)
  }

  const lines = ['ASYNC_TASK_UPDATES']
  for (const notificationId of attachment.notificationIds) {
    const notification = byId.get(notificationId)
    if (!notification) throw new Error(`Task notification ${notificationId} is missing from the prompt attachment input.`)
    if (notification.sessionId !== attachment.sessionId) {
      throw new Error(`Task notification ${notificationId} belongs to a different session.`)
    }
    if (notification.authoritativeCompletionEvidence !== false
      || notification.requiresMainWorkflowVerification !== true) {
      throw new Error(`Task notification ${notificationId} violates the non-authoritative result boundary.`)
    }
    lines.push(...renderNotification(notification))
  }
  return lines.join('\n')
}

export function buildMainCompletionReadiness(
  graph: AgentTaskGraphV2,
  verification?: MainCompletionVerificationInputV1,
): MainCompletionReadinessV1 {
  const pendingOrRunningTaskIds: string[] = []
  const failedOrKilledTaskIds: string[] = []

  for (const task of graph.tasks) {
    if (!task.requiredForCompletion) continue
    if (task.status === 'pending' || task.status === 'blocked' || task.status === 'running') {
      pendingOrRunningTaskIds.push(task.id)
    } else if ((task.status === 'failed' || task.status === 'killed')
      && task.terminalPolicy === 'must_complete_successfully') {
      failedOrKilledTaskIds.push(task.id)
    }
  }

  if (pendingOrRunningTaskIds.length > 0 || failedOrKilledTaskIds.length > 0) {
    return {
      schemaVersion: 'main-completion-readiness/v1',
      state: 'blocked_required_tasks',
      pendingOrRunningTaskIds: pendingOrRunningTaskIds.sort(compareText),
      failedOrKilledTaskIds: failedOrKilledTaskIds.sort(compareText),
    }
  }

  if (!verification) {
    throw new Error('Main workflow verification is required before completion can become eligible.')
  }
  if (!Number.isSafeInteger(verification.verifiedAgainstActionSeq)
    || verification.verifiedAgainstActionSeq !== graph.actionClock.currentActionSeq) {
    throw new Error(
      `Main workflow verification action sequence ${verification.verifiedAgainstActionSeq} does not match current action sequence ${graph.actionClock.currentActionSeq}.`,
    )
  }
  for (const ref of verification.mainWorkflowEvidenceRefs) {
    if (ref.sessionId !== graph.sessionId || ref.runId !== graph.runId || ref.immutable !== true) {
      throw new Error(`Main workflow evidence ${ref.artifactId} does not belong to the current immutable run.`)
    }
  }

  return {
    schemaVersion: 'main-completion-readiness/v1',
    state: 'eligible_for_main_verification',
    mainWorkflowEvidenceRefs: verification.mainWorkflowEvidenceRefs.map((ref) => structuredClone(ref)) as [
      ImmutableArtifactRef,
      ...ImmutableArtifactRef[],
    ],
    verifiedAgainstActionSeq: verification.verifiedAgainstActionSeq,
  }
}

function toPromptFact(task: AgentTask): AgentTaskPromptFactV1 {
  const outputArtifactIds = task.outputs.map((output) => output.artifactRef.artifactId).sort(compareText)
  return {
    schemaVersion: 'agent-task-prompt-fact/v1',
    taskId: task.id,
    taskKind: task.kind,
    status: task.status,
    title: oneLine(task.title, 160),
    completionRequirement: task.requiredForCompletion
      ? { requiredForCompletion: true, terminalPolicy: task.terminalPolicy }
      : { requiredForCompletion: false, terminalPolicy: 'does_not_block' },
    attempt: task.attempt,
    maxAttempts: task.maxAttempts,
    actionBinding: structuredClone(task.actionBinding),
    outputArtifactIds,
    sidechainTranscriptArtifactIds: task.outputs
      .filter((output) => output.artifactRef.artifactKind === 'sidechain_transcript')
      .map((output) => output.artifactRef.artifactId)
      .sort(compareText),
    outputFreshness: task.outputs.map((output) => structuredClone(output.freshness)),
    requiresMainWorkflowVerification: true,
    authoritativeCompletionEvidence: false,
  }
}

function renderTaskFact(fact: AgentTaskPromptFactV1, maxArtifactRefs: number): string {
  const required = fact.completionRequirement.requiredForCompletion
    ? `true terminalPolicy=${fact.completionRequirement.terminalPolicy}`
    : 'false terminalPolicy=does_not_block'
  const lines = [
    `- taskId=${safeAtom(fact.taskId)} kind=${fact.taskKind} status=${fact.status} requiredForCompletion=${required} attempt=${fact.attempt}/${fact.maxAttempts}`,
    `  title=${oneLine(fact.title, 160) || '(untitled)'}`,
    `  actionBinding=${renderActionBinding(fact.actionBinding)}`,
    `  outputArtifactIds=${boundedList(fact.outputArtifactIds, maxArtifactRefs)}`,
  ]
  if (fact.outputFreshness.length > 0) {
    lines.push(`  outputFreshness=${fact.outputFreshness.map(renderFreshness).join(',')}`)
  }
  if (fact.sidechainTranscriptArtifactIds.length > 0) {
    lines.push(`  sidechainTranscriptRefs=${boundedList(fact.sidechainTranscriptArtifactIds, maxArtifactRefs)}`)
  }
  return lines.join('\n')
}

function renderNotification(notification: TaskNotificationV1): string[] {
  const lines = [
    `- notificationId=${safeAtom(notification.notificationId)}`,
    `  taskId=${safeAtom(notification.taskId)} kind=${notification.taskKind} terminalStatus=${notification.terminalStatus}`,
    `  summary=${oneLine(notification.summary, 320) || '(none)'}`,
  ]
  if (notification.terminalStatus === 'completed') {
    lines.push(`  freshness=${renderFreshness(notification.freshness)}`)
    lines.push(`  evidenceRefs=${notification.outputRefs.map(renderArtifactRef).join(',')}`)
  } else {
    lines.push('  evidenceRefs=(none)')
    lines.push(
      `  errorCode=${notification.error.code} retryDisposition=${notification.error.retryDisposition} error=${oneLine(notification.error.message, 240)}`,
    )
  }
  lines.push('  requiresMainWorkflowVerification=true')
  lines.push('  authoritativeCompletionEvidence=false')
  lines.push(
    notification.terminalStatus === 'completed'
      && notification.freshness.kind === 'assessed'
      && notification.freshness.validity === 'stale'
      ? '  requiredAction=Treat this as stale, non-authoritative evidence; Main workflow must verify against current page state.'
      : '  requiredAction=Treat this as non-authoritative task evidence; Main workflow must verify current state.',
  )
  return lines
}

function renderFreshness(freshness: ResultFreshnessVerdict): string {
  return freshness.kind === 'not_action_bound'
    ? 'not_action_bound validity=not_applicable'
    : `${freshness.validity} sourceActionSeq=${freshness.sourceActionSeq} assessedAgainstActionSeq=${freshness.assessedAgainstActionSeq}`
}

function renderArtifactRef(ref: ImmutableArtifactRef): string {
  return `${safeAtom(ref.artifactId)}:${ref.artifactKind}`
}

function renderActionBinding(binding: ActionBinding): string {
  return binding.kind === 'browser_action' ? `browser_action sourceActionSeq=${binding.sourceActionSeq}` : 'not_action_bound'
}

function requiredTaskOrder(left: AgentTask, right: AgentTask): number {
  return statusPriority(left.status) - statusPriority(right.status)
    || right.priority - left.priority
    || compareText(left.createdAt, right.createdAt)
    || compareText(left.id, right.id)
}

function activeTaskOrder(left: AgentTask, right: AgentTask): number {
  return right.priority - left.priority
    || compareText(left.createdAt, right.createdAt)
    || compareText(left.id, right.id)
}

function recentTerminalOrder(left: AgentTask, right: AgentTask): number {
  const leftAt = left.status === 'completed' || left.status === 'failed' || left.status === 'killed'
    ? left.terminalAt
    : left.updatedAt
  const rightAt = right.status === 'completed' || right.status === 'failed' || right.status === 'killed'
    ? right.terminalAt
    : right.updatedAt
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

function countStatus(tasks: AgentTask[], status: AgentTaskStatus): number {
  return tasks.filter((task) => task.status === status).length
}

function boundedList(values: readonly string[], maxItems: number): string {
  if (values.length === 0) return '(none)'
  const shown = values.slice(0, maxItems).map(safeAtom)
  return `${shown.join(',')}${values.length > shown.length ? `,...(+${values.length - shown.length})` : ''}`
}

function safeAtom(value: string): string {
  return oneLine(value, 120).replace(/[=,]/g, '_')
}

function oneLine(value: unknown, maxChars: number): string {
  const normalized = String(value ?? '').replace(/\s+/g, ' ').trim()
  if (normalized.length <= maxChars) return normalized
  return `${normalized.slice(0, Math.max(0, maxChars - 14))}...[truncated]`
}

function truncateStable(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value
  const marker = '\n...[truncated]'
  if (maxChars <= marker.length) return value.slice(0, maxChars)
  return `${value.slice(0, maxChars - marker.length)}${marker}`
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer.`)
  return value
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer.`)
  return value
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}
