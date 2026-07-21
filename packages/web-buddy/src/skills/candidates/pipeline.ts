import {
  assertProposedSkill,
  type SkillCandidateV1,
  type SkillGenerationReceiptV1,
  type SkillGenerationRequestV1,
  type ValidationFindingV1,
} from './contracts.js'
import { projectSkillEvidence } from './projector.js'
import {
  candidateIdForFingerprint,
  type FileSkillCandidateStore,
} from './store.js'
import type { SkillCandidateSynthesizer } from './synthesizer.js'
import {
  skillCandidateFingerprint,
  validateProposedSkill,
} from './validator.js'

export type SkillGenerationResult =
  | {
      status: 'generated' | 'duplicate'
      candidate: SkillCandidateV1
      receipt: SkillGenerationReceiptV1
    }
  | {
      status: 'ineligible' | 'rejected'
      findings: ValidationFindingV1[]
      receipt: SkillGenerationReceiptV1
    }

export async function processSkillGenerationRequest(input: {
  traceDir: string
  request: SkillGenerationRequestV1
  store: FileSkillCandidateStore
  synthesizer: SkillCandidateSynthesizer
  now?: () => Date
}): Promise<SkillGenerationResult> {
  const existingReceipt = await input.store.readReceipt(input.request.requestId)
  if (existingReceipt) return resultFromReceipt(existingReceipt, input.store)

  const projected = await projectSkillEvidence({
    traceDir: input.traceDir,
    request: input.request,
  })
  if (!projected.eligible) {
    const receipt = receiptFor(input.request, 'ineligible', projected.findings, input.now)
    return persistTerminalReceipt(input.store, receipt)
  }

  const proposed = await input.synthesizer.synthesize(projected.evidence)
  const validation = validateProposedSkill(proposed)
  if (validation.blockers.length > 0) {
    const findings = [...validation.blockers, ...validation.warnings]
    const receipt = receiptFor(input.request, 'rejected', findings, input.now)
    return persistTerminalReceipt(input.store, receipt)
  }
  assertProposedSkill(proposed)
  const fingerprint = skillCandidateFingerprint(proposed)
  const candidateId = candidateIdForFingerprint(fingerprint)
  const existingCandidate = await input.store.findCandidate(candidateId)
  if (existingCandidate) {
    if (existingCandidate.fingerprint !== fingerprint) throw new Error('CANDIDATE_ID_COLLISION')
    const receipt = receiptFor(
      input.request,
      'duplicate',
      validation.warnings,
      input.now,
      candidateId,
    )
    return persistCandidateReceipt(input.store, receipt, existingCandidate)
  }

  const createdAt = (input.now ?? (() => new Date()))().toISOString()
  const candidate: SkillCandidateV1 = {
    schemaVersion: 'skill-candidate/v1',
    candidateId,
    createdAt,
    proposedSkill: proposed,
    provenance: {
      requestId: input.request.requestId,
      runId: input.request.runId,
      revision: input.request.revision,
      sessionId: input.request.sessionId,
      attempt: input.request.attempt,
      outcomeArtifactId: input.request.outcomeArtifactId,
      traceSha256: projected.evidence.source.traceSha256,
      generatorId: input.synthesizer.id,
      generatorVersion: input.synthesizer.version,
    },
    evidenceSummary: projected.evidence,
    fingerprint,
    validation,
  }
  try {
    const written = await input.store.writeCandidate(candidate)
    if (!written.created) {
      const stored = await input.store.readCandidate(candidateId)
      const receipt = receiptFor(
        input.request,
        stored.provenance.requestId === input.request.requestId ? 'generated' : 'duplicate',
        validation.warnings,
        input.now,
        candidateId,
      )
      return persistCandidateReceipt(input.store, receipt, stored)
    }
  } catch (error) {
    if (!isCandidateConflict(error)) throw error
    const stored = await input.store.readCandidate(candidateId)
    if (stored.fingerprint !== fingerprint) throw new Error('CANDIDATE_ID_COLLISION')
    const receipt = receiptFor(
      input.request,
      'duplicate',
      validation.warnings,
      input.now,
      candidateId,
    )
    return persistCandidateReceipt(input.store, receipt, stored)
  }

  const receipt = receiptFor(
    input.request,
    'generated',
    validation.warnings,
    input.now,
    candidateId,
    createdAt,
  )
  return persistCandidateReceipt(input.store, receipt, candidate)
}

async function resultFromReceipt(
  receipt: SkillGenerationReceiptV1,
  store: FileSkillCandidateStore,
): Promise<SkillGenerationResult> {
  if (receipt.status === 'generated' || receipt.status === 'duplicate') {
    if (!receipt.candidateId) throw new Error('GENERATION_RECEIPT_MISSING_CANDIDATE')
    const candidate = await store.readCandidate(receipt.candidateId)
    return { status: receipt.status, candidate, receipt }
  }
  return { status: receipt.status, findings: receipt.findings, receipt }
}

async function persistTerminalReceipt(
  store: FileSkillCandidateStore,
  receipt: SkillGenerationReceiptV1,
): Promise<SkillGenerationResult> {
  try {
    await store.writeReceipt(receipt)
    return { status: receipt.status as 'ineligible' | 'rejected', findings: receipt.findings, receipt }
  } catch (error) {
    if (!isReceiptConflict(error)) throw error
    const existing = await store.readReceipt(receipt.requestId)
    if (!existing) throw error
    return resultFromReceipt(existing, store)
  }
}

async function persistCandidateReceipt(
  store: FileSkillCandidateStore,
  receipt: SkillGenerationReceiptV1,
  candidate: SkillCandidateV1,
): Promise<SkillGenerationResult> {
  try {
    await store.writeReceipt(receipt)
    return {
      status: receipt.status as 'generated' | 'duplicate',
      candidate,
      receipt,
    }
  } catch (error) {
    if (!isReceiptConflict(error)) throw error
    const existing = await store.readReceipt(receipt.requestId)
    if (!existing) throw error
    return resultFromReceipt(existing, store)
  }
}

function receiptFor(
  request: SkillGenerationRequestV1,
  status: SkillGenerationReceiptV1['status'],
  findings: ValidationFindingV1[],
  now: (() => Date) | undefined,
  candidateId?: string,
  processedAt?: string,
): SkillGenerationReceiptV1 {
  return {
    schemaVersion: 'skill-generation-receipt/v1',
    requestId: request.requestId,
    processedAt: processedAt ?? (now ?? (() => new Date()))().toISOString(),
    status,
    ...(candidateId ? { candidateId } : {}),
    findings,
  }
}

function isCandidateConflict(error: unknown): boolean {
  return error instanceof Error && error.message.includes('SKILL_CANDIDATE_CONFLICT')
}

function isReceiptConflict(error: unknown): boolean {
  return error instanceof Error && error.message.includes('GENERATION_RECEIPT_CONFLICT')
}
