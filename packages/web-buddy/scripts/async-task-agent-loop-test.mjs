#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AsyncTaskRuntime } from '../dist/agents/async-task-runtime.js'
import { RunnerRegistry } from '../dist/agents/runner-registry.js'
import { AgentTaskScheduler } from '../dist/agents/task-scheduler.js'
import { FileTaskGraphStore } from '../dist/agents/task-graph-store.js'
import { TaskNotificationQueue } from '../dist/agents/task-notification-queue.js'
import { runAgentLoop, toolsForSafetyMode } from '../dist/runtime/local/agent-loop.js'
import { ToolRegistry } from '../dist/runtime/local/tool-registry.js'
import { createLocalTools } from '../dist/tools/local-adapter.js'
import { TraceRecorder } from '../dist/sdk/trace.js'
import { FileSessionRecorder, FileSessionStore, readJsonLines, restoreSessionState } from '../dist/session/index.js'

const root = await mkdtemp(join(tmpdir(), 'web-buddy-async-loop-'))
const sessionId = 'async-loop-session'
const runId = 'async-loop-run'

try {
  const taskStore = new FileTaskGraphStore({ rootDir: join(root, 'task-graphs') })
  const notifications = new TaskNotificationQueue()
  let releaseEvaluation
  const evaluationMayFinish = new Promise((resolve) => { releaseEvaluation = resolve })
  const runner = {
    contractVersion: 'agent-task-runner/v1',
    runnerId: 'async-loop-runner',
    kinds: ['workflow_evaluation'],
    runnerVersion: '1.0.0',
    capacityClass: 'deterministic',
    runnerKind: 'deterministic',
    async run(request, control) {
      const outcome = await Promise.race([
        evaluationMayFinish.then(() => 'released'),
        new Promise((resolve) => control.abortSignal.addEventListener('abort', () => resolve('aborted'), { once: true })),
      ])
      if (outcome === 'aborted') return { schemaVersion: 'agent-task-run-outcome/v1', outcome: 'aborted', reason: 'signal' }
      return {
        schemaVersion: 'agent-task-run-outcome/v1',
        outcome: 'succeeded_deterministic',
        result: {
          schemaVersion: 'deterministic-task-result/v1',
          runIdentity: request.runIdentity,
          outputRefs: [artifactRef(`result-${request.task.id}`, 'runner_result', request.task.actionBinding)],
          freshness: { kind: 'assessed', sourceActionSeq: 1, assessedAgainstActionSeq: 1, validity: 'unverified' },
          requiresMainWorkflowVerification: true,
          authoritativeCompletionEvidence: false,
        },
      }
    },
  }
  const runners = new RunnerRegistry([runner])
  const runtime = new AsyncTaskRuntime({
    sessionId,
    runId,
    store: taskStore,
    notifications,
    scheduler: (bindings) => new AgentTaskScheduler({
      store: taskStore,
      notifications,
      registry: runners,
      ...bindings,
    }),
    mainVerificationProvider: async (graph) => ({
      mainWorkflowEvidenceRefs: [artifactRef('main-workflow-evidence', 'trace', {
        kind: 'browser_action',
        sourceActionSeq: graph.actionClock.currentActionSeq,
      })],
      verifiedAgainstActionSeq: graph.actionClock.currentActionSeq,
    }),
  })

  const pageChanges = []
  const registry = new ToolRegistry([
    ...createLocalTools(),
    {
      name: 'browser_wait',
      description: 'Test-only Main Agent browser action.',
      category: 'action',
      parameters: { type: 'object', properties: {} },
      inherentRisk: 'L0',
      async run() {
        pageChanges.push(Date.now())
        if (pageChanges.length === 2) releaseEvaluation()
        return { observation: `test page changed\n${'X'.repeat(12_000)}`, pageChanged: true }
      },
    },
  ])
  assert.equal(toolNames(toolsForSafetyMode(registry, 'raw')).some((name) => name.startsWith('agent_task_')), false)
  assert.equal(toolNames(toolsForSafetyMode(registry, 'raw', true)).filter((name) => name.startsWith('agent_task_')).length, 5)
  const llm = scriptedAsyncLlm()
  const trace = new TraceRecorder(root, {
    runId,
    source: 'local-runtime',
    scenario: 'async-task-agent-loop-test',
    profile: 'test',
    goal: 'Verify async task orchestration in the Main Agent loop.',
  })
  const sessionStore = new FileSessionStore({ rootDir: join(root, 'sessions') })
  const session = await sessionStore.create({
    sessionId,
    runId,
    source: 'test',
    goal: 'Verify async task orchestration in the Main Agent loop.',
  })
  const recorder = new FileSessionRecorder(sessionStore, session)
  const gateInputs = []
  const completionGate = {
    evaluate(input) {
      gateInputs.push(structuredClone(input))
      if (!input.done) return gateDecision('ignore', 'unchanged', 'not done')
      if (input.mainCompletionReadiness?.state === 'blocked_required_tasks') {
        return gateDecision('reject', 'unchanged', 'required async tasks are incomplete')
      }
      if (!input.mainCompletionReadiness) return gateDecision('reject', 'unchanged', 'missing async readiness')
      return gateDecision('allow', 'completed', 'main verification accepted')
    },
  }

  const result = await runAgentLoop({
    goal: 'Run a required background evaluation while the Main Agent continues.',
    resume: { skills: [], experience: [], education: [], keywords: [], source: 'json' },
    llm,
    registry,
    ctx: { sessionId, highlight: false, trace, asyncTaskRuntime: runtime },
    gate: { async confirm() { return 'approve' } },
    completionGate,
    safetyMode: 'raw',
    taskType: 'explore',
    maxSteps: 8,
    session: recorder,
    contextBudget: { maxInputTokens: 1_200, compactThresholdRatio: 1, keepRecentMessages: 4 },
    semanticCompaction: { enabled: false },
  })

  const graph = await runtime.snapshot()
  const task = graph.tasks[0]
  const transcript = await readJsonLines(session.transcriptPath)
  const restored = await restoreSessionState(session)

  assert.equal(result.done, true)
  assert.equal(result.blocked, false)
  assert.equal(pageChanges.length, 2)
  assert.equal(graph.actionClock.currentActionSeq, 2)
  assert.equal(task?.status, 'completed')
  assert.equal(task?.outputs[0]?.freshness?.validity, 'stale')
  assert(llm.promptSnapshots.some((messages) => messages.some((message) => /ASYNC_TASK_UPDATES/.test(message.content ?? ''))))
  assert(llm.promptSnapshots.some((messages) => messages.some((message) => /currentActionSeq=2/.test(message.content ?? ''))))
  assert(!llm.promptSnapshots.some((messages) => messages.some((message) => /sidechain_(assistant|tool_call)/.test(message.content ?? ''))))
  assert(transcript.some((entry) => entry.type === 'async_task_notification_attachment'))
  assert(transcript.some((entry) => entry.type === 'context_compaction' && entry.summary?.agentTasks?.length > 0))
  assert.equal(restored.asyncTaskPromptAttachments.length, 1)
  assert(gateInputs.some((input) => input.mainCompletionReadiness?.state === 'eligible_for_main_verification'))
  assert(gateInputs.every((input) => input.summaryAuthority === 'main_agent'))
  assert.equal(graph.notificationOutbox.every((entry) => entry.state === 'acknowledged'), true)

  const resumedNotifications = new TaskNotificationQueue()
  const resumedRuntime = new AsyncTaskRuntime({
    sessionId,
    runId,
    store: taskStore,
    notifications: resumedNotifications,
    scheduler: (bindings) => new AgentTaskScheduler({
      store: taskStore,
      notifications: resumedNotifications,
      registry: runners,
      ...bindings,
    }),
    mainVerificationProvider: async (current) => ({
      mainWorkflowEvidenceRefs: [artifactRef('resumed-main-evidence', 'trace', {
        kind: 'browser_action',
        sourceActionSeq: current.actionClock.currentActionSeq,
      })],
      verifiedAgainstActionSeq: current.actionClock.currentActionSeq,
    }),
  })
  const resumedLlm = {
    hasKey: true,
    label: 'resumed-async-loop',
    async chatWithTools() {
      return call('resumed-done', 'agent_done', { summary: 'Resumed run verified prior task facts.', blocked: false })
    },
  }
  const resumedResult = await runAgentLoop({
    goal: 'Resume and verify the completed asynchronous work.',
    resume: { skills: [], experience: [], education: [], keywords: [], source: 'json' },
    llm: resumedLlm,
    registry,
    ctx: { sessionId, highlight: false, trace, asyncTaskRuntime: resumedRuntime },
    gate: { async confirm() { return 'approve' } },
    completionGate,
    safetyMode: 'raw',
    taskType: 'explore',
    maxSteps: 2,
    session: recorder,
    restoredMessages: restored.restoredMessages,
    restoredAsyncTaskPromptAttachments: restored.asyncTaskPromptAttachments,
  })
  const transcriptAfterResume = await readJsonLines(session.transcriptPath)
  assert.equal(resumedResult.done, true)
  assert.equal(transcriptAfterResume.filter((entry) => entry.type === 'async_task_notification_attachment').length, 1)

  trace.finish()
  console.log('async-task Main Agent loop integration test passed')
} finally {
  await rm(root, { recursive: true, force: true })
}

function scriptedAsyncLlm() {
  return {
    hasKey: true,
    label: 'scripted-async-loop',
    index: 0,
    promptSnapshots: [],
    taskId: undefined,
    async chatWithTools(messages) {
      this.promptSnapshots.push(structuredClone(messages))
      this.index += 1
      if (this.index === 1) return call('page-1', 'browser_wait', {})
      if (this.index === 2) {
        return call('spawn-1', 'agent_task_spawn', {
        kind: 'workflow_evaluation',
        title: 'Required workflow evaluation',
        goal: 'Evaluate the immutable workflow facts.',
        idempotencyKey: 'required-evaluation:v1',
        requiredForCompletion: true,
        terminalPolicy: 'must_complete_successfully',
      })
      }
      if (this.index === 3) return call('page-2', 'browser_wait', {})
      if (this.index === 4) return { content: 'The main work is done; I will stop now.', toolCalls: [] }
      if (this.index === 5) {
        const rendered = messages.map((message) => message.content ?? '').join('\n')
        this.taskId = rendered.match(/taskId=([^\s]+)/)?.[1]
        assert(this.taskId, 'notification should expose the completed task id')
        return call('result-1', 'agent_task_result', { taskId: this.taskId })
      }
      return call('done-1', 'agent_done', { summary: 'Main work and required evaluation are complete.', blocked: false })
    },
  }
}

function call(id, name, args) {
  return { content: `Calling ${name}.`, toolCalls: [{ id, name, arguments: args }] }
}

function artifactRef(artifactId, artifactKind, actionBinding = { kind: 'not_action_bound' }) {
  const bytes = Buffer.from(artifactId)
  return {
    schemaVersion: 'immutable-artifact-ref/v1',
    artifactId,
    artifactKind,
    runId,
    sessionId,
    storage: { store: 'session_artifacts', relativeSegments: [`${artifactId}.json`] },
    mediaType: 'application/json',
    byteLength: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    createdAt: new Date().toISOString(),
    actionBinding,
    immutable: true,
  }
}

function gateDecision(action, recommendedStatus, reason) {
  return {
    schemaVersion: 'completion-gate-decision/v1',
    action,
    recommendedStatus,
    reason,
    missingCriteria: [],
    blockers: [],
    evidenceIds: [],
  }
}

function toolNames(tools) {
  return tools.map((tool) => tool.function.name)
}
