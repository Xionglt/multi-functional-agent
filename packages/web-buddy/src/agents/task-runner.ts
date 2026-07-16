import type {
  AgentTaskRunControlV1,
  AgentTaskRunOutcome,
  AgentTaskRunRequestV1,
  DeterministicTaskKind,
  DeterministicTaskRunnerV1,
  ImmutableArtifactRef,
  RunnerError,
} from './async-task-contracts.js'

export type {
  AgentTaskRunnerV1,
  AgentTaskRunControlV1,
  AgentTaskRunOutcome,
  AgentTaskRunRequestV1,
  DeterministicTaskRunnerV1,
  ReadOnlyLlmTaskRunnerV1,
  RunnerError,
} from './async-task-contracts.js'

export interface FakeRunnerPlan {
  delayMs?: number
  progress?: Array<{ afterMs?: number; phase: 'initializing' | 'reading_artifacts' | 'reasoning' | 'validating_output'; summary: string }>
  outcome?: 'succeeded_deterministic' | 'failed' | 'aborted'
  outputRefs?: [ImmutableArtifactRef, ...ImmutableArtifactRef[]]
  error?: RunnerError
}

/** Deterministic runner used by scheduler tests and the fake vertical slice. */
export class FakeRunner implements DeterministicTaskRunnerV1 {
  readonly contractVersion = 'agent-task-runner/v1' as const
  readonly runnerKind = 'deterministic' as const
  readonly capacityClass = 'deterministic' as const
  readonly runnerId: string
  readonly runnerVersion: string
  readonly kinds: readonly DeterministicTaskKind[]
  readonly startedTaskIds: string[] = []
  readonly finishedTaskIds: string[] = []
  private readonly plan: FakeRunnerPlan | ((request: Extract<AgentTaskRunRequestV1, { runnerKind: 'deterministic' }>) => FakeRunnerPlan)

  constructor(options: {
    runnerId?: string
    runnerVersion?: string
    kinds?: readonly DeterministicTaskKind[]
    plan?: FakeRunnerPlan | ((request: Extract<AgentTaskRunRequestV1, { runnerKind: 'deterministic' }>) => FakeRunnerPlan)
  } = {}) {
    this.runnerId = options.runnerId ?? 'fake-deterministic-runner'
    this.runnerVersion = options.runnerVersion ?? '1.0.0'
    this.kinds = options.kinds ?? ['memory_retrieval', 'workflow_evaluation', 'delivery_probe']
    this.plan = options.plan ?? {}
  }

  async run(
    request: Extract<AgentTaskRunRequestV1, { runnerKind: 'deterministic' }>,
    control: AgentTaskRunControlV1,
  ): Promise<Exclude<AgentTaskRunOutcome, { outcome: 'succeeded' }>> {
    this.startedTaskIds.push(request.task.id)
    const plan = typeof this.plan === 'function' ? this.plan(request) : this.plan
    try {
      let progressSeq = 0
      for (const progress of plan.progress ?? []) {
        await abortableDelay(progress.afterMs ?? 0, control.abortSignal)
        progressSeq += 1
        await control.reportProgress({
          schemaVersion: 'agent-task-runner-progress/v1',
          runIdentity: request.runIdentity,
          progressSeq,
          phase: progress.phase,
          summary: progress.summary,
          occurredAt: new Date().toISOString(),
          authoritativeCompletionEvidence: false,
        })
      }
      await abortableDelay(plan.delayMs ?? 0, control.abortSignal)
    } catch {
      return { schemaVersion: 'agent-task-run-outcome/v1', outcome: 'aborted', reason: 'signal' }
    }
    this.finishedTaskIds.push(request.task.id)
    if (plan.outcome === 'aborted') {
      return { schemaVersion: 'agent-task-run-outcome/v1', outcome: 'aborted', reason: 'signal' }
    }
    if (plan.outcome === 'failed') {
      return {
        schemaVersion: 'agent-task-run-outcome/v1',
        outcome: 'failed',
        error: plan.error ?? fakeRunnerError('INTERNAL', 'Fake runner configured to fail.', 'never_retry'),
      }
    }
    const outputRefs = plan.outputRefs ?? request.inputArtifactRefs
    if (outputRefs.length === 0) {
      return {
        schemaVersion: 'agent-task-run-outcome/v1',
        outcome: 'failed',
        error: fakeRunnerError('OUTPUT_SCHEMA_INVALID', 'Fake runner success requires at least one immutable output ref.', 'never_retry'),
      }
    }
    return {
      schemaVersion: 'agent-task-run-outcome/v1',
      outcome: 'succeeded_deterministic',
      result: {
        schemaVersion: 'deterministic-task-result/v1',
        runIdentity: request.runIdentity,
        outputRefs: outputRefs as [ImmutableArtifactRef, ...ImmutableArtifactRef[]],
        freshness: request.task.actionBinding.kind === 'browser_action'
          ? {
              kind: 'assessed',
              sourceActionSeq: request.task.actionBinding.sourceActionSeq,
              assessedAgainstActionSeq: request.task.actionBinding.sourceActionSeq,
              validity: 'unverified',
            }
          : { kind: 'not_action_bound', validity: 'not_applicable' },
        requiresMainWorkflowVerification: true,
        authoritativeCompletionEvidence: false,
      },
    }
  }
}

export function fakeRunnerError(
  code: RunnerError['code'],
  message: string,
  retryDisposition: RunnerError['retryDisposition'],
): RunnerError {
  return {
    schemaVersion: 'agent-task-runner-error/v1',
    code,
    category: retryDisposition === 'retry_same_task' ? 'transient' : 'internal',
    retryDisposition,
    message,
  }
}

async function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw abortError()
  if (ms <= 0) return
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(abortError())
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function abortError(): Error {
  return Object.assign(new Error('Fake runner aborted.'), { name: 'AbortError' })
}
