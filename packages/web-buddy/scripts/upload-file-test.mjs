#!/usr/bin/env node
import assert from 'node:assert/strict'
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { browserFormSnapshot } from '../dist/browser/form-snapshot.js'
import { browserOpen } from '../dist/browser/open.js'
import { browserUploadFile } from '../dist/browser/upload-file.js'
import { sessionManager } from '../dist/session/manager.js'

process.env.PLAYWRIGHT_HEADLESS = 'true'
process.env.PLAYWRIGHT_ALLOW_DATA_URLS = 'true'
process.env.PLAYWRIGHT_ACTION_TIMEOUT_MS = '500'

const root = mkdtempSync(join(tmpdir(), 'mfa-upload-file-'))
const filePath = join(root, 'resume.pdf')
writeFileSync(filePath, '%PDF-1.4\n% test\n')

try {
  const html = `<!doctype html><html><body>
    <button id="plain" onclick="window.applyClicks = (window.applyClicks || 0) + 1">投递简历</button>
    <input id="actual-upload" type="file">
    <input id="button-upload-input" type="file">
    <button id="upload-button" type="button" onclick="document.getElementById('button-upload-input').click()">上传简历</button>
  </body></html>`
  const open = await browserOpen({
    sessionId: 'upload-file-test',
    url: `data:text/html;charset=utf-8,${encodeURIComponent(html)}`,
    waitUntil: 'domcontentloaded',
  })
  assert.equal(open.ok, true, open.observation)

  const formSnapshot = await browserFormSnapshot({ sessionId: 'upload-file-test' })
  assert.equal(formSnapshot.ok, true, formSnapshot.observation)
  assert.equal(formSnapshot.data.uploadHints.some((hint) => hint.text === '投递简历'), false)
  assert(formSnapshot.data.uploadHints.some((hint) => hint.type === 'file'))
  assert(formSnapshot.data.uploadHints.some((hint) => hint.text === '上传简历'))

  const wrongTarget = await browserUploadFile({
    sessionId: 'upload-file-test',
    filePath,
    selector: '#plain',
    confirmed: true,
    timeoutMs: 500,
  })
  assert.equal(wrongTarget.ok, false)
  assert.equal(wrongTarget.error.code, 'INVALID_ARGUMENT')
  assert.match(wrongTarget.error.message, /not a valid upload target/i)
  assert.equal(wrongTarget.error.recoverable, true)
  assert(wrongTarget.error.suggestedNextActions.includes('browser_snapshot'))
  assert(wrongTarget.error.suggestedNextActions.includes('browser_form_snapshot'))
  assert(wrongTarget.error.suggestedNextActions.some((action) => /real upload entry|真实上传入口/i.test(action)))

  const wrongTextTarget = await browserUploadFile({
    sessionId: 'upload-file-test',
    filePath,
    text: '投递简历',
    confirmed: true,
    timeoutMs: 500,
  })
  assert.equal(wrongTextTarget.ok, false)
  assert.equal(wrongTextTarget.error.code, 'INVALID_ARGUMENT')

  const applyClicks = await sessionManager.get('upload-file-test').page.evaluate(() => window.applyClicks || 0)
  assert.equal(applyClicks, 0)

  const actualInput = await browserUploadFile({
    sessionId: 'upload-file-test',
    filePath,
    selector: '#actual-upload',
    confirmed: true,
    timeoutMs: 500,
  })
  assert.equal(actualInput.ok, true, actualInput.observation)

  const uploadButton = await browserUploadFile({
    sessionId: 'upload-file-test',
    filePath,
    selector: '#upload-button',
    confirmed: true,
    timeoutMs: 500,
  })
  assert.equal(uploadButton.ok, true, uploadButton.observation)

  console.log('upload-file-test: PASS')
} finally {
  await sessionManager.closeAll().catch(() => {})
  rmSync(root, { recursive: true, force: true })
}
