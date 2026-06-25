export type TaskPhase = 'observing' | 'filling' | 'reviewing' | 'blocked' | 'done'

export interface TaskState {
  schemaVersion: 'task-state/v1'
  goal: string
  phase: TaskPhase
  knownBlockers: string[]
  completionCriteria: string[]
  updatedAt: string
}

export interface CreateDefaultTaskStateInput {
  goal: string
  updatedAt?: string
}

export function createDefaultTaskState(input: CreateDefaultTaskStateInput): TaskState {
  return {
    schemaVersion: 'task-state/v1',
    goal: input.goal,
    phase: 'observing',
    knownBlockers: [],
    completionCriteria: [],
    updatedAt: input.updatedAt ?? new Date().toISOString(),
  }
}
