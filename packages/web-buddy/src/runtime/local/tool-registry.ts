import type { ToolSchema } from '../../sdk/llm.js'
import type { RiskLevel } from '../../sdk/trace.js'
import {
  createLocalTools,
  toOpenAITools,
  type LocalToolContext,
  type LocalToolDef,
  type LocalToolRunResult,
} from '../../tools/local-adapter.js'
import {
  resolveToolExecutionPolicy,
  type ResolvedToolExecutionPolicyV1,
  type ToolExecutionPolicyDiagnosticV1,
} from '../../tools/tool-execution-policy.js'

export type ToolContext = LocalToolContext
export type ToolRunResult = LocalToolRunResult
export type ToolDef = LocalToolDef

/**
 * Local runtime registry facade. Tool definitions come from the shared catalog
 * through the local adapter; the agent loop still talks to this class.
 */
export class ToolRegistry {
  private tools = new Map<string, ToolDef>()

  constructor(defs: ToolDef[] = createLocalTools()) {
    for (const d of defs) this.tools.set(d.name, d)
  }

  get(name: string): ToolDef | undefined {
    return this.tools.get(name)
  }

  list(): ToolDef[] {
    return [...this.tools.values()]
  }

  toOpenAITools(options: { include?: Iterable<string>; exclude?: Iterable<string> } = {}): ToolSchema[] {
    const include = options.include ? new Set(options.include) : undefined
    const exclude = new Set(options.exclude ?? [])
    const tools = this.list().filter((tool) => {
      if (include && !include.has(tool.name)) return false
      return !exclude.has(tool.name)
    })
    return toOpenAITools(tools)
  }

  resolveRisk(name: string, args: Record<string, unknown>, ctx: ToolContext): RiskLevel | undefined {
    const tool = this.tools.get(name)
    if (!tool) return undefined
    return tool.resolveRisk?.(args, ctx) ?? tool.inherentRisk
  }

  /** Pure S001 classification; it is not a scheduling decision by itself. */
  resolveExecutionPolicy(
    name: string,
    args: Record<string, unknown>,
    ctx: ToolContext,
    onDiagnostic?: (diagnostic: ToolExecutionPolicyDiagnosticV1) => void,
  ): ResolvedToolExecutionPolicyV1 {
    const tool = this.tools.get(name)
    return resolveToolExecutionPolicy({
      toolName: name,
      arguments: args,
      sessionId: ctx.sessionId,
      catalogPolicy: tool?.execution,
      resolver: tool?.resolveExecution,
      onDiagnostic,
    })
  }

  async run(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolRunResult> {
    const tool = this.tools.get(name)
    if (!tool) return { observation: `Unknown tool: ${name}` }
    try {
      return await tool.run(args, ctx)
    } catch (error) {
      return { observation: `Tool ${name} threw: ${(error as Error).message}` }
    }
  }
}

export function requiresGate(risk: RiskLevel | undefined): boolean {
  return risk === 'L3' || risk === 'L4'
}
