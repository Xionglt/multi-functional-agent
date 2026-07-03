import { toolFailure, toolSuccess } from '../errors.js'
import { observationManager } from '../observation/observation-manager.js'
import { sessionManager } from '../session/manager.js'
import { collectPageFacts } from './page-facts.js'

const CONTROL_SELECTOR = [
  'input',
  'textarea',
  'select',
  '[contenteditable="true"]',
  '[role="textbox"]',
  '[role="combobox"]',
  '[role="searchbox"]',
].join(',')

export async function browserFormSnapshot(input: {
  sessionId?: string
  maxFields?: number
}) {
  const session = sessionManager.get(input.sessionId)
  if (!session) {
    return toolFailure('SESSION_NOT_FOUND', 'No browser session found. Call browser_open first.', {
      suggestedNextActions: ['browser_open'],
    })
  }

  try {
    const maxFields = input.maxFields ?? 120
    const result = await session.page.$$eval(
      CONTROL_SELECTOR,
      (nodes, limit) => {
        const normalize = (value: string | null | undefined) => (value || '').replace(/\s+/g, ' ').trim()
        const isVisible = (el: Element) => {
          const input = el as HTMLInputElement
          if (input.type === 'file') return true
          const style = window.getComputedStyle(el)
          const rect = el.getBoundingClientRect()
          return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0
        }
        const nearbyText = (el: Element) => {
          const parent = el.closest('label,[class*="form"],[class*="field"],[class*="item"],[class*="row"],[class*="upload"]') || el.parentElement
          return normalize(parent?.textContent).slice(0, 260)
        }
        const labelFor = (el: Element) => {
          const id = el.getAttribute('id')
          if (!id) return ''
          return normalize(document.querySelector(`label[for="${CSS.escape(id)}"]`)?.textContent)
        }
        const closestLabel = (el: Element) => normalize(el.closest('label')?.textContent)
        const fieldLabel = (el: Element) => {
          const aria = normalize(el.getAttribute('aria-label'))
          const labelledBy = normalize(
            (el.getAttribute('aria-labelledby') || '')
              .split(/\s+/)
              .map((id) => document.getElementById(id)?.textContent || '')
              .join(' '),
          )
          const placeholder = normalize((el as HTMLInputElement).placeholder)
          const label = labelFor(el) || closestLabel(el)
          const name = normalize(el.getAttribute('name'))
          const id = normalize(el.getAttribute('id'))
          return aria || labelledBy || label || placeholder || name || id || nearbyText(el)
        }
        const fieldValue = (el: Element) => {
          const input = el as HTMLInputElement
          if (input.type === 'file') return ''
          if ('value' in input) return normalize(String(input.value ?? ''))
          return normalize(el.textContent)
        }
        const fieldOptions = (el: Element) => {
          if (el.tagName.toLowerCase() !== 'select') return undefined
          return Array.from((el as HTMLSelectElement).options)
            .map((option) => ({
              value: option.value,
              label: normalize(option.textContent),
              selected: option.selected,
            }))
            .slice(0, 80)
        }
        const fieldError = (el: Element) => {
          const root = el.closest('[class*="form"],[class*="field"],[class*="item"],[class*="row"]') || el.parentElement
          if (!root) return ''
          const selectors = [
            '[role="alert"]',
            '[aria-live]',
            '[class*="error"]',
            '[class*="Error"]',
            '[class*="invalid"]',
            '[class*="help"]',
            '[class*="tips"]',
            '[class*="message"]',
          ]
          for (const selector of selectors) {
            const text = normalize(root.querySelector(selector)?.textContent)
            if (text) return text.slice(0, 180)
          }
          return ''
        }
        const required = (el: Element) => {
          const input = el as HTMLInputElement
          const rootText = nearbyText(el)
          return input.required || el.getAttribute('aria-required') === 'true' || /[*＊]\s*$|必填|required/i.test(rootText)
        }

        const fields = []
        for (const el of nodes) {
          if (!isVisible(el)) continue
          const input = el as HTMLInputElement
          const tag = el.tagName.toLowerCase()
          const type = input.type || el.getAttribute('type') || undefined
          if (type === 'hidden') continue
          fields.push({
            index: fields.length,
            tag,
            type,
            role: el.getAttribute('role') || undefined,
            label: fieldLabel(el),
            placeholder: normalize(input.placeholder) || undefined,
            name: normalize(el.getAttribute('name')) || undefined,
            id: normalize(el.getAttribute('id')) || undefined,
            value: fieldValue(el),
            checked: type === 'checkbox' || type === 'radio' ? input.checked : undefined,
            required: required(el),
            disabled: input.disabled || el.getAttribute('aria-disabled') === 'true',
            readonly: input.readOnly || el.getAttribute('aria-readonly') === 'true',
            invalid: el.getAttribute('aria-invalid') === 'true' || Boolean(fieldError(el)),
            error: fieldError(el) || undefined,
            nearbyText: nearbyText(el),
            options: fieldOptions(el),
          })
          if (fields.length >= limit) break
        }

        const forbiddenUploadActionText =
          /确认投递|提交申请|投递简历|立即投递|提交投递|投递|提交|申请|\b(?:apply(?:\s+now)?|submit(?:\s+application)?|confirm(?:\s+(?:application|submit))?|send\s+application|start\s+application)\b/i
        const explicitUploadTargetText =
          /上传|重新上传|选择.{0,8}(?:文件|简历)|选取.{0,8}(?:文件|简历)|附件简历|上传附件|附件上传|resume[-_\s]*upload|upload[-_\s]*resume|file[-_\s]*upload|upload[-_\s]*file|choose[-_\s]*file|select[-_\s]*file|\bupload\b|browse/i
        const uploadHints = Array.from(document.querySelectorAll('input[type="file"],button,[role="button"],a,[class*="upload"],[class*="Upload"],[id*="upload"],[id*="Upload"]'))
          .map((el) => {
            const input = el as HTMLInputElement
            const className =
              typeof (el as HTMLElement).className === 'string'
                ? (el as HTMLElement).className
                : el.getAttribute('class') || undefined
            const text = normalize(
              el.textContent ||
                input.value ||
                el.getAttribute('aria-label') ||
                el.getAttribute('title') ||
                el.getAttribute('name') ||
                el.getAttribute('id'),
            ).slice(0, 180)
            const humanText = normalize([
              el.textContent,
              input.value,
              el.getAttribute('aria-label'),
              el.getAttribute('title'),
              input.placeholder,
            ].filter(Boolean).join(' '))
            const searchableText = normalize([
              humanText,
              el.getAttribute('name'),
              el.getAttribute('id'),
              className,
              el.getAttribute('accept'),
            ].filter(Boolean).join(' '))
            return {
              tag: el.tagName.toLowerCase(),
              type: input.type || el.getAttribute('type') || undefined,
              text,
              visible: isVisible(el),
              accept: el.getAttribute('accept') || undefined,
              humanText,
              searchableText,
            }
          })
          .filter((item) => {
            if (item.type === 'file') return true
            if (!item.visible) return false
            if (forbiddenUploadActionText.test(item.humanText)) return false
            return explicitUploadTargetText.test(item.searchableText)
          })
          .map((item) => ({
            tag: item.tag,
            type: item.type,
            text: item.text,
            visible: item.visible,
            accept: item.accept,
          }))
          .slice(0, 40)

        const submitCandidates = Array.from(document.querySelectorAll('button,input[type="submit"],input[type="button"],a,[role="button"]'))
          .map((el) => {
            const input = el as HTMLInputElement
            const text = normalize(el.textContent || input.value || el.getAttribute('aria-label')).slice(0, 180)
            return {
              tag: el.tagName.toLowerCase(),
              type: input.type || el.getAttribute('type') || undefined,
              role: el.getAttribute('role') || undefined,
              text,
              visible: isVisible(el),
              risk: /submit|apply|application|提交|投递|申请|递交|报名|send|发送|confirm|确认|pay|支付/i.test(text) ? 'L3' : 'L1',
            }
          })
          .filter((item) => item.visible && item.text)
          .slice(0, 40)

        const visibleErrors = Array.from(document.querySelectorAll('[role="alert"],[class*="error"],[class*="Error"],[class*="invalid"],[class*="message"]'))
          .map((el) => normalize(el.textContent).slice(0, 180))
          .filter(Boolean)
          .slice(0, 40)

        return {
          fields,
          uploadHints,
          submitCandidates,
          visibleErrors,
          totalControls: nodes.length,
        }
      },
      maxFields,
    )

    const [title, facts] = await Promise.all([
      session.page.title(),
      collectPageFacts(session.page).catch(() => undefined),
    ])
    const data = {
      url: session.page.url(),
      title,
      ...(facts ? { facts } : {}),
      ...result,
    }
    try {
      observationManager.refreshFormState({ sessionId: session.id, formSnapshot: data })
    } catch {
      // Observation artifacts are best-effort diagnostics.
    }

    return toolSuccess(`Form snapshot captured ${result.fields.length} fields and ${result.uploadHints.length} upload hints.`, data)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return toolFailure('PAGE_CRASHED', `Failed to capture form snapshot: ${message}`, {
      recoverable: true,
      suggestedNextActions: ['browser_snapshot', 'browser_form_snapshot'],
    })
  }
}
