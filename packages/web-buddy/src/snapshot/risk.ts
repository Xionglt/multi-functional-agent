import type { ElementRef } from '../types.js'

const SUBMIT_PATTERNS = [
  /submit/i,
  /apply/i,
  /application/i,
  /提交/,
  /投递/,
  /申请/,
  /递交/,
  /报名/,
  /send/i,
  /发送/,
  /confirm/i,
  /确认/,
  /pay/i,
  /支付/,
]

const LOW_RISK_FORM_ACTION =
  /search|find|filter|apply\s+filters?|compare|sort|lookup|搜索|查询|查找|检索|筛选|过滤|比较|排序/i
const IRREVERSIBLE_ACTION =
  /submit\s+(?:application|order)|apply\s+now|application|place\s+order|checkout|purchase|buy|pay|publish|send|delete|remove|save\s+(?:profile|application)|提交申请|投递|申请|报名|订单|下单|购买|支付|付款|发布|发送|删除|保存资料/i

export function detectElementRisk(input: {
  tag: string
  role?: string
  name?: string
  text?: string
  typeAttr?: string | null
}): ElementRef['risk'] {
  const label = [input.name, input.text].filter(Boolean).join(' ')
  const isKnownLowRiskFormAction = LOW_RISK_FORM_ACTION.test(label) && !IRREVERSIBLE_ACTION.test(label)
  if (isKnownLowRiskFormAction) return 'L1'

  const isSubmitButton =
    input.tag === 'button' &&
    (input.typeAttr === 'submit' || SUBMIT_PATTERNS.some((p) => p.test(label)))
  const isSubmitInput = input.tag === 'input' && input.typeAttr === 'submit'

  if (isSubmitButton || isSubmitInput) return 'L3'

  if (input.tag === 'input') {
    const type = (input.typeAttr || 'text').toLowerCase()
    if (['password', 'file'].includes(type)) return 'L4'
    if (['email', 'tel', 'search', 'text', 'number', 'date'].includes(type)) return 'L2'
  }

  if (input.tag === 'select' || input.tag === 'textarea') return 'L2'

  if (input.role === 'textbox' || input.role === 'combobox' || input.role === 'searchbox') {
    return 'L2'
  }

  if (input.role === 'button' || input.tag === 'button' || input.tag === 'a') return 'L1'

  return 'L0'
}
