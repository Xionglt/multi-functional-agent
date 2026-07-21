#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAgentRunController } from '../dist/kernel/run-controller.js'
import { AgentRuntime } from '../dist/agent/agent-runtime.js'
import { FileSessionStore } from '../dist/session/index.js'
import { loadConfig } from '../dist/sdk/config.js'
import { createWebTaskRuntimeDriver } from '../dist/sdk/web-task.js'
import { snapshotWebTaskInput } from '../dist/task/contracts.js'

const root = await mkdtemp(join(tmpdir(), 'web-buddy-generic-runtime-entry-'))

try {
  const config = loadConfig()
  config.model.apiKey = 'runtime-entry-test-key'
  config.model.authToken = null
  config.trace.outDir = root
  config.human.permissionMode = 'balanced'

  const externalController = createAgentRunController()
  externalController.abort('cancelled before runtime entry')
  const sanitizer = (value) => value
  const emitted = []
  let runtimeInput
  const agentRuntime = {
    async run(input) {
      runtimeInput = input
      input.onEvent?.({
        schemaVersion: 'agent-runtime-event/v1',
        step: 1,
        level: 'think',
        message: 'Runtime event forwarded.',
      })
      return {
        schemaVersion: 'agent-runtime-result/v1',
        runtime: 'local-agent-loop',
        status: 'aborted',
        steps: 1,
        toolCalls: 0,
        done: false,
        blocked: true,
        paused: false,
        summary: 'Cancelled through the unified runtime entry.',
        stopReason: 'aborted',
        evidence: [],
      }
    },
  }
  const driver = createWebTaskRuntimeDriver({
    config,
    controller: externalController,
    persistenceSanitizer: sanitizer,
    agentRuntime,
  })
  const snapshot = snapshotWebTaskInput({
    schemaVersion: 'web-task-input/v1',
    runId: 'generic-runtime-entry-run',
    revision: 2,
    goal: { instruction: 'Exercise the generic runtime entry.' },
    contract: {
      schemaVersion: 'web-task-contract/v1',
      contractId: 'generic-runtime-entry-contract',
      revision: 2,
      criteria: [{
        id: 'runtime-entry-evidence',
        kind: 'evidence_present',
        description: 'The unified runtime entry may return verified evidence.',
        evidenceKinds: ['runtime_entry'],
        minCount: 1,
        allowedAuthorities: ['main_runtime'],
      }],
    },
  })

  const outcome = await driver.execute({
    schemaVersion: 'web-task-runtime-request/v1',
    input: snapshot,
    contextItems: [],
    runtime: { maxSteps: 3 },
    emit(event) { emitted.push(event) },
  })

  assert(runtimeInput, 'generic WebTask driver bypassed the injected AgentRuntime')
  assert.notEqual(runtimeInput.controller, externalController, 'Kernel received the Control Plane controller directly')
  assert.equal(runtimeInput.controller.signal, externalController.signal)
  assert.equal(runtimeInput.controller.pauseRequested, externalController.pauseRequested)
  assert.equal(runtimeInput.permissionMode, 'balanced')
  assert.equal(runtimeInput.allowFinalSubmit, false)
  assert.equal(runtimeInput.persistenceSanitizer, sanitizer)
  assert.equal(outcome.status, 'cancelled')
  assert(emitted.some((event) => (
    event.type === 'runtime_event'
    && event.data?.level === 'think'
    && event.data?.message === 'Runtime event forwarded.'
  )), 'Agent runtime event was not forwarded')
  assert.equal(
    emitted.some((event) => event.data?.kernelEventType !== undefined),
    false,
    'Kernel migration changed the public WebTask event stream',
  )

  let kernelInput
  const kernelEvidence = [{ id: 'runtime-entry-evidence' }]
  const runtime = new AgentRuntime({
    kernel: {
      async start(input) {
        kernelInput = input
        return {
          schemaVersion: 'agent-kernel-result/v1',
          runtime: 'agent-kernel',
          status: 'blocked',
          stopReason: 'paused',
          steps: 2,
          toolCalls: 1,
          done: false,
          blocked: true,
          paused: true,
          summary: 'Paused at a safe turn boundary.',
          evidence: kernelEvidence,
        }
      },
    },
  })
  const restoredMessages = [{ role: 'user', content: 'Restored message.' }]
  const runtimeController = createAgentRunController()
  const runtimeResult = await runtime.run({
    goal: 'Verify AgentRuntime contract forwarding.',
    llm: { async chatWithTools() { throw new Error('fake kernel must own execution') } },
    ctx: runtimeInput.ctx,
    gate: runtimeInput.gate,
    permissionMode: 'balanced',
    allowFinalSubmit: false,
    restoredMessages,
    persistenceSanitizer: sanitizer,
    controller: runtimeController,
  })
  assert.equal(kernelInput.permissionMode, 'balanced')
  assert.equal(kernelInput.allowFinalSubmit, false)
  assert.equal(kernelInput.restoredMessages, restoredMessages)
  assert.equal(kernelInput.persistenceSanitizer, sanitizer)
  assert.equal(kernelInput.controller, runtimeController)
  assert.equal(runtimeResult.paused, true)
  assert.equal(runtimeResult.evidence, kernelEvidence)

  const failedDriver = createWebTaskRuntimeDriver({
    config,
    durableSession: true,
    sessionId: 'generic-runtime-entry-failed-session',
    agentRuntime: {
      async run() {
        return {
          schemaVersion: 'agent-runtime-result/v1',
          runtime: 'local-agent-loop',
          status: 'failed',
          steps: 0,
          toolCalls: 0,
          done: false,
          blocked: true,
          summary: 'Runtime failed before producing a turn.',
          stopReason: 'unknown',
          evidence: [],
        }
      },
    },
  })
  const failedOutcome = await failedDriver.execute({
    schemaVersion: 'web-task-runtime-request/v1',
    input: snapshot,
    contextItems: [],
    runtime: { maxSteps: 3 },
    emit() {},
  })
  assert.equal(failedOutcome.status, 'failed', 'Kernel failure was downgraded to a blocked outcome')
  const failedSession = await new FileSessionStore({ rootDir: join(root, 'sessions') })
    .get('generic-runtime-entry-failed-session')
  assert.equal(failedSession?.status, 'failed', 'Kernel failure left the durable session non-terminal')
  assert.match(failedSession?.error ?? '', /Runtime failed before producing a turn/)
  const failedTrace = (await readFile(join(root, snapshot.runId, 'trace.jsonl'), 'utf8'))
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line))
  assert(failedTrace.some((step) => (
    step.phase === 'runtime'
    && step.status === 'error'
    && step.action === 'Runtime failed before producing a turn.'
  )), 'Kernel failure disappeared from the legacy runtime trace')
  assert.equal(externalController.status, 'aborted', 'Kernel wrote terminal state into the Control Plane controller')

  console.log('generic-runtime-entry-test: PASS')
} finally {
  await rm(root, { recursive: true, force: true })
}
