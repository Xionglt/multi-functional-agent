import type { PermissionDecision, PermissionRequest } from '../permission/permission-types.js'
import type { PolicyEngineDecision } from '../policy/policy-engine.js'
import type { RiskLevel } from '../sdk/trace.js'
import type { ToolCall, ToolUseContext } from './tool-contract.js'
import { createNormalizedToolError, messageFromUnknown } from './tool-errors.js'
import type { ResolvedToolExecutionPolicyV1 } from './tool-execution-policy.js'
import type { NormalizedToolResult } from './tool-result.js'

export type ToolOrchestrationModeV1 = 'shadow' | 'serial' | 'parallel'
/** Runtime rollout mode. `legacy` intentionally bypasses the orchestrator. */
export type ToolOrchestrationRuntimeModeV1 = 'legacy' | ToolOrchestrationModeV1

export interface IndexedToolCallV1 {
  index: number
  call: ToolCall
  policy: ResolvedToolExecutionPolicyV1
}

export interface ToolCallBatchV1 {
  schemaVersion: 'tool-call-batch/v1'
  batchId: string
  mode: 'parallel' | 'exclusive'
  calls: [IndexedToolCallV1, ...IndexedToolCallV1[]]
}

export interface ToolBatchPlanV1 {
  schemaVersion: 'tool-batch-plan/v1'
  turnId: string
  mode: ToolOrchestrationModeV1
  maxConcurrency: number
  callCount: number
  batches: ToolCallBatchV1[]
}

export interface ToolBatchDiagnosticV1 {
  code: 'TOOL_BATCH_POLICY_FALLBACK' | 'TOOL_BATCH_PLAN_INVALID'
  index?: number
  toolCallId?: string
  message: string
}

export interface PreparedToolCallV1 {
  schemaVersion: 'prepared-tool-call/v1'
  index: number
  call: ToolCall
  executionPolicy: ResolvedToolExecutionPolicyV1
  risk?: RiskLevel
  policyDecision: PolicyEngineDecision
  permissionRequest: PermissionRequest
  permissionDecision: PermissionDecision
  preparedAt: string
  preparedAtActionSeq?: number
  context: ToolUseContext
}

export type ToolStopReasonV1 =
  | 'POLICY_DENIED'
  | 'HUMAN_REJECTED'
  | 'SESSION_ABORTED'
  | 'FATAL_TOOL_ERROR'
  | 'TOOL_DONE'
  | 'DEPENDENCY_INVALIDATED'
  | 'COMMIT_FAILED'
  | 'ORCHESTRATOR_INTERNAL_ERROR'

export interface ToolStopDirectiveV1 {
  stopBatch: boolean
  stopTurn: boolean
  reason?: ToolStopReasonV1
}

export type ToolPrepareOutcomeV1 =
  | {
      schemaVersion: 'tool-prepare-outcome/v1'
      kind: 'ready'
      index: number
      prepared: PreparedToolCallV1
    }
  | {
      schemaVersion: 'tool-prepare-outcome/v1'
      kind: 'terminal'
      index: number
      call: ToolCall
      result: NormalizedToolResult
      stop: ToolStopDirectiveV1
    }

export interface ToolRunOutcomeV1 {
  schemaVersion: 'tool-run-outcome/v1'
  index: number
  prepared: PreparedToolCallV1
  execution: NormalizedToolResult
}

export interface ToolCommitOutcomeV1 {
  schemaVersion: 'tool-commit-outcome/v1'
  index: number
  committedToolCallId: string
  continueTurn: boolean
  done: boolean
  blocked: boolean
  stopReason?: ToolStopReasonV1
}

export interface ToolOrchestratorCallbacksV1 {
  prepare(call: ToolCall, index: number): Promise<ToolPrepareOutcomeV1>
  run(prepared: PreparedToolCallV1): Promise<ToolRunOutcomeV1>
  commit(
    outcome: ToolRunOutcomeV1 | Extract<ToolPrepareOutcomeV1, { kind: 'terminal' }>,
  ): Promise<ToolCommitOutcomeV1>
}

export type SyntheticBlockCodeV1 =
  | 'EARLIER_TOOL_BLOCKED'
  | 'SESSION_ABORTED'
  | 'DEPENDENCY_INVALIDATED'
  | 'EARLIER_TOOL_COMPLETED'
  | 'ORCHESTRATOR_INTERNAL_ERROR'
  | 'TOOL_COMMIT_FAILED'

export interface ToolTerminalProposalV1 {
  schemaVersion: 'tool-terminal-proposal/v1'
  index: number
  call: ToolCall
  code: SyntheticBlockCodeV1
  message: string
}

export interface ToolOrchestratorOptionsV1 {
  turnId: string
  sessionId?: string
  mode: ToolOrchestrationModeV1
  maxConcurrency?: number
  maxConcurrencyUpperBound?: number
  abortSignal?: AbortSignal
  resolvePolicy(call: ToolCall, index: number): ResolvedToolExecutionPolicyV1
  onDiagnostic?: (diagnostic: ToolBatchDiagnosticV1) => void
  materializeTerminal(proposal: ToolTerminalProposalV1): Promise<Extract<ToolPrepareOutcomeV1, { kind: 'terminal' }>>
}

export interface ToolOrchestrationResultV1 {
  schemaVersion: 'tool-orchestration-result/v1'
  plan: ToolBatchPlanV1
  commits: ToolCommitOutcomeV1[]
  terminalProposals: ToolTerminalProposalV1[]
  stopped: boolean
  stopReason?: ToolStopReasonV1
}

export class ToolBatchPlanError extends Error {
  readonly code = 'TOOL_BATCH_PLAN_INVALID'

  constructor(message: string) {
    super(message)
    this.name = 'ToolBatchPlanError'
  }
}

const FALLBACK_POLICY: ResolvedToolExecutionPolicyV1 = {
  schemaVersion: 'tool-execution-policy/v1',
  readOnly: false,
  foreground: 'exclusive',
  resource: 'run_state',
  interruptBehavior: 'block',
  background: 'never',
  source: 'default_fail_closed',
}

/** Pure, deterministic partitioning. Policy resolver failures narrow the call to exclusive. */
export function partitionToolCalls(
  calls: readonly ToolCall[],
  options: Pick<
    ToolOrchestratorOptionsV1,
    'turnId' | 'mode' | 'maxConcurrency' | 'maxConcurrencyUpperBound' | 'resolvePolicy' | 'onDiagnostic'
  >,
): ToolBatchPlanV1 {
  validateStructuralCalls(calls)
  if (typeof options.turnId !== 'string' || options.turnId.length === 0) {
    throw new ToolBatchPlanError('turnId must be a non-empty string.')
  }
  if (!isMode(options.mode)) {
    throw new ToolBatchPlanError(`Unsupported orchestration mode: ${String(options.mode)}`)
  }

  const maxConcurrency = normalizeConcurrency(options.maxConcurrency, options.maxConcurrencyUpperBound)
  const indexed = calls.map((call, index): IndexedToolCallV1 => {
    try {
      const candidate = options.resolvePolicy(call, index)
      if (isValidResolvedPolicy(candidate)) return { index, call, policy: candidate }
      options.onDiagnostic?.({
        code: 'TOOL_BATCH_POLICY_FALLBACK',
        index,
        toolCallId: call.id,
        message: 'Invalid resolved execution policy; using fail-closed exclusive policy.',
      })
    } catch (error) {
      options.onDiagnostic?.({
        code: 'TOOL_BATCH_POLICY_FALLBACK',
        index,
        toolCallId: call.id,
        message: `Execution policy resolver failed; using fail-closed exclusive policy: ${messageFromUnknown(error)}`,
      })
    }
    return { index, call, policy: { ...FALLBACK_POLICY } }
  })

  const batches: ToolCallBatchV1[] = []
  for (const item of indexed) {
    const parallel = options.mode !== 'serial' && item.policy.foreground === 'parallel' && item.policy.resource === 'none'
    const previous = batches.at(-1)
    if (parallel && previous?.mode === 'parallel') {
      previous.calls.push(item)
      continue
    }
    batches.push({
      schemaVersion: 'tool-call-batch/v1',
      batchId: `${options.turnId}:${item.index}-${item.index}`,
      mode: parallel ? 'parallel' : 'exclusive',
      calls: [item],
    })
  }
  for (const batch of batches) {
    const last = batch.calls.at(-1)!
    batch.batchId = `${options.turnId}:${batch.calls[0].index}-${last.index}`
  }

  return {
    schemaVersion: 'tool-batch-plan/v1',
    turnId: options.turnId,
    mode: options.mode,
    maxConcurrency,
    callCount: calls.length,
    batches,
  }
}

export async function orchestrateToolCalls(
  calls: readonly ToolCall[],
  callbacks: ToolOrchestratorCallbacksV1,
  options: ToolOrchestratorOptionsV1,
): Promise<ToolOrchestrationResultV1> {
  const plan = partitionToolCalls(calls, options)
  const commits: ToolCommitOutcomeV1[] = []
  const terminalProposals: ToolTerminalProposalV1[] = []
  let stopped = false
  let stopReason: ToolStopReasonV1 | undefined
  let nextUncommittedIndex = 0
  const materializedTerminals = new Map<number, Extract<ToolPrepareOutcomeV1, { kind: 'terminal' }>>()

  const terminalizeRange = async (
    selected: readonly IndexedToolCallV1[],
    code: SyntheticBlockCodeV1,
  ): Promise<Array<Extract<ToolPrepareOutcomeV1, { kind: 'terminal' }>>> => {
    const outcomes: Array<Extract<ToolPrepareOutcomeV1, { kind: 'terminal' }>> = []
    for (const item of selected) {
      const existing = materializedTerminals.get(item.index)
      if (existing) {
        outcomes.push(existing)
        continue
      }
      const proposal = makeTerminalProposal(item.index, item.call, code)
      terminalProposals.push(proposal)
      const materialized = await options.materializeTerminal(proposal)
      if (
        materialized.schemaVersion !== 'tool-prepare-outcome/v1' || materialized.kind !== 'terminal' ||
        materialized.index !== item.index || materialized.call.id !== item.call.id ||
        materialized.result.toolCallId !== item.call.id
      ) {
        throw new Error(`Invalid materialized terminal outcome for index ${item.index}.`)
      }
      materializedTerminals.set(item.index, materialized)
      outcomes.push(materialized)
    }
    return outcomes
  }

  const allIndexed = plan.batches.flatMap((batch) => batch.calls)

  for (const batch of plan.batches) {
    if (stopped || options.abortSignal?.aborted) {
      const code: SyntheticBlockCodeV1 = options.abortSignal?.aborted ? 'SESSION_ABORTED' : codeForStop(stopReason)
      const remaining = allIndexed.filter((item) => item.index >= nextUncommittedIndex)
      const synthetic = await terminalizeRange(remaining, code)
      const committed = await commitInOrder(synthetic, callbacks)
      commits.push(...committed)
      nextUncommittedIndex = calls.length
      stopped = true
      stopReason ??= options.abortSignal?.aborted ? 'SESSION_ABORTED' : 'ORCHESTRATOR_INTERNAL_ERROR'
      break
    }

    const ready: PreparedToolCallV1[] = []
    const terminal: Array<Extract<ToolPrepareOutcomeV1, { kind: 'terminal' }>> = []
    let prepareStop: ToolStopDirectiveV1 | undefined
    let prepareCursor = 0

    for (; prepareCursor < batch.calls.length; prepareCursor += 1) {
      const item = batch.calls[prepareCursor]
      if (options.abortSignal?.aborted) {
        prepareStop = { stopBatch: true, stopTurn: true, reason: 'SESSION_ABORTED' }
        break
      }
      try {
        const outcome = await callbacks.prepare(item.call, item.index)
        assertPrepareOutcome(outcome, item, options.turnId, options.sessionId)
        if (outcome.kind === 'ready') ready.push(outcome.prepared)
        else {
          terminal.push(outcome)
          if (outcome.stop.stopBatch) {
            prepareStop = outcome.stop
            prepareCursor += 1
            break
          }
        }
      } catch (error) {
        options.onDiagnostic?.({
          code: 'TOOL_BATCH_PLAN_INVALID',
          index: item.index,
          toolCallId: item.call.id,
          message: `Prepare callback failed: ${messageFromUnknown(error)}`,
        })
        prepareStop = { stopBatch: true, stopTurn: true, reason: 'ORCHESTRATOR_INTERNAL_ERROR' }
        break
      }
    }

    const unprepared = batch.calls.slice(prepareCursor)
    if (unprepared.length > 0) {
      const code: SyntheticBlockCodeV1 = prepareStop?.reason === 'SESSION_ABORTED'
        ? 'SESSION_ABORTED'
        : prepareStop?.stopTurn
          ? 'EARLIER_TOOL_BLOCKED'
          : 'DEPENDENCY_INVALIDATED'
      terminal.push(...await terminalizeRange(unprepared, code))
    }

    const capacity = batch.mode === 'parallel' && options.mode === 'parallel' ? plan.maxConcurrency : 1
    const runs = await runBoundedAllSettled(ready, capacity, callbacks.run)
    const outcomes: Array<ToolRunOutcomeV1 | Extract<ToolPrepareOutcomeV1, { kind: 'terminal' }>> = [
      ...runs,
      ...terminal,
    ].sort((left, right) => left.index - right.index)

    for (let outcomeCursor = 0; outcomeCursor < outcomes.length; outcomeCursor += 1) {
      const outcome = outcomes[outcomeCursor]
      try {
        const committed = await callbacks.commit(outcome)
        assertCommitOutcome(committed, outcome)
        commits.push(committed)
        nextUncommittedIndex = committed.index + 1

        const fatalExecution = 'execution' in outcome && outcome.execution.error?.fatal === true
        const shouldStop = fatalExecution || committed.done || committed.blocked || Boolean(committed.stopReason) || !committed.continueTurn
        if (shouldStop) {
          stopReason = fatalExecution
            ? 'FATAL_TOOL_ERROR'
            : committed.stopReason ?? (committed.done ? 'TOOL_DONE' : 'ORCHESTRATOR_INTERNAL_ERROR')
          stopped = true
          const laterInBatch = outcomes.slice(outcomeCursor + 1)
          if (laterInBatch.length > 0) {
            const code = codeForStop(stopReason)
            const replacements = await terminalizeRange(
              laterInBatch.map((later) => ({
                index: later.index,
                call: 'prepared' in later ? later.prepared.call : later.call,
                policy: 'prepared' in later ? later.prepared.executionPolicy : FALLBACK_POLICY,
              })),
              code,
            )
            const replacementCommits = await commitInOrder(replacements, callbacks)
            commits.push(...replacementCommits)
            nextUncommittedIndex = replacementCommits.at(-1)?.index !== undefined
              ? replacementCommits.at(-1)!.index + 1
              : nextUncommittedIndex
          }
          break
        }
      } catch (error) {
        options.onDiagnostic?.({
          code: 'TOOL_BATCH_PLAN_INVALID',
          index: outcome.index,
          message: `Commit callback failed: ${messageFromUnknown(error)}`,
        })
        stopReason = 'COMMIT_FAILED'
        stopped = true
        nextUncommittedIndex = outcome.index
        break
      }
    }

    if (prepareStop?.stopTurn) {
      stopped = true
      stopReason = prepareStop.reason ?? 'ORCHESTRATOR_INTERNAL_ERROR'
    }
    if (prepareStop?.stopBatch && !prepareStop.stopTurn) {
      // The barrier is complete after ordered commits; the next batch may start.
      stopped = false
    }
  }

  if (nextUncommittedIndex < calls.length && stopped) {
    const remaining = allIndexed.filter((item) => item.index >= nextUncommittedIndex)
    if (remaining.length > 0) {
      const synthetic = await terminalizeRange(remaining, codeForStop(stopReason))
      try {
        commits.push(...await commitInOrder(synthetic, callbacks))
        nextUncommittedIndex = calls.length
      } catch (error) {
        options.onDiagnostic?.({
          code: 'TOOL_BATCH_PLAN_INVALID',
          message: `Terminal commit failed: ${messageFromUnknown(error)}`,
        })
      }
    }
  }

  return {
    schemaVersion: 'tool-orchestration-result/v1',
    plan,
    commits,
    terminalProposals,
    stopped,
    ...(stopReason ? { stopReason } : {}),
  }
}

async function runBoundedAllSettled(
  prepared: readonly PreparedToolCallV1[],
  capacity: number,
  run: ToolOrchestratorCallbacksV1['run'],
): Promise<ToolRunOutcomeV1[]> {
  const outcomes = new Array<ToolRunOutcomeV1>(prepared.length)
  let cursor = 0
  const workerCount = Math.min(capacity, prepared.length)
  const workers = Array.from({ length: workerCount }, async () => {
    while (cursor < prepared.length) {
      const slot = cursor
      cursor += 1
      const item = prepared[slot]
      try {
        const outcome = await run(item)
        assertRunOutcome(outcome, item)
        outcomes[slot] = outcome
      } catch (error) {
        outcomes[slot] = failedRunOutcome(item, error)
      }
    }
  })
  await Promise.allSettled(workers)
  return outcomes
}

async function commitInOrder(
  outcomes: readonly Extract<ToolPrepareOutcomeV1, { kind: 'terminal' }>[],
  callbacks: ToolOrchestratorCallbacksV1,
): Promise<ToolCommitOutcomeV1[]> {
  const commits: ToolCommitOutcomeV1[] = []
  for (const outcome of [...outcomes].sort((left, right) => left.index - right.index)) {
    const committed = await callbacks.commit(outcome)
    assertCommitOutcome(committed, outcome)
    commits.push(committed)
  }
  return commits
}

function failedRunOutcome(prepared: PreparedToolCallV1, cause: unknown): ToolRunOutcomeV1 {
  const now = prepared.context.now?.().toISOString() ?? new Date().toISOString()
  const error = createNormalizedToolError(
    'invalid_result',
    'TOOL_RUN_CALLBACK_FAILED',
    `Run callback failed: ${messageFromUnknown(cause)}`,
    { fatal: true, cause },
  )
  return {
    schemaVersion: 'tool-run-outcome/v1',
    index: prepared.index,
    prepared,
    execution: {
      schemaVersion: 'normalized-tool-result/v1',
      toolCallId: prepared.call.id,
      name: prepared.call.name,
      args: prepared.call.arguments,
      ok: false,
      status: 'failed',
      observation: `FAILED (TOOL_RUN_CALLBACK_FAILED): ${error.message}`,
      pageChanged: false,
      done: false,
      error,
      state: {
        version: 1,
        toolCallId: prepared.call.id,
        name: prepared.call.name,
        turnId: prepared.context.turnId,
        step: prepared.context.step,
        status: 'failed',
        attempts: 1,
        queuedAt: now,
        startedAt: now,
        completedAt: now,
        durationMs: 0,
        error,
      },
      queuedAt: now,
      startedAt: now,
      completedAt: now,
      durationMs: 0,
    },
  }
}

function validateStructuralCalls(calls: readonly ToolCall[]): void {
  const ids = new Set<string>()
  for (const [index, call] of calls.entries()) {
    if (!call || typeof call !== 'object' || typeof call.id !== 'string' || call.id.length === 0) {
      throw new ToolBatchPlanError(`Call at index ${index} has no stable non-empty ID.`)
    }
    if (ids.has(call.id)) throw new ToolBatchPlanError(`Duplicate tool call ID: ${call.id}`)
    if (typeof call.name !== 'string' || call.name.length === 0 || !call.arguments || typeof call.arguments !== 'object') {
      throw new ToolBatchPlanError(`Call ${call.id} is structurally invalid.`)
    }
    ids.add(call.id)
  }
}

function normalizeConcurrency(value: number | undefined, upperBound: number | undefined): number {
  const trustedUpperBound = Number.isFinite(upperBound) && Number.isInteger(upperBound) && upperBound! > 0
    ? upperBound!
    : 8
  if (!Number.isFinite(value) || !Number.isInteger(value) || value! <= 0) return 1
  return Math.min(value!, trustedUpperBound)
}

function isMode(value: unknown): value is ToolOrchestrationModeV1 {
  return value === 'shadow' || value === 'serial' || value === 'parallel'
}

function isValidResolvedPolicy(value: unknown): value is ResolvedToolExecutionPolicyV1 {
  if (!value || typeof value !== 'object') return false
  const policy = value as Partial<ResolvedToolExecutionPolicyV1>
  if (policy.schemaVersion !== 'tool-execution-policy/v1') return false
  if (typeof policy.readOnly !== 'boolean') return false
  if (policy.foreground !== 'parallel' && policy.foreground !== 'exclusive') return false
  if (!['none', 'browser_session', 'human', 'run_state'].includes(String(policy.resource))) return false
  if (policy.interruptBehavior !== 'cancel' && policy.interruptBehavior !== 'block') return false
  if (policy.background !== 'never' && policy.background !== 'eligible') return false
  if (!['catalog', 'resolver', 'default_fail_closed'].includes(String(policy.source))) return false
  if (policy.foreground === 'parallel' && policy.resource !== 'none') return false
  if (policy.resource === 'none' && policy.resourceKey !== undefined) return false
  if (policy.resource === 'browser_session' && !/^browser:.+/.test(policy.resourceKey ?? '')) return false
  if (policy.background === 'eligible' && policy.resource !== 'none') return false
  if (policy.defaultTimeoutMs !== undefined && (
    !Number.isFinite(policy.defaultTimeoutMs) || !Number.isInteger(policy.defaultTimeoutMs) || policy.defaultTimeoutMs <= 0
  )) return false
  return true
}

function assertPrepareOutcome(
  outcome: ToolPrepareOutcomeV1,
  item: IndexedToolCallV1,
  turnId: string,
  sessionId?: string,
): void {
  if (!outcome || outcome.schemaVersion !== 'tool-prepare-outcome/v1' || outcome.index !== item.index) {
    throw new Error(`Invalid prepare outcome for index ${item.index}.`)
  }
  if (outcome.kind === 'ready') {
    if (outcome.prepared.index !== item.index || outcome.prepared.call.id !== item.call.id) {
      throw new Error(`Prepared call identity mismatch at index ${item.index}.`)
    }
    const prepared = outcome.prepared
    if (prepared.context.turnId !== turnId || (sessionId !== undefined && prepared.context.sessionId !== sessionId)) {
      throw new Error(`Prepared call turn/session mismatch at index ${item.index}.`)
    }
    if (!isValidResolvedPolicy(prepared.executionPolicy)) {
      throw new Error(`Prepared call policy is invalid at index ${item.index}.`)
    }
    if (
      item.policy.foreground === 'parallel' && item.policy.resource === 'none' &&
      (prepared.executionPolicy.foreground !== 'parallel' || prepared.executionPolicy.resource !== 'none')
    ) {
      throw new Error(`Prepared call policy changed after parallel planning at index ${item.index}.`)
    }
    if (
      prepared.executionPolicy.resource === 'browser_session' &&
      prepared.executionPolicy.resourceKey !== `browser:${prepared.context.sessionId}`
    ) {
      throw new Error(`Prepared browser resource key mismatch at index ${item.index}.`)
    }
  } else if (outcome.kind === 'terminal') {
    if (outcome.call.id !== item.call.id || (outcome.stop.stopTurn && !outcome.stop.stopBatch)) {
      throw new Error(`Terminal prepare outcome mismatch at index ${item.index}.`)
    }
  } else {
    throw new Error(`Unknown prepare outcome at index ${item.index}.`)
  }
}

function assertRunOutcome(outcome: ToolRunOutcomeV1, prepared: PreparedToolCallV1): void {
  if (
    !outcome || outcome.schemaVersion !== 'tool-run-outcome/v1' || outcome.index !== prepared.index ||
    outcome.prepared.call.id !== prepared.call.id || outcome.execution.toolCallId !== prepared.call.id
  ) {
    throw new Error(`Invalid run outcome for index ${prepared.index}.`)
  }
}

function assertCommitOutcome(
  outcome: ToolCommitOutcomeV1,
  source: ToolRunOutcomeV1 | Extract<ToolPrepareOutcomeV1, { kind: 'terminal' }>,
): void {
  const callId = 'prepared' in source ? source.prepared.call.id : source.call.id
  if (
    !outcome || outcome.schemaVersion !== 'tool-commit-outcome/v1' || outcome.index !== source.index ||
    outcome.committedToolCallId !== callId || typeof outcome.continueTurn !== 'boolean' ||
    typeof outcome.done !== 'boolean' || typeof outcome.blocked !== 'boolean'
  ) {
    throw new Error(`Invalid commit outcome for index ${source.index}.`)
  }
}

function makeTerminalProposal(index: number, call: ToolCall, code: SyntheticBlockCodeV1): ToolTerminalProposalV1 {
  return {
    schemaVersion: 'tool-terminal-proposal/v1',
    index,
    call,
    code,
    message: syntheticMessage(code),
  }
}

function syntheticMessage(code: SyntheticBlockCodeV1): string {
  switch (code) {
    case 'EARLIER_TOOL_BLOCKED': return 'An earlier tool blocked the remaining calls.'
    case 'SESSION_ABORTED': return 'The session was aborted before this tool could start.'
    case 'DEPENDENCY_INVALIDATED': return 'An earlier call invalidated this tool dependency.'
    case 'EARLIER_TOOL_COMPLETED': return 'An earlier tool completed the turn.'
    case 'TOOL_COMMIT_FAILED': return 'An earlier tool result could not be committed.'
    case 'ORCHESTRATOR_INTERNAL_ERROR': return 'The tool orchestrator stopped safely after an internal error.'
  }
}

function codeForStop(reason: ToolStopReasonV1 | undefined): SyntheticBlockCodeV1 {
  if (reason === 'SESSION_ABORTED') return 'SESSION_ABORTED'
  if (reason === 'TOOL_DONE') return 'EARLIER_TOOL_COMPLETED'
  if (reason === 'POLICY_DENIED' || reason === 'HUMAN_REJECTED') return 'EARLIER_TOOL_BLOCKED'
  if (reason === 'COMMIT_FAILED') return 'TOOL_COMMIT_FAILED'
  if (reason === 'DEPENDENCY_INVALIDATED') return 'DEPENDENCY_INVALIDATED'
  return 'ORCHESTRATOR_INTERNAL_ERROR'
}
