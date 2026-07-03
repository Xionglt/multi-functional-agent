#!/usr/bin/env node
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium } from 'playwright'
import { inspectDirectSubmitReviewPage } from '../dist/workflow/direct-submit.js'
import { ensureAlibabaApplicationNoticeAccepted } from '../dist/sdk/alibaba.js'
import { collectPageFacts } from '../dist/browser/page-facts.js'
import { browserFormSnapshot } from '../dist/browser/form-snapshot.js'
import { browserOpen } from '../dist/browser/open.js'
import { browserSnapshot } from '../dist/browser/snapshot.js'
import { sessionManager } from '../dist/session/manager.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixtureDir = join(__dirname, 'fixtures', 'direct-submit-flow')
process.env.PLAYWRIGHT_ALLOW_DATA_URLS = 'true'
process.env.PLAYWRIGHT_HEADLESS = 'true'
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage()

try {
  await page.goto(fixtureUrl('direct-submit-review.html'))
  const direct = await inspectDirectSubmitReviewPage(page)
  assert.equal(direct.detected, true)
  assert.equal(direct.nextStep, 'final_submit')
  assert.equal(direct.signals.loginWall, false)
  assert.equal(direct.signals.realFillableFieldCount, 0)
  assert.equal(direct.signals.agreementCheckboxCount, 1)
  assert.equal(direct.signals.submitApplyButtonCount, 1)
  assert.match(direct.userMessage ?? '', /在线简历\/直接投递模式/)
  assert.match(direct.userMessage ?? '', /没有可填写/)
  assert.match(direct.userMessage ?? '', /final_submit/)
  const directFacts = await collectPageFacts(page)
  assert.equal(directFacts.hasAgreementCheckbox, true)
  assert.equal(directFacts.agreementChecked, false)
  assert.equal(directFacts.hasRealUploadInput, false)
  assert(directFacts.likelyFinalSubmitButtons.some((button) => button.text === '确认投递'))
  assert.equal(directFacts.likelyApplyEntryButtons.length, 0)
  const formFactsHtml = `<!doctype html><html lang="zh"><body>
    <form>
      <label><input type="checkbox" id="agree"> 我已阅读并同意申请工作需知</label>
      <button type="submit">确认投递</button>
    </form>
  </body></html>`
  const formFactsOpen = await browserOpen({
    sessionId: 'direct-submit-form-facts',
    url: `data:text/html;charset=utf-8,${encodeURIComponent(formFactsHtml)}`,
    waitUntil: 'domcontentloaded',
  })
  assert.equal(formFactsOpen.ok, true, formFactsOpen.observation)
  const pageFactsSnapshot = await browserSnapshot({ sessionId: 'direct-submit-form-facts' })
  assert.equal(pageFactsSnapshot.ok, true, pageFactsSnapshot.observation)
  assert.equal(pageFactsSnapshot.data.facts.hasAgreementCheckbox, true)
  assert(pageFactsSnapshot.data.facts.likelyFinalSubmitButtons.some((button) => button.text === '确认投递'))
  const formFactsSnapshot = await browserFormSnapshot({ sessionId: 'direct-submit-form-facts' })
  assert.equal(formFactsSnapshot.ok, true, formFactsSnapshot.observation)
  assert.equal(formFactsSnapshot.data.facts.hasAgreementCheckbox, true)
  assert(formFactsSnapshot.data.facts.likelyFinalSubmitButtons.some((button) => button.text === '确认投递'))

  await page.setContent(`<!doctype html><html lang="zh"><body>
    <h1>阿里岗位申请</h1>
    <section><h2>申请工作需知</h2><p>请阅读并同意后继续。</p></section>
    <label><input type="checkbox"> 我已阅读并同意申请工作需知</label>
    <button type="button" onclick="
      if (!document.querySelector('input[type=checkbox]').checked) {
        document.getElementById('status').textContent = '请先阅读并同意申请工作需知'
        return
      }
      document.getElementById('quota-dialog').hidden = false
    ">投递简历</button>
    <p id="status"></p>
    <div id="quota-dialog" role="dialog" aria-modal="true" hidden>
      <p>温馨提示：你暂未申请职位，本月能申请5个职位，请慎重选择！</p>
      <button type="button">取消</button>
      <button type="button">投递</button>
    </div>
  </body></html>`)
  const entryNotice = await inspectDirectSubmitReviewPage(page)
  assert.equal(entryNotice.detected, false)
  assert.equal(entryNotice.signals.loginWall, false)
  assert.equal(entryNotice.signals.agreementCheckboxCount, 1)
  assert.equal(entryNotice.signals.submitApplyButtonCount, 1)
  assert.match(entryNotice.reason, /application-entry/i)
  const entryFacts = await collectPageFacts(page)
  assert.equal(entryFacts.hasAgreementCheckbox, true)
  assert.equal(entryFacts.agreementChecked, false)
  assert.equal(entryFacts.hasApplicationQuotaDialog, false)
  assert(entryFacts.likelyApplyEntryButtons.some((button) => button.text === '投递简历'))
  assert.equal(entryFacts.likelyFinalSubmitButtons.length, 0)
  await page.locator('input[type="checkbox"]').check()
  await page.getByRole('button', { name: '投递简历', exact: true }).click()
  assert.equal(await page.getByRole('dialog').isVisible(), true)
  assert.equal(await page.getByRole('button', { name: '取消', exact: true }).isVisible(), true)
  assert.equal(await page.getByRole('button', { name: '投递', exact: true }).isVisible(), true)
  const lifecycleQuotaFacts = await collectPageFacts(page)
  assert.equal(lifecycleQuotaFacts.hasAgreementCheckbox, true)
  assert.equal(lifecycleQuotaFacts.agreementChecked, true)
  assert.equal(lifecycleQuotaFacts.hasApplicationQuotaDialog, true)
  assert.match(lifecycleQuotaFacts.quotaDialogText ?? '', /本月能申请5个职位/)
  assert.equal(lifecycleQuotaFacts.visibleBlockingDialog.present, true)
  assert.equal(lifecycleQuotaFacts.visibleBlockingDialog.kind, 'quota')

  await page.setContent(`<!doctype html><html lang="zh"><body>
    <div role="dialog" aria-modal="true">
      <p>本月能申请 10 个职位，请慎重选择。</p>
      <button type="button">取消</button>
      <button type="button">投递</button>
    </div>
  </body></html>`)
  assert.equal(await page.getByRole('button', { name: '取消', exact: true }).isVisible(), true)
  assert.equal(await page.getByRole('button', { name: '投递', exact: true }).isVisible(), true)
  const quotaFacts = await collectPageFacts(page)
  assert.equal(quotaFacts.hasApplicationQuotaDialog, true)
  assert.match(quotaFacts.quotaDialogText ?? '', /本月能申请/)
  assert.equal(quotaFacts.visibleBlockingDialog.present, true)
  assert.equal(quotaFacts.visibleBlockingDialog.kind, 'quota')

  await page.route('https://talent-holding.alibaba.com/off-campus/position-detail?*', (route) => route.fulfill({
    status: 200,
    contentType: 'text/html; charset=utf-8',
    body: `<!doctype html><html lang="zh"><body>
    <h1>阿里岗位详情</h1>
    <label><input id="notice" type="checkbox"> 申请此职位表明您已阅读并同意阿里巴巴集团及关联公司的《申请工作需知》</label>
    <button type="button">投递简历</button>
  </body></html>`,
  }))
  await page.goto('https://talent-holding.alibaba.com/off-campus/position-detail?lang=zh&positionId=fixture')
  const notice = await ensureAlibabaApplicationNoticeAccepted(page)
  assert.equal(notice.found, true)
  assert.equal(notice.checked, true)
  assert.equal(await page.locator('#notice').isChecked(), true)

  await page.goto(fixtureUrl('ordinary-form-submit.html'))
  const ordinary = await inspectDirectSubmitReviewPage(page)
  assert.equal(ordinary.detected, false)
  assert(ordinary.signals.realFillableFieldCount >= 3)
  assert.match(ordinary.reason, /fillable application fields/i)

  await page.goto(fixtureUrl('login-wall.html'))
  const login = await inspectDirectSubmitReviewPage(page)
  assert.equal(login.detected, false)
  assert.equal(login.signals.loginWall, true)
  assert.match(login.reason, /login wall/i)

  console.log('direct-submit-flow-test: PASS')
} finally {
  await browser.close()
  await sessionManager.closeAll().catch(() => {})
}

function fixtureUrl(name) {
  return pathToFileURL(join(fixtureDir, name)).toString()
}
