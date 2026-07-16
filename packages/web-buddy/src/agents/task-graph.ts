import { createHash, randomUUID } from 'node:crypto'
import type {
  ActionBinding,
  AgentTask as AgentTaskV2,
  AgentTaskEvent,
  AgentTaskGraphSafety as AgentTaskGraphSafetyV2,
  AgentTaskGraphV2,
  AgentTaskInput as AgentTaskInputV2,
  TaskCompletionRequirement,
  TaskIdempotency,
  TaskSpawnResolutionV1,
  AgentTaskGraphV1MigrationOptions,
  ContractMigrationResult,
  ContractMigrationWarning,
  LegacyAgentTaskGraphV1MigrationInput,
} from './async-task-contracts.js'

export type {
  AgentTaskEvent,
  AgentTaskGraphV2,
  TaskRunIdentity,
} from './async-task-contracts.js'

export type AgentTaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'killed' | 'blocked'

export type AgentTaskKind =
  | 'main_browser_step'
  | 'candidate_job_research'
  | 'trace_summarization'
  | 'memory_retrieval'
  | 'workflow_evaluation'
  | 'delivery_probe'

export type AgentTaskAccessMode = 'read_only' | 'browser_write' | 'filesystem_write' | 'analysis_only'

export type AgentTaskInputKind =
  | 'goal'
  | 'memory_artifact'
  | 'trace_artifact'
  | 'page_snapshot_artifact'
  | 'workflow_state'

export type AgentTaskOutputKind =
  | 'recommendation'
  | 'candidate_jobs'
  | 'trace_summary'
  | 'memory_result'
  | 'artifact_ref'
  | 'transcript_ref'
  | 'workflow_patch_proposal'

export type AgentTaskLockResource =
  | 'browser_page'
  | 'session_transcript'
  | 'workflow_state'
  | 'memory_store'
  | 'trace_store'

export type AgentTaskLockMode = 'read' | 'write'

export const READ_ONLY_SUBAGENT_TASK_KINDS = [
  'candidate_job_research',
  'trace_summarization',
  'memory_retrieval',
] as const satisfies readonly AgentTaskKind[]

export interface AgentTaskGraph {
  schemaVersion: 'agent-task-graph/v1'
  graphId: string
  runId: string
  sessionId: string
  createdAt: string
  updatedAt: string
  owner: 'runtime_orchestrator'
  tasks: AgentTask[]
  locks: AgentTaskLock[]
  safety: AgentTaskGraphSafety
}

export interface AgentTask {
  id: string
  kind: AgentTaskKind
  status: AgentTaskStatus
  title: string
  assignedAgent?: string
  accessMode: AgentTaskAccessMode
  blockedBy: string[]
  blocks: string[]
  createdAt: string
  updatedAt: string
  startedAt?: string
  completedAt?: string
  inputs: AgentTaskInput[]
  outputs: AgentTaskOutput[]
  error?: string
  sidechainTranscriptPath?: string
  requiresMainWorkflowVerification: boolean
  authoritativeCompletionEvidence: false
}

export interface AgentTaskInput {
  kind: AgentTaskInputKind
  ref?: string
  value?: unknown
}

export interface AgentTaskOutput {
  kind: AgentTaskOutputKind
  ref?: string
  value?: unknown
  appendToMainTranscript: boolean
  requiresMainWorkflowVerification: boolean
  authoritativeCompletionEvidence: false
}

export interface AgentTaskLock {
  id: string
  ownerTaskId: string
  resource: AgentTaskLockResource
  resourceId?: string
  mode: AgentTaskLockMode
  acquiredAt: string
  releasedAt?: string
}

export interface AgentTaskGraphSafety {
  browserWriteOwnerTaskId?: string
  subagentDefaultAccessMode: 'read_only'
  allowedReadOnlyTaskKinds: typeof READ_ONLY_SUBAGENT_TASK_KINDS[number][]
  disallowedSubagentGateKinds: Array<'login' | 'captcha' | 'upload_resume' | 'save_resume' | 'final_submit'>
  disallowedSubagentToolNames: string[]
  finalDecisionOwner: 'main_agent_runtime'
  completionEvidenceRequiresMainVerification: true
}

export interface CreateAgentTaskGraphInput {
  graphId?: string
  runId: string
  sessionId: string
  now?: string
}

export interface CreateAgentTaskInput {
  id?: string
  kind: AgentTaskKind
  title: string
  status?: AgentTaskStatus
  assignedAgent?: string
  accessMode?: AgentTaskAccessMode
  blockedBy?: string[]
  blocks?: string[]
  inputs?: AgentTaskInput[]
  outputs?: AddAgentTaskOutputInput[]
  sidechainTranscriptPath?: string
  now?: string
}

export interface AddAgentTaskOutputInput {
  kind: AgentTaskOutputKind
  ref?: string
  value?: unknown
  appendToMainTranscript?: boolean
  requiresMainWorkflowVerification?: boolean
  authoritativeCompletionEvidence?: boolean
}

export interface AcquireAgentTaskLockInput {
  ownerTaskId: string
  resource: AgentTaskLockResource
  resourceId?: string
  mode: AgentTaskLockMode
  lockId?: string
  now?: string
}

export interface StartAgentTaskOptions {
  now?: string
  acquireBrowserPageWriteLock?: boolean
  browserPageId?: string
}

export function createAgentTaskGraph(input: CreateAgentTaskGraphInput): AgentTaskGraph {
  const now = input.now ?? new Date().toISOString()
  return {
    schemaVersion: 'agent-task-graph/v1',
    graphId: input.graphId ?? `graph_${randomUUID()}`,
    runId: input.runId,
    sessionId: input.sessionId,
    createdAt: now,
    updatedAt: now,
    owner: 'runtime_orchestrator',
    tasks: [],
    locks: [],
    safety: defaultAgentTaskGraphSafety(),
  }
}

export function defaultAgentTaskGraphSafety(): AgentTaskGraphSafety {
  return {
    subagentDefaultAccessMode: 'read_only',
    allowedReadOnlyTaskKinds: [...READ_ONLY_SUBAGENT_TASK_KINDS],
    disallowedSubagentGateKinds: ['login', 'captcha', 'upload_resume', 'save_resume', 'final_submit'],
    disallowedSubagentToolNames: [
      'browser_open',
      'browser_click',
      'browser_click_text',
      'browser_type',
      'browser_fill_by_label',
      'browser_select',
      'browser_select_by_text',
      'browser_set_field',
      'browser_press_key',
      'browser_upload_file',
      'agent_done',
      'ask_user',
    ],
    finalDecisionOwner: 'main_agent_runtime',
    completionEvidenceRequiresMainVerification: true,
  }
}

export function createAgentTask(input: CreateAgentTaskInput): AgentTask {
  const now = input.now ?? new Date().toISOString()
  const blockedBy = uniqueIds(input.blockedBy ?? [], input.id)
  const blocks = uniqueIds(input.blocks ?? [], input.id)
  const status = input.status ?? (blockedBy.length ? 'blocked' : 'pending')
  return {
    id: input.id ?? `task_${randomUUID()}`,
    kind: input.kind,
    status,
    title: input.title,
    ...(input.assignedAgent ? { assignedAgent: input.assignedAgent } : {}),
    accessMode: input.accessMode ?? defaultAccessModeForKind(input.kind),
    blockedBy,
    blocks,
    createdAt: now,
    updatedAt: now,
    inputs: [...(input.inputs ?? [])],
    outputs: (input.outputs ?? []).map(createAgentTaskOutput),
    ...(input.sidechainTranscriptPath ? { sidechainTranscriptPath: input.sidechainTranscriptPath } : {}),
    requiresMainWorkflowVerification: true,
    authoritativeCompletionEvidence: false,
  }
}

export function createReadOnlySubagentTask(
  input: Omit<CreateAgentTaskInput, 'accessMode' | 'kind'> & {
    kind: typeof READ_ONLY_SUBAGENT_TASK_KINDS[number]
  },
): AgentTask {
  return createAgentTask({
    ...input,
    accessMode: 'read_only',
  })
}

export function isReadOnlySubagentTaskKind(kind: AgentTaskKind): kind is typeof READ_ONLY_SUBAGENT_TASK_KINDS[number] {
  return READ_ONLY_SUBAGENT_TASK_KINDS.includes(kind as typeof READ_ONLY_SUBAGENT_TASK_KINDS[number])
}

export function assertReadOnlySubagentTask(task: AgentTask): void {
  if (!isReadOnlySubagentTaskKind(task.kind)) {
    throw new Error(`Task ${task.id} (${task.kind}) is not allowed in the read-only subagent runner.`)
  }
  if (task.accessMode !== 'read_only') {
    throw new Error(`Task ${task.id} must use read_only access; got ${task.accessMode}.`)
  }
}

export function addAgentTask(graph: AgentTaskGraph, taskInput: AgentTask | CreateAgentTaskInput): AgentTaskGraph {
  const task = isAgentTask(taskInput) ? cloneTask(taskInput) : createAgentTask(taskInput)
  if (graph.tasks.some((existing) => existing.id === task.id)) {
    throw new Error(`Task already exists: ${task.id}`)
  }
  assertKnownDependencies(graph, task)

  const next = touchGraph({
    ...graph,
    tasks: syncTaskLinks([...graph.tasks.map(cloneTask), task]),
  }, task.updatedAt)
  assertAcyclicTaskGraph(next)
  return refreshBlockedTasks(next, task.updatedAt)
}

export function getAgentTask(graph: AgentTaskGraph, taskId: string): AgentTask | undefined {
  const task = graph.tasks.find((candidate) => candidate.id === taskId)
  return task ? cloneTask(task) : undefined
}

export function getRunnableAgentTasks(graph: AgentTaskGraph): AgentTask[] {
  return graph.tasks.filter((task) => canRunAgentTask(graph, task.id)).map(cloneTask)
}

export function canRunAgentTask(graph: AgentTaskGraph, taskId: string): boolean {
  const task = requireTask(graph, taskId)
  return task.status === 'pending' && unresolvedBlockedBy(graph, task).length === 0
}

export function startAgentTask(graph: AgentTaskGraph, taskId: string, options: StartAgentTaskOptions = {}): AgentTaskGraph {
  const task = requireTask(graph, taskId)
  const unresolved = unresolvedBlockedBy(graph, task)
  if (unresolved.length) {
    throw new Error(`Task ${taskId} is blocked by unresolved task(s): ${unresolved.join(', ')}`)
  }
  if (task.status !== 'pending') {
    throw new Error(`Task ${taskId} cannot start from status ${task.status}.`)
  }

  const now = options.now ?? new Date().toISOString()
  let next = updateTask(graph, taskId, {
    status: 'running',
    startedAt: task.startedAt ?? now,
    updatedAt: now,
  })

  if (task.accessMode === 'browser_write' && options.acquireBrowserPageWriteLock !== false) {
    next = acquireAgentTaskLock(next, {
      ownerTaskId: taskId,
      resource: 'browser_page',
      resourceId: options.browserPageId ?? 'default',
      mode: 'write',
      now,
    })
  }

  return next
}

export function completeAgentTask(
  graph: AgentTaskGraph,
  taskId: string,
  outputInputs: AddAgentTaskOutputInput[] = [],
  now = new Date().toISOString(),
): AgentTaskGraph {
  requireTask(graph, taskId)
  const outputs = outputInputs.map(createAgentTaskOutput)
  let next = updateTask(graph, taskId, (task) => ({
    status: 'completed',
    completedAt: task.completedAt ?? now,
    updatedAt: now,
    outputs: [...task.outputs, ...outputs],
  }))
  next = releaseAgentTaskLocks(next, taskId, now)
  return refreshBlockedTasks(next, now)
}

export function failAgentTask(graph: AgentTaskGraph, taskId: string, error: string, now = new Date().toISOString()): AgentTaskGraph {
  requireTask(graph, taskId)
  let next = updateTask(graph, taskId, {
    status: 'failed',
    completedAt: now,
    updatedAt: now,
    error,
  })
  next = releaseAgentTaskLocks(next, taskId, now)
  return refreshBlockedTasks(next, now)
}

export function killAgentTask(graph: AgentTaskGraph, taskId: string, reason: string, now = new Date().toISOString()): AgentTaskGraph {
  requireTask(graph, taskId)
  let next = updateTask(graph, taskId, {
    status: 'killed',
    completedAt: now,
    updatedAt: now,
    error: reason,
  })
  next = releaseAgentTaskLocks(next, taskId, now)
  return refreshBlockedTasks(next, now)
}

export function blockAgentTask(graph: AgentTaskGraph, taskId: string, reason: string, now = new Date().toISOString()): AgentTaskGraph {
  requireTask(graph, taskId)
  return updateTask(graph, taskId, {
    status: 'blocked',
    updatedAt: now,
    error: reason,
  })
}

export function addAgentTaskOutput(
  graph: AgentTaskGraph,
  taskId: string,
  outputInput: AddAgentTaskOutputInput,
  now = new Date().toISOString(),
): AgentTaskGraph {
  requireTask(graph, taskId)
  const output = createAgentTaskOutput(outputInput)
  return updateTask(graph, taskId, (task) => ({
    outputs: [...task.outputs, output],
    updatedAt: now,
  }))
}

export function setAgentTaskSidechainTranscript(
  graph: AgentTaskGraph,
  taskId: string,
  sidechainTranscriptPath: string,
  now = new Date().toISOString(),
): AgentTaskGraph {
  requireTask(graph, taskId)
  return updateTask(graph, taskId, {
    sidechainTranscriptPath,
    updatedAt: now,
  })
}

export function acquireAgentTaskLock(graph: AgentTaskGraph, input: AcquireAgentTaskLockInput): AgentTaskGraph {
  const owner = requireTask(graph, input.ownerTaskId)
  if (input.mode === 'write' && input.resource === 'browser_page' && owner.accessMode !== 'browser_write') {
    throw new Error(`Task ${owner.id} cannot acquire a browser_page write lock with ${owner.accessMode} access.`)
  }

  const now = input.now ?? new Date().toISOString()
  const resourceId = input.resourceId ?? (input.resource === 'browser_page' ? 'default' : undefined)
  const activeConflict = graph.locks.find((lock) => {
    if (lock.releasedAt) return false
    if (lock.resource !== input.resource) return false
    if ((lock.resourceId ?? 'default') !== (resourceId ?? 'default')) return false
    if (lock.ownerTaskId === input.ownerTaskId) return false
    return lock.mode === 'write' || input.mode === 'write'
  })
  if (activeConflict) {
    throw new Error(
      `Resource ${input.resource}:${resourceId ?? 'default'} is already locked by ${activeConflict.ownerTaskId}.`,
    )
  }

  const lock: AgentTaskLock = {
    id: input.lockId ?? `lock_${randomUUID()}`,
    ownerTaskId: input.ownerTaskId,
    resource: input.resource,
    ...(resourceId ? { resourceId } : {}),
    mode: input.mode,
    acquiredAt: now,
  }

  return touchGraph({
    ...graph,
    locks: [...graph.locks.map(cloneLock), lock],
    safety: input.resource === 'browser_page' && input.mode === 'write'
      ? { ...graph.safety, browserWriteOwnerTaskId: input.ownerTaskId }
      : { ...graph.safety },
  }, now)
}

export function releaseAgentTaskLocks(graph: AgentTaskGraph, ownerTaskId: string, now = new Date().toISOString()): AgentTaskGraph {
  const locks = graph.locks.map((lock) => (
    lock.ownerTaskId === ownerTaskId && !lock.releasedAt
      ? { ...lock, releasedAt: now }
      : cloneLock(lock)
  ))
  const browserWriteOwnerTaskId = locks.find((lock) => (
    lock.resource === 'browser_page' && lock.mode === 'write' && !lock.releasedAt
  ))?.ownerTaskId
  return touchGraph({
    ...graph,
    locks,
    safety: {
      ...graph.safety,
      ...(browserWriteOwnerTaskId ? { browserWriteOwnerTaskId } : { browserWriteOwnerTaskId: undefined }),
    },
  }, now)
}

export function assertAcyclicTaskGraph(graph: AgentTaskGraph): void {
  const byId = new Map(graph.tasks.map((task) => [task.id, task]))
  const visiting = new Set<string>()
  const visited = new Set<string>()

  const visit = (taskId: string, path: string[]): void => {
    if (visited.has(taskId)) return
    if (visiting.has(taskId)) {
      throw new Error(`Task graph contains a cycle: ${[...path, taskId].join(' -> ')}`)
    }
    const task = byId.get(taskId)
    if (!task) return

    visiting.add(taskId)
    for (const downstreamId of task.blocks) visit(downstreamId, [...path, taskId])
    visiting.delete(taskId)
    visited.add(taskId)
  }

  for (const task of graph.tasks) visit(task.id, [])
}

function createAgentTaskOutput(input: AddAgentTaskOutputInput): AgentTaskOutput {
  if (input.authoritativeCompletionEvidence) {
    throw new Error('Subagent output cannot be authoritative completion evidence; main workflow must verify it.')
  }
  if (input.requiresMainWorkflowVerification === false) {
    throw new Error('Subagent output must require main workflow verification.')
  }
  return {
    kind: input.kind,
    ...(input.ref ? { ref: input.ref } : {}),
    ...(input.value !== undefined ? { value: input.value } : {}),
    appendToMainTranscript: input.appendToMainTranscript ?? false,
    requiresMainWorkflowVerification: true,
    authoritativeCompletionEvidence: false,
  }
}

function defaultAccessModeForKind(kind: AgentTaskKind): AgentTaskAccessMode {
  if (kind === 'main_browser_step') return 'browser_write'
  return isReadOnlySubagentTaskKind(kind) ? 'read_only' : 'analysis_only'
}

function assertKnownDependencies(graph: AgentTaskGraph, task: AgentTask): void {
  const known = new Set(graph.tasks.map((existing) => existing.id))
  const unknown = [...task.blockedBy, ...task.blocks].filter((id) => !known.has(id))
  if (unknown.length) throw new Error(`Task ${task.id} references unknown task(s): ${uniqueIds(unknown).join(', ')}`)
}

function refreshBlockedTasks(graph: AgentTaskGraph, now: string): AgentTaskGraph {
  return touchGraph({
    ...graph,
    tasks: graph.tasks.map((task) => {
      const unresolved = unresolvedBlockedBy(graph, task)
      if (task.status === 'pending' && unresolved.length) {
        return { ...task, status: 'blocked', updatedAt: now }
      }
      if (task.status === 'blocked' && unresolved.length === 0 && !task.error) {
        return { ...task, status: 'pending', updatedAt: now }
      }
      return cloneTask(task)
    }),
  }, now)
}

function unresolvedBlockedBy(graph: AgentTaskGraph, task: AgentTask): string[] {
  const byId = new Map(graph.tasks.map((candidate) => [candidate.id, candidate]))
  return task.blockedBy.filter((blockedById) => byId.get(blockedById)?.status !== 'completed')
}

function syncTaskLinks(tasks: AgentTask[]): AgentTask[] {
  const byId = new Map(tasks.map((task) => [task.id, cloneTask(task)]))
  for (const task of [...byId.values()]) {
    for (const blockedById of task.blockedBy) {
      const dependency = byId.get(blockedById)
      if (dependency) dependency.blocks = uniqueIds([...dependency.blocks, task.id], dependency.id)
    }
    for (const blockedId of task.blocks) {
      const blocked = byId.get(blockedId)
      if (blocked) blocked.blockedBy = uniqueIds([...blocked.blockedBy, task.id], blocked.id)
    }
  }
  return [...byId.values()]
}

function updateTask(
  graph: AgentTaskGraph,
  taskId: string,
  patch: Partial<AgentTask> | ((task: AgentTask) => Partial<AgentTask>),
): AgentTaskGraph {
  const now = new Date().toISOString()
  const tasks = graph.tasks.map((task) => {
    if (task.id !== taskId) return cloneTask(task)
    const resolved = typeof patch === 'function' ? patch(cloneTask(task)) : patch
    return { ...task, ...resolved }
  })
  return touchGraph({ ...graph, tasks }, tasks.find((task) => task.id === taskId)?.updatedAt ?? now)
}

function requireTask(graph: AgentTaskGraph, taskId: string): AgentTask {
  const task = graph.tasks.find((candidate) => candidate.id === taskId)
  if (!task) throw new Error(`Task not found: ${taskId}`)
  return task
}

function touchGraph(graph: AgentTaskGraph, updatedAt = new Date().toISOString()): AgentTaskGraph {
  return {
    ...graph,
    updatedAt,
    tasks: graph.tasks.map(cloneTask),
    locks: graph.locks.map(cloneLock),
    safety: { ...graph.safety },
  }
}

function cloneTask(task: AgentTask): AgentTask {
  return {
    ...task,
    blockedBy: [...task.blockedBy],
    blocks: [...task.blocks],
    inputs: task.inputs.map((input) => ({ ...input })),
    outputs: task.outputs.map((output) => ({ ...output })),
  }
}

function cloneLock(lock: AgentTaskLock): AgentTaskLock {
  return { ...lock }
}

function uniqueIds(values: string[], selfId?: string): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value && value !== selfId))]
}

function isAgentTask(value: AgentTask | CreateAgentTaskInput): value is AgentTask {
  return 'createdAt' in value && 'updatedAt' in value && 'requiresMainWorkflowVerification' in value
}

// V2 control-plane reducers. The legacy helpers above remain until A10 switches the
// synchronous runtime pilot; Store/Scheduler only consume these frozen V2 shapes.

export interface CreateAgentTaskGraphV2Input {
  graphId?: string
  runId: string
  sessionId: string
  currentActionSeq?: number
  now?: string
}

export interface CreateAgentTaskV2Input {
  id?: string
  kind: AgentTaskV2['kind']
  title: string
  priority?: number
  blockedBy?: string[]
  blocks?: string[]
  inputs?: AgentTaskInputV2[]
  actionBinding?: ActionBinding
  idempotency: TaskIdempotency
  completionRequirement?: TaskCompletionRequirement
  maxAttempts?: number
  timeoutMs?: number
  leaseDurationMs?: number
  now?: string
}

export function createAgentTaskGraphV2(input: CreateAgentTaskGraphV2Input): AgentTaskGraphV2 {
  const now = input.now ?? new Date().toISOString()
  return {
    schemaVersion: 'agent-task-graph/v2',
    revision: 0,
    nextEventSeq: 1,
    graphId: input.graphId ?? `graph_${randomUUID()}`,
    runId: input.runId,
    sessionId: input.sessionId,
    createdAt: now,
    updatedAt: now,
    owner: 'runtime_orchestrator',
    actionClock: {
      schemaVersion: 'browser-action-clock/v1',
      sessionId: input.sessionId,
      runId: input.runId,
      currentActionSeq: input.currentActionSeq ?? 0,
      updatedAt: now,
      authority: 'main_agent_runtime',
    },
    tasks: [],
    locks: [],
    notificationOutbox: [],
    safety: defaultAgentTaskGraphSafetyV2(),
  }
}

export function defaultAgentTaskGraphSafetyV2(): AgentTaskGraphSafetyV2 {
  return {
    browserWriteOwnership: { owner: 'main_agent_runtime' },
    subagentCapabilityPolicy: 'immutable_artifact_read_only',
    subagentDefaultAccessMode: 'read_only',
    allowedReadOnlyTaskKinds: ['candidate_job_research', 'trace_summarization', 'memory_retrieval'],
    allowedReadOnlyTools: ['artifact_read_text', 'artifact_read_json', 'artifact_search_text', 'artifact_list_refs'],
    disallowedSubagentGateKinds: ['login', 'captcha', 'upload_resume', 'save_resume', 'final_submit'],
    disallowedSubagentToolNames: [
      'browser_open',
      'browser_click',
      'browser_click_text',
      'browser_type',
      'browser_fill_by_label',
      'browser_select',
      'browser_select_by_text',
      'browser_set_field',
      'browser_press_key',
      'browser_upload_file',
      'agent_done',
      'ask_user',
    ],
    finalDecisionOwner: 'main_agent_runtime',
    completionEvidenceRequiresMainVerification: true,
  }
}

export function createAgentTaskV2(input: CreateAgentTaskV2Input): AgentTaskV2 {
  const now = input.now ?? new Date().toISOString()
  const blockedBy = uniqueIds(input.blockedBy ?? [], input.id)
  const blocks = uniqueIds(input.blocks ?? [], input.id)
  const role = roleForV2Kind(input.kind)
  const completion = input.completionRequirement ?? { requiredForCompletion: false, terminalPolicy: 'does_not_block' }
  const core = {
    schemaVersion: 'agent-task/v2' as const,
    id: input.id ?? `task_${randomUUID()}`,
    title: input.title,
    priority: input.priority ?? 0,
    blockedBy,
    blocks,
    inputs: structuredClone(input.inputs ?? []),
    outputs: [],
    attempts: [],
    actionBinding: structuredClone(input.actionBinding ?? { kind: 'not_action_bound' }),
    idempotency: structuredClone(input.idempotency),
    attempt: 0,
    maxAttempts: input.maxAttempts ?? 2,
    timeoutMs: input.timeoutMs ?? 120_000,
    leaseDurationMs: input.leaseDurationMs ?? 150_000,
    createdAt: now,
    updatedAt: now,
    requiresMainWorkflowVerification: true as const,
    authoritativeCompletionEvidence: false as const,
  }
  if (blockedBy.length > 0) {
    return {
      ...core,
      ...role,
      ...completion,
      status: 'blocked',
      blockReason: { kind: 'dependency_wait', unresolvedTaskIds: [...blockedBy] },
    } as AgentTaskV2
  }
  return { ...core, ...role, ...completion, status: 'pending' } as AgentTaskV2
}

export function addAgentTaskV2(graph: AgentTaskGraphV2, task: AgentTaskV2): AgentTaskGraphV2 {
  if (graph.tasks.some((candidate) => candidate.id === task.id)) throw graphV2Error('IDEMPOTENCY_CONFLICT', `Task already exists: ${task.id}`)
  const sameKey = graph.tasks.find((candidate) => candidate.idempotency.key === task.idempotency.key)
  if (sameKey) {
    throw graphV2Error(
      sameKey.idempotency.inputDigest === task.idempotency.inputDigest ? 'IDEMPOTENCY_CONFLICT' : 'IDEMPOTENCY_CONFLICT',
      `Idempotency key ${task.idempotency.key} is already used by ${sameKey.id}.`,
    )
  }
  const known = new Set(graph.tasks.map((candidate) => candidate.id))
  const unknown = [...task.blockedBy, ...task.blocks].filter((id) => !known.has(id))
  if (unknown.length) throw graphV2Error('DEPENDENCY_UNRESOLVED', `Task ${task.id} references unknown task(s): ${uniqueIds(unknown).join(', ')}`)
  const tasks = syncTaskLinksV2([...graph.tasks.map(cloneV2), cloneV2(task)])
  assertAcyclicTaskGraphV2(tasks)
  return { ...cloneV2(graph), tasks }
}

export function resolveAgentTaskSpawnV2(graph: AgentTaskGraphV2, task: AgentTaskV2): TaskSpawnResolutionV1 {
  const existing = graph.tasks.find((candidate) => candidate.idempotency.key === task.idempotency.key)
  if (!existing) return { schemaVersion: 'task-spawn-resolution/v1', outcome: 'created', task: cloneV2(task) }
  if (existing.idempotency.inputDigest === task.idempotency.inputDigest) {
    return { schemaVersion: 'task-spawn-resolution/v1', outcome: 'existing_same_digest', task: cloneV2(existing) }
  }
  return {
    schemaVersion: 'task-spawn-resolution/v1',
    outcome: 'conflict',
    error: {
      schemaVersion: 'async-task-contract-error/v1',
      code: 'IDEMPOTENCY_CONFLICT',
      category: 'conflict',
      retryDisposition: 'new_task_required',
      message: `Idempotency key ${task.idempotency.key} was reused with a different input digest.`,
      occurredAt: new Date().toISOString(),
      taskId: existing.id,
    },
  }
}

export function migrateAgentTaskGraphV1(
  input: LegacyAgentTaskGraphV1MigrationInput,
  options: AgentTaskGraphV1MigrationOptions,
): ContractMigrationResult<AgentTaskGraphV2> {
  if ((input as { schemaVersion?: string }).schemaVersion !== 'agent-task-graph/v1') {
    return {
      status: 'rejected',
      error: {
        schemaVersion: 'async-task-contract-error/v1',
        code: 'UNSUPPORTED_SCHEMA_VERSION',
        category: 'validation',
        retryDisposition: 'never_retry',
        message: `Cannot migrate schema ${(input as { schemaVersion?: string }).schemaVersion ?? 'unknown'}.`,
        occurredAt: options.migratedAt,
      },
    }
  }
  if (input.tasks.some((task) => isTerminalStatusV2(task.status) && task.outputs.length > 0)) {
    return {
      status: 'rebuild_required',
      reason: 'Legacy terminal outputs lack verified immutable artifact metadata.',
      warnings: [],
    }
  }

  const warnings: ContractMigrationWarning[] = []
  const tasks = input.tasks.map((legacy): AgentTaskV2 => {
    const idempotency: TaskIdempotency = {
      schemaVersion: 'agent-task-idempotency/v1',
      scope: 'session',
      key: `legacy:${input.graphId}:${legacy.id}`,
      canonicalization: 'web-buddy-task-input-jcs/v1',
      digestAlgorithm: 'sha256',
      inputDigest: createHash('sha256').update(canonicalJson(legacy.inputs)).digest('hex'),
    }
    warnings.push({ code: 'LEGACY_IDEMPOTENCY_DERIVED', message: `Derived idempotency for legacy task ${legacy.id}.` })
    warnings.push({ code: 'LEGACY_ACTION_BINDING_UNKNOWN', message: `Legacy task ${legacy.id} is not action-bound.` })
    const base = createAgentTaskV2({
      id: legacy.id,
      kind: legacy.kind,
      title: `Legacy task ${legacy.id}`,
      inputs: legacy.inputs.map((structuredValue) => ({ kind: 'goal', structuredValue })),
      idempotency,
      maxAttempts: options.defaultMaxAttempts,
      timeoutMs: options.defaultTimeoutMs,
      leaseDurationMs: options.defaultLeaseDurationMs,
      now: input.updatedAt,
    })
    if (legacy.status === 'running') {
      if (legacy.accessMode === 'browser_write') {
        const error = migrationPolicyError(legacy.id, options.migratedAt)
        warnings.push({ code: 'LEGACY_RUNNING_BROWSER_WRITE_FAILED', message: `Legacy browser-write task ${legacy.id} was failed.` })
        return {
          ...base,
          status: 'failed',
          terminalAt: options.migratedAt,
          updatedAt: options.migratedAt,
          lastError: error,
        } as AgentTaskV2
      }
      warnings.push({ code: 'LEGACY_RUNNING_READ_ONLY_REQUEUED', message: `Legacy read-only task ${legacy.id} was requeued.` })
      return { ...base, status: 'pending', updatedAt: options.migratedAt } as AgentTaskV2
    }
    if (legacy.status === 'blocked') {
      return {
        ...base,
        status: 'blocked',
        blockReason: { kind: 'manual', code: 'legacy_blocked', reason: 'Preserved from legacy graph.' },
      } as AgentTaskV2
    }
    if (legacy.status === 'completed' || legacy.status === 'failed' || legacy.status === 'killed') {
      return { ...base, status: legacy.status, terminalAt: input.updatedAt } as AgentTaskV2
    }
    return { ...base, status: 'pending' } as AgentTaskV2
  })
  const runningIds = new Set(input.tasks.filter((task) => task.status === 'running').map((task) => task.id))
  const graph: AgentTaskGraphV2 = {
    ...createAgentTaskGraphV2({
      graphId: input.graphId,
      runId: input.runId,
      sessionId: input.sessionId,
      now: options.migratedAt,
    }),
    createdAt: input.createdAt,
    tasks,
    locks: input.locks.map((lock) => runningIds.has(lock.ownerTaskId) && !lock.releasedAt
      ? { ...lock, releasedAt: options.migratedAt }
      : structuredClone(lock)),
  }
  return { status: 'migrated', value: graph, warnings }
}

export function getAgentTaskV2(graph: AgentTaskGraphV2, taskId: string): AgentTaskV2 | undefined {
  const task = graph.tasks.find((candidate) => candidate.id === taskId)
  return task ? cloneV2(task) : undefined
}

export function getRunnableAgentTasksV2(graph: AgentTaskGraphV2, now = new Date().toISOString()): AgentTaskV2[] {
  return graph.tasks
    .filter((task) => task.status === 'pending'
      && (!task.nextAttemptAt || task.nextAttemptAt <= now)
      && task.blockedBy.every((id) => graph.tasks.find((candidate) => candidate.id === id)?.status === 'completed'))
    .sort((left, right) => right.priority - left.priority || left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
    .map(cloneV2)
}

export function finalizeAgentTaskGraphMutationV2(
  current: AgentTaskGraphV2,
  draft: AgentTaskGraphV2,
  event: AgentTaskEvent,
  now = event.occurredAt,
): { graph: AgentTaskGraphV2; event: AgentTaskEvent } {
  const revisionAfter = current.revision + 1
  const graph: AgentTaskGraphV2 = {
    ...cloneV2(draft),
    graphId: current.graphId,
    runId: current.runId,
    sessionId: current.sessionId,
    revision: revisionAfter,
    nextEventSeq: current.nextEventSeq + 1,
    updatedAt: now,
  }
  const finalized = {
    ...cloneV2(event),
    eventSeq: current.nextEventSeq,
    revisionBefore: current.revision,
    revisionAfter,
    sessionId: current.sessionId,
    graphId: current.graphId,
    occurredAt: now,
    authoritativeTaskState: true as const,
    authoritativeCompletionEvidence: false as const,
  } as AgentTaskEvent
  return { graph, event: finalized }
}

export function assertAcyclicTaskGraphV2(tasksOrGraph: AgentTaskV2[] | AgentTaskGraphV2): void {
  const tasks = Array.isArray(tasksOrGraph) ? tasksOrGraph : tasksOrGraph.tasks
  const byId = new Map(tasks.map((task) => [task.id, task]))
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (taskId: string, path: string[]): void => {
    if (visited.has(taskId)) return
    if (visiting.has(taskId)) throw graphV2Error('DAG_CYCLE', `Task graph contains a cycle: ${[...path, taskId].join(' -> ')}`)
    const task = byId.get(taskId)
    if (!task) return
    visiting.add(taskId)
    for (const downstream of task.blocks) visit(downstream, [...path, taskId])
    visiting.delete(taskId)
    visited.add(taskId)
  }
  for (const task of tasks) visit(task.id, [])
}

function roleForV2Kind(kind: AgentTaskV2['kind']): Pick<AgentTaskV2, 'kind' | 'accessMode' | 'capacityClass'> {
  if (kind === 'main_browser_step') return { kind, accessMode: 'browser_write', capacityClass: 'main_agent_only' }
  if (kind === 'candidate_job_research' || kind === 'trace_summarization') {
    return { kind, accessMode: 'read_only', capacityClass: 'read_only_llm' }
  }
  if (kind === 'memory_retrieval') return { kind, accessMode: 'read_only', capacityClass: 'deterministic' }
  return { kind, accessMode: 'analysis_only', capacityClass: 'deterministic' }
}

function syncTaskLinksV2(tasks: AgentTaskV2[]): AgentTaskV2[] {
  const byId = new Map(tasks.map((task) => [task.id, cloneV2(task)]))
  for (const task of [...byId.values()]) {
    for (const dependencyId of task.blockedBy) {
      const dependency = byId.get(dependencyId)
      if (dependency) dependency.blocks = uniqueIds([...dependency.blocks, task.id], dependency.id)
    }
    for (const downstreamId of task.blocks) {
      const downstream = byId.get(downstreamId)
      if (downstream) downstream.blockedBy = uniqueIds([...downstream.blockedBy, task.id], downstream.id)
    }
  }
  return [...byId.values()]
}

function graphV2Error(code: 'IDEMPOTENCY_CONFLICT' | 'DEPENDENCY_UNRESOLVED' | 'DAG_CYCLE', message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code })
}

function migrationPolicyError(taskId: string, occurredAt: string) {
  return {
    schemaVersion: 'async-task-contract-error/v1' as const,
    code: 'POLICY_VIOLATION' as const,
    category: 'policy' as const,
    retryDisposition: 'new_task_required' as const,
    message: `Legacy browser-write task ${taskId} cannot be replayed in the background.`,
    occurredAt,
    taskId,
  }
}

function isTerminalStatusV2(status: AgentTaskV2['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'killed'
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`)
    .join(',')}}`
}

function cloneV2<T>(value: T): T { return structuredClone(value) }
