import { randomUUID } from 'node:crypto'

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
