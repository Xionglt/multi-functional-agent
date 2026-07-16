export type ToolForegroundModeV1 = 'parallel' | 'exclusive'
export type ToolResourceClassV1 = 'none' | 'browser_session' | 'human' | 'run_state'
export type ToolInterruptBehaviorV1 = 'cancel' | 'block'
export type ToolBackgroundModeV1 = 'never' | 'eligible'

export interface ToolExecutionPolicyV1 {
  schemaVersion: 'tool-execution-policy/v1'
  readOnly: boolean
  foreground: ToolForegroundModeV1
  resource: ToolResourceClassV1
  interruptBehavior: ToolInterruptBehaviorV1
  background: ToolBackgroundModeV1
  defaultTimeoutMs?: number
}

export interface ResolvedToolExecutionPolicyV1 extends ToolExecutionPolicyV1 {
  resourceKey?: string
  source: 'catalog' | 'resolver' | 'default_fail_closed'
}

export type ToolExecutionPolicyDiagnosticCodeV1 =
  | 'TOOL_POLICY_MISSING'
  | 'TOOL_POLICY_INVALID'
  | 'TOOL_POLICY_RESOLVER_FAILED'

export interface ToolExecutionPolicyDiagnosticV1 {
  schemaVersion: 'tool-execution-policy-diagnostic/v1'
  code: ToolExecutionPolicyDiagnosticCodeV1
  toolName: string
  message: string
}

export interface ToolExecutionPolicyResolverContextV1 {
  toolName: string
  arguments: Readonly<Record<string, unknown>>
  sessionId?: string
}

export type ToolExecutionPolicyResolverV1 = (context: ToolExecutionPolicyResolverContextV1) => unknown

export interface ResolveToolExecutionPolicyInputV1 extends ToolExecutionPolicyResolverContextV1 {
  catalogPolicy?: unknown
  resolver?: ToolExecutionPolicyResolverV1
  onDiagnostic?: (diagnostic: ToolExecutionPolicyDiagnosticV1) => void
}

export const FAIL_CLOSED_TOOL_EXECUTION_POLICY_V1: ResolvedToolExecutionPolicyV1 = Object.freeze({
  schemaVersion: 'tool-execution-policy/v1',
  readOnly: false,
  foreground: 'exclusive',
  resource: 'run_state',
  interruptBehavior: 'block',
  background: 'never',
  source: 'default_fail_closed',
})

const FOREGROUND_MODES = new Set<ToolForegroundModeV1>(['parallel', 'exclusive'])
const RESOURCE_CLASSES = new Set<ToolResourceClassV1>(['none', 'browser_session', 'human', 'run_state'])
const INTERRUPT_BEHAVIORS = new Set<ToolInterruptBehaviorV1>(['cancel', 'block'])
const BACKGROUND_MODES = new Set<ToolBackgroundModeV1>(['never', 'eligible'])

/**
 * Resolve a catalog policy without consulting legacy metadata, risk, or category.
 * Any missing, throwing, or structurally unsafe input becomes the exact S001
 * fail-closed policy and is reported through the optional diagnostic callback.
 */
export function resolveToolExecutionPolicy(
  input: ResolveToolExecutionPolicyInputV1,
): ResolvedToolExecutionPolicyV1 {
  let candidate = input.catalogPolicy
  let source: ResolvedToolExecutionPolicyV1['source'] = 'catalog'

  if (input.resolver) {
    source = 'resolver'
    try {
      candidate = input.resolver({
        toolName: input.toolName,
        arguments: input.arguments,
        sessionId: input.sessionId,
      })
    } catch (error) {
      return failClosed(input, 'TOOL_POLICY_RESOLVER_FAILED', `Execution policy resolver failed: ${errorMessage(error)}`)
    }
  }

  if (candidate === undefined || candidate === null) {
    return failClosed(input, 'TOOL_POLICY_MISSING', 'No typed execution policy was declared.')
  }

  if (!isRecord(candidate) || isPromiseLike(candidate)) {
    return failClosed(input, 'TOOL_POLICY_INVALID', 'Execution policy must be a synchronous object.')
  }

  const invalidReason = validatePolicy(candidate, input.sessionId)
  if (invalidReason) return failClosed(input, 'TOOL_POLICY_INVALID', invalidReason)

  const policy = candidate as unknown as ToolExecutionPolicyV1 & { resourceKey?: string }
  const resolved: ResolvedToolExecutionPolicyV1 = {
    schemaVersion: policy.schemaVersion,
    readOnly: policy.readOnly,
    foreground: policy.foreground,
    resource: policy.resource,
    interruptBehavior: policy.interruptBehavior,
    background: policy.background,
    source,
    ...(policy.defaultTimeoutMs === undefined ? {} : { defaultTimeoutMs: policy.defaultTimeoutMs }),
  }

  if (policy.resource === 'browser_session') resolved.resourceKey = `browser:${input.sessionId}`
  return resolved
}

function validatePolicy(candidate: Record<string, unknown>, sessionId: string | undefined): string | undefined {
  if (candidate.schemaVersion !== 'tool-execution-policy/v1') return 'Unsupported execution policy schema.'
  if (typeof candidate.readOnly !== 'boolean') return 'readOnly must be boolean.'
  if (!FOREGROUND_MODES.has(candidate.foreground as ToolForegroundModeV1)) return 'Invalid foreground mode.'
  if (!RESOURCE_CLASSES.has(candidate.resource as ToolResourceClassV1)) return 'Invalid resource class.'
  if (!INTERRUPT_BEHAVIORS.has(candidate.interruptBehavior as ToolInterruptBehaviorV1)) {
    return 'Invalid interrupt behavior.'
  }
  if (!BACKGROUND_MODES.has(candidate.background as ToolBackgroundModeV1)) return 'Invalid background mode.'
  if (
    candidate.defaultTimeoutMs !== undefined &&
    (typeof candidate.defaultTimeoutMs !== 'number' ||
      !Number.isFinite(candidate.defaultTimeoutMs) ||
      !Number.isInteger(candidate.defaultTimeoutMs) ||
      candidate.defaultTimeoutMs <= 0)
  ) {
    return 'defaultTimeoutMs must be a finite positive integer.'
  }

  if (candidate.foreground === 'parallel' && candidate.resource !== 'none') {
    return 'Parallel foreground execution requires resource=none.'
  }
  if (candidate.background === 'eligible' && candidate.resource !== 'none') {
    return 'Background eligibility requires resource=none.'
  }

  if (candidate.resource === 'browser_session') {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return 'Browser policy requires a session id.'
    if (candidate.resourceKey !== undefined && candidate.resourceKey !== `browser:${sessionId}`) {
      return 'Browser resource key does not match the current session.'
    }
  } else if (candidate.resourceKey !== undefined) {
    return 'Only browser_session policies may declare a resource key in v1.'
  }
  return undefined
}

function failClosed(
  input: ResolveToolExecutionPolicyInputV1,
  code: ToolExecutionPolicyDiagnosticCodeV1,
  message: string,
): ResolvedToolExecutionPolicyV1 {
  try {
    input.onDiagnostic?.({
      schemaVersion: 'tool-execution-policy-diagnostic/v1',
      code,
      toolName: input.toolName,
      message,
    })
  } catch {
    // Diagnostics are observational and cannot weaken fail-closed planning.
  }
  return FAIL_CLOSED_TOOL_EXECUTION_POLICY_V1
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isPromiseLike(value: Record<string, unknown>): boolean {
  return typeof value.then === 'function'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
