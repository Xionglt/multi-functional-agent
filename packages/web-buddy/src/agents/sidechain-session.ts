import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, relative, sep, join } from 'node:path'
import type { SessionRecorder } from '../session/session-recorder.js'
import { appendJsonLine } from '../session/transcript.js'
import type {
  ActionBinding,
  ImmutableArtifactRef,
  RunnerProgress,
} from './async-task-contracts.js'

export type SidechainTranscriptEntryType =
  | 'sidechain_started'
  | 'sidechain_context_envelope'
  | 'sidechain_progress'
  | 'sidechain_assistant'
  | 'sidechain_note'
  | 'sidechain_tool_call'
  | 'sidechain_tool_result'
  | 'sidechain_completed'
  | 'sidechain_failed'
  | 'sidechain_aborted'

export interface SidechainTranscriptEntry {
  version: 1
  sidechainId: string
  taskId: string
  agentId: string
  ts: string
  type: SidechainTranscriptEntryType
  message?: string
  data?: Record<string, unknown>
}

export interface CreateSidechainSessionInput {
  taskId: string
  agentId?: string
  runId: string
  sessionId: string
  outputDir: string
  transcriptPath?: string
  mainSession?: SessionRecorder
  now?: () => Date
}

export interface RecordSidechainSummaryInput {
  status: 'completed' | 'failed' | 'blocked' | 'killed'
  summary: string
  taskKind: string
  outputs?: unknown[]
  turnId?: string
}

export interface SidechainSession {
  sidechainId: string
  taskId: string
  agentId: string
  transcriptPath: string
  append(entry: Omit<SidechainTranscriptEntry, 'version' | 'sidechainId' | 'taskId' | 'agentId' | 'ts'>): Promise<void>
  recordProgress(progress: RunnerProgress): Promise<void>
  finalizeTranscript(actionBinding: ActionBinding): Promise<ImmutableArtifactRef<'sidechain_transcript'>>
  recordMainSummary(input: RecordSidechainSummaryInput): Promise<void>
}

export async function createSidechainSession(input: CreateSidechainSessionInput): Promise<SidechainSession> {
  const sidechainId = `sidechain_${randomUUID()}`
  const agentId = input.agentId ?? `agent_${randomUUID().slice(0, 8)}`
  const transcriptPath = input.transcriptPath
    ?? join(input.outputDir, 'sidechains', `${sanitizePathPart(input.taskId)}-${sanitizePathPart(sidechainId)}.jsonl`)
  const now = () => (input.now?.() ?? new Date()).toISOString()
  let finalizedRef: ImmutableArtifactRef<'sidechain_transcript'> | undefined

  await mkdir(dirname(transcriptPath), { recursive: true })
  await writeFile(transcriptPath, '', { flag: 'a' })

  const append: SidechainSession['append'] = async (entry) => {
    if (finalizedRef) throw new Error(`Sidechain transcript is already finalized: ${transcriptPath}`)
    await appendJsonLine(transcriptPath, {
      version: 1,
      sidechainId,
      taskId: input.taskId,
      agentId,
      ts: now(),
      ...entry,
    } satisfies SidechainTranscriptEntry)
  }

  const recordProgress: SidechainSession['recordProgress'] = async (progress) => {
    await append({
      type: 'sidechain_progress',
      message: progress.summary,
      data: {
        schemaVersion: progress.schemaVersion,
        runIdentity: progress.runIdentity,
        progressSeq: progress.progressSeq,
        phase: progress.phase,
        occurredAt: progress.occurredAt,
        authoritativeCompletionEvidence: false,
      },
    })
  }

  const finalizeTranscript: SidechainSession['finalizeTranscript'] = async (actionBinding) => {
    if (finalizedRef) return finalizedRef
    const bytes = await readFile(transcriptPath)
    const relativePath = relative(input.outputDir, transcriptPath)
    if (!relativePath || relativePath === '..' || relativePath.startsWith(`..${sep}`)) {
      throw new Error('Sidechain transcript must remain inside the session artifact root.')
    }
    const relativeSegments = relativePath.split(sep)
    if (relativeSegments.some((segment) => !segment || segment === '.' || segment === '..')) {
      throw new Error('Sidechain transcript has invalid relative storage segments.')
    }
    finalizedRef = {
      schemaVersion: 'immutable-artifact-ref/v1',
      artifactId: `artifact_${sidechainId}`,
      artifactKind: 'sidechain_transcript',
      runId: input.runId,
      sessionId: input.sessionId,
      storage: {
        store: 'session_artifacts',
        relativeSegments,
      },
      mediaType: 'application/x-ndjson',
      byteLength: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      createdAt: now(),
      actionBinding,
      immutable: true,
    }
    return finalizedRef
  }

  const recordMainSummary: SidechainSession['recordMainSummary'] = async (summaryInput) => {
    if (!input.mainSession) return
    const evidence = {
      schemaVersion: 'workflow-evidence/v1',
      id: `sidechain_${sanitizeEvidenceId(input.taskId)}_${sanitizeEvidenceId(sidechainId)}`,
      kind: 'sidechain_summary',
      summary: summaryInput.summary,
      source: 'read_only_subagent',
      confidence: summaryInput.status === 'completed' ? 'medium' : 'low',
      ts: now(),
      phase: 'sidechain',
      sessionId: input.sessionId,
      runId: input.runId,
      ...(summaryInput.turnId ? { turnId: summaryInput.turnId } : {}),
      data: {
        status: summaryInput.status,
        taskId: input.taskId,
        taskKind: summaryInput.taskKind,
        sidechainId,
        agentId,
        sidechainTranscriptPath: transcriptPath,
        outputs: summaryInput.outputs ?? [],
        appendOnlyRawTranscript: true,
        requiresMainWorkflowVerification: true,
        authoritativeCompletionEvidence: false,
        note: 'Read-only subagent summary only. Main workflow must verify before completion.',
      },
    }

    const transcriptEntry: Parameters<SessionRecorder['transcript']>[0] = {
      type: 'workflow_evidence',
      ...(summaryInput.turnId ? { turnId: summaryInput.turnId } : {}),
      evidence,
    } as Parameters<SessionRecorder['transcript']>[0]
    await input.mainSession.transcript(transcriptEntry)
    await input.mainSession.event({
      type: 'workflow_evidence_recorded',
      ...(summaryInput.turnId ? { turnId: summaryInput.turnId } : {}),
      message: `Read-only sidechain ${summaryInput.status}: ${summaryInput.summary.slice(0, 160)}`,
      data: {
        evidenceId: evidence.id,
        kind: evidence.kind,
        taskId: input.taskId,
        sidechainId,
        sidechainTranscriptPath: transcriptPath,
        requiresMainWorkflowVerification: true,
        authoritativeCompletionEvidence: false,
      },
    })
  }

  return {
    sidechainId,
    taskId: input.taskId,
    agentId,
    transcriptPath,
    append,
    recordProgress,
    finalizeTranscript,
    recordMainSummary,
  }
}

function sanitizePathPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]+/g, '_').replace(/^_+|_+$/g, '') || 'sidechain'
}

function sanitizeEvidenceId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'evidence'
}
