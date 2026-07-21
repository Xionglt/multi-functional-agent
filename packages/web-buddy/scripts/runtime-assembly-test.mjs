#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ActionLedger } from '../dist/task/action-ledger.js'
import { assembleRuntimeProfile, inferWebBuddyTaskType } from '../dist/runtime/local/runtime-assembler.js'
import { assembleCompletionArtifacts } from '../dist/runtime/local/result-assembler.js'
import { FileToolResultStore } from '../dist/tools/tool-result-store.js'
import { retrieveLifecycleMemoryContext } from '../dist/memory/context-provider.js'
import { evaluateCompletionContract } from '../dist/task/completion-contract.js'

const config = {
  agent: {
    asyncTasks: {
      enabled: true,
      maxQueuedTasks: 32,
      maxConcurrentReadOnlyLlmTasks: 2,
      maxConcurrentDeterministicTasks: 4,
      notificationWaitMs: 15_000,
    },
    toolOrchestration: { mode: 'parallel', maxConcurrency: 3, parallelAllowlist: ['resume_query'] },
  },
}

const researchTask = taskSnapshot({ scenario: 'research' })
const research = assembleRuntimeProfile({ task: researchTask, config, durableSession: true })
assert.equal(research.profileId, 'research-analysis/v1')
assert.equal(research.taskType, 'explore')
assert.equal(research.asyncTasks.eligible, true)
assert.equal(research.toolOrchestration.mode, 'parallel')

const formTask = taskSnapshot({
  scenario: 'form_draft',
  criteria: [{
    kind: 'form_state', id: 'draft', description: 'draft', requireFullAudit: true,
    requiredFieldCoverage: 1, allowVisibleErrors: false, requireDraftOnly: true,
  }],
})
const form = assembleRuntimeProfile({ task: formTask, config, durableSession: true })
assert.equal(inferWebBuddyTaskType(formTask), 'fill_form')
assert.equal(form.profileId, 'form-draft/v1')
assert.equal(form.asyncTasks.eligible, false)
assert.deepEqual(form.toolOrchestration, { mode: 'serial', maxConcurrency: 1, parallelAllowlist: [] })

const ledger = new ActionLedger(() => new Date('2026-07-21T00:00:00.000Z'))
ledger.propose({ actionId: 'submit-1', actionKind: 'submit', toolName: 'browser_click' })
ledger.authorize('submit-1')
ledger.skip('submit-1')
assert(ledger.outcomes(['submit']).some((item) => item.outcome === 'approved'))
assert(ledger.outcomes(['submit']).some((item) => item.outcome === 'not_performed'))
ledger.propose({ actionId: 'send-1', actionKind: 'send', toolName: 'send_message' })
ledger.authorize('send-1')
ledger.perform('send-1')
assert(ledger.outcomes(['send']).some((item) => item.outcome === 'performed'))
assert(!ledger.outcomes(['send']).some((item) => item.outcome === 'not_performed'))
assert.throws(() => ledger.perform('submit-1'), /cannot transition/)
assert.equal(evaluateCompletionContract({
  contract: {
    schemaVersion: 'web-task-contract/v1', contractId: 'ledger-contract', revision: 0,
    criteria: [{
      kind: 'action_boundary', id: 'no-send', description: 'send must not happen',
      actionKinds: ['send'], outcome: 'not_performed',
    }],
  },
  runId: 'runtime-assembly-run', revision: 0, evidence: [], artifacts: [],
  actions: ledger.outcomes(['send']),
}).completed, false)

const root = await mkdtemp(join(tmpdir(), 'web-buddy-runtime-assembly-'))
try {
  const store = new FileToolResultStore({ rootDir: root })
  const ownerScope = {
    schemaVersion: 'owner-scope/v1',
    tenantId: 'tenant-runtime-assembly',
    userId: 'user-runtime-assembly',
  }
  const artifacts = await assembleCompletionArtifacts({
    goal: 'Compare options.',
    summary: 'Option A is less expensive.',
    contract: {
      schemaVersion: 'web-task-contract/v1',
      contractId: 'custom.contract.without.starter.id',
      revision: 0,
      criteria: [{
        kind: 'artifact_present', id: 'report', description: 'report',
        artifactKinds: ['comparison_report'], minCount: 1, schemaVersions: ['comparison-report/v1'],
      }],
    },
    contextItems: [contextItem('comparison.a', 'comparison_option', { label: 'A', facts: { price: 10 } })],
    evidence: [],
    existingArtifacts: [],
    runId: 'runtime-assembly-run',
    revision: 0,
    sessionId: 'runtime-assembly-session',
    ownerScope,
    store,
    now: () => new Date('2026-07-21T00:00:00.000Z'),
  })
  assert.equal(artifacts.length, 1)
  assert.equal(artifacts[0].kind, 'comparison_report')
  assert.match(artifacts[0].producer.id, /^result-assembler:/)
  assert.deepEqual(artifacts[0].ownerScope, ownerScope)

  const memoryItems = await retrieveLifecycleMemoryContext({
    service: {
      async retrieve() {
        return {
          schemaVersion: 'memory-lifecycle-retrieval-result/v2',
          mode: 'keyword',
          records: [
            { record: memoryRecord('safe-memory', 'internal'), score: 1, reason: 'keyword' },
            { record: memoryRecord('secret-memory', 'secret'), score: 0.9, reason: 'keyword' },
          ],
        }
      },
    },
    ownerScope: { schemaVersion: 'owner-scope/v1', tenantId: 'tenant-a', userId: 'user-a' },
    query: 'remember safe preferences',
    runId: 'runtime-assembly-run',
    revision: 0,
    sessionId: 'runtime-assembly-session',
  })
  assert.equal(memoryItems.length, 1)
  assert.equal(memoryItems[0].id, 'lifecycle-memory.safe-memory.r1')
  assert.equal(memoryItems[0].instructionAuthority, 'data_only')
} finally {
  await rm(root, { recursive: true, force: true })
}

console.log('runtime-assembly-test: PASS')

function taskSnapshot({ scenario, criteria = [] }) {
  return {
    schemaVersion: 'web-task-input-snapshot/v1',
    runId: 'run-profile',
    revision: 0,
    sha256: 'a'.repeat(64),
    goal: { instruction: 'Fixture task.', scenario },
    contextItems: [],
    contextProviders: [],
    contract: {
      schemaVersion: 'web-task-contract/v1', contractId: 'fixture', revision: 0, criteria,
    },
  }
}

function contextItem(id, kind, content) {
  return {
    schemaVersion: 'context-item/v1', id, kind, content,
    origin: 'user', trust: 'user_authorized', instructionAuthority: 'data_only', sensitivity: 'public',
    provenance: { capturedAt: '2026-07-21T00:00:00.000Z', parentContentIds: [] },
    allowedUses: ['prompt', 'artifact'], freshness: { validity: 'current', revision: 0 },
    retention: { scope: 'run', deleteWithSession: true },
    sanitization: { policyId: 'fixture', status: 'unchanged', redactedFields: [], instructionNeutralized: true, transformedFrom: [] },
    integrity: { immutable: true, digestVerified: true },
  }
}

function memoryRecord(entryId, sensitivity) {
  return {
    schemaVersion: 'memory-lifecycle-record/v2', entryId, contentVersionId: `${entryId}:v1`, revision: 1,
    state: 'active', content: { preference: entryId }, contentHash: 'b'.repeat(64),
    scope: { kind: 'user', tenantId: 'tenant-a', userId: 'user-a' },
    trust: 'user_authorized', sensitivity,
    provenance: { contentId: entryId, capturedAt: '2026-07-21T00:00:00.000Z', parentContentIds: [], runId: 'memory-run' },
    derivedFrom: [], transformChain: [], confidence: 1,
    createdAt: '2026-07-21T00:00:00.000Z', updatedAt: '2026-07-21T00:00:00.000Z',
    supersedes: [], conflicts: [],
  }
}
