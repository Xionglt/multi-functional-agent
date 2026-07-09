#!/usr/bin/env node
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { runReadOnlySubagentRuntimePilot } from '../dist/agents/runtime-pilot.js'
import {
  FileSessionRecorder,
  FileSessionStore,
  readJsonLines,
} from '../dist/session/index.js'
import { CompletionGate } from '../dist/workflow/completion-gate.js'
import { WorkflowEngine } from '../dist/workflow/workflow-engine.js'
import { createInitialWorkflowState } from '../dist/workflow/workflow-state.js'

const now = '2026-07-09T00:00:00.000Z'
const artifactRoot = resolve('tmp/read-only-subagent-runtime-test')
rmSync(artifactRoot, { recursive: true, force: true })
mkdirSync(artifactRoot, { recursive: true })

const store = new FileSessionStore({ rootDir: resolve(artifactRoot, 'sessions') })
const session = await store.create({
  sessionId: 'read-only-runtime-session',
  runId: 'read-only-runtime-run',
  source: 'test',
  goal: 'Verify runtime pilot read-only sidechain evidence cannot complete workflow.',
  mode: 'read-only-subagent-runtime',
  now,
})
const recorder = new FileSessionRecorder(store, session)

const pilot = await runReadOnlySubagentRuntimePilot({
  pilotKind: 'trace_summarization',
  runId: session.runId,
  sessionId: session.sessionId,
  outputDir: session.outputDir,
  mainSession: recorder,
  graphId: 'runtime-pilot-graph',
  taskId: 'runtime-trace-summary',
  agentId: 'read-only-runtime-agent',
  turnId: 'turn_runtime_pilot',
  now: () => new Date('2026-07-09T00:00:01.000Z'),
  artifacts: [
    {
      kind: 'trace',
      ref: 'trace-runtime-main-path',
      summary: 'Runtime trace shows form audit is still missing and no user confirmation exists.',
      value: {
        events: [
          { type: 'workflow_evaluated', phase: 'in_target_flow' },
          { type: 'completion_gate_evaluated', action: 'reject' },
        ],
      },
    },
    {
      kind: 'memory',
      ref: 'memory-readonly-context',
      summary: 'Candidate prefers runtime infrastructure work.',
      value: { targetRoles: ['runtime infrastructure'] },
    },
    {
      kind: 'page_snapshot',
      ref: 'snapshot-readonly-context',
      summary: 'Application form page was observed earlier, but no live Page is exposed to the subagent.',
      value: { title: 'Application draft', pageType: 'form' },
    },
  ],
})

assert.equal(pilot.pilotKind, 'trace_summarization')
assert.equal(pilot.status, 'completed')
assert.equal(pilot.task.status, 'completed')
assert.equal(pilot.task.accessMode, 'read_only')
assert.equal(pilot.task.requiresMainWorkflowVerification, true)
assert.equal(pilot.task.authoritativeCompletionEvidence, false)
assert.equal(pilot.graph.safety.browserWriteOwnerTaskId, undefined)
assert.equal(pilot.graph.locks.some((lock) => lock.resource === 'browser_page'), false)
assert.equal(pilot.sidechain.requiresMainWorkflowVerification, true)
assert.equal(pilot.sidechain.authoritativeCompletionEvidence, false)
assert.equal(pilot.workflowEvidenceSummary.requiresMainWorkflowVerification, true)
assert.equal(pilot.workflowEvidenceSummary.authoritativeCompletionEvidence, false)
assert(existsSync(pilot.sidechain.sidechainTranscriptPath), 'sidechain transcript should be written')

const sidechainEntries = await readJsonLines(pilot.sidechain.sidechainTranscriptPath)
const sidechainToolCalls = sidechainEntries.filter((entry) => entry.type === 'sidechain_tool_call')
assert.equal(sidechainToolCalls.length, 1)
assert.equal(sidechainToolCalls[0].data.name, 'read_trace_artifact')
assert.equal(
  sidechainToolCalls.some((entry) => /browser_|agent_done|ask_user/.test(String(entry.data.name))),
  false,
  'runtime pilot must not expose browser/write/completion tools to the subagent',
)
assert(sidechainEntries.some((entry) => entry.type === 'sidechain_completed'))

const transcript = await readJsonLines(session.transcriptPath)
const sidechainEvidenceEntry = transcript.find(
  (entry) => entry.type === 'workflow_evidence' && entry.evidence?.kind === 'sidechain_summary',
)
assert(sidechainEvidenceEntry, 'main transcript should include workflow_evidence sidechain summary')

const sidechainEvidence = sidechainEvidenceEntry.evidence
assert.equal(sidechainEvidence.source, 'read_only_subagent')
assert.equal(sidechainEvidence.data.status, 'completed')
assert.equal(sidechainEvidence.data.taskKind, 'trace_summarization')
assert.equal(sidechainEvidence.data.sidechainTranscriptPath, pilot.sidechain.sidechainTranscriptPath)
assert.equal(sidechainEvidence.data.requiresMainWorkflowVerification, true)
assert.equal(sidechainEvidence.data.authoritativeCompletionEvidence, false)
assert.equal(
  sidechainEvidence.data.outputs.every((output) => output.requiresMainWorkflowVerification === true),
  true,
)
assert.equal(
  sidechainEvidence.data.outputs.every((output) => output.authoritativeCompletionEvidence === false),
  true,
)

const transcriptEvidence = transcript
  .filter((entry) => entry.type === 'workflow_evidence')
  .map((entry) => entry.evidence)

const workflowEvaluation = WorkflowEngine.evaluate({
  previous: {
    ...createInitialWorkflowState(now),
    phase: 'in_target_flow',
    confidence: 'medium',
    reason: 'Main workflow is still responsible for verification.',
    updatedAt: now,
  },
  recentActions: [{
    toolName: 'agent_done',
    toolResult: {
      observation: `agent_done: ${pilot.sidechain.summary}`,
      done: true,
      data: { blocked: false },
    },
  }],
  evidenceSnapshot: transcriptEvidence,
  taskType: 'fill_form',
  now,
})

assert(
  workflowEvaluation.missingCriteria.some((criterion) => criterion.missingEvidenceKinds.includes('page')),
  'sidechain summary must not satisfy main workflow page evidence requirements',
)
assert.equal(workflowEvaluation.matchedCriteria.length, 0)
assert.equal(workflowEvaluation.evidenceIds.includes(sidechainEvidence.id), false)

const completionGateDecision = CompletionGate.evaluate({
  done: true,
  blocked: false,
  summary: pilot.sidechain.summary,
  workflowEvaluation,
  taskType: 'fill_form',
  source: 'agent_done',
})

assert.notEqual(completionGateDecision.action, 'allow')
assert.equal(completionGateDecision.recommendedStatus, 'unchanged')
assert.match(completionGateDecision.reason, /task completion evidence is missing|Form coverage/i)
assert.equal(completionGateDecision.evidenceIds.includes(sidechainEvidence.id), false)

console.log('read-only-subagent-runtime-test passed')
console.log(`artifactRoot=${artifactRoot}`)
console.log(`sessionTranscript=${session.transcriptPath}`)
console.log(`sidechainTranscript=${pilot.sidechain.sidechainTranscriptPath}`)
