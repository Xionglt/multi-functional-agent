export interface PageButtonFact {
  tag: string
  type?: string
  role?: string
  text: string
  visible?: boolean
  disabled?: boolean
}

export interface VisibleBlockingDialogFact {
  present: boolean
  kind?: 'quota' | 'login' | 'captcha' | 'validation' | 'confirmation' | 'modal' | 'unknown'
  text?: string
  role?: string
}

export interface PageFacts {
  hasAgreementCheckbox: boolean
  agreementChecked: boolean
  hasApplicationQuotaDialog: boolean
  quotaDialogText?: string
  hasRealUploadInput: boolean
  uploadCandidateCount: number
  submitLikeButtons: PageButtonFact[]
  likelyApplyEntryButtons: PageButtonFact[]
  likelyFinalSubmitButtons: PageButtonFact[]
  visibleBlockingDialog: VisibleBlockingDialogFact
}

export function emptyPageFacts(): PageFacts {
  return {
    hasAgreementCheckbox: false,
    agreementChecked: false,
    hasApplicationQuotaDialog: false,
    hasRealUploadInput: false,
    uploadCandidateCount: 0,
    submitLikeButtons: [],
    likelyApplyEntryButtons: [],
    likelyFinalSubmitButtons: [],
    visibleBlockingDialog: { present: false },
  }
}

export function normalizePageFacts(raw: Partial<PageFacts> | undefined): PageFacts | undefined {
  if (!raw) return undefined
  const facts = emptyPageFacts()
  facts.hasAgreementCheckbox = Boolean(raw.hasAgreementCheckbox)
  facts.agreementChecked = Boolean(raw.agreementChecked)
  facts.hasApplicationQuotaDialog = Boolean(raw.hasApplicationQuotaDialog)
  facts.hasRealUploadInput = Boolean(raw.hasRealUploadInput)
  facts.uploadCandidateCount = safeCount(raw.uploadCandidateCount)
  facts.submitLikeButtons = normalizeButtons(raw.submitLikeButtons, 24)
  facts.likelyApplyEntryButtons = normalizeButtons(raw.likelyApplyEntryButtons, 16)
  facts.likelyFinalSubmitButtons = normalizeButtons(raw.likelyFinalSubmitButtons, 16)

  const quotaDialogText = redactText(raw.quotaDialogText, 260)
  if (quotaDialogText) facts.quotaDialogText = quotaDialogText

  const dialog = raw.visibleBlockingDialog
  if (dialog?.present) {
    facts.visibleBlockingDialog = {
      present: true,
      kind: normalizeDialogKind(dialog.kind),
      text: redactText(dialog.text, 260) || undefined,
      role: redactText(dialog.role, 80) || undefined,
    }
  }

  return facts
}

function normalizeButtons(buttons: PageButtonFact[] | undefined, limit: number): PageButtonFact[] {
  return (buttons ?? [])
    .map((button) => ({
      tag: redactText(button.tag, 40) || 'unknown',
      type: redactText(button.type, 40) || undefined,
      role: redactText(button.role, 40) || undefined,
      text: redactText(button.text, 140),
      visible: button.visible,
      disabled: button.disabled,
    }))
    .filter((button) => button.text)
    .slice(0, limit)
}

function normalizeDialogKind(kind: VisibleBlockingDialogFact['kind'] | undefined): VisibleBlockingDialogFact['kind'] | undefined {
  if (
    kind === 'quota' ||
    kind === 'login' ||
    kind === 'captcha' ||
    kind === 'validation' ||
    kind === 'confirmation' ||
    kind === 'modal' ||
    kind === 'unknown'
  ) {
    return kind
  }
  return undefined
}

function safeCount(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  return Math.max(0, Math.floor(value))
}

function redactText(value: string | undefined, max: number): string {
  const normalized = (value || '').replace(/\s+/g, ' ').trim()
  if (!normalized) return ''
  const redacted = normalized
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
    .replace(/\b(?:\+?\d[\d\s().-]{6,}\d)\b/g, '[number]')
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, '[url]')
  return redacted.length <= max ? redacted : `${redacted.slice(0, max)}...`
}
