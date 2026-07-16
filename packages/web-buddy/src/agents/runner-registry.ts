import type { AgentTaskKind, AgentTaskRunnerV1, BackgroundAgentTaskKind } from './async-task-contracts.js'

export class RunnerRegistry {
  private readonly byKind = new Map<BackgroundAgentTaskKind, AgentTaskRunnerV1>()

  constructor(runners: readonly AgentTaskRunnerV1[] = []) {
    for (const runner of runners) this.register(runner)
  }

  register(runner: AgentTaskRunnerV1): void {
    if ((runner.kinds as readonly AgentTaskKind[]).includes('main_browser_step')) {
      throw registryError('POLICY_VIOLATION', `Runner ${runner.runnerId} cannot register main_browser_step.`)
    }
    if (runner.kinds.length === 0) throw registryError('RUNNER_KIND_CONFLICT', `Runner ${runner.runnerId} has no task kinds.`)
    for (const kind of runner.kinds) {
      assertRunnerKindMatches(runner, kind)
      const existing = this.byKind.get(kind)
      if (existing && existing !== runner) {
        throw registryError('RUNNER_KIND_CONFLICT', `Task kind ${kind} is already owned by ${existing.runnerId}.`)
      }
    }
    for (const kind of runner.kinds) this.byKind.set(kind, runner)
  }

  unregister(runnerId: string): number {
    let removed = 0
    for (const [kind, runner] of this.byKind) {
      if (runner.runnerId !== runnerId) continue
      this.byKind.delete(kind)
      removed += 1
    }
    return removed
  }

  get(kind: BackgroundAgentTaskKind): AgentTaskRunnerV1 | undefined {
    return this.byKind.get(kind)
  }

  require(kind: BackgroundAgentTaskKind): AgentTaskRunnerV1 {
    const runner = this.get(kind)
    if (!runner) throw registryError('RUNNER_NOT_FOUND', `No runner registered for task kind ${kind}.`)
    return runner
  }

  list(): AgentTaskRunnerV1[] {
    return [...new Set(this.byKind.values())]
  }
}

function assertRunnerKindMatches(runner: AgentTaskRunnerV1, kind: BackgroundAgentTaskKind): void {
  const valid = runner.runnerKind === 'read_only_llm'
    ? kind === 'candidate_job_research' || kind === 'trace_summarization'
    : kind === 'memory_retrieval' || kind === 'workflow_evaluation' || kind === 'delivery_probe'
  if (!valid) {
    throw registryError(
      'RUNNER_KIND_CONFLICT',
      `Runner ${runner.runnerId} (${runner.runnerKind}) cannot own task kind ${kind}.`,
    )
  }
}

function registryError(code: 'RUNNER_NOT_FOUND' | 'RUNNER_KIND_CONFLICT' | 'POLICY_VIOLATION', message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code })
}
