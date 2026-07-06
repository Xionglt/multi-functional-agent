import assert from 'node:assert/strict'

import {
  createRunMemory,
  renderRunMemory,
  updateRunMemoryFromModel,
  updateRunMemoryFromTool,
} from '../dist/context/run-memory.js'

const memory = createRunMemory('2026-07-06T00:00:00.000Z')

assert.equal(updateRunMemoryFromTool({
  memory,
  toolName: 'browser_type',
  args: { ref: 'searchbox', text: 'React' },
  result: { observation: 'Typed into search field.', pageChanged: false },
  ok: true,
  now: '2026-07-06T00:00:01.000Z',
}), true)

assert.equal(updateRunMemoryFromTool({
  memory,
  toolName: 'browser_snapshot',
  args: {},
  result: { observation: 'No results found for this query. Try another keyword.', pageChanged: false },
  ok: true,
  now: '2026-07-06T00:00:02.000Z',
}), true)

assert.deepEqual(memory.searchedKeywords, ['React'])
assert.deepEqual(memory.emptyResultKeywords, ['React'])

assert.equal(updateRunMemoryFromModel({
  memory,
  content: [
    '候选岗位: AI Agent 研发工程师 | reason=matches agent/runtime/backend experience.',
    '候选岗位: Web Platform Engineer | reason=matches frontend platform work.',
    '排除: Hardware Frontend Engineer | reason=embedded hardware frontend is not a fit.',
    'current best candidate: AI Agent 研发工程师 | reason=strongest fit.',
  ].join('\n'),
  now: '2026-07-06T00:00:03.000Z',
}), true)

assert(memory.candidateJobs.some((job) => job.title.includes('AI Agent 研发工程师')))
assert(memory.excludedCandidates.some((job) => job.title.includes('Hardware Frontend Engineer')))
assert.equal(memory.currentBestCandidate?.title.includes('AI Agent 研发工程师'), true)

const rendered = renderRunMemory(memory)
assert(rendered.includes('emptyResultKeywords: React'))
assert(rendered.includes('candidateJobs:'))
assert(rendered.includes('currentBestCandidate:'))

console.log('run-memory-test: PASS')
