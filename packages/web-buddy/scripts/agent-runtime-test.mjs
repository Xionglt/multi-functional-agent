#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentRuntime } from '../dist/agent/agent-runtime.js'
import { ToolRegistry } from '../dist/runtime/local/tool-registry.js'
import { runAgentLoop } from '../dist/runtime/local/agent-loop.js'
import { AutoHumanGate } from '../dist/sdk/human.js'
import { TraceRecorder } from '../dist/sdk/trace.js'
import { sessionManager } from '../dist/session/manager.js'

process.env.PLAYWRIGHT_HEADLESS = 'true'
process.env.PLAYWRIGHT_ALLOWED_DOMAINS = 'runtime.example.test'
process.env.PLAYWRIGHT_TYPE_DELAY_MS = '0'
process.env.PLAYWRIGHT_SLOWMO_MS = '0'
process.env.AGENT_TRACE_MODE = 'redacted'

const html = `<!doctype html><html><body>
  <h1>Runtime Test Form</h1>
  <label for="name">Full Name</label><input id="name" type="text" required />
  <label for="email">Email</label><input id="email" type="email" required />
  <button type="button">Save draft</button>
</body></html>`
const formUrl = 'https://runtime.example.test/form'

const profile = {
  name: 'Zhang San',
  email: 'zhangsan@example.com',
  phone: '13800001234',
  location: 'Hangzhou',
  summary: 'Frontend engineer',
  skills: ['TypeScript', 'Playwright'],
  experience: [{ title: 'Engineer', company: 'Example Inc.', period: '2022-now' }],
  education: [{ degree: 'BS', major: 'Computer Science', school: 'Example University' }],
  keywords: [],
  source: 'json',
}

class RuntimeMockLlm {
  constructor(sessionId) {
    this.sessionId = sessionId
    this.hasKey = true
    this.label = 'runtime-mock-llm'
    this.turn = 0
    this.sawPoisonFreePrompt = false
    this.sawTaskStatePrompt = false
  }

  findRef(regex) {
    const snap = sessionManager.get(this.sessionId)?.latestSnapshot
    assert(snap, 'mock expected latest snapshot after browser_open')
    for (const [ref, stored] of snap.refMap) {
      const hay = [stored.name, stored.text, stored.aria].filter(Boolean).join(' ')
      if (regex.test(hay) && (stored.tag === 'input' || stored.tag === 'textarea')) return ref
    }
    return undefined
  }

  async chatWithTools(messages) {
    const rendered = JSON.stringify(messages)
    assert(!rendered.includes('POISON ARTIFACT'), 'AgentRuntime must not read trace artifact files into prompts')
    this.sawPoisonFreePrompt = true
    if (rendered.includes('## TASK_STATE') && rendered.includes('source: derived_from_workflow')) {
      this.sawTaskStatePrompt = true
    }
    if (rendered.includes('PREMATURE_AGENT_DONE_REJECTED')) {
      return { content: 'No further safe work.', toolCalls: [] }
    }

    this.turn += 1
    if (this.turn === 1) {
      return {
        content: 'Open the local test form.',
        toolCalls: [{ id: 'runtime-open', name: 'browser_open', arguments: { url: formUrl, waitUntil: 'domcontentloaded' } }],
      }
    }
    if (this.turn === 2) {
      const ref = this.findRef(/full name|name/i)
      assert(ref, 'mock could not find Full Name ref')
      return {
        content: 'Fill the name field.',
        toolCalls: [{ id: 'runtime-type', name: 'browser_type', arguments: { ref, text: profile.name } }],
      }
    }
    return {
      content: 'Done.',
      toolCalls: [{ id: 'runtime-done', name: 'agent_done', arguments: { summary: 'Filled the name field.', blocked: false } }],
    }
  }
}

class DoneOnlyMockLlm {
  constructor() {
    this.hasKey = true
    this.label = 'done-only-mock-llm'
  }

  async chatWithTools(messages) {
    if (JSON.stringify(messages).includes('PREMATURE_AGENT_DONE_REJECTED')) {
      return { content: 'Direct loop acknowledged completion rejection.', toolCalls: [] }
    }
    return {
      content: 'Direct loop still works.',
      toolCalls: [{ id: 'loop-done', name: 'agent_done', arguments: { summary: 'Old runAgentLoop entry works.', blocked: false } }],
    }
  }
}

const root = mkdtempSync(join(tmpdir(), 'mfa-agent-runtime-'))
const trace = new TraceRecorder(root, {
  runId: 'agent-runtime-test',
  source: 'local-runtime',
  scenario: 'agent-runtime-test',
  profile: 'test',
  goal: 'Run AgentRuntime facade test.',
})
assert(trace.agentTrace, 'agent-runtime test expected an active agent trace session')
trace.agentTrace.writeArtifact('page-state-latest.json', JSON.stringify({ title: 'POISON ARTIFACT PAGE' }))
trace.agentTrace.writeArtifact('form-state-latest.json', JSON.stringify({ fields: [{ label: 'POISON ARTIFACT FIELD' }] }))

try {
  const runtimeSessionId = 'agent-runtime-test'
  const runtimeMock = new RuntimeMockLlm(runtimeSessionId)
  const events = []
  const runtime = new AgentRuntime()
  const runtimePage = (await sessionManager.getOrCreate(runtimeSessionId)).page
  await runtimePage.route(formUrl, (route) => route.fulfill({
    status: 200,
    contentType: 'text/html; charset=utf-8',
    body: html,
  }))
  const draftSinkRule = {
    id: 'agent-runtime-explicit-draft-sinks',
    actionKinds: ['navigate', 'type_or_paste'],
    decision: 'ask',
    destinationOrigins: ['https://runtime.example.test'],
    requireApprovalBinding: true,
  }
  const result = await runtime.run({
    goal: 'Fill the current form with my resume. Do not submit.',
    resume: profile,
    llm: runtimeMock,
    ctx: { sessionId: runtimeSessionId, highlight: false, trace },
    gate: new AutoHumanGate(),
    maxSteps: 5,
    taskContract: {
      schemaVersion: 'web-task-contract/v1',
      contractId: 'agent-runtime-form-contract',
      revision: 0,
      criteria: [
        {
          id: 'runtime-form-complete',
          kind: 'form_state',
          description: 'Every required runtime fixture field must be filled after a full audit.',
          requireFullAudit: true,
          requiredFieldCoverage: 1,
          allowVisibleErrors: false,
          requireDraftOnly: true,
        },
        {
          id: 'runtime-submit-not-performed',
          kind: 'action_boundary',
          description: 'The runtime fixture must not submit the form.',
          actionKinds: ['submit'],
          outcome: 'not_performed',
        },
      ],
      sensitiveActions: [
        draftSinkRule,
        {
          id: 'agent-runtime-submit-denied',
          actionKinds: ['submit'],
          decision: 'deny',
          destinationOrigins: ['https://runtime.example.test'],
          requireApprovalBinding: true,
        },
      ],
    },
    taskPolicy: {
      schemaVersion: 'task-policy/v1',
      defaultSensitiveAction: 'deny',
      rules: [draftSinkRule],
    },
    onEvent: (event) => events.push(event),
  })

  assert.equal(result.schemaVersion, 'agent-runtime-result/v1')
  assert(result.steps > 0, 'AgentRuntime result should include steps > 0')
  assert(result.toolCalls > 0, 'AgentRuntime result should include toolCalls > 0')
  assert.equal(result.done, false)
  assert.equal(result.blocked, false)
  assert.equal(result.stopReason, 'step_budget')
  assert.match(result.summary, /Reached step budget/i)
  assert(runtimeMock.sawPoisonFreePrompt, 'mock should have inspected runtime prompts')
  assert(runtimeMock.sawTaskStatePrompt, 'PromptAssembler should mark loop TaskState as derived from WorkflowState')
  assert(events.some((event) => event.schemaVersion === 'agent-runtime-event/v1'), 'runtime events should be wrapped')
  assert(
    events.some((event) => event.level === 'gate' && /completion_gate rejected/i.test(event.message)),
    'runtime events should surface completion gate rejections',
  )

  const directLoopResult = await runAgentLoop({
    goal: 'Prove old runAgentLoop entry still works.',
    resume: profile,
    llm: new DoneOnlyMockLlm(),
    registry: new ToolRegistry(),
    ctx: { sessionId: 'agent-runtime-direct-loop-test', highlight: false, trace },
    gate: new AutoHumanGate(),
    maxSteps: 2,
  })
  assert.equal(directLoopResult.done, true, 'runAgentLoop old entry should still return done=true')
  assert.equal(directLoopResult.blocked, false, 'runAgentLoop should return control after completion evidence is missing')
  assert.match(directLoopResult.summary, /acknowledged completion rejection/i)
  assert(directLoopResult.toolCalls > 0, 'runAgentLoop old entry should still dispatch tools')

  trace.finish()
  console.log('agent-runtime-test: PASS')
} finally {
  await sessionManager.closeAll().catch(() => {})
  rmSync(root, { recursive: true, force: true })
}
