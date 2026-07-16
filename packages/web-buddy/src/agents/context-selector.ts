import type {
  ActionBinding,
  ContextCatalogManifestV1,
  FreshnessAssessment,
  OmittedContextItem,
  OmittedContextReason,
  ReadOnlyLlmTaskKind,
  SelectedContextItem,
  SelectedContextReason,
  SensitiveDisclosureGrantRefV1,
} from './async-task-contracts.js'
import {
  canonicalJson,
  createContextCatalog,
  policyViolation,
  sha256Hex,
  type ContextCatalogItem,
  type ContextCatalogV1,
  type ContextRetention,
} from './context-catalog.js'

export interface SelectContextInput {
  catalog: ContextCatalogV1
  taskId: string
  taskKind: ReadOnlyLlmTaskKind
  createdAt: string
  currentActionBinding: ActionBinding
  relevanceText: string
  maxInputTokens: number
  fixedEnvelopeTokens: number
  sensitiveDisclosureGrants?: readonly SensitiveDisclosureGrantRefV1[]
}

export interface ContextSelectionResult {
  catalogManifest: ContextCatalogManifestV1
  selectedContext: SelectedContextItem[]
  omittedContext: OmittedContextItem[]
  sensitiveDisclosureGrants: SensitiveDisclosureGrantRefV1[]
  selectedContextTokens: number
}

interface EligibleCandidate {
  item: Extract<ContextCatalogItem, { availability: 'selectable' }>
  freshness: FreshnessAssessment
  grant?: SensitiveDisclosureGrantRefV1
  relevanceScore: number
}

const READ_ONLY_LLM_TASK_KINDS: readonly ReadOnlyLlmTaskKind[] = [
  'candidate_job_research',
  'trace_summarization',
]

const RETENTION_ORDER: Readonly<Record<ContextRetention, number>> = {
  task_contract: 0,
  task_input: 1,
  structured_state: 2,
  output_contract: 3,
  safety_policy: 4,
  causal_slice: 5,
  optional: 6,
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/

export function selectContext(input: SelectContextInput): ContextSelectionResult {
  validateSelectionInput(input)
  const items = validateCatalogPartition(input.catalog)
  const grants = normalizeGrants(
    input.sensitiveDisclosureGrants ?? [],
    input.taskId,
    input.catalog.parentSessionId,
    input.createdAt,
  )
  const grantByCandidate = indexGrantsByCandidate(grants)
  const currentActionBinding = normalizeCurrentActionBinding(input.currentActionBinding)
  const queryTerms = tokenize(input.relevanceText)
  const omittedById = new Map<string, OmittedContextItem>()
  const eligible: EligibleCandidate[] = []

  // This pass is deliberately complete before relevance or token arithmetic runs.
  for (const item of items) {
    const permissionReason = permissionOmissionReason(item, input.taskKind, grantByCandidate)
    if (permissionReason) {
      omittedById.set(item.id, { id: item.id, sensitivity: item.sensitivity, reason: permissionReason })
      continue
    }
    if (item.availability !== 'selectable') {
      throw policyViolation('MISSING_REQUIRED_CONTEXT', `Selectable context ${item.id} has no closed context unit.`)
    }
    const freshness = assessCandidateFreshness(item, currentActionBinding)
    if (freshness.state === 'stale' && !item.allowStale) {
      omittedById.set(item.id, { id: item.id, sensitivity: item.sensitivity, reason: 'stale_not_allowed' })
      continue
    }
    eligible.push({
      item,
      freshness,
      grant: item.sensitivity === 'sensitive' ? grantByCandidate.get(item.id)?.[0] : undefined,
      relevanceScore: scoreCandidate(item, freshness, queryTerms, currentActionBinding),
    })
  }

  const deniedMandatory = items.filter((item) => item.retention !== 'optional' && omittedById.has(item.id))
  if (deniedMandatory.length > 0) {
    const ids = deniedMandatory.map((item) => item.id).sort().join(', ')
    throw policyViolation('MISSING_REQUIRED_CONTEXT', `Mandatory context was denied before selection: ${ids}.`)
  }

  const availableContextTokens = input.maxInputTokens - input.fixedEnvelopeTokens
  const mandatory = eligible
    .filter(({ item }) => item.retention !== 'optional')
    .sort(compareMandatory)
  const optional = eligible
    .filter(({ item }) => item.retention === 'optional')
    .sort(compareRelevant)
  const mandatoryTokens = mandatory.reduce((sum, candidate) => sum + candidate.item.tokenEstimate, 0)
  if (mandatoryTokens > availableContextTokens) {
    throw policyViolation('BUDGET_EXCEEDED', 'Mandatory task contract, structured state, or causal context exceeds the input budget.')
  }

  const chosen: EligibleCandidate[] = [...mandatory]
  let selectedContextTokens = mandatoryTokens
  for (const candidate of optional) {
    if (selectedContextTokens + candidate.item.tokenEstimate <= availableContextTokens) {
      chosen.push(candidate)
      selectedContextTokens += candidate.item.tokenEstimate
    } else {
      omittedById.set(candidate.item.id, {
        id: candidate.item.id,
        sensitivity: candidate.item.sensitivity,
        reason: 'budget_exceeded',
      })
    }
  }

  const selectedContext = chosen.map(toSelectedContextItem)
  const selectedIds = new Set(selectedContext.map((item) => item.id))
  const omittedContext = items
    .filter((item) => !selectedIds.has(item.id))
    .map((item) => omittedById.get(item.id) ?? missingAuditReason(item))
    .sort((left, right) => left.id.localeCompare(right.id))
  assertCompletePartition(items, selectedContext, omittedContext)

  const usedGrantIds = new Set(
    selectedContext
      .filter((item): item is Extract<SelectedContextItem, { sensitivity: 'sensitive' }> => item.sensitivity === 'sensitive')
      .map((item) => item.disclosureGrantId),
  )
  const sensitiveDisclosureGrants = grants.filter((grant) => usedGrantIds.has(grant.grantId))
  if (sensitiveDisclosureGrants.length !== usedGrantIds.size) {
    throw policyViolation('SENSITIVE_CONTEXT_NOT_AUTHORIZED', 'Selected sensitive context has no unique disclosure grant.')
  }

  return {
    catalogManifest: cloneManifest(input.catalog.manifest),
    selectedContext,
    omittedContext,
    sensitiveDisclosureGrants,
    selectedContextTokens,
  }
}

function permissionOmissionReason(
  item: ContextCatalogItem,
  taskKind: ReadOnlyLlmTaskKind,
  grantByCandidate: ReadonlyMap<string, readonly SensitiveDisclosureGrantRefV1[]>,
): OmittedContextReason | undefined {
  if (item.availability === 'denied') return item.deniedReason
  if (item.sensitivity === 'secret') return 'secret_denied'
  if (item.sensitivity === 'sensitive' && !grantByCandidate.has(item.id)) return 'sensitive_not_authorized'
  if (!item.allowedTaskKinds.includes(taskKind)) return 'task_kind_mismatch'
  return undefined
}

function assessCandidateFreshness(
  item: ContextCatalogItem,
  currentActionBinding: ActionBinding,
): FreshnessAssessment {
  if (item.actionBinding.kind === 'not_action_bound') return { state: 'not_action_bound' }
  if (currentActionBinding.kind !== 'browser_action') {
    throw policyViolation('INVALID_SOURCE_ACTION_SEQ', 'Action-bound context requires a current Main Agent action sequence.')
  }
  const sourceActionSeq = item.actionBinding.sourceActionSeq
  const assessedAgainstActionSeq = currentActionBinding.sourceActionSeq
  if (sourceActionSeq > assessedAgainstActionSeq) {
    throw policyViolation('INVALID_SOURCE_ACTION_SEQ', 'Context source action sequence is in the future.')
  }
  if (sourceActionSeq === assessedAgainstActionSeq) {
    return { state: 'current', sourceActionSeq, assessedAgainstActionSeq }
  }
  const lag = assessedAgainstActionSeq - sourceActionSeq
  return {
    state: lag <= item.maxActionLag ? 'historical' : 'stale',
    sourceActionSeq,
    assessedAgainstActionSeq,
  }
}

function scoreCandidate(
  item: Extract<ContextCatalogItem, { availability: 'selectable' }>,
  freshness: FreshnessAssessment,
  queryTerms: ReadonlySet<string>,
  currentActionBinding: ActionBinding,
): number {
  const searchable = new Set([
    ...item.relevanceTerms,
    ...tokenize(item.unit.sanitizedSummary.text),
  ])
  let overlap = 0
  for (const term of queryTerms) if (searchable.has(term)) overlap += 1
  const freshnessScore = freshness.state === 'current'
    ? 40
    : freshness.state === 'historical'
      ? 25
      : freshness.state === 'not_action_bound'
        ? 15
        : 0
  const actionScore = freshness.state !== 'not_action_bound' && currentActionBinding.kind === 'browser_action'
    ? Math.max(0, 20 - (currentActionBinding.sourceActionSeq - freshness.sourceActionSeq))
    : 0
  return 10 + freshnessScore + actionScore + overlap * 30
}

function compareMandatory(left: EligibleCandidate, right: EligibleCandidate): number {
  return RETENTION_ORDER[left.item.retention] - RETENTION_ORDER[right.item.retention]
    || right.relevanceScore - left.relevanceScore
    || left.item.id.localeCompare(right.item.id)
}

function compareRelevant(left: EligibleCandidate, right: EligibleCandidate): number {
  const leftDenominator = Math.max(1, left.item.tokenEstimate)
  const rightDenominator = Math.max(1, right.item.tokenEstimate)
  const ratioOrder = right.relevanceScore * leftDenominator - left.relevanceScore * rightDenominator
  return ratioOrder
    || right.relevanceScore - left.relevanceScore
    || left.item.tokenEstimate - right.item.tokenEstimate
    || left.item.id.localeCompare(right.item.id)
}

function toSelectedContextItem(candidate: EligibleCandidate): SelectedContextItem {
  const base = {
    id: candidate.item.id,
    freshness: candidate.freshness,
    allowedTaskKinds: [...candidate.item.allowedTaskKinds],
    tokenEstimate: candidate.item.tokenEstimate,
    selectedReason: selectedReason(candidate.item.retention, candidate.freshness),
    unit: candidate.item.unit,
  }
  if (candidate.item.sensitivity === 'sensitive') {
    if (!candidate.grant) {
      throw policyViolation('SENSITIVE_CONTEXT_NOT_AUTHORIZED', `Sensitive context ${candidate.item.id} is missing its grant.`)
    }
    return { ...base, sensitivity: 'sensitive', disclosureGrantId: candidate.grant.grantId }
  }
  if (candidate.item.sensitivity === 'secret') {
    throw policyViolation('SECRET_CONTEXT_SELECTED', 'Secret context cannot enter the selected union.')
  }
  return { ...base, sensitivity: candidate.item.sensitivity }
}

function selectedReason(retention: ContextRetention, freshness: FreshnessAssessment): SelectedContextReason {
  switch (retention) {
    case 'task_contract':
    case 'task_input':
    case 'structured_state': return 'required_task_input'
    case 'output_contract': return 'required_output_contract'
    case 'safety_policy': return 'required_safety_policy'
    case 'causal_slice': return 'bounded_causal_slice'
    case 'optional': return freshness.state === 'not_action_bound' ? 'relevant_task_kind' : 'relevant_action'
  }
}

function normalizeGrants(
  values: readonly SensitiveDisclosureGrantRefV1[],
  taskId: string,
  sessionId: string,
  createdAt: string,
): SensitiveDisclosureGrantRefV1[] {
  const envelopeTime = parseIsoTimestamp(createdAt, 'createdAt')
  if (!Array.isArray(values)) {
    throw policyViolation('SENSITIVE_CONTEXT_NOT_AUTHORIZED', 'Sensitive disclosure grants must be an array.')
  }
  const seen = new Set<string>()
  return values.map<SensitiveDisclosureGrantRefV1>((grant: SensitiveDisclosureGrantRefV1) => {
    assertGrantKeys(grant)
    const allowedIds: readonly string[] = grant.allowedContextItemIds
    if (
      grant.schemaVersion !== 'sensitive-disclosure-grant/v1'
      || grant.taskId !== taskId
      || grant.sessionId !== sessionId
      || grant.purpose !== 'async_task_context'
      || grant.issuedBy !== 'main_agent_runtime_policy'
      || typeof grant.grantId !== 'string'
      || grant.grantId.length === 0
      || !SHA256_PATTERN.test(grant.grantDigest)
      || !Array.isArray(allowedIds)
      || allowedIds.some((id: string) => typeof id !== 'string' || id.length === 0)
    ) {
      throw policyViolation('SENSITIVE_CONTEXT_NOT_AUTHORIZED', 'Sensitive disclosure grant scope or shape is invalid.')
    }
    if (seen.has(grant.grantId)) {
      throw policyViolation('SENSITIVE_CONTEXT_NOT_AUTHORIZED', `Duplicate sensitive disclosure grant ${grant.grantId}.`)
    }
    seen.add(grant.grantId)
    const issuedAt = parseIsoTimestamp(grant.issuedAt, 'issuedAt')
    const expiresAt = parseIsoTimestamp(grant.expiresAt, 'expiresAt')
    if (issuedAt > envelopeTime || expiresAt <= envelopeTime) {
      throw policyViolation('SENSITIVE_CONTEXT_NOT_AUTHORIZED', 'Sensitive disclosure grant is not valid at envelope creation time.')
    }
    const allowedContextItemIds = [...new Set<string>(allowedIds)].sort((left, right) => left.localeCompare(right))
    return {
      schemaVersion: 'sensitive-disclosure-grant/v1',
      grantId: grant.grantId,
      sessionId: grant.sessionId,
      taskId: grant.taskId,
      allowedContextItemIds,
      purpose: 'async_task_context',
      issuedBy: 'main_agent_runtime_policy',
      issuedAt: grant.issuedAt,
      expiresAt: grant.expiresAt,
      grantDigest: grant.grantDigest,
    }
  }).sort((left, right) => left.grantId.localeCompare(right.grantId))
}

function indexGrantsByCandidate(
  grants: readonly SensitiveDisclosureGrantRefV1[],
): ReadonlyMap<string, readonly SensitiveDisclosureGrantRefV1[]> {
  const result = new Map<string, SensitiveDisclosureGrantRefV1[]>()
  for (const grant of grants) {
    for (const contextId of grant.allowedContextItemIds) {
      const entries = result.get(contextId) ?? []
      entries.push(grant)
      entries.sort((left, right) => left.grantId.localeCompare(right.grantId))
      result.set(contextId, entries)
    }
  }
  return result
}

function validateSelectionInput(input: SelectContextInput): void {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw policyViolation('MISSING_REQUIRED_CONTEXT', 'Context selector input must be an object.')
  }
  if (!READ_ONLY_LLM_TASK_KINDS.includes(input.taskKind)) {
    throw policyViolation('LIVE_CAPABILITY_FORBIDDEN', 'S004 envelopes are only valid for read-only LLM task kinds.')
  }
  if (typeof input.taskId !== 'string' || input.taskId.length === 0 || typeof input.relevanceText !== 'string') {
    throw policyViolation('MISSING_REQUIRED_CONTEXT', 'Task identity and relevance text are required.')
  }
  parseIsoTimestamp(input.createdAt, 'createdAt')
  requireBudgetInteger(input.maxInputTokens, 'maxInputTokens')
  requireBudgetInteger(input.fixedEnvelopeTokens, 'fixedEnvelopeTokens')
  if (input.fixedEnvelopeTokens > input.maxInputTokens) {
    throw policyViolation('BUDGET_EXCEEDED', 'Fixed envelope tokens exceed the maximum input budget.')
  }
}

function validateCatalogPartition(catalog: ContextCatalogV1): ContextCatalogItem[] {
  if (catalog.schemaVersion !== 'context-catalog/v1') {
    throw policyViolation('MISSING_REQUIRED_CONTEXT', 'Unsupported internal context catalog version.')
  }
  const rebuilt = createContextCatalog({
    parentRunId: catalog.parentRunId,
    parentSessionId: catalog.parentSessionId,
    catalogRevision: catalog.catalogRevision,
    candidates: catalog.items.map((item) => ({
      provenance: item.provenance,
      sensitivity: item.sensitivity,
      allowedTaskKinds: item.allowedTaskKinds,
      tokenEstimate: item.tokenEstimate,
      retention: item.retention,
      actionBinding: item.actionBinding,
      relevanceTerms: item.relevanceTerms,
      maxActionLag: item.maxActionLag,
      allowStale: item.allowStale,
      content: item.availability === 'selectable'
        ? { kind: 'context_unit' as const, unit: item.unit }
        : { kind: 'denied' as const, reason: item.deniedReason },
    })),
  })
  const items = rebuilt.items
  const ids = items.map((item) => item.id)
  if (new Set(ids).size !== ids.length) {
    throw policyViolation('DUPLICATE_CONTEXT_ID', 'Context catalog contains duplicate candidate IDs.')
  }
  const manifest = catalog.manifest
  if (
    manifest.schemaVersion !== 'context-catalog-manifest/v1'
    || manifest.catalogRevision !== catalog.catalogRevision
    || manifest.canonicalization !== 'context-catalog-item-ids-jcs/v1'
    || manifest.candidateCount !== ids.length
    || canonicalJson(manifest.candidateItemIds) !== canonicalJson(ids)
    || manifest.catalogDigest !== sha256Hex(JSON.stringify(ids))
    || canonicalJson(catalog.items.map((item) => item.id).sort()) !== canonicalJson(ids)
  ) {
    throw policyViolation('MISSING_REQUIRED_CONTEXT', 'Context catalog manifest does not match its candidates.')
  }
  return items
}

function normalizeCurrentActionBinding(binding: ActionBinding): ActionBinding {
  if (binding.kind === 'not_action_bound') return { kind: 'not_action_bound' }
  if (binding.kind === 'browser_action' && Number.isSafeInteger(binding.sourceActionSeq) && binding.sourceActionSeq >= 0) {
    return { kind: 'browser_action', sourceActionSeq: binding.sourceActionSeq }
  }
  throw policyViolation('INVALID_SOURCE_ACTION_SEQ', 'Current action binding is invalid.')
}

function assertCompletePartition(
  items: readonly ContextCatalogItem[],
  selected: readonly SelectedContextItem[],
  omitted: readonly OmittedContextItem[],
): void {
  const auditIds = [...selected.map((item) => item.id), ...omitted.map((item) => item.id)]
  if (auditIds.length !== items.length || new Set(auditIds).size !== auditIds.length) {
    throw policyViolation('DUPLICATE_CONTEXT_ID', 'Context audit arrays are not a unique partition.')
  }
  const expected = items.map((item) => item.id).sort()
  const actual = [...auditIds].sort()
  if (canonicalJson(expected) !== canonicalJson(actual)) {
    throw policyViolation('MISSING_REQUIRED_CONTEXT', 'Every catalog candidate must be selected or omitted exactly once.')
  }
}

function missingAuditReason(item: ContextCatalogItem): never {
  throw policyViolation('MISSING_REQUIRED_CONTEXT', `Context candidate ${item.id} has no audit reason.`)
}

function cloneManifest(manifest: ContextCatalogManifestV1): ContextCatalogManifestV1 {
  return {
    schemaVersion: 'context-catalog-manifest/v1',
    catalogRevision: manifest.catalogRevision,
    catalogDigest: manifest.catalogDigest,
    canonicalization: 'context-catalog-item-ids-jcs/v1',
    candidateItemIds: [...manifest.candidateItemIds],
    candidateCount: manifest.candidateCount,
  }
}

function tokenize(value: string): Set<string> {
  return new Set(value.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [])
}

function parseIsoTimestamp(value: string, field: string): number {
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw policyViolation('MISSING_REQUIRED_CONTEXT', `${field} must be an ISO UTC timestamp.`)
  }
  return parsed
}

function requireBudgetInteger(value: unknown, field: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw policyViolation('BUDGET_EXCEEDED', `${field} must be a non-negative safe integer.`)
  }
}

function assertGrantKeys(grant: SensitiveDisclosureGrantRefV1): void {
  if (!grant || typeof grant !== 'object' || Array.isArray(grant)) {
    throw policyViolation('SENSITIVE_CONTEXT_NOT_AUTHORIZED', 'Sensitive disclosure grant must be a closed object.')
  }
  const expected = [
    'schemaVersion',
    'grantId',
    'sessionId',
    'taskId',
    'allowedContextItemIds',
    'purpose',
    'issuedBy',
    'issuedAt',
    'expiresAt',
    'grantDigest',
  ]
  const keys = Object.keys(grant)
  if (keys.length !== expected.length || keys.some((key) => !expected.includes(key))) {
    throw policyViolation('SENSITIVE_CONTEXT_NOT_AUTHORIZED', 'Sensitive disclosure grant has forbidden fields.')
  }
}
