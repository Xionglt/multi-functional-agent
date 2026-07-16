#!/usr/bin/env node
import assert from 'node:assert/strict'
import { TOOL_CATALOG } from '../dist/tools/catalog.js'
import {
  FAIL_CLOSED_TOOL_EXECUTION_POLICY_V1,
  resolveToolExecutionPolicy,
} from '../dist/tools/tool-execution-policy.js'

const parallelPolicy = {
  schemaVersion: 'tool-execution-policy/v1',
  readOnly: true,
  foreground: 'parallel',
  resource: 'none',
  interruptBehavior: 'cancel',
  background: 'never',
  defaultTimeoutMs: 30_000,
}
const browserPolicy = {
  schemaVersion: 'tool-execution-policy/v1',
  readOnly: true,
  foreground: 'exclusive',
  resource: 'browser_session',
  interruptBehavior: 'block',
  background: 'never',
}
const runStatePolicy = {
  schemaVersion: 'tool-execution-policy/v1',
  readOnly: false,
  foreground: 'exclusive',
  resource: 'run_state',
  interruptBehavior: 'block',
  background: 'never',
}

function resolve(overrides = {}) {
  const diagnostics = []
  const policy = resolveToolExecutionPolicy({
    toolName: 'fixture_tool',
    arguments: {},
    sessionId: 's-7',
    catalogPolicy: parallelPolicy,
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    ...overrides,
  })
  return { policy, diagnostics }
}

const parallel = resolve()
assert.deepEqual(parallel.policy, { ...parallelPolicy, source: 'catalog' })
assert.deepEqual(parallel.diagnostics, [])

const browser = resolve({ toolName: 'browser_snapshot', catalogPolicy: browserPolicy })
assert.deepEqual(browser.policy, { ...browserPolicy, resourceKey: 'browser:s-7', source: 'catalog' })
assert.deepEqual(browser.diagnostics, [])

const resolver = resolve({ resolver: () => runStatePolicy })
assert.equal(resolver.policy.source, 'resolver')
assert.equal(resolver.policy.foreground, 'exclusive')

for (const fixture of [
  { name: 'missing', catalogPolicy: undefined, code: 'TOOL_POLICY_MISSING' },
  {
    name: 'invalid schema',
    catalogPolicy: { ...parallelPolicy, schemaVersion: 'tool-execution-policy/v2' },
    code: 'TOOL_POLICY_INVALID',
  },
  {
    name: 'parallel shared resource',
    catalogPolicy: { ...parallelPolicy, resource: 'browser_session' },
    code: 'TOOL_POLICY_INVALID',
  },
  {
    name: 'background mutable resource',
    catalogPolicy: { ...runStatePolicy, background: 'eligible' },
    code: 'TOOL_POLICY_INVALID',
  },
  {
    name: 'bad timeout',
    catalogPolicy: { ...parallelPolicy, defaultTimeoutMs: 0 },
    code: 'TOOL_POLICY_INVALID',
  },
  {
    name: 'mismatched browser key',
    catalogPolicy: { ...browserPolicy, resourceKey: 'browser:other' },
    code: 'TOOL_POLICY_INVALID',
  },
  {
    name: 'async resolver',
    resolver: async () => parallelPolicy,
    code: 'TOOL_POLICY_INVALID',
  },
]) {
  const outcome = resolve(fixture)
  assert.strictEqual(outcome.policy, FAIL_CLOSED_TOOL_EXECUTION_POLICY_V1, fixture.name)
  assert.equal(outcome.diagnostics.length, 1, fixture.name)
  assert.equal(outcome.diagnostics[0].code, fixture.code, fixture.name)
}

const resolverThrow = resolve({
  resolver: () => {
    throw new Error('resolver exploded')
  },
})
assert.strictEqual(resolverThrow.policy, FAIL_CLOSED_TOOL_EXECUTION_POLICY_V1)
assert.equal(resolverThrow.diagnostics[0].code, 'TOOL_POLICY_RESOLVER_FAILED')
assert.match(resolverThrow.diagnostics[0].message, /resolver exploded/)

const metadataCannotAuthorize = resolve({
  toolName: 'legacy_observation',
  catalogPolicy: undefined,
  arguments: {},
  metadata: { readOnly: true, risk: 'L0', category: 'observation' },
})
assert.strictEqual(metadataCannotAuthorize.policy, FAIL_CLOSED_TOOL_EXECUTION_POLICY_V1)

assert.doesNotThrow(() =>
  resolveToolExecutionPolicy({
    toolName: 'missing_with_broken_diagnostic_sink',
    arguments: {},
    catalogPolicy: undefined,
    onDiagnostic: () => {
      throw new Error('diagnostic sink failed')
    },
  }),
)

const browserNames = TOOL_CATALOG.map((tool) => tool.name).filter((name) => name.startsWith('browser_'))
assert(browserNames.length > 0)
for (const toolName of browserNames) {
  const catalogTool = TOOL_CATALOG.find((tool) => tool.name === toolName)
  assert(catalogTool, toolName)
  assert.equal(catalogTool.execution.foreground, 'exclusive', toolName)
  assert.equal(catalogTool.execution.resource, 'browser_session', toolName)
  assert.equal(catalogTool.execution.background, 'never', toolName)
  const outcome = resolve({ toolName, catalogPolicy: catalogTool.execution })
  assert.equal(outcome.policy.foreground, 'exclusive', toolName)
  assert.equal(outcome.policy.resource, 'browser_session', toolName)
  assert.equal(outcome.policy.resourceKey, 'browser:s-7', toolName)
  assert.equal(outcome.policy.background, 'never', toolName)
}

assert.deepEqual(
  TOOL_CATALOG.filter((tool) => tool.execution.foreground === 'parallel').map((tool) => tool.name),
  ['resume_query'],
)

const proposedCatalogPolicies = new Map(
  TOOL_CATALOG.map((tool) => {
    if (tool.name === 'resume_query') return [tool.name, parallelPolicy]
    if (tool.name.startsWith('browser_') || tool.name === 'job_match_candidates') return [tool.name, browserPolicy]
    return [tool.name, runStatePolicy]
  }),
)
assert.deepEqual(
  [...proposedCatalogPolicies.entries()]
    .filter(([, policy]) => policy.foreground === 'parallel')
    .map(([name]) => name),
  ['resume_query'],
)
assert.equal(
  [...proposedCatalogPolicies.values()].some((policy) => policy.background === 'eligible'),
  false,
)

console.log(
  JSON.stringify({
    ok: true,
    browserToolsChecked: browserNames.length,
    catalogToolsChecked: TOOL_CATALOG.length,
    parallelAllowlist: ['resume_query'],
    diagnosticsChecked: 8,
  }),
)
