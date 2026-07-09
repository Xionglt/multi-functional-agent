import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { SessionRecorder } from '../session/session-recorder.js'
import { appendJsonLine } from '../session/transcript.js'

export type SidechainTranscriptEntryType =
  | 'sidechain_started'
  | 'sidechain_note'
  | 'sidechain_tool_call'
  | 'sidechain_tool_result'
  | 'sidechain_completed'
  | 'sidechain_failed'

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
  recordMainSummary(input: RecordSidechainSummaryInput): Promise<void>
}

export async function createSidechainSession(input: CreateSidechainSessionInput): Promise<SidechainSession> {
  const sidechainId = `sidechain_${randomUUID()}`
  const agentId = input.agentId ?? `agent_${randomUUID().slice(0, 8)}`
  const transcriptPath = input.transcriptPath
    ?? join(input.outputDir, 'sidechains', `${sanitizePathPart(input.taskId)}-${sanitizePathPart(sidechainId)}.jsonl`)
  const now = () => (input.now?.() ?? new Date()).toISOString()

  await mkdir(dirname(transcriptPath), { recursive: true })
  await writeFile(transcriptPath, '', { flag: 'a' })

  const append: SidechainSession['append'] = async (entry) => {
    await appendJsonLine(transcriptPath, {
      version: 1,
      sidechainId,
      taskId: input.taskId,
      agentId,
      ts: now(),
      ...entry,
    } satisfies SidechainTranscriptEntry)
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
    recordMainSummary,
  }
}

function sanitizePathPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]+/g, '_').replace(/^_+|_+$/g, '') || 'sidechain'
}

function sanitizeEvidenceId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'evidence'
}
