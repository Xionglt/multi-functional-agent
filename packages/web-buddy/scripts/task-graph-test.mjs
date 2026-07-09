import assert from 'node:assert/strict'
import {
  acquireAgentTaskLock,
  addAgentTask,
  addAgentTaskOutput,
  canRunAgentTask,
  completeAgentTask,
  createAgentTask,
  createAgentTaskGraph,
  createReadOnlySubagentTask,
  getAgentTask,
  getRunnableAgentTasks,
  startAgentTask,
} from '../dist/agents/task-graph.js'

const now = '2026-07-09T00:00:00.000Z'

let graph = createAgentTaskGraph({
  graphId: 'graph-test',
  runId: 'run-test',
  sessionId: 'session-test',
  now,
})

graph = addAgentTask(graph, createAgentTask({
  id: 'main-step',
  kind: 'main_browser_step',
  title: 'Main browser workflow verifies final state',
  now,
}))
graph = addAgentTask(graph, createReadOnlySubagentTask({
  id: 'research',
  kind: 'candidate_job_research',
  title: 'Research candidate jobs from artifacts',
  blockedBy: ['main-step'],
  inputs: [{ kind: 'page_snapshot_artifact', ref: 'snapshot-1' }],
  now,
}))

assert.equal(getAgentTask(graph, 'main-step').accessMode, 'browser_write')
assert.equal(getAgentTask(graph, 'research').accessMode, 'read_only')
assert.equal(getAgentTask(graph, 'research').status, 'blocked')
assert.deepEqual(getAgentTask(graph, 'research').blockedBy, ['main-step'])
assert.deepEqual(getAgentTask(graph, 'main-step').blocks, ['research'])
assert.equal(canRunAgentTask(graph, 'main-step'), true)
assert.equal(canRunAgentTask(graph, 'research'), false)
assert.deepEqual(getRunnableAgentTasks(graph).map((task) => task.id), ['main-step'])

graph = startAgentTask(graph, 'main-step', { now, browserPageId: 'page-a' })
assert.equal(getAgentTask(graph, 'main-step').status, 'running')
assert.equal(graph.safety.browserWriteOwnerTaskId, 'main-step')
assert.equal(graph.locks.filter((lock) => !lock.releasedAt && lock.resource === 'browser_page').length, 1)

graph = addAgentTask(graph, createAgentTask({
  id: 'other-writer',
  kind: 'main_browser_step',
  title: 'A second browser writer',
  now,
}))
assert.throws(
  () => startAgentTask(graph, 'other-writer', { now, browserPageId: 'page-a' }),
  /already locked by main-step/,
  'a second task must not acquire the same browser page write lock',
)
assert.throws(
  () => acquireAgentTaskLock(graph, {
    ownerTaskId: 'research',
    resource: 'browser_page',
    resourceId: 'page-a',
    mode: 'write',
    now,
  }),
  /cannot acquire a browser_page write lock/,
  'read-only subagents must not acquire browser write locks',
)

graph = completeAgentTask(graph, 'main-step', [{
  kind: 'recommendation',
  value: { verifiedBy: 'main workflow' },
}], now)
assert.equal(getAgentTask(graph, 'main-step').status, 'completed')
assert.equal(getAgentTask(graph, 'research').status, 'pending')
assert.equal(canRunAgentTask(graph, 'research'), true)
assert.equal(graph.locks.every((lock) => lock.ownerTaskId !== 'main-step' || lock.releasedAt), true)

assert.throws(
  () => addAgentTaskOutput(graph, 'research', {
    kind: 'recommendation',
    value: 'looks complete',
    authoritativeCompletionEvidence: true,
  }, now),
  /cannot be authoritative completion evidence/,
)

let cyclic = createAgentTaskGraph({
  graphId: 'graph-cycle',
  runId: 'run-cycle',
  sessionId: 'session-cycle',
  now,
})
cyclic = addAgentTask(cyclic, createAgentTask({
  id: 'a',
  kind: 'workflow_evaluation',
  title: 'A',
  now,
}))
cyclic = addAgentTask(cyclic, createAgentTask({
  id: 'b',
  kind: 'memory_retrieval',
  title: 'B',
  blockedBy: ['a'],
  now,
}))
assert.throws(
  () => addAgentTask(cyclic, createAgentTask({
    id: 'c',
    kind: 'trace_summarization',
    title: 'C',
    blockedBy: ['b'],
    blocks: ['a'],
    now,
  })),
  /contains a cycle/,
)

console.log('task-graph-test passed')
