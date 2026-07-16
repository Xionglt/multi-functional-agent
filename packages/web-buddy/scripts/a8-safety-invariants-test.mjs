#!/usr/bin/env node
import assert from 'node:assert/strict'
import { CompletionGate } from '../dist/workflow/completion-gate.js'
import { assessAsyncTaskResultFreshness } from '../dist/agents/async-task-safety.js'
import { defaultAgentTaskGraphSafetyV2 } from '../dist/agents/task-graph.js'
import { RunnerRegistry } from '../dist/agents/runner-registry.js'
import { executeReadOnlySubagentTool } from '../dist/agents/agent-runner.js'
import { classifySafetyInvariant } from '../dist/policy/safety-invariants.js'

const requiredTaskBlocked = CompletionGate.evaluate({
  done: true,
  blocked: false,
  asyncTaskRuntimeEnabled: true,
  taskType: 'fill_form',
  formCoverage: fullAuditCoverage(),
  fillLedgerSummary: verifiedLedger(),
  mainCompletionReadiness: {
    schemaVersion: 'main-completion-readiness/v1',
    state: 'blocked_required_tasks',
    pendingOrRunningTaskIds: ['task_required_pending'],
    failedOrKilledTaskIds: [],
  },
  source: 'agent_done',
})
assert.equal(requiredTaskBlocked.action, 'reject')
assert.equal(requiredTaskBlocked.recommendedStatus, 'unchanged')
assert.equal(requiredTaskBlocked.missingCriteria.at(-1)?.id, 'required_async_tasks_incomplete')
assert.match(requiredTaskBlocked.reason, /required asynchronous tasks/i)

const missingRuntimeReadiness = CompletionGate.evaluate({
  done: true,
  blocked: false,
  asyncTaskRuntimeEnabled: true,
  taskType: 'fill_form',
  formCoverage: fullAuditCoverage(),
  fillLedgerSummary: verifiedLedger(),
  source: 'agent_done',
})
assert.equal(missingRuntimeReadiness.action, 'reject')
assert.equal(missingRuntimeReadiness.missingCriteria.at(-1)?.id, 'required_async_task_readiness_missing')

const requiredTaskFailed = CompletionGate.evaluate({
  done: true,
  blocked: false,
  asyncTaskRuntimeEnabled: true,
  taskType: 'fill_form',
  formCoverage: fullAuditCoverage(),
  fillLedgerSummary: verifiedLedger(),
  mainCompletionReadiness: {
    schemaVersion: 'main-completion-readiness/v1',
    state: 'blocked_required_tasks',
    pendingOrRunningTaskIds: [],
    failedOrKilledTaskIds: ['task_required_failed'],
  },
  source: 'agent_done',
})
assert.equal(requiredTaskFailed.action, 'reject')
assert.match(requiredTaskFailed.missingCriteria.at(-1)?.reason ?? '', /task_required_failed/)

const subagentSummaryRejected = CompletionGate.evaluate({
  done: true,
  blocked: false,
  taskType: 'explore',
  page: detailPage(),
  summary: 'Candidate role detail, company, location, and requirements were found.',
  summaryAuthority: 'read_only_subagent',
  source: 'agent_done',
})
assert.equal(subagentSummaryRejected.action, 'reject')
assert.notEqual(subagentSummaryRejected.recommendedStatus, 'completed')
assert.match(subagentSummaryRejected.reason, /not completion evidence/i)

const mainSummaryAllowed = CompletionGate.evaluate({
  done: true,
  blocked: false,
  taskType: 'explore',
  page: detailPage(),
  summary: 'Candidate role detail, company, location, and requirements were verified.',
  summaryAuthority: 'main_agent',
  source: 'agent_done',
})
assert.equal(mainSummaryAllowed.action, 'allow')

const actionClock = {
  schemaVersion: 'browser-action-clock/v1',
  sessionId: 'session-a8',
  runId: 'run-a8',
  currentActionSeq: 8,
  updatedAt: '2026-07-10T00:00:08.000Z',
  authority: 'main_agent_runtime',
}
assert.deepEqual(
  assessAsyncTaskResultFreshness({ kind: 'browser_action', sourceActionSeq: 7 }, actionClock),
  { kind: 'assessed', sourceActionSeq: 7, assessedAgainstActionSeq: 8, validity: 'stale' },
)
assert.deepEqual(
  assessAsyncTaskResultFreshness({ kind: 'browser_action', sourceActionSeq: 8 }, actionClock),
  { kind: 'assessed', sourceActionSeq: 8, assessedAgainstActionSeq: 8, validity: 'unverified' },
)
assert.deepEqual(
  assessAsyncTaskResultFreshness({ kind: 'not_action_bound' }, actionClock),
  { kind: 'not_action_bound', validity: 'not_applicable' },
)
assert.throws(
  () => assessAsyncTaskResultFreshness({ kind: 'browser_action', sourceActionSeq: 9 }, actionClock),
  (error) => error?.code === 'INVALID_SOURCE_ACTION_SEQ',
)

const safety = defaultAgentTaskGraphSafetyV2()
assert.deepEqual(safety.browserWriteOwnership, { owner: 'main_agent_runtime' })
assert.equal(safety.subagentCapabilityPolicy, 'immutable_artifact_read_only')
assert.equal(safety.finalDecisionOwner, 'main_agent_runtime')
assert.equal(safety.completionEvidenceRequiresMainVerification, true)
assert.deepEqual(safety.disallowedSubagentGateKinds, ['login', 'captcha', 'upload_resume', 'save_resume', 'final_submit'])
assert.deepEqual(safety.allowedReadOnlyTools, [
  'artifact_read_text',
  'artifact_read_json',
  'artifact_search_text',
  'artifact_list_refs',
])

assert.throws(
  () => new RunnerRegistry([{
    contractVersion: 'agent-task-runner/v1',
    runnerId: 'malicious-browser-runner',
    runnerVersion: '1.0.0',
    kinds: ['main_browser_step'],
    capacityClass: 'read_only_llm',
    runnerKind: 'read_only_llm',
    async run() { throw new Error('must not run') },
  }]),
  (error) => error?.code === 'POLICY_VIOLATION',
)

assert.throws(
  () => executeReadOnlySubagentTool({ name: 'browser_click', arguments: { ref: 'e1' } }, []),
  /cannot execute browser\/write\/completion tools/i,
)
assert.throws(
  () => executeReadOnlySubagentTool({ name: 'agent_done', arguments: {} }, []),
  /cannot execute browser\/write\/completion tools/i,
)

for (const probe of [
  { toolName: 'browser_click_text', args: { text: 'Sign in' }, gateKind: 'login' },
  { toolName: 'browser_click_text', args: { text: 'Captcha verification' }, gateKind: 'captcha' },
  { toolName: 'browser_upload_file', args: { path: '/tmp/resume.pdf' }, gateKind: 'upload_resume' },
  { toolName: 'browser_click_text', args: { text: 'Save resume' }, gateKind: 'save_resume' },
  { toolName: 'browser_click_text', args: { text: 'Submit application' }, gateKind: 'final_submit' },
]) {
  const decision = classifySafetyInvariant({ toolName: probe.toolName, args: probe.args })
  assert.equal(decision.action, 'gate')
  assert.equal(decision.gateKind, probe.gateKind)
}

console.log('A8 safety invariant tests passed')

function fullAuditCoverage() {
  return {
    scope: 'full_audit',
    complete: true,
    auditTool: 'browser_form_audit',
    scrolledTop: true,
    scrolledBottom: true,
    fieldLimitReached: false,
  }
}

function verifiedLedger() {
  return {
    schemaVersion: 'fill-ledger-summary/v1',
    total: 1,
    pending: 0,
    filled: 1,
    verified: 1,
    failed: 0,
    needsUser: 0,
    skipped: 0,
    required: 1,
    pendingRequired: 0,
  }
}

function detailPage() {
  return {
    schemaVersion: 'page-state/v1',
    pageType: 'detail',
    title: 'Role detail',
    url: 'https://example.invalid/jobs/1',
    textSummary: 'A role detail page is visible.',
    formCount: 0,
    inputCount: 0,
    updatedAt: '2026-07-10T00:00:00.000Z',
  }
}
