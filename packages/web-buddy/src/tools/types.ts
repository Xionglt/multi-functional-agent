import type { RiskLevel } from '../sdk/trace.js'
import type { ToolExecutionPolicyV1 } from './tool-execution-policy.js'

export type ToolCategory = 'observation' | 'action' | 'human' | 'eval'

export interface ToolDef {
  name: string
  mcpName?: string
  description: string
  category: ToolCategory
  risk: RiskLevel
  /**
   * S001 scheduling contract. This deliberately does not derive from metadata,
   * category, or risk: those fields are not scheduling authority.
   */
  execution: ToolExecutionPolicyV1
  parameters: Record<string, unknown>
  local: {
    enabled: boolean
  }
  mcp: {
    enabled: boolean
  }
  metadata?: Record<string, unknown>
}
