import type { ArtifactRef, ContextItem, EvidenceRef, OwnerScope, TaskContract } from '../../task/contracts.js'
import type { ToolResultStore } from '../../tools/tool-result-store.js'

export interface ResultAssemblerInput {
  goal: string
  summary: string
  contract?: TaskContract
  contextItems: readonly ContextItem[]
  evidence: readonly EvidenceRef[]
  existingArtifacts: readonly ArtifactRef[]
  runId: string
  revision: number
  sessionId: string
  ownerScope?: OwnerScope
  store: ToolResultStore
  now?: () => Date
}
export interface CompletionArtifactMaterializer {
  id: string
  supports(input: {
    artifactKind: string
    payloadSchemaVersion: string
    contract: TaskContract
  }): boolean
  content(input: ResultAssemblerInput): unknown
}

const MATERIALIZERS: readonly CompletionArtifactMaterializer[] = [{
  id: 'comparison-report/v1',
  supports: ({ artifactKind, payloadSchemaVersion }) => (
    artifactKind === 'comparison_report' && payloadSchemaVersion === 'comparison-report/v1'
  ),
  content: (input) => ({
    schemaVersion: 'comparison-report/v1',
    goal: input.goal,
    summary: input.summary,
    options: input.contextItems
      .filter((item) => item.kind === 'comparison_option')
      .map((item) => ({ id: item.id, facts: item.content })),
    evidenceIds: input.evidence.map((item) => item.id),
    generatedAt: (input.now ?? (() => new Date()))().toISOString(),
  }),
}]

/** Materializes contract-required terminal artifacts through a schema registry. */
export async function assembleCompletionArtifacts(input: ResultAssemblerInput): Promise<ArtifactRef[]> {
  if (!input.contract || !input.summary.trim()) return [...input.existingArtifacts]
  const artifacts = [...input.existingArtifacts]
  for (const criterion of input.contract.criteria) {
    if (criterion.kind !== 'artifact_present') continue
    if (artifacts.filter((item) => criterion.artifactKinds.includes(item.kind)
      && (!criterion.schemaVersions?.length || criterion.schemaVersions.includes(item.payloadSchemaVersion))).length >= criterion.minCount) {
      continue
    }
    const artifactKind = criterion.artifactKinds[0]
    const payloadSchemaVersion = criterion.schemaVersions?.[0]
    if (!artifactKind || !payloadSchemaVersion) continue
    const materializer = MATERIALIZERS.find((candidate) => candidate.supports({
      artifactKind,
      payloadSchemaVersion,
      contract: input.contract!,
    }))
    if (!materializer) continue
    const stored = await input.store.write({
      runId: input.runId,
      sessionId: input.sessionId,
      toolCallId: `completion-artifact:${criterion.id}`,
      toolName: 'result_assembler',
      kind: 'llm_summary',
      content: materializer.content(input),
      mediaType: 'application/json',
      sensitivity: 'internal',
      retention: { scope: 'run', deleteWithSession: true },
      summary: input.summary,
    })
    artifacts.push({
      schemaVersion: 'artifact-ref/v1',
      id: stored.artifactId,
      kind: artifactKind,
      payloadSchemaVersion,
      mediaType: stored.mediaType,
      byteLength: stored.bytes,
      sha256: stored.sha256,
      createdAt: stored.createdAt,
      immutable: true,
      locator: `artifact:${stored.artifactId}`,
      producer: { id: `result-assembler:${materializer.id}`, version: '1' },
      parentEvidenceIds: input.evidence.map((item) => item.id),
      parentArtifactIds: [],
      origin: 'derived',
      trust: 'derived_untrusted',
      sensitivity: stored.sensitivity,
      retention: { scope: 'run', deleteWithSession: true },
      ...(input.ownerScope ? { ownerScope: structuredClone(input.ownerScope) } : {}),
      binding: { runId: input.runId, revision: input.revision },
      requiresMainWorkflowVerification: false,
      authoritativeCompletionEvidence: true,
      redaction: {
        status: stored.redaction?.status === 'redacted'
          ? 'redacted'
          : stored.redaction?.status === 'contains_sensitive'
            ? 'rejected'
            : 'not_required',
        policyId: 'runtime-persistence-boundary/v1',
      },
      scanner: { status: 'not_scanned', scannerId: 'not-configured' },
    })
  }
  return artifacts
}
