import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { z } from 'zod'
import type { LlmGateway } from './llm.js'

/**
 * Structured resume profile — the canonical representation the matcher and the
 * application form-filler both consume. Everything is optional because PDF
 * extraction is best-effort and the user can always edit the JSON.
 */
export interface ResumeExperience {
  company?: string
  title?: string
  period?: string
  summary?: string
}

export interface ResumeEducation {
  school?: string
  degree?: string
  major?: string
  period?: string
}

export interface ResumeProfile {
  name?: string
  email?: string
  phone?: string
  location?: string
  summary?: string
  /** Normalized lower-case skill tokens, e.g. ["typescript", "react", "k8s"]. */
  skills: string[]
  experience: ResumeExperience[]
  education: ResumeEducation[]
  /** Free-form keywords derived from the raw text (for matching fallback). */
  keywords: string[]
  /** Where the profile came from. */
  source: 'pdf' | 'json' | 'txt'
}

export type ResumeSourceType =
  | 'pdf-text'
  | 'pdf-image'
  | 'docx'
  | 'txt'
  | 'json'
  | 'html'

export interface FieldValue<T> {
  value: T
  confidence: number
  evidence?: string
}

export interface ResumeProjectExperience {
  name?: string
  role?: string
  period?: string
  summary?: string
  technologies?: string[]
}

export interface ResumeProfileV2 {
  schemaVersion: 'resume-profile/v2'
  name?: FieldValue<string>
  email?: FieldValue<string>
  phone?: FieldValue<string>
  location?: FieldValue<string>
  summary?: FieldValue<string>
  targetRoles: FieldValue<string[]>
  skills: FieldValue<string[]>
  projects: FieldValue<ResumeProjectExperience[]>
  experience: FieldValue<ResumeExperience[]>
  education: FieldValue<ResumeEducation[]>
  keywords: FieldValue<string[]>
  seniority?: FieldValue<string>
  source: {
    path?: string
    type: ResumeSourceType
    extractionWarnings: string[]
    textLength?: number
    parser: 'heuristic' | 'llm' | 'llm_with_heuristic_repair' | 'json'
  }
}

export type ResumeIngestLlm = Pick<LlmGateway, 'hasKey' | 'generateJson'>

export interface ResumeIngestOptions {
  /** Optional LLM gateway. If absent or without a key, v2 falls back to heuristics. */
  llm?: ResumeIngestLlm
  /** Optional source path override for artifacts; defaults to the file path. */
  sourcePath?: string
  /** Minimum extracted text length before a PDF is treated as text-based. */
  minPdfTextLength?: number
}

// ---------------------------------------------------------------------------
// PDF text extraction (pdfjs-dist)
// ---------------------------------------------------------------------------

interface PdfTextLib {
  getDocument: (params: { data: Uint8Array; isEvalSupported?: boolean }) => {
    promise: Promise<{ numPages: number; getPage: (n: number) => Promise<PdfPage> }>
  }
  GlobalWorkerOptions: { workerSrc: string }
}

interface PdfPage {
  getTextContent: () => Promise<{ items: Array<{ str?: string; hasEOL?: boolean }> }>
}

/**
 * Extract plain text from a PDF using pdfjs-dist.
 *
 * pdfjs is loaded dynamically so it stays an optional runtime dependency and
 * does not get pulled into the MCP server bundle path. The worker runs on the
 * main thread via the fake-worker fallback (workerSrc resolves to the shipped
 * worker module, which Node can dynamic-import).
 */
export async function extractTextFromPdf(filePath: string): Promise<string> {
  const data = new Uint8Array(readFileSync(filePath))
  const pdfjs = (await import('pdfjs-dist/legacy/build/pdf.mjs')) as PdfTextLib
  const { createRequire } = await import('node:module')
  const require = createRequire(import.meta.url)
  try {
    pdfjs.GlobalWorkerOptions.workerSrc = require.resolve(
      'pdfjs-dist/legacy/build/pdf.worker.mjs',
    )
  } catch {
    // Falls back to main-thread fake worker if resolution fails.
  }

  let standardFontDataUrl: string | undefined
  try {
    standardFontDataUrl = require.resolve('pdfjs-dist/standard_fonts/')
  } catch {
    // Optional: silences a harmless "standardFontDataUrl" warning.
  }

  const doc = await pdfjs.getDocument({
    data,
    isEvalSupported: false,
    ...(standardFontDataUrl ? { standardFontDataUrl } : {}),
  }).promise
  const lines: string[] = []
  for (let i = 1; i <= doc.numPages; i += 1) {
    const page = await doc.getPage(i)
    const content = await page.getTextContent()
    let buffer = ''
    for (const item of content.items) {
      const str = item.str ?? ''
      buffer += str
      if (item.hasEOL) {
        lines.push(buffer)
        buffer = ''
      } else if (str) {
        buffer += ' '
      }
    }
    if (buffer.trim()) lines.push(buffer)
  }
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Heuristic field extraction
// ---------------------------------------------------------------------------

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/
const PHONE_RE = /(\+?\d[\d\s\-()]{7,}\d)/
const DEFAULT_MIN_PDF_TEXT_LENGTH = 80
const RESUME_LLM_MAX_CHARS = 18000

const confidenceSchema = z.number().finite().min(0).max(1)
const fieldValueSchema = <T extends z.ZodTypeAny>(value: T) => z.object({
  value,
  confidence: confidenceSchema,
  evidence: z.string().optional(),
})
const resumeExperienceSchema = z.object({
  company: z.string().optional(),
  title: z.string().optional(),
  period: z.string().optional(),
  summary: z.string().optional(),
})
const resumeEducationSchema = z.object({
  school: z.string().optional(),
  degree: z.string().optional(),
  major: z.string().optional(),
  period: z.string().optional(),
})
const resumeProjectSchema = z.object({
  name: z.string().optional(),
  role: z.string().optional(),
  period: z.string().optional(),
  summary: z.string().optional(),
  technologies: z.array(z.string()).optional(),
})
const sourceSchema = z.object({
  path: z.string().optional(),
  type: z.enum(['pdf-text', 'pdf-image', 'docx', 'txt', 'json', 'html']),
  extractionWarnings: z.array(z.string()),
  textLength: z.number().int().nonnegative().optional(),
  parser: z.enum(['heuristic', 'llm', 'llm_with_heuristic_repair', 'json']),
})
const resumeProfileV2Schema = z.object({
  schemaVersion: z.literal('resume-profile/v2'),
  name: fieldValueSchema(z.string()).optional(),
  email: fieldValueSchema(z.string()).optional(),
  phone: fieldValueSchema(z.string()).optional(),
  location: fieldValueSchema(z.string()).optional(),
  summary: fieldValueSchema(z.string()).optional(),
  targetRoles: fieldValueSchema(z.array(z.string())),
  skills: fieldValueSchema(z.array(z.string())),
  projects: fieldValueSchema(z.array(resumeProjectSchema)),
  experience: fieldValueSchema(z.array(resumeExperienceSchema)),
  education: fieldValueSchema(z.array(resumeEducationSchema)),
  keywords: fieldValueSchema(z.array(z.string())),
  seniority: fieldValueSchema(z.string()).optional(),
  source: sourceSchema,
})
const llmResumeSchema = resumeProfileV2Schema.omit({ source: true }).extend({
  schemaVersion: z.literal('resume-profile/v2').optional(),
})

type LlmResumeArrayFieldKey = 'targetRoles' | 'skills' | 'projects' | 'experience' | 'education' | 'keywords'

const LLM_ARRAY_FIELD_KEYS: LlmResumeArrayFieldKey[] = [
  'targetRoles',
  'skills',
  'projects',
  'experience',
  'education',
  'keywords',
]

const SKILL_DICTIONARY = [
  'typescript', 'javascript', 'python', 'java', 'go', 'golang', 'rust', 'c++', 'c#',
  'react', 'vue', 'angular', 'next.js', 'node', 'nodejs', 'deno',
  'playwright', 'selenium', 'puppeteer',
  'docker', 'kubernetes', 'k8s', 'terraform', 'helm',
  'aws', 'gcp', 'azure', 'aliyun',
  'mysql', 'postgres', 'redis', 'kafka', 'mongodb', 'elasticsearch',
  'graphql', 'grpc', 'rest', 'protobuf',
  'machine learning', 'deep learning', 'pytorch', 'tensorflow', 'nlp', 'llm',
  'spark', 'flink', 'hadoop', 'hive',
  'linux', 'git', 'ci/cd', 'jenkins', 'microservices', 'ddd', 'ddd',
  '产品经理', '后端', '前端', '全栈', '算法', '数据', '测试', '运维', 'devops',
  'node.js', 'express', 'nestjs', 'spring', 'django', 'fastapi', 'flask',
]

function findFirst(text: string, re: RegExp): string | undefined {
  const m = text.match(re)
  return m ? m[0].trim() : undefined
}

function extractName(lines: string[]): string | undefined {
  // First non-empty line that is NOT an email/phone/header and is short enough
  // to plausibly be a name. Prefers lines containing CJK or capitalized words.
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    if (EMAIL_RE.test(line) || PHONE_RE.test(line)) continue
    if (/^(email|phone|tel|手机|邮箱|电话|地址|summary|技能|skills|experience|教育)/i.test(line)) continue
    if (line.length > 30) continue
    const hasCjk = /[一-鿿]{2,}/.test(line)
    const hasCapitalized = /[A-Z][a-z]+\s[A-Z][a-z]+/.test(line)
    if (hasCjk || hasCapitalized) return line
  }
  return undefined
}

function extractSkills(text: string): string[] {
  const lower = ` ${text.toLowerCase()} `
  const found = new Set<string>()
  for (const skill of SKILL_DICTIONARY) {
    const needle = skill.toLowerCase()
    // Substring match (not regex) — skills like "c++" and "c#" are literal.
    if (lower.includes(needle)) found.add(needle)
  }
  return [...found].sort()
}

function extractExperience(lines: string[]): ResumeExperience[] {
  const out: ResumeExperience[] = []
  // Heuristic: a line with a date range (2019-2021 / 2021.01- ...) followed by
  // a company-ish line.
  const dateRe = /(19|20)\d{2}[\s./-]*(0?[1-9]|1[012])?[\s./-]*[-–~至到]{1,3}[\s./-]*(19|20)\d{2}|至今|present|now/i
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim()
    if (!dateRe.test(line)) continue
    const company = lines[i - 1]?.trim() || undefined
    const title = lines[i + 1]?.trim() || undefined
    out.push({ company, period: line, title, summary: undefined })
    if (out.length >= 8) break
  }
  return out
}

function extractEducation(lines: string[]): ResumeEducation[] {
  const out: ResumeEducation[] = []
  const eduKeywords = /(大学|university|学院|college|本科|硕士|博士|bachelor|master|ph\.?d)/i
  for (const raw of lines) {
    const line = raw.trim()
    if (!eduKeywords.test(line)) continue
    const degree = line.match(/(本科|硕士|博士|bachelor|master|ph\.?d)/i)?.[0]
    out.push({ school: line, degree })
    if (out.length >= 4) break
  }
  return out
}

/** Parse a plain-text blob (already extracted) into a structured profile. */
export function parseResumeText(text: string, source: ResumeProfile['source']): ResumeProfile {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)
  const flat = lines.join('\n')

  const skills = extractSkills(flat)
  const keywords = [
    ...skills,
    ...lines
      .filter((l) => l.length <= 18 && /^[一-鿿A-Za-z .+#/-]+$/.test(l))
      .map((l) => l.toLowerCase()),
  ]
  const keywordSet = [...new Set(keywords)]

  return {
    name: extractName(lines),
    email: findFirst(flat, EMAIL_RE),
    phone: findFirst(flat, PHONE_RE),
    location: undefined,
    summary: lines.slice(0, 1).join(' '),
    skills,
    experience: extractExperience(lines),
    education: extractEducation(lines),
    keywords: keywordSet,
    source,
  }
}

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(1, value))
}

function sanitizedEvidence(text: string | undefined): string | undefined {
  if (!text) return undefined
  const redacted = text
    .replace(EMAIL_RE, '[email]')
    .replace(PHONE_RE, '[phone]')
    .replace(/\s+/g, ' ')
    .trim()
  if (!redacted) return undefined
  return redacted.length > 160 ? `${redacted.slice(0, 157)}...` : redacted
}

function stringField(value: string | undefined, confidence: number, evidence: string): FieldValue<string> | undefined {
  const cleaned = value?.trim()
  if (!cleaned) return undefined
  return {
    value: cleaned,
    confidence: clampConfidence(confidence),
    evidence: sanitizedEvidence(evidence),
  }
}

function arrayField<T>(value: T[], confidence: number, evidence: string): FieldValue<T[]> {
  return {
    value,
    confidence: clampConfidence(confidence),
    evidence: sanitizedEvidence(evidence),
  }
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const value of values) {
    const cleaned = value?.trim()
    if (!cleaned) continue
    const key = cleaned.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(cleaned)
  }
  return out
}

function normalizeStringArray(values: string[]): string[] {
  return uniqueStrings(values.map((value) => value.replace(/\s+/g, ' ')))
}

function normalizeProjects(values: ResumeProjectExperience[]): ResumeProjectExperience[] {
  return values
    .map((project) => ({
      name: project.name?.trim() || undefined,
      role: project.role?.trim() || undefined,
      period: project.period?.trim() || undefined,
      summary: project.summary?.trim() || undefined,
      technologies: project.technologies ? normalizeStringArray(project.technologies) : undefined,
    }))
    .filter((project) => Boolean(project.name || project.role || project.summary || project.technologies?.length))
}

function normalizeExperience(values: ResumeExperience[]): ResumeExperience[] {
  return values
    .map((item) => ({
      company: item.company?.trim() || undefined,
      title: item.title?.trim() || undefined,
      period: item.period?.trim() || undefined,
      summary: item.summary?.trim() || undefined,
    }))
    .filter((item) => Boolean(item.company || item.title || item.period || item.summary))
}

function normalizeEducation(values: ResumeEducation[]): ResumeEducation[] {
  return values
    .map((item) => ({
      school: item.school?.trim() || undefined,
      degree: item.degree?.trim() || undefined,
      major: item.major?.trim() || undefined,
      period: item.period?.trim() || undefined,
    }))
    .filter((item) => Boolean(item.school || item.degree || item.major || item.period))
}

function normalizeField<T>(
  field: FieldValue<T>,
  normalizeValue: (value: T) => T,
): FieldValue<T> {
  return {
    value: normalizeValue(field.value),
    confidence: clampConfidence(field.confidence),
    evidence: sanitizedEvidence(field.evidence),
  }
}

function inferTargetRoles(profile: ResumeProfile): string[] {
  const fromExperience = uniqueStrings(profile.experience.map((item) => item.title)).slice(0, 3)
  if (fromExperience.length) return fromExperience
  const joined = `${profile.summary ?? ''} ${profile.keywords.join(' ')}`.toLowerCase()
  const roles: string[] = []
  if (/frontend|front-end|前端|react|vue/.test(joined)) roles.push('Frontend Engineer')
  if (/backend|back-end|后端|java|go|golang|spring/.test(joined)) roles.push('Backend Engineer')
  if (/fullstack|full-stack|全栈/.test(joined)) roles.push('Full-stack Engineer')
  if (/算法|machine learning|deep learning|nlp|llm/.test(joined)) roles.push('Algorithm Engineer')
  if (/产品经理|product manager/.test(joined)) roles.push('Product Manager')
  return uniqueStrings(roles).slice(0, 3)
}

function inferSeniority(profile: ResumeProfile): string | undefined {
  const joined = `${profile.summary ?? ''} ${profile.experience.map((item) => item.title ?? '').join(' ')}`.toLowerCase()
  if (/principal|staff|architect|专家|架构/.test(joined)) return 'principal'
  if (/senior|lead|高级|资深/.test(joined)) return 'senior'
  if (/junior|intern|实习|初级/.test(joined)) return 'junior'
  if (profile.experience.length) return 'mid'
  return undefined
}

function sourceTypeFromLegacy(source: ResumeProfile['source']): ResumeSourceType {
  if (source === 'pdf') return 'pdf-text'
  return source
}

function legacySourceFromSourceType(type: ResumeSourceType): ResumeProfile['source'] {
  if (type === 'json') return 'json'
  if (type === 'txt' || type === 'docx' || type === 'html') return 'txt'
  return 'pdf'
}

function legacyProfileToResumeV2(
  profile: ResumeProfile,
  metadata: {
    path?: string
    type?: ResumeSourceType
    textLength?: number
    extractionWarnings?: string[]
    parser?: ResumeProfileV2['source']['parser']
  } = {},
): ResumeProfileV2 {
  const targetRoles = inferTargetRoles(profile)
  const seniority = inferSeniority(profile)
  const v2: ResumeProfileV2 = {
    schemaVersion: 'resume-profile/v2',
    name: stringField(profile.name, 0.7, 'Heuristic name candidate from resume header.'),
    email: stringField(profile.email, 0.98, 'Detected by deterministic email pattern.'),
    phone: stringField(profile.phone, 0.95, 'Detected by deterministic phone pattern.'),
    location: stringField(profile.location, 0.45, 'Heuristic location candidate.'),
    summary: stringField(profile.summary, 0.55, 'Heuristic summary from leading resume text.'),
    targetRoles: arrayField(targetRoles, targetRoles.length ? 0.55 : 0.2, 'Inferred from titles and resume keywords.'),
    skills: arrayField(normalizeStringArray(profile.skills), profile.skills.length ? 0.75 : 0.2, 'Matched local skill dictionary.'),
    projects: arrayField([], 0.15, 'No project-specific heuristic extraction available.'),
    experience: arrayField(normalizeExperience(profile.experience), profile.experience.length ? 0.55 : 0.2, 'Detected date ranges and adjacent title/company lines.'),
    education: arrayField(normalizeEducation(profile.education), profile.education.length ? 0.6 : 0.2, 'Matched education keywords in resume text.'),
    keywords: arrayField(normalizeStringArray(profile.keywords), profile.keywords.length ? 0.55 : 0.2, 'Derived from skills and short keyword-like lines.'),
    seniority: stringField(seniority, seniority ? 0.45 : 0.2, 'Inferred from title seniority words and experience presence.'),
    source: {
      path: metadata.path,
      type: metadata.type ?? sourceTypeFromLegacy(profile.source),
      extractionWarnings: metadata.extractionWarnings ?? [],
      textLength: metadata.textLength,
      parser: metadata.parser ?? 'heuristic',
    },
  }
  return resumeProfileV2Schema.parse(v2)
}

export function resumeV2ToLegacyProfile(profile: ResumeProfileV2): ResumeProfile {
  const source: ResumeProfile['source'] =
    profile.source.type === 'json'
      ? 'json'
      : profile.source.type === 'txt' || profile.source.type === 'docx' || profile.source.type === 'html'
        ? 'txt'
        : 'pdf'
  return {
    name: profile.name?.value,
    email: profile.email?.value,
    phone: profile.phone?.value,
    location: profile.location?.value,
    summary: profile.summary?.value,
    skills: profile.skills.value,
    experience: profile.experience.value,
    education: profile.education.value,
    keywords: profile.keywords.value,
    source,
  }
}

function normalizeProfileV2(profile: ResumeProfileV2): ResumeProfileV2 {
  const normalized: ResumeProfileV2 = {
    ...profile,
    name: profile.name ? normalizeField(profile.name, (value) => value.trim()) : undefined,
    email: profile.email ? normalizeField(profile.email, (value) => value.trim()) : undefined,
    phone: profile.phone ? normalizeField(profile.phone, (value) => value.trim()) : undefined,
    location: profile.location ? normalizeField(profile.location, (value) => value.trim()) : undefined,
    summary: profile.summary ? normalizeField(profile.summary, (value) => value.trim()) : undefined,
    targetRoles: normalizeField(profile.targetRoles, normalizeStringArray),
    skills: normalizeField(profile.skills, normalizeStringArray),
    projects: normalizeField(profile.projects, normalizeProjects),
    experience: normalizeField(profile.experience, normalizeExperience),
    education: normalizeField(profile.education, normalizeEducation),
    keywords: normalizeField(profile.keywords, normalizeStringArray),
    seniority: profile.seniority ? normalizeField(profile.seniority, (value) => value.trim()) : undefined,
    source: {
      ...profile.source,
      extractionWarnings: profile.source.extractionWarnings.map((warning) => sanitizedEvidence(warning) ?? warning),
    },
  }
  return resumeProfileV2Schema.parse(normalized)
}

function contactsEquivalent(kind: 'email' | 'phone', left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) return false
  if (kind === 'email') return left.trim().toLowerCase() === right.trim().toLowerCase()
  const leftDigits = left.replace(/\D/g, '')
  const rightDigits = right.replace(/\D/g, '')
  return leftDigits.length > 0 && leftDigits === rightDigits
}

function repairDeterministicContacts(
  profile: ResumeProfileV2,
  text: string,
): { profile: ResumeProfileV2; repaired: boolean; warnings: string[] } {
  const warnings: string[] = []
  let repaired = false
  const next: ResumeProfileV2 = {
    ...profile,
    source: { ...profile.source, extractionWarnings: [...profile.source.extractionWarnings] },
  }
  const email = findFirst(text, EMAIL_RE)
  const phone = findFirst(text, PHONE_RE)

  if (email && !contactsEquivalent('email', next.email?.value, email)) {
    next.email = {
      value: email,
      confidence: Math.max(next.email?.confidence ?? 0, 0.98),
      evidence: 'Detected by deterministic email pattern.',
    }
    warnings.push('Email field repaired by deterministic extraction.')
    repaired = true
  } else if (next.email && !EMAIL_RE.test(next.email.value)) {
    next.email = undefined
    warnings.push('Invalid LLM email field was dropped.')
    repaired = true
  }

  if (phone && !contactsEquivalent('phone', next.phone?.value, phone)) {
    next.phone = {
      value: phone,
      confidence: Math.max(next.phone?.confidence ?? 0, 0.95),
      evidence: 'Detected by deterministic phone pattern.',
    }
    warnings.push('Phone field repaired by deterministic extraction.')
    repaired = true
  } else if (next.phone && !PHONE_RE.test(next.phone.value)) {
    next.phone = undefined
    warnings.push('Invalid LLM phone field was dropped.')
    repaired = true
  }

  if (repaired) {
    next.source.parser = 'llm_with_heuristic_repair'
    next.source.extractionWarnings.push(...warnings)
  }

  return { profile: normalizeProfileV2(next), repaired, warnings }
}

function missingStringField(field: FieldValue<string> | undefined): boolean {
  return !field?.value?.trim()
}

function missingArrayField<T>(field: FieldValue<T[]>): boolean {
  return field.value.length === 0
}

function cloneProfileForRepair(profile: ResumeProfileV2): ResumeProfileV2 {
  return {
    ...profile,
    source: { ...profile.source, extractionWarnings: [...profile.source.extractionWarnings] },
    targetRoles: { ...profile.targetRoles, value: [...profile.targetRoles.value] },
    skills: { ...profile.skills, value: [...profile.skills.value] },
    projects: { ...profile.projects, value: [...profile.projects.value] },
    experience: { ...profile.experience, value: profile.experience.value.map((item) => ({ ...item })) },
    education: { ...profile.education, value: profile.education.value.map((item) => ({ ...item })) },
    keywords: { ...profile.keywords, value: [...profile.keywords.value] },
  }
}

function repairMissingLlmFields(
  profile: ResumeProfileV2,
  text: string,
): { profile: ResumeProfileV2; repaired: boolean; warnings: string[] } {
  const legacy = parseResumeText(text, legacySourceFromSourceType(profile.source.type))
  const fallback = legacyProfileToResumeV2(legacy, {
    type: profile.source.type,
    textLength: text.length,
    parser: 'heuristic',
  })
  const warnings: string[] = []
  const next = cloneProfileForRepair(profile)

  const backfillScalar = (
    key: 'name' | 'location' | 'summary' | 'seniority',
    warning: string,
  ) => {
    if (missingStringField(next[key]) && fallback[key]?.value) {
      next[key] = fallback[key]
      warnings.push(warning)
    }
  }
  backfillScalar('name', 'Name field backfilled by deterministic resume parser.')
  backfillScalar('location', 'Location field backfilled by deterministic resume parser.')
  backfillScalar('summary', 'Summary field backfilled by deterministic resume parser.')
  backfillScalar('seniority', 'Seniority field backfilled by deterministic resume parser.')

  const backfillArray = (
    key: 'targetRoles' | 'projects' | 'experience' | 'education' | 'keywords',
    warning: string,
  ) => {
    if (missingArrayField(next[key]) && fallback[key].value.length > 0) {
      next[key] = fallback[key]
      warnings.push(warning)
    }
  }
  backfillArray('targetRoles', 'Target roles backfilled by deterministic resume parser.')
  backfillArray('projects', 'Projects backfilled by deterministic resume parser.')
  backfillArray('experience', 'Experience backfilled by deterministic resume parser.')
  backfillArray('education', 'Education backfilled by deterministic resume parser.')
  backfillArray('keywords', 'Keywords backfilled by deterministic resume parser.')

  const mergedSkills = normalizeStringArray([...next.skills.value, ...fallback.skills.value])
  if (mergedSkills.length > next.skills.value.length) {
    next.skills = {
      value: mergedSkills,
      confidence: Math.max(next.skills.confidence, fallback.skills.confidence),
      evidence: next.skills.evidence || fallback.skills.evidence,
    }
    warnings.push('Skills merged with deterministic resume parser.')
  }

  if (warnings.length) {
    next.source.parser = 'llm_with_heuristic_repair'
    next.source.extractionWarnings.push(...warnings)
  }
  return { profile: normalizeProfileV2(next), repaired: warnings.length > 0, warnings }
}

function repairDeterministicResumeFields(profile: ResumeProfileV2, text: string): ResumeProfileV2 {
  const contact = repairDeterministicContacts(profile, text).profile
  return repairMissingLlmFields(contact, text).profile
}

interface LlmResumePayload {
  schemaVersion?: 'resume-profile/v2'
  name?: FieldValue<string>
  email?: FieldValue<string>
  phone?: FieldValue<string>
  location?: FieldValue<string>
  summary?: FieldValue<string>
  targetRoles: FieldValue<string[]>
  skills: FieldValue<string[]>
  projects: FieldValue<ResumeProjectExperience[]>
  experience: FieldValue<ResumeExperience[]>
  education: FieldValue<ResumeEducation[]>
  keywords: FieldValue<string[]>
  seniority?: FieldValue<string>
}

interface LlmResumeParseAttempt {
  payload: LlmResumePayload
  repaired: boolean
  warnings: string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function compactJson(value: unknown, maxChars = 9000): string {
  const text = JSON.stringify(value, null, 2) ?? String(value)
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n... [truncated]` : text
}

function formatZodIssues(error: z.ZodError, limit = 6): string {
  return error.issues
    .slice(0, limit)
    .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
    .join('; ')
}

function unwrapLlmResumeRoot(value: unknown): unknown {
  if (!isRecord(value)) return value
  for (const key of ['profile', 'resume', 'resumeProfile', 'data', 'result']) {
    if (isRecord(value[key])) return value[key]
  }
  return value
}

function coerceString(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined
  if (typeof value === 'string') return value.trim() || undefined
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return undefined
}

function coerceStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return normalizeStringArray(value.map(coerceString).filter(Boolean) as string[])
  const scalar = coerceString(value)
  if (!scalar) return []
  return normalizeStringArray(scalar.split(/[,\n;；，、|/]+/))
}

function coerceConfidence(value: unknown, fallback: number): number {
  const numeric = typeof value === 'number'
    ? value
    : typeof value === 'string'
      ? Number.parseFloat(value)
      : Number.NaN
  if (!Number.isFinite(numeric)) return fallback
  return clampConfidence(numeric > 1 && numeric <= 100 ? numeric / 100 : numeric)
}

function coerceEvidence(value: unknown, fallback: string): string | undefined {
  if (Array.isArray(value)) {
    const joined = value.map(coerceString).filter(Boolean).join('; ')
    return sanitizedEvidence(joined || fallback)
  }
  return sanitizedEvidence(coerceString(value) || fallback)
}

function rawFieldValue(value: unknown): unknown {
  if (isRecord(value) && 'value' in value) return value.value
  return value
}

function normalizeScalarLlmField(
  value: unknown,
  fallbackEvidence: string,
  fallbackConfidence = 0.65,
): FieldValue<string> | undefined {
  const rawValue = rawFieldValue(value)
  const scalar = coerceString(rawValue)
  if (!scalar) return undefined
  const field = isRecord(value) ? value : {}
  return {
    value: scalar,
    confidence: coerceConfidence(field.confidence, fallbackConfidence),
    evidence: coerceEvidence(field.evidence, fallbackEvidence),
  }
}

function normalizeArrayLlmField<T>(
  value: unknown,
  normalizeValue: (value: unknown) => T[],
  fallbackEvidence: string,
  fallbackConfidence = 0.65,
): FieldValue<T[]> {
  const rawValue = rawFieldValue(value)
  const field = isRecord(value) ? value : {}
  return {
    value: normalizeValue(rawValue),
    confidence: coerceConfidence(field.confidence, fallbackConfidence),
    evidence: coerceEvidence(field.evidence, fallbackEvidence),
  }
}

function coerceProjectArray(value: unknown): ResumeProjectExperience[] {
  const items = Array.isArray(value) ? value : isRecord(value) || coerceString(value) ? [value] : []
  return normalizeProjects(items.map((item) => {
    if (!isRecord(item)) return { summary: coerceString(item) }
    return {
      name: coerceString(item.name ?? item.project ?? item.title),
      role: coerceString(item.role),
      period: coerceString(item.period ?? item.time ?? item.date),
      summary: coerceString(item.summary ?? item.description ?? item.desc),
      technologies: coerceStringArray(item.technologies ?? item.techStack ?? item.tech ?? item.skills),
    }
  }))
}

function coerceExperienceArray(value: unknown): ResumeExperience[] {
  const items = Array.isArray(value) ? value : isRecord(value) || coerceString(value) ? [value] : []
  return normalizeExperience(items.map((item) => {
    if (!isRecord(item)) return { summary: coerceString(item) }
    return {
      company: coerceString(item.company ?? item.organization ?? item.org),
      title: coerceString(item.title ?? item.role ?? item.position),
      period: coerceString(item.period ?? item.time ?? item.date),
      summary: coerceString(item.summary ?? item.description ?? item.desc),
    }
  }))
}

function coerceEducationArray(value: unknown): ResumeEducation[] {
  const items = Array.isArray(value) ? value : isRecord(value) || coerceString(value) ? [value] : []
  return normalizeEducation(items.map((item) => {
    if (!isRecord(item)) return { school: coerceString(item) }
    return {
      school: coerceString(item.school ?? item.university ?? item.institution),
      degree: coerceString(item.degree),
      major: coerceString(item.major ?? item.field),
      period: coerceString(item.period ?? item.time ?? item.date),
    }
  }))
}

function pickField(root: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (root[key] !== undefined && root[key] !== null) return root[key]
  }
  return undefined
}

function normalizeLlmResumePayload(raw: unknown): LlmResumePayload | null {
  const root = unwrapLlmResumeRoot(raw)
  if (!isRecord(root)) return null

  return {
    schemaVersion: 'resume-profile/v2',
    name: normalizeScalarLlmField(pickField(root, ['name', 'fullName', 'candidateName']), 'candidate name field'),
    email: normalizeScalarLlmField(pickField(root, ['email', 'mail']), 'email/contact field'),
    phone: normalizeScalarLlmField(pickField(root, ['phone', 'mobile', 'telephone']), 'phone/contact field'),
    location: normalizeScalarLlmField(pickField(root, ['location', 'city', 'address']), 'location field'),
    summary: normalizeScalarLlmField(pickField(root, ['summary', 'profileSummary', 'introduction']), 'summary field'),
    targetRoles: normalizeArrayLlmField(
      pickField(root, ['targetRoles', 'target_roles', 'desiredRoles', 'roles', 'jobTargets']),
      coerceStringArray,
      'target roles field',
      0.55,
    ),
    skills: normalizeArrayLlmField(
      pickField(root, ['skills', 'technicalSkills', 'skillSet', 'technologies']),
      coerceStringArray,
      'skills field',
      0.7,
    ),
    projects: normalizeArrayLlmField(
      pickField(root, ['projects', 'projectExperience', 'project_experience']),
      coerceProjectArray,
      'projects field',
      0.65,
    ),
    experience: normalizeArrayLlmField(
      pickField(root, ['experience', 'workExperience', 'work_experience', 'employment']),
      coerceExperienceArray,
      'experience field',
      0.65,
    ),
    education: normalizeArrayLlmField(
      pickField(root, ['education', 'educations']),
      coerceEducationArray,
      'education field',
      0.65,
    ),
    keywords: normalizeArrayLlmField(
      pickField(root, ['keywords', 'tags', 'keyWords']),
      coerceStringArray,
      'keywords field',
      0.55,
    ),
    seniority: normalizeScalarLlmField(pickField(root, ['seniority', 'level']), 'seniority field', 0.55),
  }
}

function hasUsefulLlmResumePayload(payload: LlmResumePayload): boolean {
  const nonEmptyArrays = LLM_ARRAY_FIELD_KEYS.filter((key) => payload[key].value.length > 0).length
  const scalars = [payload.name, payload.email, payload.phone, payload.location, payload.summary, payload.seniority]
    .filter((field) => Boolean(field?.value)).length
  return nonEmptyArrays > 0 || scalars >= 3
}

function parseLlmResumePayload(raw: unknown): LlmResumeParseAttempt | null {
  const direct = llmResumeSchema.safeParse(raw)
  if (direct.success && hasUsefulLlmResumePayload(direct.data)) {
    return { payload: direct.data, repaired: false, warnings: [] }
  }

  const normalized = normalizeLlmResumePayload(raw)
  if (!normalized) return null
  const normalizedParse = llmResumeSchema.safeParse(normalized)
  if (!normalizedParse.success || !hasUsefulLlmResumePayload(normalizedParse.data)) return null

  const issues = direct.success ? '' : formatZodIssues(direct.error)
  return {
    payload: normalizedParse.data,
    repaired: true,
    warnings: [
      issues
        ? `LLM resume JSON normalized before schema validation (${issues}).`
        : 'LLM resume JSON normalized before schema validation.',
    ],
  }
}

function resumeLlmSystemPrompt(): string {
  return [
    'You extract structured resume profiles.',
    'Return only a single JSON object. No markdown, comments, or prose.',
    'Every field you provide must follow { "value": ..., "confidence": number, "evidence": string }.',
    'Confidence must be between 0 and 1.',
    'Evidence must be short, sanitized, and should describe the cue or section; do not quote long resume text.',
    'If a field is unknown, omit optional scalar fields and use an empty array for array fields.',
  ].join(' ')
}

function resumeLlmUserPrompt(text: string): string {
  const clipped = text.length > RESUME_LLM_MAX_CHARS ? text.slice(0, RESUME_LLM_MAX_CHARS) : text
  return [
    'Parse this resume into this JSON schema:',
    JSON.stringify({
      schemaVersion: 'resume-profile/v2',
      name: { value: 'string', confidence: 0.0, evidence: 'short cue' },
      email: { value: 'string', confidence: 0.0, evidence: 'short cue' },
      phone: { value: 'string', confidence: 0.0, evidence: 'short cue' },
      location: { value: 'string', confidence: 0.0, evidence: 'short cue' },
      summary: { value: 'string', confidence: 0.0, evidence: 'short cue' },
      targetRoles: { value: ['string'], confidence: 0.0, evidence: 'short cue' },
      skills: { value: ['string'], confidence: 0.0, evidence: 'short cue' },
      projects: {
        value: [{ name: 'string', role: 'string', period: 'string', summary: 'string', technologies: ['string'] }],
        confidence: 0.0,
        evidence: 'short cue',
      },
      experience: {
        value: [{ company: 'string', title: 'string', period: 'string', summary: 'string' }],
        confidence: 0.0,
        evidence: 'short cue',
      },
      education: {
        value: [{ school: 'string', degree: 'string', major: 'string', period: 'string' }],
        confidence: 0.0,
        evidence: 'short cue',
      },
      keywords: { value: ['string'], confidence: 0.0, evidence: 'short cue' },
      seniority: { value: 'junior|mid|senior|principal|unknown', confidence: 0.0, evidence: 'short cue' },
    }),
    'Resume text:',
    clipped,
  ].join('\n')
}

function resumeJsonRepairSystemPrompt(): string {
  return [
    'You repair resume JSON so it matches the requested schema.',
    'Return only a single JSON object. Do not add markdown, comments, or prose.',
    'Preserve the facts already present in the input JSON. Do not invent resume details.',
    'Every field must follow { "value": ..., "confidence": number, "evidence": string }.',
  ].join(' ')
}

function resumeJsonRepairUserPrompt(payload: unknown, schemaIssues: string): string {
  return [
    'Repair this candidate resume JSON into schemaVersion "resume-profile/v2".',
    'Required array fields: targetRoles, skills, projects, experience, education, keywords.',
    'Optional scalar fields: name, email, phone, location, summary, seniority.',
    `Schema validation issues: ${schemaIssues || 'unknown'}`,
    'Candidate JSON:',
    compactJson(payload),
  ].join('\n')
}

async function parseResumeTextWithLlm(
  text: string,
  metadata: {
    llm: ResumeIngestLlm
    path?: string
    type: ResumeSourceType
    extractionWarnings: string[]
  },
): Promise<ResumeProfileV2 | null> {
  let payload: unknown = null
  try {
    payload = await metadata.llm.generateJson<unknown>(
      resumeLlmSystemPrompt(),
      resumeLlmUserPrompt(text),
      { timeoutMs: 30000, maxTokens: 5000, redactTrace: true },
    )
  } catch {
    return null
  }
  if (payload === null) return null

  let attempt = parseLlmResumePayload(payload)
  if (!attempt) {
    const firstParse = llmResumeSchema.safeParse(payload)
    const firstIssues = firstParse.success ? '' : formatZodIssues(firstParse.error)
    const repaired = await metadata.llm.generateJson<unknown>(
      resumeJsonRepairSystemPrompt(),
      resumeJsonRepairUserPrompt(payload, firstIssues),
      { timeoutMs: 25000, maxTokens: 5000, redactTrace: true },
    )
    attempt = parseLlmResumePayload(repaired)
    if (attempt) {
      attempt.repaired = true
      attempt.warnings.unshift(
        firstIssues
          ? `LLM resume JSON repaired after schema validation failure (${firstIssues}).`
          : 'LLM resume JSON repaired after schema validation failure.',
      )
    }
  }
  if (!attempt) return null

  const profile: ResumeProfileV2 = normalizeProfileV2({
    schemaVersion: 'resume-profile/v2',
    ...attempt.payload,
    source: {
      path: metadata.path,
      type: metadata.type,
      extractionWarnings: [
        ...metadata.extractionWarnings,
        ...attempt.warnings,
        ...(text.length > RESUME_LLM_MAX_CHARS
          ? ['Resume text was truncated before LLM parsing to stay within parser limits.']
          : []),
      ],
      textLength: text.length,
      parser: attempt.repaired ? 'llm_with_heuristic_repair' : 'llm',
    },
  })

  return repairDeterministicResumeFields(profile, text)
}

async function ingestResumeText(
  text: string,
  legacySource: ResumeProfile['source'],
  sourceType: ResumeSourceType,
  options: ResumeIngestOptions,
  extractionWarnings: string[] = [],
): Promise<ResumeProfileV2> {
  const sourcePath = options.sourcePath
  const warnings = [...extractionWarnings]
  const llm = options.llm
  if (llm?.hasKey) {
    const parsed = await parseResumeTextWithLlm(text, {
      llm,
      path: sourcePath,
      type: sourceType,
      extractionWarnings: warnings,
    })
    if (parsed) return parsed
    warnings.push('LLM resume JSON parse failed (request, empty response, or schema validation); used heuristic parser.')
  } else {
    warnings.push('No model key configured; used heuristic resume parser.')
  }

  const legacy = parseResumeText(text, legacySource)
  return legacyProfileToResumeV2(legacy, {
    path: sourcePath,
    type: sourceType,
    textLength: text.length,
    extractionWarnings: warnings,
    parser: 'heuristic',
  })
}

function readJsonResumeV2(filePath: string, options: ResumeIngestOptions): ResumeProfileV2 {
  const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as unknown
  const asV2 = resumeProfileV2Schema.safeParse(parsed)
  if (asV2.success) {
    return normalizeProfileV2({
      ...asV2.data,
      source: {
        ...asV2.data.source,
        path: asV2.data.source.path ?? options.sourcePath,
        parser: 'json',
      },
    })
  }

  const legacy = parsed as Partial<ResumeProfile>
  const legacySource =
    legacy.source === 'pdf' || legacy.source === 'txt' || legacy.source === 'json'
      ? legacy.source
      : 'json'
  return legacyProfileToResumeV2({
    skills: [],
    experience: [],
    education: [],
    keywords: [],
    ...legacy,
    source: legacySource,
  }, {
    path: options.sourcePath,
    type: 'json',
    extractionWarnings: [],
    parser: 'json',
  })
}

export async function readResumeV2(
  filePath: string,
  options: ResumeIngestOptions = {},
): Promise<ResumeProfileV2 | null> {
  if (!existsSync(filePath)) return null
  const ingestOptions: ResumeIngestOptions = {
    ...options,
    sourcePath: options.sourcePath ?? filePath,
  }
  const lower = filePath.toLowerCase()
  if (lower.endsWith('.json')) return readJsonResumeV2(filePath, ingestOptions)
  if (lower.endsWith('.txt')) {
    return ingestResumeText(readFileSync(filePath, 'utf8'), 'txt', 'txt', ingestOptions)
  }
  if (lower.endsWith('.pdf')) {
    const text = await extractTextFromPdf(filePath)
    const minTextLength = ingestOptions.minPdfTextLength ?? DEFAULT_MIN_PDF_TEXT_LENGTH
    const isTextPdf = text.replace(/\s+/g, '').length >= minTextLength
    if (!isTextPdf) {
      return ingestResumeText(text, 'pdf', 'pdf-image', ingestOptions, [
        'PDF text extraction produced little usable text; scanned/image PDF ingestion is reserved for a future multimodal adapter.',
      ])
    }
    return ingestResumeText(text, 'pdf', 'pdf-text', ingestOptions)
  }
  return null
}

export async function ingestResume(
  filePath: string,
  options: ResumeIngestOptions = {},
): Promise<ResumeProfileV2 | null> {
  return readResumeV2(filePath, options)
}

/**
 * Read a resume from disk. Supports:
 *   - .pdf   (primary, parsed with pdfjs-dist)
 *   - .json  (already-structured ResumeProfile, for deterministic demos)
 *   - .txt   (plain text, heuristically parsed)
 *
 * If the path does not exist, returns null so the caller can decide whether to
 * fall back to a generated sample resume.
 */
export async function readResume(filePath: string): Promise<ResumeProfile | null> {
  if (!existsSync(filePath)) return null
  const lower = filePath.toLowerCase()
  if (lower.endsWith('.json')) {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as Partial<ResumeProfile>
    return { skills: [], experience: [], education: [], keywords: [], source: 'json', ...parsed }
  }
  if (lower.endsWith('.txt')) {
    return parseResumeText(readFileSync(filePath, 'utf8'), 'txt')
  }
  if (lower.endsWith('.pdf')) {
    const text = await extractTextFromPdf(filePath)
    return parseResumeText(text, 'pdf')
  }
  return null
}

// ---------------------------------------------------------------------------
// Sample resume PDF generator
// ---------------------------------------------------------------------------

/**
 * Write a minimal but VALID one-page PDF with extractable text. Used by the
 * demo (so it runs without a real resume) and by the resume unit test (so it
 * verifies genuine pdfjs-dist extraction end-to-end).
 *
 * The layout is intentionally simple: each `line` becomes a `(...) Tj` on its
 * own text line with correct xref offsets computed from the assembled bytes.
 */
export function writeSampleResumePdf(
  filePath: string,
  lines: string[] = SAMPLE_RESUME_LINES,
): void {
  mkdirSync(dirname(filePath), { recursive: true })

  const header = '%PDF-1.4\n'
  const objects: string[] = []

  objects.push('<< /Type /Catalog /Pages 2 0 R >>')
  objects.push('<< /Type /Pages /Kids [3 0 R] /Count 1 >>')
  objects.push(
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ' +
      '/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
  )
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')

  // Build the content stream: start text, 12pt, position first line, then
  // step down 18pt per line.
  const streamParts: string[] = ['BT', '/F1 12 Tf', '72 720 Td', '18 TL']
  for (let i = 0; i < lines.length; i += 1) {
    const escaped = lines[i].replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
    streamParts.push(`(${escaped}) Tj`)
    if (i < lines.length - 1) streamParts.push('T*')
  }
  streamParts.push('ET')
  const stream = streamParts.join('\n')
  objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`)

  // Assemble body with byte-accurate xref offsets.
  let body = header
  const offsets: number[] = []
  for (let i = 0; i < objects.length; i += 1) {
    offsets.push(Buffer.byteLength(body))
    body += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`
  }

  const xrefStart = Buffer.byteLength(body)
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const off of offsets) {
    xref += `${String(off).padStart(10, '0')} 00000 n \n`
  }
  const trailer =
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n` +
    `startxref\n${xrefStart}\n%%EOF\n`

  writeFileSync(filePath, Buffer.from(body + xref + trailer, 'latin1'))
}

export const SAMPLE_RESUME_LINES = [
  'Zhang San',
  'Email: zhangsan@example.com  Phone: 13800001234',
  'Summary: Senior frontend engineer with 6 years building large-scale web apps.',
  '',
  'Skills: TypeScript React Vue Next.js Node.js Playwright Docker Kubernetes AWS',
  '',
  'Experience',
  'Ant Group',
  '2021.05-Present',
  'Senior Frontend Engineer',
  'Built internal tooling platform with React and TypeScript.',
  '',
  'ByteDance',
  '2019.07-2021.04',
  'Frontend Engineer',
  'Developed component library and automated E2E tests with Playwright.',
  '',
  'Education',
  'Zhejiang University, Bachelor, Computer Science, 2015-2019',
]
