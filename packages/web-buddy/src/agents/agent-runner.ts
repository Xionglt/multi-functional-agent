import { createHash } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import type { SessionRecorder } from '../session/session-recorder.js'
import type { ToolSchema } from '../sdk/llm.js'
import type {
  ImmutableArtifactRef,
  JsonValue,
  ReadOnlyArtifactToolName,
} from './async-task-contracts.js'
import {
  assertReadOnlySubagentTask,
  type AddAgentTaskOutputInput,
  type AgentTask,
  type AgentTaskOutput,
} from './task-graph.js'
import { createSidechainSession, type SidechainSession } from './sidechain-session.js'

export type ReadOnlyArtifactKind = 'memory' | 'trace' | 'page_snapshot'

export const READ_ONLY_SUBAGENT_TOOL_NAMES = [
  'read_memory_artifact',
  'read_trace_artifact',
  'read_page_snapshot_artifact',
] as const

export const DISALLOWED_SUBAGENT_WRITE_TOOL_NAMES = [
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
] as const

export const CONTRACT_READ_ONLY_ARTIFACT_TOOL_NAMES = [
  'artifact_read_text',
  'artifact_read_json',
  'artifact_search_text',
  'artifact_list_refs',
] as const satisfies readonly ReadOnlyArtifactToolName[]

export interface ImmutableArtifactReader {
  read(ref: ImmutableArtifactRef): Promise<Uint8Array>
}

export interface ContractReadOnlyArtifactToolResult {
  toolCallId: string
  name: ReadOnlyArtifactToolName
  ok: true
  result: JsonValue
}

export class ContractReadOnlyArtifactToolError extends Error {
  constructor(
    readonly code: 'TOOL_DENIED' | 'ARTIFACT_NOT_READY' | 'ARTIFACT_INTEGRITY_FAILED',
    message: string,
  ) {
    super(message)
    this.name = 'ContractReadOnlyArtifactToolError'
  }
}

export class FileImmutableArtifactReader implements ImmutableArtifactReader {
  private readonly rootDir: string

  constructor(rootDir: string) {
    this.rootDir = resolve(rootDir)
  }

  async read(ref: ImmutableArtifactRef): Promise<Uint8Array> {
    assertImmutableArtifactRef(ref)
    const root = await realpath(this.rootDir).catch(() => {
      throw new ContractReadOnlyArtifactToolError('ARTIFACT_NOT_READY', 'Session artifact root is not available.')
    })
    const candidate = resolve(root, ...ref.storage.relativeSegments)
    assertPathInsideRoot(root, candidate)
    const resolvedPath = await realpath(candidate).catch(() => {
      throw new ContractReadOnlyArtifactToolError('ARTIFACT_NOT_READY', `Artifact ${ref.artifactId} is not available.`)
    })
    assertPathInsideRoot(root, resolvedPath)
    const bytes = await readFile(resolvedPath)
    const digest = createHash('sha256').update(bytes).digest('hex')
    if (bytes.byteLength !== ref.byteLength || digest !== ref.sha256) {
      throw new ContractReadOnlyArtifactToolError(
        'ARTIFACT_INTEGRITY_FAILED',
        `Artifact integrity verification failed for ${ref.artifactId}.`,
      )
    }
    return bytes
  }
}

export function readOnlySubagentToolSchemas(
  allowedTools: readonly ReadOnlyArtifactToolName[] = CONTRACT_READ_ONLY_ARTIFACT_TOOL_NAMES,
): ToolSchema[] {
  const allowed = new Set(allowedTools)
  return CONTRACT_READ_ONLY_ARTIFACT_TOOL_NAMES
    .filter((name) => allowed.has(name))
    .map((name) => toolSchemaFor(name))
}

export async function executeContractReadOnlyArtifactTool(input: {
  call: ReadOnlySubagentToolCall
  allowedTools: readonly ReadOnlyArtifactToolName[]
  artifacts: readonly ImmutableArtifactRef[]
  reader: ImmutableArtifactReader
}): Promise<ContractReadOnlyArtifactToolResult> {
  if (!isContractReadOnlyArtifactToolName(input.call.name) || !input.allowedTools.includes(input.call.name)) {
    throw new ContractReadOnlyArtifactToolError(
      'TOOL_DENIED',
      readOnlyToolDeniedMessage(input.call.name),
    )
  }

  const name = input.call.name
  const toolCallId = input.call.id ?? name
  if (name === 'artifact_list_refs') {
    return {
      toolCallId,
      name,
      ok: true,
      result: {
        artifacts: input.artifacts.map((ref) => ({
          artifactId: ref.artifactId,
          artifactKind: ref.artifactKind,
          mediaType: ref.mediaType,
          byteLength: ref.byteLength,
          actionBinding: ref.actionBinding,
        })),
      },
    }
  }

  const artifactId = requiredStringArgument(input.call, 'artifactId')
  const ref = input.artifacts.find((candidate) => candidate.artifactId === artifactId)
  if (!ref) {
    throw new ContractReadOnlyArtifactToolError(
      'TOOL_DENIED',
      `Artifact ${artifactId} is not selected in this task context envelope.`,
    )
  }
  const bytes = await input.reader.read(ref)
  const text = Buffer.from(bytes).toString('utf8')

  if (name === 'artifact_read_text') {
    return { toolCallId, name, ok: true, result: { artifactId, text } }
  }
  if (name === 'artifact_read_json') {
    try {
      return { toolCallId, name, ok: true, result: { artifactId, value: JSON.parse(text) as JsonValue } }
    } catch {
      throw new ContractReadOnlyArtifactToolError(
        'ARTIFACT_INTEGRITY_FAILED',
        `Artifact ${artifactId} is not valid JSON.`,
      )
    }
  }

  const query = requiredStringArgument(input.call, 'query')
  const requestedMax = input.call.arguments?.maxMatches
  const maxMatches = typeof requestedMax === 'number' && Number.isInteger(requestedMax)
    ? Math.max(1, Math.min(requestedMax, 50))
    : 20
  const normalizedQuery = query.toLocaleLowerCase()
  const matches = text
    .split(/\r?\n/)
    .map((line, index) => ({ lineNumber: index + 1, text: line }))
    .filter((entry) => entry.text.toLocaleLowerCase().includes(normalizedQuery))
    .slice(0, maxMatches)
  return { toolCallId, name, ok: true, result: { artifactId, query, matches } }
}

export interface ReadOnlyArtifact {
  kind: ReadOnlyArtifactKind
  ref: string
  value: unknown
  summary?: string
}

export interface ReadOnlySubagentToolCall {
  id?: string
  name: string
  arguments?: Record<string, unknown>
}

export interface ReadOnlySubagentToolResult {
  toolCallId: string
  name: string
  ok: boolean
  result?: unknown
  error?: string
}

export interface ReadOnlySubagentDraft {
  summary: string
  outputs?: AddAgentTaskOutputInput[]
}

export interface ReadOnlySubagentHandlerContext {
  task: AgentTask
  artifacts: ReadOnlyArtifact[]
  sidechain: SidechainSession
  readArtifact(kind: ReadOnlyArtifactKind, ref?: string): ReadOnlyArtifact[]
  callTool(call: ReadOnlySubagentToolCall): Promise<ReadOnlySubagentToolResult>
  note(message: string, data?: Record<string, unknown>): Promise<void>
}

export interface RunReadOnlySubagentInput {
  task: AgentTask
  runId: string
  sessionId: string
  outputDir: string
  artifacts: ReadOnlyArtifact[]
  mainSession?: SessionRecorder
  agentId?: string
  turnId?: string
  toolCalls?: ReadOnlySubagentToolCall[]
  handler?: (context: ReadOnlySubagentHandlerContext) => Promise<ReadOnlySubagentDraft>
  now?: () => Date
}

export interface ReadOnlySubagentRunResult {
  status: 'completed' | 'failed'
  taskId: string
  taskKind: AgentTask['kind']
  sidechainId: string
  agentId: string
  sidechainTranscriptPath: string
  summary: string
  outputs: AgentTaskOutput[]
  toolResults: ReadOnlySubagentToolResult[]
  error?: string
  requiresMainWorkflowVerification: true
  authoritativeCompletionEvidence: false
}

export class ReadOnlySubagentToolError extends Error {
  readonly code = 'READ_ONLY_SUBAGENT_TOOL_DENIED'

  constructor(toolName: string) {
    super(readOnlyToolDeniedMessage(toolName))
    this.name = 'ReadOnlySubagentToolError'
  }
}

export async function runReadOnlySubagent(input: RunReadOnlySubagentInput): Promise<ReadOnlySubagentRunResult> {
  assertReadOnlySubagentTask(input.task)

  const sidechain = await createSidechainSession({
    taskId: input.task.id,
    agentId: input.agentId,
    runId: input.runId,
    sessionId: input.sessionId,
    outputDir: input.outputDir,
    mainSession: input.mainSession,
    now: input.now,
  })
  const toolResults: ReadOnlySubagentToolResult[] = []

  await sidechain.append({
    type: 'sidechain_started',
    message: `Read-only sidechain started for ${input.task.kind}.`,
    data: {
      taskId: input.task.id,
      taskKind: input.task.kind,
      accessMode: input.task.accessMode,
      artifactRefs: input.artifacts.map((artifact) => ({ kind: artifact.kind, ref: artifact.ref })),
      allowedTools: [...READ_ONLY_SUBAGENT_TOOL_NAMES],
      disallowedWriteTools: [...DISALLOWED_SUBAGENT_WRITE_TOOL_NAMES],
    },
  })

  const callTool = async (call: ReadOnlySubagentToolCall): Promise<ReadOnlySubagentToolResult> => {
    await sidechain.append({
      type: 'sidechain_tool_call',
      message: call.name,
      data: { toolCallId: call.id ?? call.name, name: call.name, arguments: call.arguments ?? {} },
    })

    try {
      const result = executeReadOnlySubagentTool(call, input.artifacts)
      const toolResult: ReadOnlySubagentToolResult = {
        toolCallId: call.id ?? call.name,
        name: call.name,
        ok: true,
        result,
      }
      toolResults.push(toolResult)
      await sidechain.append({
        type: 'sidechain_tool_result',
        message: `${call.name} completed.`,
        data: { toolCallId: toolResult.toolCallId, name: call.name, ok: true, result },
      })
      return toolResult
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const toolResult: ReadOnlySubagentToolResult = {
        toolCallId: call.id ?? call.name,
        name: call.name,
        ok: false,
        error: message,
      }
      toolResults.push(toolResult)
      await sidechain.append({
        type: 'sidechain_tool_result',
        message: `${call.name} denied.`,
        data: { toolCallId: toolResult.toolCallId, name: call.name, ok: false, error: message },
      })
      throw error
    }
  }

  try {
    for (const call of input.toolCalls ?? []) await callTool(call)

    const context: ReadOnlySubagentHandlerContext = {
      task: input.task,
      artifacts: input.artifacts.map(cloneArtifact),
      sidechain,
      readArtifact: (kind, ref) => filterArtifacts(input.artifacts, kind, ref).map(cloneArtifact),
      callTool,
      note: (message, data) => sidechain.append({
        type: 'sidechain_note',
        message,
        ...(data ? { data } : {}),
      }),
    }
    const draft = input.handler
      ? await input.handler(context)
      : defaultReadOnlySubagentDraft(input.task, input.artifacts, toolResults)
    const outputs = normalizeReadOnlyOutputs(draft.outputs ?? defaultOutputsForTask(input.task, input.artifacts), input.task)
    const summary = draft.summary.trim() || defaultSummaryForTask(input.task, input.artifacts)

    await sidechain.append({
      type: 'sidechain_completed',
      message: summary,
      data: {
        outputs,
        requiresMainWorkflowVerification: true,
        authoritativeCompletionEvidence: false,
      },
    })
    await sidechain.recordMainSummary({
      status: 'completed',
      taskKind: input.task.kind,
      summary,
      outputs,
      ...(input.turnId ? { turnId: input.turnId } : {}),
    })

    return {
      status: 'completed',
      taskId: input.task.id,
      taskKind: input.task.kind,
      sidechainId: sidechain.sidechainId,
      agentId: sidechain.agentId,
      sidechainTranscriptPath: sidechain.transcriptPath,
      summary,
      outputs,
      toolResults,
      requiresMainWorkflowVerification: true,
      authoritativeCompletionEvidence: false,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const summary = `Read-only sidechain failed: ${message}`
    await sidechain.append({
      type: 'sidechain_failed',
      message: summary,
      data: {
        error: message,
        requiresMainWorkflowVerification: true,
        authoritativeCompletionEvidence: false,
      },
    })
    await sidechain.recordMainSummary({
      status: 'failed',
      taskKind: input.task.kind,
      summary,
      outputs: [],
      ...(input.turnId ? { turnId: input.turnId } : {}),
    })

    return {
      status: 'failed',
      taskId: input.task.id,
      taskKind: input.task.kind,
      sidechainId: sidechain.sidechainId,
      agentId: sidechain.agentId,
      sidechainTranscriptPath: sidechain.transcriptPath,
      summary,
      outputs: [],
      toolResults,
      error: message,
      requiresMainWorkflowVerification: true,
      authoritativeCompletionEvidence: false,
    }
  }
}

export function executeReadOnlySubagentTool(
  call: ReadOnlySubagentToolCall,
  artifacts: ReadOnlyArtifact[],
): { artifacts: ReadOnlyArtifact[]; observation: string } {
  const name = call.name
  if (!isReadOnlySubagentToolName(name)) throw new ReadOnlySubagentToolError(name)

  const kind = artifactKindForTool(name)
  const ref = typeof call.arguments?.ref === 'string' ? call.arguments.ref : undefined
  const selected = filterArtifacts(artifacts, kind, ref).map(cloneArtifact)
  return {
    artifacts: selected,
    observation: `${name} returned ${selected.length} ${kind} artifact(s).`,
  }
}

export function isReadOnlySubagentToolName(name: string): name is typeof READ_ONLY_SUBAGENT_TOOL_NAMES[number] {
  return READ_ONLY_SUBAGENT_TOOL_NAMES.includes(name as typeof READ_ONLY_SUBAGENT_TOOL_NAMES[number])
}

export function isSubagentWriteToolName(name: string): boolean {
  return DISALLOWED_SUBAGENT_WRITE_TOOL_NAMES.includes(name as typeof DISALLOWED_SUBAGENT_WRITE_TOOL_NAMES[number])
    || name.startsWith('browser_')
}

function readOnlyToolDeniedMessage(toolName: string): string {
  if (isSubagentWriteToolName(toolName)) {
    return `Read-only subagents cannot execute browser/write/completion tools (${toolName}); they may only read memory, trace, and page snapshot artifacts.`
  }
  return `Tool ${toolName} is not available to read-only subagents; allowed tools are ${READ_ONLY_SUBAGENT_TOOL_NAMES.join(', ')}.`
}

function defaultReadOnlySubagentDraft(
  task: AgentTask,
  artifacts: ReadOnlyArtifact[],
  toolResults: ReadOnlySubagentToolResult[],
): ReadOnlySubagentDraft {
  return {
    summary: defaultSummaryForTask(task, artifacts),
    outputs: defaultOutputsForTask(task, artifacts, toolResults),
  }
}

function defaultSummaryForTask(task: AgentTask, artifacts: ReadOnlyArtifact[]): string {
  const counts = countArtifactsByKind(artifacts)
  if (task.kind === 'candidate_job_research') {
    return `Read-only candidate job research inspected ${counts.page_snapshot} page snapshot artifact(s), ${counts.memory} memory artifact(s), and ${counts.trace} trace artifact(s).`
  }
  if (task.kind === 'trace_summarization') {
    return `Read-only trace summarization inspected ${counts.trace} trace artifact(s).`
  }
  if (task.kind === 'memory_retrieval') {
    return `Read-only memory retrieval inspected ${counts.memory} memory artifact(s).`
  }
  return `Read-only sidechain inspected ${artifacts.length} artifact(s).`
}

function defaultOutputsForTask(
  task: AgentTask,
  artifacts: ReadOnlyArtifact[],
  toolResults: ReadOnlySubagentToolResult[] = [],
): AddAgentTaskOutputInput[] {
  if (task.kind === 'candidate_job_research') {
    return [{
      kind: 'candidate_jobs',
      value: {
        artifactRefs: artifacts.map((artifact) => artifact.ref),
        candidates: extractCandidateHints(artifacts),
        toolResultCount: toolResults.length,
      },
    }]
  }
  if (task.kind === 'trace_summarization') {
    return [{
      kind: 'trace_summary',
      value: {
        artifactRefs: artifacts.filter((artifact) => artifact.kind === 'trace').map((artifact) => artifact.ref),
        summaries: artifacts.filter((artifact) => artifact.kind === 'trace').map((artifact) => artifact.summary ?? summarizeValue(artifact.value)),
        toolResultCount: toolResults.length,
      },
    }]
  }
  return [{
    kind: 'memory_result',
    value: {
      artifactRefs: artifacts.filter((artifact) => artifact.kind === 'memory').map((artifact) => artifact.ref),
      summaries: artifacts.filter((artifact) => artifact.kind === 'memory').map((artifact) => artifact.summary ?? summarizeValue(artifact.value)),
      toolResultCount: toolResults.length,
    },
  }]
}

function normalizeReadOnlyOutputs(outputs: AddAgentTaskOutputInput[], task: AgentTask): AgentTaskOutput[] {
  return outputs.map((output) => {
    if (output.authoritativeCompletionEvidence) {
      throw new Error(`Read-only task ${task.id} cannot emit authoritative completion evidence.`)
    }
    if (output.requiresMainWorkflowVerification === false) {
      throw new Error(`Read-only task ${task.id} output must require main workflow verification.`)
    }
    return {
      kind: output.kind,
      ...(output.ref ? { ref: output.ref } : {}),
      ...(output.value !== undefined ? { value: output.value } : {}),
      appendToMainTranscript: output.appendToMainTranscript ?? false,
      requiresMainWorkflowVerification: true,
      authoritativeCompletionEvidence: false,
    }
  })
}

function artifactKindForTool(toolName: typeof READ_ONLY_SUBAGENT_TOOL_NAMES[number]): ReadOnlyArtifactKind {
  if (toolName === 'read_memory_artifact') return 'memory'
  if (toolName === 'read_trace_artifact') return 'trace'
  return 'page_snapshot'
}

function filterArtifacts(artifacts: ReadOnlyArtifact[], kind: ReadOnlyArtifactKind, ref?: string): ReadOnlyArtifact[] {
  return artifacts.filter((artifact) => artifact.kind === kind && (!ref || artifact.ref === ref))
}

function countArtifactsByKind(artifacts: ReadOnlyArtifact[]): Record<ReadOnlyArtifactKind, number> {
  return {
    memory: artifacts.filter((artifact) => artifact.kind === 'memory').length,
    trace: artifacts.filter((artifact) => artifact.kind === 'trace').length,
    page_snapshot: artifacts.filter((artifact) => artifact.kind === 'page_snapshot').length,
  }
}

function extractCandidateHints(artifacts: ReadOnlyArtifact[]): unknown[] {
  const values = artifacts
    .filter((artifact) => artifact.kind === 'page_snapshot' || artifact.kind === 'memory')
    .flatMap((artifact) => candidateHintsFromValue(artifact.value))
  return values.slice(0, 20)
}

function candidateHintsFromValue(value: unknown): unknown[] {
  if (!value || typeof value !== 'object') return []
  if (Array.isArray(value)) return value.flatMap(candidateHintsFromValue)
  const record = value as Record<string, unknown>
  if (Array.isArray(record.candidates)) return record.candidates
  if (Array.isArray(record.jobs)) return record.jobs
  if (Array.isArray(record.items)) return record.items
  return []
}

function summarizeValue(value: unknown): string {
  if (typeof value === 'string') return truncate(value.replace(/\s+/g, ' ').trim(), 240)
  if (!value || typeof value !== 'object') return String(value ?? '')
  if (Array.isArray(value)) return `array(${value.length})`
  return `object(${Object.keys(value as Record<string, unknown>).slice(0, 8).join(', ')})`
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}...` : value
}

function cloneArtifact(artifact: ReadOnlyArtifact): ReadOnlyArtifact {
  return {
    ...artifact,
    value: cloneValue(artifact.value),
  }
}

function cloneValue(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(cloneValue)
  const clone: Record<string, unknown> = {}
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    clone[key] = cloneValue(nested)
  }
  return clone
}

function isContractReadOnlyArtifactToolName(name: string): name is ReadOnlyArtifactToolName {
  return CONTRACT_READ_ONLY_ARTIFACT_TOOL_NAMES.includes(name as ReadOnlyArtifactToolName)
}

function requiredStringArgument(call: ReadOnlySubagentToolCall, name: string): string {
  const value = call.arguments?.[name]
  if (typeof value !== 'string' || !value.trim()) {
    throw new ContractReadOnlyArtifactToolError('TOOL_DENIED', `${call.name} requires a non-empty ${name}.`)
  }
  return value
}

function assertImmutableArtifactRef(ref: ImmutableArtifactRef): void {
  if (ref.schemaVersion !== 'immutable-artifact-ref/v1' || ref.immutable !== true) {
    throw new ContractReadOnlyArtifactToolError('ARTIFACT_INTEGRITY_FAILED', 'Artifact ref is not immutable.')
  }
  if (ref.storage.store !== 'session_artifacts' || ref.storage.relativeSegments.length === 0) {
    throw new ContractReadOnlyArtifactToolError('ARTIFACT_INTEGRITY_FAILED', 'Artifact ref has invalid storage metadata.')
  }
  if (ref.storage.relativeSegments.some((segment) => (
    !segment
    || segment === '.'
    || segment === '..'
    || segment.includes('/')
    || segment.includes('\\')
  ))) {
    throw new ContractReadOnlyArtifactToolError('ARTIFACT_INTEGRITY_FAILED', 'Artifact ref contains unsafe path segments.')
  }
  if (!Number.isSafeInteger(ref.byteLength) || ref.byteLength < 0 || !/^[a-f0-9]{64}$/i.test(ref.sha256)) {
    throw new ContractReadOnlyArtifactToolError('ARTIFACT_INTEGRITY_FAILED', 'Artifact ref has invalid integrity metadata.')
  }
}

function assertPathInsideRoot(root: string, candidate: string): void {
  if (candidate === root || candidate.startsWith(`${root}${sep}`)) return
  throw new ContractReadOnlyArtifactToolError('ARTIFACT_INTEGRITY_FAILED', 'Artifact path escapes the session artifact root.')
}

function toolSchemaFor(name: ReadOnlyArtifactToolName): ToolSchema {
  if (name === 'artifact_list_refs') {
    return {
      type: 'function',
      function: {
        name,
        description: 'List immutable artifacts selected in this task context envelope.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
      },
    }
  }
  if (name === 'artifact_search_text') {
    return {
      type: 'function',
      function: {
        name,
        description: 'Search text inside one selected immutable artifact without accessing a live page.',
        parameters: {
          type: 'object',
          properties: {
            artifactId: { type: 'string' },
            query: { type: 'string' },
            maxMatches: { type: 'integer', minimum: 1, maximum: 50 },
          },
          required: ['artifactId', 'query'],
          additionalProperties: false,
        },
      },
    }
  }
  return {
    type: 'function',
    function: {
      name,
      description: name === 'artifact_read_json'
        ? 'Read one selected immutable JSON artifact.'
        : 'Read one selected immutable text artifact.',
      parameters: {
        type: 'object',
        properties: { artifactId: { type: 'string' } },
        required: ['artifactId'],
        additionalProperties: false,
      },
    },
  }
}
