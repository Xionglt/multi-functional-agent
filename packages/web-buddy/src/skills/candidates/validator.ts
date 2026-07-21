import { createHash } from 'node:crypto'
import {
  assertProposedSkill,
  type ProposedSkillV1,
  type ValidationFindingV1,
} from './contracts.js'

const TOP_LEVEL_KEYS = new Set([
  'schemaVersion',
  'id',
  'name',
  'scope',
  'priority',
  'triggers',
  'provides',
  'promptSections',
  'body',
])
const TRIGGER_KEYS = [
  'taskTypes',
  'domains',
  'urlPatterns',
  'workflowPhases',
  'toolNames',
] as const

export interface ProposedSkillValidation {
  blockers: ValidationFindingV1[]
  warnings: ValidationFindingV1[]
}

export function validateProposedSkill(value: unknown): ProposedSkillValidation {
  const blockers: ValidationFindingV1[] = []
  if (!plainObject(value)) {
    blockers.push(blocker('INVALID_SCHEMA', '$', 'Proposed Skill must be a JSON object.'))
    return { blockers, warnings: [] }
  }

  for (const key of Object.keys(value)) {
    if (!TOP_LEVEL_KEYS.has(key)) {
      blockers.push(blocker('UNSUPPORTED_FIELD', `$.${key}`, `Field ${key} is not allowed.`))
    }
  }
  if (value.schemaVersion !== 'proposed-skill/v1') {
    blockers.push(blocker('INVALID_SCHEMA', '$.schemaVersion', 'Unsupported proposed Skill schema.'))
  }
  if (typeof value.id !== 'string' || !/^[a-z0-9][a-z0-9._-]{2,119}$/.test(value.id)) {
    blockers.push(blocker('INVALID_SKILL_ID', '$.id', 'Skill id must be a stable lowercase identifier.'))
  }
  if (typeof value.name !== 'string' || value.name.trim().length < 1 || value.name.length > 120) {
    blockers.push(blocker('INVALID_SKILL_NAME', '$.name', 'Skill name must contain 1-120 characters.'))
  }
  if (value.scope !== 'project' && value.scope !== 'user') {
    blockers.push(blocker('UNSAFE_SCOPE', '$.scope', 'Candidate scope must be project or user.'))
  }
  if (!Number.isInteger(value.priority) || Number(value.priority) < 0 || Number(value.priority) > 1000) {
    blockers.push(blocker('INVALID_PRIORITY', '$.priority', 'Priority must be an integer from 0 to 1000.'))
  }

  validateTriggers(value.triggers, blockers)
  validateProvides(value.provides, blockers)
  validatePromptSections(value.promptSections, blockers)
  if (typeof value.body !== 'string' || value.body.trim().length < 1 || value.body.length > 4000) {
    blockers.push(blocker('INVALID_BODY', '$.body', 'Skill body must contain 1-4000 characters.'))
  }

  const serialized = canonicalJson(value)
  for (const rule of SENSITIVE_TEXT_RULES) {
    if (rule.pattern.test(serialized)) {
      blockers.push(blocker(rule.code, '$', rule.message))
    }
  }

  if (blockers.length === 0) {
    try {
      assertProposedSkill(value)
    } catch {
      blockers.push(blocker('INVALID_SCHEMA', '$', 'Proposed Skill does not match the closed contract.'))
    }
  }
  return { blockers: deduplicateFindings(blockers), warnings: [] }
}

export function skillCandidateFingerprint(skill: ProposedSkillV1): string {
  const validation = validateProposedSkill(skill)
  if (validation.blockers.length > 0) throw new Error('INVALID_PROPOSED_SKILL_FOR_FINGERPRINT')
  const normalized = {
    triggers: normalizeTriggers(skill.triggers),
    promptSections: skill.promptSections.map((section) => ({
      id: section.id,
      summary: normalizeText(section.summary),
    })),
    body: normalizeText(skill.body),
  }
  return createHash('sha256').update(canonicalJson(normalized)).digest('hex')
}

function validateTriggers(value: unknown, findings: ValidationFindingV1[]): void {
  if (!plainObject(value)) {
    findings.push(blocker('INVALID_TRIGGERS', '$.triggers', 'Triggers must be an object.'))
    return
  }
  for (const key of Object.keys(value)) {
    if (!TRIGGER_KEYS.includes(key as (typeof TRIGGER_KEYS)[number])) {
      findings.push(blocker('UNSUPPORTED_TRIGGER', `$.triggers.${key}`, 'Trigger type is not allowed.'))
    }
  }
  let count = 0
  for (const key of TRIGGER_KEYS) {
    const entries = value[key]
    if (entries === undefined) continue
    if (!Array.isArray(entries)) {
      findings.push(blocker('INVALID_TRIGGER', `$.triggers.${key}`, 'Trigger values must be an array.'))
      continue
    }
    for (const [index, entry] of entries.entries()) {
      if (typeof entry !== 'string' || !entry.trim() || entry.length > 200) {
        findings.push(blocker(
          'INVALID_TRIGGER',
          `$.triggers.${key}[${index}]`,
          'Trigger values must be non-empty and bounded.',
        ))
        continue
      }
      count += 1
      if (entry === '*' || entry === '**') {
        findings.push(blocker(
          'UNBOUNDED_TRIGGER',
          `$.triggers.${key}[${index}]`,
          'Wildcard-only triggers are not allowed.',
        ))
      }
      if (key === 'urlPatterns' && /^\*+(?:\/\*+)?$/.test(entry)) {
        findings.push(blocker(
          'UNBOUNDED_TRIGGER',
          `$.triggers.${key}[${index}]`,
          'Wildcard-only URL patterns are not allowed.',
        ))
      }
      if (key === 'domains' && (
        entry.includes('://')
        || entry.includes('/')
        || entry.includes('?')
        || !/^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,62})\.)*[a-z0-9](?:[a-z0-9-]{0,62})$/i.test(entry)
      )) {
        findings.push(blocker(
          'INVALID_DOMAIN_TRIGGER',
          `$.triggers.${key}[${index}]`,
          'Domain triggers cannot include protocol, path, or query.',
        ))
      }
    }
  }
  if (count === 0) {
    findings.push(blocker('MISSING_TRIGGER', '$.triggers', 'At least one bounded trigger is required.'))
  }
}

function validateProvides(value: unknown, findings: ValidationFindingV1[]): void {
  if (
    !plainObject(value)
    || Object.keys(value).length !== 1
    || !Array.isArray(value.promptSections)
    || value.promptSections.length !== 1
    || value.promptSections[0] !== 'NEXT_ACTION_RULES'
  ) {
    findings.push(blocker(
      'UNSAFE_CAPABILITY',
      '$.provides',
      'Candidates may only provide NEXT_ACTION_RULES.',
    ))
  }
}

function validatePromptSections(value: unknown, findings: ValidationFindingV1[]): void {
  if (!Array.isArray(value) || value.length !== 1 || !plainObject(value[0])) {
    findings.push(blocker(
      'INVALID_PROMPT_SECTION',
      '$.promptSections',
      'Exactly one NEXT_ACTION_RULES section is required.',
    ))
    return
  }
  const section = value[0]
  if (
    Object.keys(section).some((key) => !['id', 'summary'].includes(key))
    || section.id !== 'NEXT_ACTION_RULES'
    || typeof section.summary !== 'string'
    || section.summary.trim().length < 1
    || section.summary.length > 1800
  ) {
    findings.push(blocker(
      'INVALID_PROMPT_SECTION',
      '$.promptSections[0]',
      'Prompt section must be a bounded NEXT_ACTION_RULES summary.',
    ))
  }
}

const SENSITIVE_TEXT_RULES = [
  {
    code: 'SECRET_DETECTED',
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]+/i,
    message: 'Candidate contains an authorization credential.',
  },
  {
    code: 'SECRET_DETECTED',
    pattern: /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{8,}\b/i,
    message: 'Candidate contains a credential-like token.',
  },
  {
    code: 'SECRET_DETECTED',
    pattern: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/,
    message: 'Candidate contains a JWT-like token.',
  },
  {
    code: 'SECRET_DETECTED',
    pattern: /\b(?:api[_-]?key|auth(?:orization)?|password|secret|token)\s*[:=]\s*["']?[^\s"',}]{4,}/i,
    message: 'Candidate contains a secret key-value pair.',
  },
  {
    code: 'PII_DETECTED',
    pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/,
    message: 'Candidate contains an email address.',
  },
  {
    code: 'PII_DETECTED',
    pattern: /\b1[3-9]\d{9}\b/,
    message: 'Candidate contains a phone number.',
  },
  {
    code: 'ABSOLUTE_PATH_DETECTED',
    pattern: /(?:\/Users\/|\/home\/|(?:^|[^A-Za-z0-9])[A-Za-z]:\\)/,
    message: 'Candidate contains an absolute local path.',
  },
  {
    code: 'PROMPT_INJECTION_DETECTED',
    pattern: /(?:ignore\s+previous|system\s+prompt|developer\s+message|<system>)/i,
    message: 'Candidate contains prompt-injection language.',
  },
] as const

function normalizeTriggers(triggers: ProposedSkillV1['triggers']): Record<string, string[]> {
  const normalized: Record<string, string[]> = {}
  for (const key of TRIGGER_KEYS) {
    const values = triggers[key]
    if (!values?.length) continue
    normalized[key] = [...new Set(values.map(normalizeText))].sort()
  }
  return normalized
}

function normalizeText(value: string): string {
  return value.replace(/\r\n?/g, '\n').trim()
}

function blocker(code: string, path: string, message: string): ValidationFindingV1 {
  return {
    schemaVersion: 'skill-candidate-finding/v1',
    severity: 'blocker',
    code,
    path,
    message,
  }
}

function deduplicateFindings(findings: ValidationFindingV1[]): ValidationFindingV1[] {
  const seen = new Set<string>()
  return findings.filter((finding) => {
    const key = `${finding.code}\0${finding.path}\0${finding.message}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const item = value as Record<string, unknown>
  return `{${Object.keys(item).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(item[key])}`
  )).join(',')}}`
}
