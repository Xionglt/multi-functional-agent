import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  executeReadOnlySubagentTool,
  runReadOnlySubagent,
} from '../dist/agents/agent-runner.js'
import {
  createAgentTask,
  createReadOnlySubagentTask,
} from '../dist/agents/task-graph.js'
import {
  FileSessionRecorder,
  FileSessionStore,
  readJsonLines,
} from '../dist/session/index.js'

const root = mkdtempSync(join(tmpdir(), 'mfa-read-only-subagent-'))

try {
  const store = new FileSessionStore({ rootDir: join(root, 'sessions') })
  const session = await store.create({
    sessionId: 'sidechain-session',
    runId: 'sidechain-run',
    source: 'test',
    goal: 'Verify read-only subagent sidechains.',
    now: '2026-07-09T00:00:00.000Z',
  })
  const recorder = new FileSessionRecorder(store, session)

  const researchTask = createReadOnlySubagentTask({
    id: 'research-task',
    kind: 'candidate_job_research',
    title: 'Research jobs from artifacts',
    inputs: [
      { kind: 'page_snapshot_artifact', ref: 'snapshot-1' },
      { kind: 'memory_artifact', ref: 'memory-1' },
    ],
    now: '2026-07-09T00:00:00.000Z',
  })
  const artifacts = [
    {
      kind: 'page_snapshot',
      ref: 'snapshot-1',
      summary: 'Visible job list',
      value: {
        candidates: [
          { title: 'Runtime Engineer', url: 'https://example.test/jobs/runtime' },
          { title: 'Agent Infrastructure Engineer', url: 'https://example.test/jobs/agents' },
        ],
      },
    },
    {
      kind: 'memory',
      ref: 'memory-1',
      summary: 'Candidate prefers runtime systems roles.',
      value: { targetRoles: ['runtime', 'agents'] },
    },
    {
      kind: 'trace',
      ref: 'trace-1',
      summary: 'Previous run stopped before application submit.',
      value: { events: [{ type: 'workflow_updated' }] },
    },
  ]

  const completed = await runReadOnlySubagent({
    task: researchTask,
    runId: session.runId,
    sessionId: session.sessionId,
    outputDir: session.outputDir,
    mainSession: recorder,
    artifacts,
    toolCalls: [
      { id: 'read-page', name: 'read_page_snapshot_artifact', arguments: { ref: 'snapshot-1' } },
      { id: 'read-memory', name: 'read_memory_artifact', arguments: { ref: 'memory-1' } },
    ],
    turnId: 'turn_001',
    now: () => new Date('2026-07-09T00:00:01.000Z'),
  })

  assert.equal(completed.status, 'completed')
  assert.equal(completed.requiresMainWorkflowVerification, true)
  assert.equal(completed.authoritativeCompletionEvidence, false)
  assert.equal(completed.outputs.every((output) => output.requiresMainWorkflowVerification), true)
  assert.equal(completed.outputs.every((output) => output.authoritativeCompletionEvidence === false), true)
  assert.equal(completed.toolResults.every((result) => result.ok), true)
  assert(existsSync(completed.sidechainTranscriptPath), 'sidechain transcript should be written independently')

  const sidechainEntries = await readJsonLines(completed.sidechainTranscriptPath)
  assert(sidechainEntries.some((entry) => entry.type === 'sidechain_started'))
  assert(sidechainEntries.some((entry) => entry.type === 'sidechain_tool_call' && entry.data?.name === 'read_page_snapshot_artifact'))
  assert(sidechainEntries.some((entry) => entry.type === 'sidechain_completed'))

  const transcript = await readJsonLines(session.transcriptPath)
  const sidechainEvidence = transcript.find((entry) => entry.type === 'workflow_evidence' && entry.evidence?.kind === 'sidechain_summary')
  assert(sidechainEvidence, 'main session transcript should record a sidechain summary')
  assert.equal(sidechainEvidence.evidence.data.sidechainTranscriptPath, completed.sidechainTranscriptPath)
  assert.equal(sidechainEvidence.evidence.data.requiresMainWorkflowVerification, true)
  assert.equal(sidechainEvidence.evidence.data.authoritativeCompletionEvidence, false)

  assert.throws(
    () => executeReadOnlySubagentTool({ name: 'browser_upload_file', arguments: { filePath: '/tmp/resume.pdf' } }, artifacts),
    /cannot execute browser\/write\/completion tools/,
  )

  const blockedWrite = await runReadOnlySubagent({
    task: createReadOnlySubagentTask({
      id: 'blocked-write-task',
      kind: 'memory_retrieval',
      title: 'Try a forbidden write',
      now: '2026-07-09T00:00:00.000Z',
    }),
    runId: session.runId,
    sessionId: session.sessionId,
    outputDir: session.outputDir,
    mainSession: recorder,
    artifacts,
    toolCalls: [{ id: 'write-attempt', name: 'browser_type', arguments: { ref: 'e1', text: 'nope' } }],
  })
  assert.equal(blockedWrite.status, 'failed')
  assert.equal(blockedWrite.toolResults[0].ok, false)
  assert.match(blockedWrite.error, /cannot execute browser\/write\/completion tools/)

  const badEvidence = await runReadOnlySubagent({
    task: createReadOnlySubagentTask({
      id: 'bad-evidence-task',
      kind: 'trace_summarization',
      title: 'Try authoritative completion evidence',
      now: '2026-07-09T00:00:00.000Z',
    }),
    runId: session.runId,
    sessionId: session.sessionId,
    outputDir: session.outputDir,
    mainSession: recorder,
    artifacts,
    handler: async () => ({
      summary: 'Looks complete, incorrectly.',
      outputs: [{
        kind: 'trace_summary',
        value: 'complete',
        authoritativeCompletionEvidence: true,
      }],
    }),
  })
  assert.equal(badEvidence.status, 'failed')
  assert.match(badEvidence.error, /cannot emit authoritative completion evidence/)

  await assert.rejects(
    () => runReadOnlySubagent({
      task: createAgentTask({
        id: 'main-task',
        kind: 'main_browser_step',
        title: 'Main browser task is not a subagent task',
        now: '2026-07-09T00:00:00.000Z',
      }),
      runId: session.runId,
      sessionId: session.sessionId,
      outputDir: session.outputDir,
      artifacts,
    }),
    /not allowed in the read-only subagent runner/,
  )

  console.log('read-only-subagent-test passed')
} finally {
  rmSync(root, { recursive: true, force: true })
}
