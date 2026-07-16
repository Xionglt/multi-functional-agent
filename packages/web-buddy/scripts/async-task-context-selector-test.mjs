#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  adaptArtifactSensitivity,
  createContextCatalog,
} from '../dist/agents/context-catalog.js'
import { selectContext } from '../dist/agents/context-selector.js'
import { buildSubagentContextEnvelope } from '../dist/agents/context-envelope.js'

const RUN_ID = 'run-context-selector-001'
const SESSION_ID = 'session-context-selector-001'
const CREATED_AT = '2026-07-10T12:00:00.000Z'
const CURRENT_ACTION = { kind: 'browser_action', sourceActionSeq: 10 }

const outputSchemaRef = artifact('schema', 'output-schema', undefined)
const taskContractRef = artifact('task_graph_checkpoint', 'task-contract', undefined)
const traceRef = artifact('trace', 'required-trace', 10)
const workflowRef = artifact('task_graph_checkpoint', 'workflow-state', 10)
const toolCallRef = artifact('tool_call', 'causal-call', 9)
const toolResultRef = artifact('tool_result', 'causal-result', 9)
const skillRef = artifact('runner_result', 'skill-result', undefined)
const mcpRef = artifact('runner_result', 'mcp-result', undefined)
const memoryRef = artifact('memory', 'preferred-memory', undefined)
const secretRef = artifact('trace', 'secret-trace', 10)
const liveRef = artifact('page_snapshot', 'live-source-marker', 10)
const historyRef = artifact('trace', 'history-source-marker', 10)
const incompleteCallRef = artifact('tool_call', 'incomplete-call', 10)
const staleRef = artifact('trace', 'stale-trace', 1)
const mismatchRef = artifact('memory', 'mismatch-memory', undefined)
const unauthorizedRef = artifact('memory', 'unauthorized-memory', undefined)
const budgetRef = artifact('trace', 'budget-trace', undefined)

const candidates = [
  candidate({
    provenance: workflowProvenance('task-contract-workflow', 1, [taskContractRef], { kind: 'not_action_bound' }),
    retention: 'task_contract',
    actionBinding: { kind: 'not_action_bound' },
    tokenEstimate: 25,
    relevanceTerms: ['candidate', 'contract'],
    unit: structuredUnit('goal', 'Research matching runtime roles from frozen artifacts.', [taskContractRef]),
  }),
  candidate({
    provenance: { kind: 'trace', traceId: 'trace-required', artifactRef: traceRef },
    retention: 'task_input',
    actionBinding: traceRef.actionBinding,
    tokenEstimate: 35,
    relevanceTerms: ['candidate', 'trace'],
    unit: artifactUnit(traceRef, 'Frozen candidate trace at action 10.'),
  }),
  candidate({
    provenance: workflowProvenance('candidate-workflow', 8, [workflowRef], workflowRef.actionBinding),
    retention: 'structured_state',
    actionBinding: workflowRef.actionBinding,
    tokenEstimate: 40,
    relevanceTerms: ['workflow', 'candidate'],
    unit: structuredUnit('workflow_state', 'Structured workflow state revision 8.', [workflowRef]),
  }),
  candidate({
    provenance: {
      kind: 'tool',
      toolName: 'artifact_read_json',
      toolCallId: 'tool-call-causal-001',
      callArtifactRef: toolCallRef,
      resultArtifactRef: toolResultRef,
    },
    retention: 'causal_slice',
    actionBinding: toolCallRef.actionBinding,
    tokenEstimate: 45,
    relevanceTerms: ['runtime', 'candidate', 'tool'],
    maxActionLag: 2,
    unit: toolUnit('tool-call-causal-001', 'artifact_read_json', toolCallRef, toolResultRef, 'Bounded causal tool exchange.'),
  }),
  candidate({
    provenance: {
      kind: 'skill',
      packageName: '@web-buddy/research',
      skillName: 'candidate-research',
      skillVersion: '1.0.0',
      invocationId: 'skill-invocation-001',
      resultArtifactRef: skillRef,
    },
    retention: 'optional',
    actionBinding: skillRef.actionBinding,
    tokenEstimate: 30,
    relevanceTerms: ['runtime', 'skill'],
    unit: artifactUnit(skillRef, 'Stable research skill result for runtime roles.'),
  }),
  candidate({
    provenance: {
      kind: 'mcp',
      server: 'jobs-index',
      operationKind: 'method',
      operation: 'search_candidates',
      requestId: 'mcp-request-001',
      resultArtifactRef: mcpRef,
    },
    retention: 'optional',
    actionBinding: mcpRef.actionBinding,
    tokenEstimate: 30,
    relevanceTerms: ['unrelated'],
    unit: artifactUnit(mcpRef, 'Frozen MCP search result.'),
  }),
  candidate({
    provenance: {
      kind: 'memory',
      namespace: 'candidate-preferences',
      recordId: 'preferred',
      recordVersion: '3',
      artifactRef: memoryRef,
    },
    sensitivity: 'sensitive',
    retention: 'optional',
    actionBinding: memoryRef.actionBinding,
    tokenEstimate: 20,
    relevanceTerms: ['runtime', 'candidate'],
    unit: artifactUnit(memoryRef, 'Candidate preference summary for runtime roles.'),
  }),
  candidate({
    provenance: { kind: 'trace', traceId: 'trace-secret', artifactRef: secretRef },
    sensitivity: 'secret',
    retention: 'optional',
    actionBinding: secretRef.actionBinding,
    tokenEstimate: 1,
    relevanceTerms: ['runtime'],
    unit: artifactUnit(secretRef, 'Secret marker that must never be selected.'),
  }),
  deniedCandidate({
    provenance: workflowProvenance('live-workflow', 2, [liveRef], liveRef.actionBinding),
    reason: 'live_page_denied',
    actionBinding: liveRef.actionBinding,
  }),
  deniedCandidate({
    provenance: workflowProvenance('history-workflow', 2, [historyRef], historyRef.actionBinding),
    reason: 'full_history_denied',
    actionBinding: historyRef.actionBinding,
  }),
  deniedCandidate({
    provenance: {
      kind: 'tool',
      toolName: 'artifact_read_text',
      toolCallId: 'tool-call-incomplete-001',
      callArtifactRef: incompleteCallRef,
    },
    reason: 'incomplete_tool_exchange',
    actionBinding: incompleteCallRef.actionBinding,
  }),
  candidate({
    provenance: { kind: 'trace', traceId: 'trace-stale', artifactRef: staleRef },
    retention: 'optional',
    actionBinding: staleRef.actionBinding,
    tokenEstimate: 1,
    relevanceTerms: ['runtime'],
    maxActionLag: 0,
    allowStale: false,
    unit: artifactUnit(staleRef, 'Old trace outside the accepted action lag.'),
  }),
  candidate({
    provenance: {
      kind: 'memory',
      namespace: 'other-task',
      recordId: 'mismatch',
      recordVersion: '1',
      artifactRef: mismatchRef,
    },
    retention: 'optional',
    actionBinding: mismatchRef.actionBinding,
    tokenEstimate: 1,
    allowedTaskKinds: ['memory_retrieval'],
    unit: artifactUnit(mismatchRef, 'Memory intended for a different task kind.'),
  }),
  candidate({
    provenance: {
      kind: 'memory',
      namespace: 'candidate-private',
      recordId: 'unauthorized',
      recordVersion: '1',
      artifactRef: unauthorizedRef,
    },
    sensitivity: 'sensitive',
    retention: 'optional',
    actionBinding: unauthorizedRef.actionBinding,
    tokenEstimate: 1,
    relevanceTerms: ['runtime'],
    unit: artifactUnit(unauthorizedRef, 'Sensitive memory without a task-scoped grant.'),
  }),
  candidate({
    provenance: { kind: 'trace', traceId: 'trace-budget', artifactRef: budgetRef },
    retention: 'optional',
    actionBinding: budgetRef.actionBinding,
    tokenEstimate: 90,
    relevanceTerms: ['runtime', 'candidate', 'tool'],
    unit: artifactUnit(budgetRef, 'Relevant but oversized complete trace item.'),
  }),
]

const catalog = createContextCatalog({
  parentRunId: RUN_ID,
  parentSessionId: SESSION_ID,
  catalogRevision: 7,
  candidates,
})
const reversedCatalog = createContextCatalog({
  parentRunId: RUN_ID,
  parentSessionId: SESSION_ID,
  catalogRevision: 7,
  candidates: [...candidates].reverse(),
})

assert.equal(catalog.items.length, 15)
assert.deepEqual(catalog.manifest, reversedCatalog.manifest, 'catalog IDs and manifest must not depend on ingestion order')
assert(catalog.items.every((item) => /^ctx:(tool|skill|mcp|trace|memory|workflow):sha256:[a-f0-9]{64}$/.test(item.id)))
assert.deepEqual(new Set(catalog.items.map((item) => item.originKind)), new Set(['tool', 'skill', 'mcp', 'trace', 'memory', 'workflow']))
assert.equal(adaptArtifactSensitivity('public'), 'public')
assert.equal(adaptArtifactSensitivity('personal'), 'sensitive')
assert.equal(adaptArtifactSensitivity('internal'), 'sensitive')
assert.equal(adaptArtifactSensitivity('secret'), 'secret')
assertViolation(() => adaptArtifactSensitivity('unknown'), 'SENSITIVE_CONTEXT_NOT_AUTHORIZED')

const preferredMemoryId = itemId(catalog, (item) => item.provenance.kind === 'memory' && item.provenance.recordId === 'preferred')
const grant = {
  schemaVersion: 'sensitive-disclosure-grant/v1',
  grantId: 'grant-context-001',
  sessionId: SESSION_ID,
  taskId: 'task-candidate-research-001',
  allowedContextItemIds: [preferredMemoryId],
  purpose: 'async_task_context',
  issuedBy: 'main_agent_runtime_policy',
  issuedAt: '2026-07-10T11:59:00.000Z',
  expiresAt: '2026-07-10T13:00:00.000Z',
  grantDigest: digest('grant-context-001'),
}
const buildInput = {
  envelopeId: 'envelope-context-001',
  taskId: 'task-candidate-research-001',
  taskKind: 'candidate_job_research',
  parentRunId: RUN_ID,
  parentSessionId: SESSION_ID,
  createdAt: CREATED_AT,
  sourceGraphRevision: 12,
  currentActionBinding: CURRENT_ACTION,
  objective: projection('Find runtime roles using only selected frozen context.'),
  outputSchemaRef,
  allowedTools: ['artifact_search_text', 'artifact_read_json', 'artifact_read_text', 'artifact_read_json'],
  catalog,
  relevanceText: 'runtime candidate skill tool',
  sensitiveDisclosureGrants: [grant],
  tokenBudget: {
    maxInputTokens: 300,
    fixedEnvelopeTokens: 100,
    reservedOutputTokens: 128,
  },
}

const envelope = buildSubagentContextEnvelope(buildInput)
const envelopeAgain = buildSubagentContextEnvelope(buildInput)
const envelopeFromReversedCatalog = buildSubagentContextEnvelope({ ...buildInput, catalog: reversedCatalog })
const bytes = Buffer.from(JSON.stringify(envelope), 'utf8')
assert.deepEqual(bytes, Buffer.from(JSON.stringify(envelopeAgain), 'utf8'), 'same explicit input must produce identical bytes')
assert.deepEqual(bytes, Buffer.from(JSON.stringify(envelopeFromReversedCatalog), 'utf8'), 'catalog ingestion order must not affect bytes')

assert.equal(envelope.parentHistoryIncluded, false)
assert.equal(envelope.authorityBoundary.browserWrite, false)
assert.equal(envelope.authorityBoundary.livePageAccess, false)
assert.deepEqual(envelope.authorityBoundary.gates, {
  login: false,
  captcha: false,
  upload: false,
  save: false,
  finalSubmit: false,
})
assert.deepEqual(envelope.allowedTools, ['artifact_read_text', 'artifact_read_json', 'artifact_search_text'])
assert.equal(envelope.outputSchemaRef.artifactKind, 'schema')
assert.equal(envelope.tokenBudget.fixedEnvelopeTokens + envelope.tokenBudget.selectedContextTokens, envelope.tokenBudget.usedInputTokens)
assert(envelope.tokenBudget.usedInputTokens <= envelope.tokenBudget.maxInputTokens)
assert.equal(envelope.tokenBudget.selectedContextTokens, envelope.selectedContext.reduce((sum, item) => sum + item.tokenEstimate, 0))

const selectedIds = new Set(envelope.selectedContext.map((item) => item.id))
const omittedIds = new Set(envelope.omittedContext.map((item) => item.id))
assert.equal(selectedIds.size + omittedIds.size, catalog.items.length)
for (const id of catalog.manifest.candidateItemIds) {
  assert.notEqual(selectedIds.has(id), omittedIds.has(id), `${id} must appear in exactly one audit array`)
}

const taskContractId = itemId(catalog, (item) => item.retention === 'task_contract')
const taskInputId = itemId(catalog, (item) => item.retention === 'task_input')
const structuredStateId = itemId(catalog, (item) => item.retention === 'structured_state')
const causalId = itemId(catalog, (item) => item.retention === 'causal_slice')
assert.equal(selectedById(envelope, taskContractId).selectedReason, 'required_task_input')
assert.equal(selectedById(envelope, taskInputId).selectedReason, 'required_task_input')
assert.equal(selectedById(envelope, structuredStateId).selectedReason, 'required_task_input')
const causal = selectedById(envelope, causalId)
assert.equal(causal.selectedReason, 'bounded_causal_slice')
assert.equal(causal.freshness.state, 'historical')
assert.equal(causal.unit.kind, 'tool_exchange')
assert.equal(causal.unit.callArtifactRef.artifactKind, 'tool_call')
assert.equal(causal.unit.resultArtifactRef.artifactKind, 'tool_result')

const selectedSensitive = selectedById(envelope, preferredMemoryId)
assert.equal(selectedSensitive.sensitivity, 'sensitive')
assert.equal(selectedSensitive.disclosureGrantId, grant.grantId)
assert.deepEqual(envelope.sensitiveDisclosureGrants.map((entry) => entry.grantId), [grant.grantId])

const omittedReason = new Map(envelope.omittedContext.map((item) => [item.id, item.reason]))
assert.equal(omittedReason.get(itemId(catalog, (item) => item.sensitivity === 'secret')), 'secret_denied')
assert.equal(omittedReason.get(itemId(catalog, (item) => item.availability === 'denied' && item.deniedReason === 'live_page_denied')), 'live_page_denied')
assert.equal(omittedReason.get(itemId(catalog, (item) => item.availability === 'denied' && item.deniedReason === 'full_history_denied')), 'full_history_denied')
assert.equal(omittedReason.get(itemId(catalog, (item) => item.availability === 'denied' && item.deniedReason === 'incomplete_tool_exchange')), 'incomplete_tool_exchange')
assert.equal(omittedReason.get(itemId(catalog, (item) => item.provenance.kind === 'trace' && item.provenance.traceId === 'trace-stale')), 'stale_not_allowed')
assert.equal(omittedReason.get(itemId(catalog, (item) => item.provenance.kind === 'memory' && item.provenance.recordId === 'mismatch')), 'task_kind_mismatch')
assert.equal(omittedReason.get(itemId(catalog, (item) => item.provenance.kind === 'memory' && item.provenance.recordId === 'unauthorized')), 'sensitive_not_authorized')
assert.equal(omittedReason.get(itemId(catalog, (item) => item.provenance.kind === 'mcp')), 'budget_exceeded')
assert.equal(omittedReason.get(itemId(catalog, (item) => item.provenance.kind === 'trace' && item.provenance.traceId === 'trace-budget')), 'budget_exceeded')
assert(!envelope.selectedContext.some((item) => item.sensitivity === 'secret'))

const serialized = JSON.stringify(envelope)
assert(!serialized.includes('parentMessages'))
assert(!serialized.includes('reactHistory'))
assert(!serialized.includes('"livePage":'))
assert(!serialized.includes('"browserContext":'))

const directSelection = selectContext({
  catalog,
  taskId: buildInput.taskId,
  taskKind: buildInput.taskKind,
  createdAt: buildInput.createdAt,
  currentActionBinding: buildInput.currentActionBinding,
  relevanceText: buildInput.relevanceText,
  maxInputTokens: buildInput.tokenBudget.maxInputTokens,
  fixedEnvelopeTokens: buildInput.tokenBudget.fixedEnvelopeTokens,
  sensitiveDisclosureGrants: buildInput.sensitiveDisclosureGrants,
})
assert.deepEqual(directSelection.selectedContext, envelope.selectedContext)
assert.deepEqual(directSelection.omittedContext, envelope.omittedContext)

assertViolation(
  () => buildSubagentContextEnvelope({ ...buildInput, parentMessages: [] }),
  'FULL_HISTORY_FORBIDDEN',
)
assertViolation(
  () => buildSubagentContextEnvelope({ ...buildInput, livePage: { url: 'https://example.invalid' } }),
  'LIVE_CAPABILITY_FORBIDDEN',
)
assertViolation(
  () => buildSubagentContextEnvelope({
    ...buildInput,
    tokenBudget: { ...buildInput.tokenBudget, maxInputTokens: 244 },
  }),
  'BUDGET_EXCEEDED',
)

const rawHistoryText = '{"role":"assistant","content":"private reasoning"}'
assertViolation(
  () => createContextCatalog({
    parentRunId: RUN_ID,
    parentSessionId: SESSION_ID,
    catalogRevision: 1,
    candidates: [candidate({
      provenance: workflowProvenance('raw-history', 1, [taskContractRef], { kind: 'not_action_bound' }),
      retention: 'optional',
      actionBinding: { kind: 'not_action_bound' },
      tokenEstimate: 1,
      unit: {
        kind: 'structured_projection',
        projectionKind: 'goal',
        sanitizedSummary: projection(rawHistoryText),
        evidenceRefs: [taskContractRef],
      },
    })],
  }),
  'FULL_HISTORY_FORBIDDEN',
)

assertViolation(
  () => createContextCatalog({
    parentRunId: RUN_ID,
    parentSessionId: SESSION_ID,
    catalogRevision: 1,
    candidates: [candidate({
      provenance: {
        kind: 'tool',
        toolName: 'artifact_read_text',
        toolCallId: 'partial-selectable',
        callArtifactRef: incompleteCallRef,
      },
      retention: 'optional',
      actionBinding: incompleteCallRef.actionBinding,
      tokenEstimate: 1,
      unit: {
        kind: 'tool_exchange',
        toolCallId: 'partial-selectable',
        toolName: 'artifact_read_text',
        callArtifactRef: incompleteCallRef,
        sanitizedSummary: projection('Partial tool exchange.'),
      },
    })],
  }),
  'INCOMPLETE_TOOL_EXCHANGE',
)

assertViolation(
  () => createContextCatalog({
    parentRunId: RUN_ID,
    parentSessionId: SESSION_ID,
    catalogRevision: 1,
    candidates: [candidates[0], candidates[0]],
  }),
  'DUPLICATE_CONTEXT_ID',
)

const foreignRef = { ...skillRef, sessionId: 'foreign-session' }
assertViolation(
  () => createContextCatalog({
    parentRunId: RUN_ID,
    parentSessionId: SESSION_ID,
    catalogRevision: 1,
    candidates: [candidate({
      provenance: {
        kind: 'skill',
        packageName: 'foreign',
        skillName: 'foreign',
        skillVersion: '1',
        invocationId: 'foreign',
        resultArtifactRef: foreignRef,
      },
      retention: 'optional',
      actionBinding: foreignRef.actionBinding,
      tokenEstimate: 1,
      unit: artifactUnit(foreignRef, 'Foreign artifact.'),
    })],
  }),
  'INVALID_ARTIFACT_REF',
  'ARTIFACT_INTEGRITY_FAILED',
)

const unsafePathRef = {
  ...skillRef,
  artifactId: 'unsafe-path',
  storage: { store: 'session_artifacts', relativeSegments: ['..', 'secret.json'] },
}
assertViolation(
  () => createContextCatalog({
    parentRunId: RUN_ID,
    parentSessionId: SESSION_ID,
    catalogRevision: 1,
    candidates: [candidate({
      provenance: {
        kind: 'skill',
        packageName: 'unsafe',
        skillName: 'unsafe',
        skillVersion: '1',
        invocationId: 'unsafe',
        resultArtifactRef: unsafePathRef,
      },
      retention: 'optional',
      actionBinding: unsafePathRef.actionBinding,
      tokenEstimate: 1,
      unit: artifactUnit(unsafePathRef, 'Unsafe path artifact.'),
    })],
  }),
  'INVALID_ARTIFACT_REF',
  'ARTIFACT_INTEGRITY_FAILED',
)

console.log('async-task context catalog/selector/envelope tests passed')

function candidate({
  provenance,
  sensitivity = 'public',
  allowedTaskKinds = ['candidate_job_research'],
  tokenEstimate,
  retention,
  actionBinding,
  relevanceTerms = [],
  maxActionLag,
  allowStale,
  unit,
}) {
  return {
    provenance,
    sensitivity,
    allowedTaskKinds,
    tokenEstimate,
    retention,
    actionBinding,
    relevanceTerms,
    ...(maxActionLag === undefined ? {} : { maxActionLag }),
    ...(allowStale === undefined ? {} : { allowStale }),
    content: { kind: 'context_unit', unit },
  }
}

function deniedCandidate({ provenance, reason, actionBinding }) {
  return {
    provenance,
    sensitivity: 'public',
    allowedTaskKinds: ['candidate_job_research'],
    tokenEstimate: 0,
    retention: 'optional',
    actionBinding,
    relevanceTerms: [],
    content: { kind: 'denied', reason },
  }
}

function workflowProvenance(workflowId, stateRevision, evidenceRefs, actionBinding) {
  return {
    kind: 'workflow',
    workflowId,
    workflowRunId: RUN_ID,
    stateRevision,
    evidenceRefs,
    actionBinding,
  }
}

function artifactUnit(artifactRef, summary) {
  return { kind: 'artifact', artifactRef, sanitizedSummary: projection(summary) }
}

function structuredUnit(projectionKind, text, evidenceRefs) {
  return {
    kind: 'structured_projection',
    projectionKind,
    sanitizedSummary: projection(text),
    evidenceRefs,
  }
}

function toolUnit(toolCallId, toolName, callArtifactRef, resultArtifactRef, summary) {
  return {
    kind: 'tool_exchange',
    toolCallId,
    toolName,
    callArtifactRef,
    resultArtifactRef,
    sanitizedSummary: projection(summary),
  }
}

function projection(text, sourceArtifactRefs = []) {
  return {
    schemaVersion: 'sanitized-text-projection/v1',
    text,
    projectionPolicy: 'no_react_history/v1',
    sourceArtifactRefs,
    sourceItemCount: sourceArtifactRefs.length,
    maxChars: Math.max(64, text.length),
    contentDigest: digest(text),
  }
}

function artifact(artifactKind, artifactId, sourceActionSeq) {
  return {
    schemaVersion: 'immutable-artifact-ref/v1',
    artifactId,
    artifactKind,
    runId: RUN_ID,
    sessionId: SESSION_ID,
    storage: {
      store: 'session_artifacts',
      relativeSegments: [artifactKind, `${artifactId}.json`],
    },
    mediaType: 'application/json',
    byteLength: 128,
    sha256: digest(`artifact:${artifactKind}:${artifactId}`),
    createdAt: CREATED_AT,
    actionBinding: sourceActionSeq === undefined
      ? { kind: 'not_action_bound' }
      : { kind: 'browser_action', sourceActionSeq },
    immutable: true,
  }
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex')
}

function itemId(catalogValue, predicate) {
  const item = catalogValue.items.find(predicate)
  assert(item, 'expected catalog item was not found')
  return item.id
}

function selectedById(envelopeValue, id) {
  const item = envelopeValue.selectedContext.find((candidateValue) => candidateValue.id === id)
  assert(item, `expected selected context ${id}`)
  return item
}

function assertViolation(operation, safeDetailCode, contractCode = 'CONTEXT_POLICY_VIOLATION') {
  assert.throws(
    operation,
    (error) => error?.code === contractCode && error?.safeDetailCode === safeDetailCode,
    `${contractCode}/${safeDetailCode}`,
  )
}
