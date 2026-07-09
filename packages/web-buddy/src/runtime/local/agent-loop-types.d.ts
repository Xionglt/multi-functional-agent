import type { TokenBudgetSnapshot as KernelTokenBudgetSnapshot } from '../../kernel/token-budget.js'

declare global {
  type TokenBudgetSnapshot = KernelTokenBudgetSnapshot
}

export {}
