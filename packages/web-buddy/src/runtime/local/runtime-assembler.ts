import type { AgentConfig } from '../../sdk/config.js'
import type { WebTaskInputSnapshot } from '../../task/contracts.js'
import type { ToolOrchestrationOptions } from './agent-loop.js'
import type { WebBuddyTaskType } from '../../workflow/completion-gate.js'

export type RuntimeTaskProfileId =
  | 'safe-web/v1'
  | 'research-analysis/v1'
  | 'form-draft/v1'
  | 'final-review/v1'

export interface RuntimeAssembly {
  schemaVersion: 'runtime-assembly/v1'
  profileId: RuntimeTaskProfileId
  taskType: WebBuddyTaskType
  durableSession: boolean
  asyncTasks: {
    eligible: boolean
    reason: string
  }
  memory: {
    mode: 'host_lifecycle' | 'legacy_local' | 'disabled'
  }
  toolOrchestration: ToolOrchestrationOptions
}

export function assembleRuntimeProfile(input: {
  task: WebTaskInputSnapshot
  config: AgentConfig
  durableSession?: boolean
  hasLifecycleMemoryProvider?: boolean
  hasAsyncRuntimeFactory?: boolean
}): RuntimeAssembly {
  const taskType = inferWebBuddyTaskType(input.task)
  const profileId = profileFor(input.task, taskType)
  const durableSession = input.durableSession ?? true
  const analysisTask = profileId === 'research-analysis/v1'
  const asyncConfigured = input.config.agent.asyncTasks?.enabled === true || input.hasAsyncRuntimeFactory === true
  const asyncEligible = analysisTask && durableSession && asyncConfigured
  const writeSensitive = profileId === 'form-draft/v1' || profileId === 'final-review/v1'
  const configuredOrchestration = input.config.agent.toolOrchestration
  const toolOrchestration: ToolOrchestrationOptions = writeSensitive
    ? { mode: 'serial', maxConcurrency: 1, parallelAllowlist: [] }
    : {
        mode: configuredOrchestration.mode,
        maxConcurrency: configuredOrchestration.maxConcurrency,
        parallelAllowlist: configuredOrchestration.parallelAllowlist,
      }
  return {
    schemaVersion: 'runtime-assembly/v1',
    profileId,
    taskType,
    durableSession,
    asyncTasks: {
      eligible: asyncEligible,
      reason: !analysisTask
        ? 'Only research/comparison profiles may use read-only async workers.'
        : !durableSession
          ? 'Async workers require a durable session.'
          : !asyncConfigured
            ? 'Async workers are disabled by configuration.'
            : 'Read-only async workers are eligible for this analysis task.',
    },
    memory: {
      mode: input.hasLifecycleMemoryProvider
        ? 'host_lifecycle'
        : input.task.ownerScope
          ? 'disabled'
          : 'legacy_local',
    },
    toolOrchestration,
  }
}

export function inferWebBuddyTaskType(task: Pick<WebTaskInputSnapshot, 'goal' | 'contract'>): WebBuddyTaskType {
  const scenario = task.goal.scenario?.toLowerCase()
  if (scenario === 'apply_entry') return 'apply_entry'
  if (scenario === 'final_review') return 'final_review'
  if (task.contract.criteria.some((criterion) => criterion.kind === 'form_state')
    || scenario === 'form_draft'
    || scenario === 'fill_form') {
    return 'fill_form'
  }
  return 'explore'
}

function profileFor(
  task: Pick<WebTaskInputSnapshot, 'goal' | 'contract'>,
  taskType: WebBuddyTaskType,
): RuntimeTaskProfileId {
  if (taskType === 'fill_form') return 'form-draft/v1'
  if (taskType === 'final_review' || taskType === 'apply_entry') return 'final-review/v1'
  const scenario = task.goal.scenario?.toLowerCase()
  if (scenario === 'research' || scenario === 'comparison') return 'research-analysis/v1'
  if (task.contract.criteria.some((criterion) => criterion.kind === 'artifact_present')) {
    return 'research-analysis/v1'
  }
  return 'safe-web/v1'
}
