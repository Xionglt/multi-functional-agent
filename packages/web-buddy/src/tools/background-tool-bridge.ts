import type {
  AgentTask,
  AgentTaskInput,
  AgentTaskStatus,
  BackgroundAgentTaskKind,
  ImmutableArtifactRef,
  JsonValue,
  TaskContractError,
  TaskSpawnResolutionV1,
} from '../agents/async-task-contracts.js'
import type { AsyncTaskSpawnInput } from '../agents/async-task-runtime.js'
import type { PreparedToolCallV1 } from './tool-orchestrator.js'

export interface ExistingAsyncTaskRuntimePortV1 {
  spawn(input: AsyncTaskSpawnInput): Promise<TaskSpawnResolutionV1>
}

export interface BackgroundToolTaskMappingV1 {
  schemaVersion: 'background-tool-bridge/v1'
  toolName: string
  taskKind: BackgroundAgentTaskKind
  toSpawnInput(prepared: PreparedToolCallV1): Promise<AsyncTaskSpawnInput>
}

export interface BackgroundToolStartResultV1 {
  schemaVersion: 'tool-background-start/v1'
  taskId: string
  spawnOutcome: 'created' | 'existing_same_digest'
  status: AgentTaskStatus
  outputRefs: ImmutableArtifactRef[]
  requiresMainWorkflowVerification: true
  authoritativeCompletionEvidence: false
}

export type BackgroundToolBridgeErrorCodeV1 =
  | 'BACKGROUND_NOT_ELIGIBLE'
  | 'BACKGROUND_MAPPING_NOT_FOUND'
  | 'BACKGROUND_RESOURCE_FORBIDDEN'
  | 'BACKGROUND_INPUT_NOT_IMMUTABLE'
  | 'BACKGROUND_INPUT_NOT_CLONEABLE'
  | 'BACKGROUND_TASK_KIND_FORBIDDEN'
  | 'BACKGROUND_IDEMPOTENCY_CONFLICT'
  | 'BACKGROUND_RUNTIME_UNAVAILABLE'
  | 'SESSION_ABORTED'

export interface BackgroundToolBridgeErrorV1 {
  schemaVersion: 'background-tool-bridge-error/v1'
  code: BackgroundToolBridgeErrorCodeV1
  message: string
  retryable: boolean
  taskContractError?: TaskContractError
}

export interface BackgroundToolBridgeV1 {
  readonly contractVersion: 'background-tool-bridge/v1'
  start(prepared: PreparedToolCallV1): Promise<BackgroundToolStartResultV1>
}

export interface BackgroundToolBridgeOptionsV1 {
  runtime: ExistingAsyncTaskRuntimePortV1
  mappings: readonly BackgroundToolTaskMappingV1[]
}

const FORBIDDEN_CONTROL_TOOLS = new Set([
  'agent_task_spawn',
  'agent_task_status',
  'agent_task_wait',
  'agent_task_result',
  'agent_task_cancel',
  'ask_user',
  'agent_done',
])

const ALLOWED_BACKGROUND_TASK_KINDS = new Set<BackgroundAgentTaskKind>([
  'trace_summarization',
  'memory_retrieval',
  'candidate_job_research',
])

const SPAWN_INPUT_KEYS = new Set([
  'taskId',
  'kind',
  'title',
  'inputs',
  'blockedBy',
  'blocks',
  'priority',
  'idempotencyKey',
  'completionRequirement',
  'actionBinding',
])

export class BackgroundToolBridgeError extends Error implements BackgroundToolBridgeErrorV1 {
  readonly schemaVersion = 'background-tool-bridge-error/v1' as const

  constructor(
    readonly code: BackgroundToolBridgeErrorCodeV1,
    message: string,
    readonly retryable: boolean,
    readonly taskContractError?: TaskContractError,
  ) {
    super(message)
    this.name = 'BackgroundToolBridgeError'
  }

  toJSON(): BackgroundToolBridgeErrorV1 {
    return {
      schemaVersion: this.schemaVersion,
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.taskContractError ? { taskContractError: this.taskContractError } : {}),
    }
  }
}

export class BackgroundToolBridge implements BackgroundToolBridgeV1 {
  readonly contractVersion = 'background-tool-bridge/v1' as const
  private readonly runtime: ExistingAsyncTaskRuntimePortV1
  private readonly mappings: ReadonlyMap<string, BackgroundToolTaskMappingV1>

  constructor(options: BackgroundToolBridgeOptionsV1) {
    this.runtime = options.runtime
    const mappings = new Map<string, BackgroundToolTaskMappingV1>()
    for (const mapping of options.mappings) {
      const toolName = mapping.toolName.trim()
      if (!toolName || mappings.has(toolName)) {
        throw bridgeError('BACKGROUND_MAPPING_NOT_FOUND', `Background mapping name is empty or duplicated: ${mapping.toolName}.`)
      }
      mappings.set(toolName, mapping)
    }
    this.mappings = mappings
  }

  async start(prepared: PreparedToolCallV1): Promise<BackgroundToolStartResultV1> {
    validatePreparedCall(prepared)
    const mapping = this.mappings.get(prepared.call.name)
    if (!mapping) {
      throw bridgeError('BACKGROUND_MAPPING_NOT_FOUND', `No trusted background mapping exists for ${prepared.call.name}.`)
    }
    validateTaskKind(mapping.taskKind)

    let spawnInput: AsyncTaskSpawnInput
    try {
      spawnInput = await mapping.toSpawnInput(prepared)
    } catch (error) {
      if (error instanceof BackgroundToolBridgeError) throw error
      throw bridgeError(
        'BACKGROUND_INPUT_NOT_CLONEABLE',
        `Background mapping for ${prepared.call.name} rejected its input: ${safeErrorMessage(error)}.`,
      )
    }
    validateSpawnInput(spawnInput, mapping)

    let resolution: TaskSpawnResolutionV1
    try {
      resolution = await this.runtime.spawn(clone(spawnInput))
    } catch (error) {
      throw mapRuntimeError(error)
    }
    if (resolution.outcome === 'conflict') {
      throw new BackgroundToolBridgeError(
        'BACKGROUND_IDEMPOTENCY_CONFLICT',
        resolution.error.message,
        false,
        resolution.error,
      )
    }
    validateSpawnedTask(resolution.task, mapping)
    return {
      schemaVersion: 'tool-background-start/v1',
      taskId: resolution.task.id,
      spawnOutcome: resolution.outcome,
      status: resolution.task.status,
      outputRefs: resolution.task.outputs.map((output) => clone(output.artifactRef)),
      requiresMainWorkflowVerification: true,
      authoritativeCompletionEvidence: false,
    }
  }
}

export function createTraceSummarizationMappingV1(): BackgroundToolTaskMappingV1 {
  return {
    schemaVersion: 'background-tool-bridge/v1',
    toolName: 'trace_summarization',
    taskKind: 'trace_summarization',
    async toSpawnInput(prepared) {
      const artifactRef = prepared.call.arguments.traceArtifactRef
      assertArtifactRef(artifactRef, prepared, 'trace')
      const title = optionalNonEmptyString(prepared.call.arguments.title) ?? 'Summarize immutable trace artifact'
      return {
        kind: 'trace_summarization',
        title,
        inputs: [{ kind: 'trace_artifact', artifactRef: clone(artifactRef) }],
        idempotencyKey: `background:trace_summarization:${artifactRef.artifactId}:${artifactRef.sha256}`,
        completionRequirement: { requiredForCompletion: false, terminalPolicy: 'does_not_block' },
        actionBinding: clone(artifactRef.actionBinding),
      }
    },
  }
}

function validatePreparedCall(prepared: PreparedToolCallV1): void {
  if (prepared.schemaVersion !== 'prepared-tool-call/v1'
    || prepared.call.id !== prepared.context.toolCallId
    || prepared.context.sessionId.trim() === ''
    || prepared.context.runId.trim() === '') {
    throw bridgeError('BACKGROUND_NOT_ELIGIBLE', 'Background start requires a valid, current prepared-tool-call/v1.')
  }
  const policy = prepared.executionPolicy
  if (policy.schemaVersion !== 'tool-execution-policy/v1' || policy.background !== 'eligible') {
    throw bridgeError('BACKGROUND_NOT_ELIGIBLE', `Tool ${prepared.call.name} is not explicitly background eligible.`)
  }
  if (policy.resource !== 'none' || policy.resourceKey !== undefined) {
    throw bridgeError('BACKGROUND_RESOURCE_FORBIDDEN', `Tool ${prepared.call.name} holds forbidden resource ${policy.resource}.`)
  }
  if (prepared.call.name.startsWith('browser_') || FORBIDDEN_CONTROL_TOOLS.has(prepared.call.name)) {
    throw bridgeError('BACKGROUND_RESOURCE_FORBIDDEN', `Tool ${prepared.call.name} cannot be dispatched through the background bridge.`)
  }
  assertCloneableJson(prepared.call.arguments, 'tool arguments')
  assertNoDomRefStrings(prepared.call.arguments)
}

function validateSpawnInput(input: AsyncTaskSpawnInput, mapping: BackgroundToolTaskMappingV1): void {
  if (!isPlainRecord(input)) {
    throw bridgeError('BACKGROUND_INPUT_NOT_CLONEABLE', 'Mapped spawn input must be a plain structured object.')
  }
  for (const key of Object.keys(input)) {
    if (!SPAWN_INPUT_KEYS.has(key)) {
      throw bridgeError('BACKGROUND_INPUT_NOT_CLONEABLE', `Mapped spawn input contains non-contract field ${key}.`)
    }
  }
  if (input.kind !== mapping.taskKind) {
    throw bridgeError('BACKGROUND_TASK_KIND_FORBIDDEN', `Mapping ${mapping.toolName} cannot select task kind ${input.kind}.`)
  }
  validateTaskKind(input.kind)
  if (!optionalNonEmptyString(input.title) || !optionalNonEmptyString(input.idempotencyKey)) {
    throw bridgeError('BACKGROUND_INPUT_NOT_CLONEABLE', 'Mapped title and idempotencyKey must be non-empty strings.')
  }
  for (const taskInput of input.inputs ?? []) validateTaskInput(taskInput)
  assertCloneableJson(input, 'mapped spawn input')
}

function validateTaskInput(input: AgentTaskInput): void {
  if (!isPlainRecord(input)) {
    throw bridgeError('BACKGROUND_INPUT_NOT_CLONEABLE', 'Task inputs must be plain structured records.')
  }
  if (input.kind === 'goal' || input.kind === 'workflow_state') {
    assertJsonValue(input.structuredValue, `structured ${input.kind} input`)
    return
  }
  assertArtifactRef(input.artifactRef)
}

function validateTaskKind(kind: BackgroundAgentTaskKind): void {
  if (!ALLOWED_BACKGROUND_TASK_KINDS.has(kind)) {
    throw bridgeError('BACKGROUND_TASK_KIND_FORBIDDEN', `Task kind ${kind} is not allowed through BackgroundToolBridge v1.`)
  }
}

function validateSpawnedTask(task: AgentTask, mapping: BackgroundToolTaskMappingV1): void {
  if (!task.id.trim() || task.kind !== mapping.taskKind) {
    throw bridgeError('BACKGROUND_RUNTIME_UNAVAILABLE', 'Async task runtime returned an inconsistent task resolution.')
  }
}

function assertArtifactRef(
  value: unknown,
  prepared?: PreparedToolCallV1,
  expectedKind?: ImmutableArtifactRef['artifactKind'],
): asserts value is ImmutableArtifactRef {
  if (!isPlainRecord(value)
    || value.schemaVersion !== 'immutable-artifact-ref/v1'
    || value.immutable !== true
    || value.storage === null
    || !isPlainRecord(value.storage)
    || value.storage.store !== 'session_artifacts'
    || !Array.isArray(value.storage.relativeSegments)
    || value.storage.relativeSegments.length === 0
    || value.storage.relativeSegments.some((part) => typeof part !== 'string' || !part || part === '.' || part === '..' || part.includes('/'))
    || typeof value.artifactId !== 'string'
    || !value.artifactId.trim()
    || typeof value.sha256 !== 'string'
    || !/^[a-f0-9]{64}$/i.test(value.sha256)
    || typeof value.byteLength !== 'number'
    || !Number.isSafeInteger(value.byteLength)
    || value.byteLength < 0
    || (expectedKind !== undefined && value.artifactKind !== expectedKind)
    || (prepared !== undefined && (value.sessionId !== prepared.context.sessionId || value.runId !== prepared.context.runId))) {
    throw bridgeError('BACKGROUND_INPUT_NOT_IMMUTABLE', 'Background artifact input must be an immutable, integral, same-session artifact ref.')
  }
}

function assertCloneableJson(value: unknown, label: string): void {
  try {
    assertJsonValue(value, label)
    structuredClone(value)
  } catch (error) {
    if (error instanceof BackgroundToolBridgeError) throw error
    throw bridgeError('BACKGROUND_INPUT_NOT_CLONEABLE', `${label} is not structured-cloneable JSON: ${safeErrorMessage(error)}.`)
  }
}

function assertJsonValue(value: unknown, label: string, seen = new Set<object>()): asserts value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number' && Number.isFinite(value)) return
  if (typeof value !== 'object') {
    throw bridgeError('BACKGROUND_INPUT_NOT_CLONEABLE', `${label} contains a non-JSON value.`)
  }
  if (seen.has(value)) throw bridgeError('BACKGROUND_INPUT_NOT_CLONEABLE', `${label} contains a cycle.`)
  if (!Array.isArray(value) && !isPlainRecord(value)) {
    throw bridgeError('BACKGROUND_INPUT_NOT_CLONEABLE', `${label} contains a live or mutable runtime object.`)
  }
  seen.add(value)
  if (Array.isArray(value)) {
    for (const item of value) assertJsonValue(item, label, seen)
  } else {
    for (const item of Object.values(value)) assertJsonValue(item, label, seen)
  }
  seen.delete(value)
}

function assertNoDomRefStrings(value: unknown, path = 'arguments'): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoDomRefStrings(item, `${path}[${index}]`))
    return
  }
  if (!isPlainRecord(value)) return
  for (const [key, nested] of Object.entries(value)) {
    if (typeof nested === 'string' && /^(domRef|elementRef|freshnessRef|snapshotRef|selectorRef)$/i.test(key)) {
      throw bridgeError('BACKGROUND_RESOURCE_FORBIDDEN', `Live DOM/freshness reference at ${path}.${key} is forbidden.`)
    }
    assertNoDomRefStrings(nested, `${path}.${key}`)
  }
}

function mapRuntimeError(error: unknown): BackgroundToolBridgeError {
  const taskContractError = extractTaskContractError(error)
  if (taskContractError?.code === 'SESSION_ABORTED') {
    return new BackgroundToolBridgeError('SESSION_ABORTED', taskContractError.message, false, taskContractError)
  }
  if (taskContractError?.code === 'IDEMPOTENCY_CONFLICT') {
    return new BackgroundToolBridgeError('BACKGROUND_IDEMPOTENCY_CONFLICT', taskContractError.message, false, taskContractError)
  }
  return new BackgroundToolBridgeError(
    'BACKGROUND_RUNTIME_UNAVAILABLE',
    taskContractError?.message ?? `Async task runtime rejected background start: ${safeErrorMessage(error)}.`,
    taskContractError?.retryDisposition === 'retry_same_task',
    taskContractError,
  )
}

function extractTaskContractError(error: unknown): TaskContractError | undefined {
  if (error === null || typeof error !== 'object') return undefined
  const candidate = 'contractError' in error && isPlainRecord(error.contractError) ? error.contractError : error
  return 'schemaVersion' in candidate && candidate.schemaVersion === 'async-task-contract-error/v1'
    ? candidate as unknown as TaskContractError
    : undefined
}

function bridgeError(code: BackgroundToolBridgeErrorCodeV1, message: string): BackgroundToolBridgeError {
  return new BackgroundToolBridgeError(code, message, false)
}

function optionalNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function clone<T>(value: T): T { return structuredClone(value) }
