#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { buildSnapshot } from '../dist/snapshot/builder.js'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const html = readFileSync(join(scriptDir, '..', 'src', 'web', 'public', 'venue-booking.html'), 'utf8')
const server = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(html)
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
assert(address && typeof address === 'object')

const browser = await chromium.launch({ headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  await page.goto(`http://127.0.0.1:${address.port}/`, { waitUntil: 'domcontentloaded' })

  const initialSnapshot = await buildSnapshot(page, { maxElements: 120 })
  assert(initialSnapshot.snapshot.textSummary.length <= 4003)
  assert.match(initialSnapshot.snapshot.textSummary, /西岸编译室/)
  assert.match(initialSnapshot.snapshot.textSummary, /不支持 24 小时前免费取消/)
  assert.match(initialSnapshot.snapshot.textSummary, /地铁步行 12 分钟/)
  const compareRef = initialSnapshot.snapshot.elements.find((element) => element.name === '按条件比较 5 个场地')
  assert.equal(compareRef?.risk, 'L1')

  await page.getByRole('button', { name: '按条件比较 5 个场地' }).click()
  await assertText(page, '#resultSummary', '已比较 5 个场地；1 个符合全部条件')

  const firstCard = page.locator('.venue-card').first()
  await assertText(firstCard, 'h3', '西岸编译室')
  await assertText(firstCard, '.match', '9/9 MATCH')
  await firstCard.getByRole('button', { name: '查看方案' }).click()

  await assertText(page, '#detailSheet h1', '西岸编译室')
  await assertText(page, '#detailOrder', '预订总价¥3,580')
  await page.getByRole('button', { name: '选择这个方案' }).click()

  await page.getByLabel('联系人姓名').fill('林舟')
  await page.getByLabel('企业名称').fill('杭州栖木科技有限公司')
  await page.getByLabel('手机号').fill('13800001126')
  await page.getByLabel('邮箱').fill('linzhou@example.test')
  await page.getByLabel('发票类型').selectOption('vat-normal')
  await page.getByLabel('给场地的留言（选填）').fill('请将桌椅预设为 4 组岛形布局')
  await page.getByLabel('我已核对日期、时段、人数、茶歇和取消政策。').check()

  const payButton = page.getByRole('button', { name: '确认并支付订金 ¥537' })
  assert.equal(await payButton.isVisible(), true)
  const bookingSnapshot = await buildSnapshot(page, { maxElements: 120 })
  const payRef = bookingSnapshot.snapshot.elements.find((element) => element.name === '确认并支付订金 ¥537')
  assert.equal(payRef?.risk, 'L3')
  const oracle = await page.evaluate(() => window.__VENUE_TEST_STATE__)
  assert.equal(oracle.step, 'booking')
  assert.equal(oracle.selectedVenueId, 'west-compiler')
  assert.equal(oracle.paymentAttempts, 0)
  assert.equal(oracle.committedPayments, 0)

  console.log('venue-booking-fixture-test: passed')
} finally {
  await browser.close()
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
}

async function assertText(root, selector, expected) {
  const text = (await root.locator(selector).textContent())?.replace(/\s+/g, '') || ''
  assert(text.includes(expected.replace(/\s+/g, '')), `Expected ${selector} to contain "${expected}", got "${text}"`)
}
