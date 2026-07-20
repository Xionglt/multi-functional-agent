#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { callBrowserTool, TOOL_DEFINITIONS } from '../dist/tools/index.js'

const observationTools = [
  'browser_snapshot',
  'browser_form_snapshot',
  'browser_form_audit',
  'browser_inspect_options',
  'browser_wait',
  'browser_screenshot',
]
assert.deepEqual(
  TOOL_DEFINITIONS.map((tool) => tool.name).sort(),
  [...observationTools].sort(),
  'the default MCP surface must only advertise observation tools',
)

const mcpClient = new Client({ name: 'm6-boundary-test', version: '1.0.0' })
const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const packageManifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const mcpTransport = new StdioClientTransport({
  command: process.execPath,
  args: ['./dist/server.js'],
  cwd: packageRoot,
  stderr: 'pipe',
})
try {
  await mcpClient.connect(mcpTransport)
  assert.deepEqual(
    mcpClient.getServerVersion(),
    { name: 'web-buddy', version: packageManifest.version },
    'MCP handshake metadata must match the public package release',
  )
} finally {
  await mcpClient.close()
}

let collectorHits = 0
let collectorBody = ''
const collector = createServer((request, response) => {
  collectorHits += 1
  request.setEncoding('utf8')
  request.on('data', (chunk) => {
    collectorBody += chunk
  })
  request.on('end', () => {
    response.writeHead(200, { 'content-type': 'text/plain' })
    response.end('unexpected')
  })
})
await new Promise((resolve) => collector.listen(0, '127.0.0.1', resolve))

try {
  const address = collector.address()
  assert(address && typeof address === 'object')
  const secret = 'm6-mcp-sentinel-do-not-send'
  const denied = await callBrowserTool('browser_open', {
    url: `http://127.0.0.1:${address.port}/collect?secret=${secret}`,
    authorization: `Bearer ${secret}`,
  })
  assert.match(denied, /MCP_POLICY_DENIED/)
  assert.equal(denied.includes(secret), false, 'denial must not echo MCP secrets')
  assert.equal(collectorHits, 0, 'denied MCP navigation must not reach the network')
  assert.equal(collectorBody.includes(secret), false)

  const observation = await callBrowserTool('browser_wait', { for: 'ms', ms: 0 })
  assert.doesNotMatch(observation, /MCP_POLICY_DENIED/, 'observation calls remain available')
  assert.match(observation, /SESSION_NOT_FOUND/)
} finally {
  await new Promise((resolve, reject) => collector.close((error) => error ? reject(error) : resolve()))
}

console.log('security-m6-mcp-boundary-test: PASS (observation-only MCP, mutation/network fail-closed)')
