import type { SessionRecorder } from '../session/session-recorder.js'
import {
  runReadOnlySubagent,
  type ReadOnlyArtifact,
  type ReadOnlyArtifactKind,
  type ReadOnlySubagentRunResult,
  type ReadOnlySubagentToolCall,
} from './agent-runner.js'
import {
  addAgentTask,
  completeAgentTask,
  createAgentTaskGraph,
  createReadOnlySubagentTask,
  failAgentTask,
  setAgentTaskSidechainTranscript,
  startAgentTask,
  type AddAgentTaskOutputInput,
  type AgentTask,
  type AgentTaskGraph,
  type AgentTaskInput,
} from './task-graph.js'

export type ReadOnlySubagentRuntimePilotKind = 'trace_summarization'

export interface RunReadOnlySubagentRuntimePilotInput {
  pilotKind?: ReadOnlySubagentRuntimePilotKind
  runId: string
  sessionId: string
  outputDir: string
  artifacts: ReadOnlyArtifact[]
  mainSession?: SessionRecorder
  graphId?: string
  taskId?: string
  agentId?: string
  turnId?: string
  now?: () => Date
}

export interface ReadOnlySubagentWorkflowEvidenceSummary {
  kind: 'sidechain_summary'
  source: 'read_only_subagent'
  taskKind: ReadOnlySubagentRuntimePilotKind
  taskId: string
  summary: string
  sidechainTranscriptPath: string
  requiresMainWorkflowVerification: true
  authoritativeCompletionEvidence: false
}

export interface ReadOnlySubagentRuntimePilotResult {
  pilotKind: ReadOnlySubagentRuntimePilotKind
  status: ReadOnlySubagentRunResult['status']
  graph: AgentTaskGraph
  task: AgentTask
  sidechain: ReadOnlySubagentRunResult
  workflowEvidenceSummary: ReadOnlySubagentWorkflowEvidenceSummary
}

const ALLOWED_RUNTIME_PILOT_ARTIFACT_KINDS = new Set<ReadOnlyArtifactKind>([
  'memory',
  'trace',
  'page_snapshot',
])

export async function runReadOnlySubagentRuntimePilot(
  input: RunReadOnlySubagentRuntimePilotInput,
): Promise<ReadOnlySubagentRuntimePilotResult> {
  const pilotKind = input.pilotKind ?? 'trace_summarization'
  const artifacts = input.artifacts.map(validateReadOnlyArtifact)
  const taskId = input.taskId ?? `${pilotKind}_pilot`
  const now = input.now?.().toISOString() ?? new Date().toISOString()

  assertPilotArtifacts(pilotKind, artifacts)

  let graph = createAgentTaskGraph({
    graphId: input.graphId,
    runId: input.runId,
    sessionId: input.sessionId,
    now,
  })
  const task = createReadOnlySubagentTask({
    id: taskId,
    kind: pilotKind,
    title: 'Summarize runtime trace artifacts without browser access',
    inputs: artifactTaskInputs(artifacts),
    now,
  })

  graph = addAgentTask(graph, task)
  graph = startAgentTask(graph, task.id, { now })

  const sidechain = await runReadOnlySubagent({
    task,
    runId: input.runId,
    sessionId: input.sessionId,
    outputDir: input.outputDir,
    artifacts,
    mainSession: input.mainSession,
    agentId: input.agentId,
    turnId: input.turnId,
    toolCalls: runtimePilotToolCalls(pilotKind, artifacts),
    now: input.now,
  })

  graph = setAgentTaskSidechainTranscript(graph, task.id, sidechain.sidechainTranscriptPath, currentIso(input.now))
  if (sidechain.status === 'completed') {
    graph = completeAgentTask(graph, task.id, runtimePilotTaskOutputs(sidechain), currentIso(input.now))
  } else {
    graph = failAgentTask(graph, task.id, sidechain.error ?? sidechain.summary, currentIso(input.now))
  }

  const completedTask = graph.tasks.find((candidate) => candidate.id === task.id)
  if (!completedTask) throw new Error(`Runtime pilot task disappeared from graph: ${task.id}`)

  return {
    pilotKind,
    status: sidechain.status,
    graph,
    task: completedTask,
    sidechain,
    workflowEvidenceSummary: {
      kind: 'sidechain_summary',
      source: 'read_only_subagent',
      taskKind: pilotKind,
      taskId: task.id,
      summary: sidechain.summary,
      sidechainTranscriptPath: sidechain.sidechainTranscriptPath,
      requiresMainWorkflowVerification: true,
      authoritativeCompletionEvidence: false,
    },
  }
}

function assertPilotArtifacts(
  pilotKind: ReadOnlySubagentRuntimePilotKind,
  artifacts: ReadOnlyArtifact[],
): void {
  if (pilotKind !== 'trace_summarization') {
    throw new Error(`Unsupported read-only runtime pilot: ${pilotKind}`)
  }

  if (!artifacts.some((artifact) => artifact.kind === 'trace')) {
    throw new Error('trace_summarization runtime pilot requires at least one trace artifact.')
  }
}

function validateReadOnlyArtifact(artifact: ReadOnlyArtifact): ReadOnlyArtifact {
  if (!ALLOWED_RUNTIME_PILOT_ARTIFACT_KINDS.has(artifact.kind)) {
    throw new Error(`Read-only runtime pilot cannot read ${artifact.kind} artifacts.`)
  }
  if (!artifact.ref) throw new Error('Read-only runtime pilot artifacts must include a ref.')
  return {
    ...artifact,
    value: cloneValue(artifact.value),
  }
}

function artifactTaskInputs(artifacts: ReadOnlyArtifact[]): AgentTaskInput[] {
  return artifacts.map((artifact) => ({
    kind: taskInputKindForArtifact(artifact.kind),
    ref: artifact.ref,
  }))
}

function taskInputKindForArtifact(kind: ReadOnlyArtifactKind): AgentTaskInput['kind'] {
  if (kind === 'memory') return 'memory_artifact'
  if (kind === 'trace') return 'trace_artifact'
  return 'page_snapshot_artifact'
}

function runtimePilotToolCalls(
  pilotKind: ReadOnlySubagentRuntimePilotKind,
  artifacts: ReadOnlyArtifact[],
): ReadOnlySubagentToolCall[] {
  if (pilotKind === 'trace_summarization') {
    return artifacts
      .filter((artifact) => artifact.kind === 'trace')
      .map((artifact, index) => ({
        id: `runtime-pilot-read-trace-${index + 1}`,
        name: 'read_trace_artifact',
        arguments: { ref: artifact.ref },
      }))
  }
  return []
}

function runtimePilotTaskOutputs(sidechain: ReadOnlySubagentRunResult): AddAgentTaskOutputInput[] {
  return [
    ...sidechain.outputs,
    {
      kind: 'transcript_ref',
      ref: sidechain.sidechainTranscriptPath,
      value: {
        sidechainId: sidechain.sidechainId,
        agentId: sidechain.agentId,
        status: sidechain.status,
      },
      appendToMainTranscript: true,
      requiresMainWorkflowVerification: true,
      authoritativeCompletionEvidence: false,
    },
  ]
}

function currentIso(now?: () => Date): string {
  return now?.().toISOString() ?? new Date().toISOString()
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
