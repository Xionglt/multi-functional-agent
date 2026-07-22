import type {
  ProjectedSkillEvidenceV1,
  ProposedSkillV1,
} from './contracts.js'

export interface SkillCandidateSynthesizer {
  readonly id: string
  readonly version: string
  synthesize(evidence: ProjectedSkillEvidenceV1): Promise<ProposedSkillV1>
}

export class TemplateSkillCandidateSynthesizer implements SkillCandidateSynthesizer {
  readonly id = 'template-sop'
  readonly version = '1'

  async synthesize(evidence: ProjectedSkillEvidenceV1): Promise<ProposedSkillV1> {
    const taskLabel = evidence.task.taskType ?? evidence.successfulTools[0]?.toolName
    if (!taskLabel) throw new Error('TEMPLATE_SYNTHESIS_REQUIRES_TOOL_STEP')
    const trigger = evidence.task.taskType
      ? { taskTypes: [evidence.task.taskType] }
      : { toolNames: [evidence.successfulTools[0].toolName] }
    const sequence = evidence.successfulTools
      .map((step, index) => (
        `${index + 1}. Call ${step.toolName}, then verify that the step succeeded before continuing.`
      ))
      .join('\n')
    const suffix = evidence.source.traceSha256.slice(0, 10)
    return {
      schemaVersion: 'proposed-skill/v1',
      id: `learned.${slug(taskLabel)}.${suffix}`,
      name: `Learned ${title(taskLabel)} Workflow`,
      scope: 'project',
      priority: 500,
      triggers: trigger,
      provides: { promptSections: ['NEXT_ACTION_RULES'] },
      promptSections: [{
        id: 'NEXT_ACTION_RULES',
        summary: `For comparable tasks, follow this verified tool sequence:\n${sequence}`,
      }],
      body: 'Generated from sanitized successful runtime evidence. Review before promotion.',
    }
  }
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'workflow'
}

function title(value: string): string {
  return value
    .split(/[._-]+/)
    .filter(Boolean)
    .map((part) => `${part[0].toUpperCase()}${part.slice(1).toLowerCase()}`)
    .join(' ')
    .slice(0, 80) || 'Workflow'
}
