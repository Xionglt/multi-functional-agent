import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { AgentTaskEvent, AgentTaskGraphV2 } from './async-task-contracts.js'

export interface TaskGraphMutation {
  graph: AgentTaskGraphV2
  event: AgentTaskEvent
}

export interface TaskGraphStore {
  create(graph: AgentTaskGraphV2): Promise<void>
  load(sessionId: string): Promise<AgentTaskGraphV2 | undefined>
  transact(sessionId: string, reducer: (current: AgentTaskGraphV2) => TaskGraphMutation): Promise<TaskGraphMutation>
  readEvents(sessionId: string): Promise<AgentTaskEvent[]>
}

export interface FileTaskGraphStoreOptions {
  rootDir?: string
  resolveSessionDir?: (sessionId: string) => string
  faultInjector?: (point: FileTaskGraphStoreFaultPoint) => void | Promise<void>
}

export type FileTaskGraphStoreFaultPoint =
  | 'after_wal_commit'
  | 'after_event_append'
  | 'after_snapshot_commit'

interface TaskGraphWalV1 {
  schemaVersion: 'agent-task-store-wal/v1'
  transactionId: string
  sessionId: string
  graph: AgentTaskGraphV2
  event: AgentTaskEvent
}

/**
 * A per-session serialized file store. The WAL is the atomic commit record; load()
 * completes any transaction interrupted between event append and snapshot rename.
 */
export class FileTaskGraphStore implements TaskGraphStore {
  readonly rootDir: string
  private readonly resolveSessionDir?: (sessionId: string) => string
  private readonly faultInjector?: FileTaskGraphStoreOptions['faultInjector']
  private readonly chains = new Map<string, Promise<void>>()

  constructor(options: FileTaskGraphStoreOptions = {}) {
    this.rootDir = resolve(options.rootDir ?? join(process.cwd(), 'output', 'sessions'))
    this.resolveSessionDir = options.resolveSessionDir
    this.faultInjector = options.faultInjector
  }

  async create(graph: AgentTaskGraphV2): Promise<void> {
    await this.serialized(graph.sessionId, async () => {
      await this.recover(graph.sessionId)
      if (await readJsonIfPresent<AgentTaskGraphV2>(this.snapshotPath(graph.sessionId))) {
        throw storeError('GRAPH_ALREADY_EXISTS', `Task graph already exists for session ${graph.sessionId}.`)
      }
      assertGraphIdentity(graph, graph.sessionId)
      await atomicWriteJson(this.snapshotPath(graph.sessionId), clone(graph))
      await ensureFile(this.eventsPath(graph.sessionId))
    })
  }

  async load(sessionId: string): Promise<AgentTaskGraphV2 | undefined> {
    return this.serialized(sessionId, async () => {
      await this.recover(sessionId)
      const graph = await readJsonIfPresent<AgentTaskGraphV2>(this.snapshotPath(sessionId))
      if (!graph) return undefined
      assertGraphIdentity(graph, sessionId)
      return clone(graph)
    })
  }

  async transact(
    sessionId: string,
    reducer: (current: AgentTaskGraphV2) => TaskGraphMutation,
  ): Promise<TaskGraphMutation> {
    return this.serialized(sessionId, async () => {
      await this.recover(sessionId)
      const current = await readJsonIfPresent<AgentTaskGraphV2>(this.snapshotPath(sessionId))
      if (!current) throw storeError('GRAPH_NOT_FOUND', `Task graph not found for session ${sessionId}.`)
      const mutation = reducer(clone(current))
      validateMutation(current, mutation, sessionId)

      const committed = clone(mutation)
      const wal: TaskGraphWalV1 = {
        schemaVersion: 'agent-task-store-wal/v1',
        transactionId: `txn_${randomUUID()}`,
        sessionId,
        graph: committed.graph,
        event: committed.event,
      }
      await atomicWriteJson(this.walPath(sessionId), wal)
      await this.inject('after_wal_commit')
      await appendEventIdempotently(this.eventsPath(sessionId), committed.event)
      await this.inject('after_event_append')
      await atomicWriteJson(this.snapshotPath(sessionId), committed.graph)
      await this.inject('after_snapshot_commit')
      await rm(this.walPath(sessionId), { force: true })
      return clone(committed)
    })
  }

  async readEvents(sessionId: string): Promise<AgentTaskEvent[]> {
    return this.serialized(sessionId, async () => {
      await this.recover(sessionId)
      return clone(await readEventLog(this.eventsPath(sessionId)))
    })
  }

  private async recover(sessionId: string): Promise<void> {
    const wal = await readJsonIfPresent<TaskGraphWalV1>(this.walPath(sessionId))
    if (!wal) return
    if (wal.schemaVersion !== 'agent-task-store-wal/v1' || wal.sessionId !== sessionId) {
      throw storeError('UNSUPPORTED_SCHEMA_VERSION', `Invalid task graph WAL for session ${sessionId}.`)
    }
    validateMutationAgainstPersistedSnapshot(
      await readJsonIfPresent<AgentTaskGraphV2>(this.snapshotPath(sessionId)),
      wal,
      sessionId,
    )
    await appendEventIdempotently(this.eventsPath(sessionId), wal.event)
    await atomicWriteJson(this.snapshotPath(sessionId), wal.graph)
    await rm(this.walPath(sessionId), { force: true })
  }

  private serialized<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.chains.get(sessionId) ?? Promise.resolve()
    let release!: () => void
    const gate = new Promise<void>((resolveGate) => { release = resolveGate })
    const queued = prior.catch(() => undefined).then(() => gate)
    this.chains.set(sessionId, queued)
    return prior.catch(() => undefined).then(operation).finally(() => {
      release()
      if (this.chains.get(sessionId) === queued) this.chains.delete(sessionId)
    })
  }

  private sessionDir(sessionId: string): string {
    return resolve(this.resolveSessionDir?.(sessionId) ?? join(this.rootDir, sessionId))
  }

  private snapshotPath(sessionId: string): string { return join(this.sessionDir(sessionId), 'task-graph.json') }
  private eventsPath(sessionId: string): string { return join(this.sessionDir(sessionId), 'task-events.jsonl') }
  private walPath(sessionId: string): string { return join(this.sessionDir(sessionId), 'task-graph.wal.json') }

  private async inject(point: FileTaskGraphStoreFaultPoint): Promise<void> {
    await this.faultInjector?.(point)
  }
}

function validateMutation(current: AgentTaskGraphV2, mutation: TaskGraphMutation, sessionId: string): void {
  assertGraphIdentity(mutation.graph, sessionId)
  const event = mutation.event
  if (mutation.graph.graphId !== current.graphId || mutation.graph.runId !== current.runId) {
    throw storeError('REVISION_CONFLICT', 'A transaction cannot replace graph, run, or session identity.')
  }
  if (mutation.graph.revision !== current.revision + 1) {
    throw storeError('REVISION_CONFLICT', 'Graph revision must increment exactly once.', current.revision, mutation.graph.revision)
  }
  if (event.revisionBefore !== current.revision || event.revisionAfter !== mutation.graph.revision) {
    throw storeError('REVISION_CONFLICT', 'Task event revision fence does not match the snapshot mutation.')
  }
  if (event.eventSeq !== current.nextEventSeq || mutation.graph.nextEventSeq !== current.nextEventSeq + 1) {
    throw storeError('EVENT_SEQUENCE_CONFLICT', 'Task event sequence must consume exactly the current nextEventSeq.')
  }
  if (event.sessionId !== sessionId || event.graphId !== current.graphId) {
    throw storeError('EVENT_SEQUENCE_CONFLICT', 'Task event identity does not match its graph.')
  }
  if (event.authoritativeCompletionEvidence !== false || event.authoritativeTaskState !== true) {
    throw storeError('POLICY_VIOLATION', 'Task events cannot become workflow completion evidence.')
  }
  validateEventFence(current, mutation.graph, event)
}

function validateEventFence(current: AgentTaskGraphV2, next: AgentTaskGraphV2, event: AgentTaskEvent): void {
  if (event.eventType === 'graph_migrated') return
  if (event.eventType === 'browser_action_advanced') {
    const { previousActionSeq, currentActionSeq } = event.payload
    if (previousActionSeq !== current.actionClock.currentActionSeq
      || currentActionSeq !== previousActionSeq + 1
      || next.actionClock.currentActionSeq !== currentActionSeq
      || next.actionClock.sessionId !== current.actionClock.sessionId
      || next.actionClock.runId !== current.actionClock.runId
      || next.actionClock.authority !== 'main_agent_runtime') {
      throw storeError('INVALID_TRANSITION', `browser_action_advanced has an invalid action-clock fence for ${event.payload.actionId}.`)
    }
    return
  }
  if (next.actionClock.currentActionSeq !== current.actionClock.currentActionSeq) {
    throw storeError('POLICY_VIOLATION', 'Only browser_action_advanced may mutate the Main Agent action clock.')
  }
  const before = current.tasks.find((task) => task.id === event.taskId)
  const after = next.tasks.find((task) => task.id === event.taskId)
  if (event.eventType === 'task_created') {
    if (before || !after || after.idempotency.key !== event.payload.idempotency.key) {
      throw storeError('INVALID_TRANSITION', `task_created does not match task ${event.taskId}.`)
    }
    return
  }
  if (!before || !after) throw storeError('TASK_NOT_FOUND', `Event task not found: ${event.taskId}`)
  if (event.eventType === 'task_claimed') {
    if (before.status !== 'pending' || after.status !== 'running' || !sameRunIdentity(event.runIdentity, after)) {
      throw storeError('STALE_LEASE', `Claim fence does not match task ${event.taskId}.`)
    }
    return
  }
  if ('runIdentity' in event && event.runIdentity) {
    if (before.status !== 'running' || !sameRunIdentity(event.runIdentity, before)) {
      throw storeError('STALE_LEASE', `Run fence does not match task ${event.taskId}.`)
    }
    if (before.lease.expiresAt < event.occurredAt && event.eventType !== 'task_lease_expired') {
      throw storeError('LEASE_EXPIRED', `Lease expired before ${event.eventType} for task ${event.taskId}.`)
    }
  }
}

function sameRunIdentity(
  identity: { taskId: string; attempt: number; leaseId: string; leaseOwnerId: string },
  task: Extract<AgentTaskGraphV2['tasks'][number], { status: 'running' }>,
): boolean {
  return identity.taskId === task.id
    && identity.attempt === task.attempt
    && identity.leaseId === task.lease.leaseId
    && identity.leaseOwnerId === task.lease.ownerId
}

function validateMutationAgainstPersistedSnapshot(
  current: AgentTaskGraphV2 | undefined,
  wal: TaskGraphWalV1,
  sessionId: string,
): void {
  if (!current) throw storeError('GRAPH_NOT_FOUND', `Cannot recover missing graph for session ${sessionId}.`)
  if (current.revision === wal.graph.revision) return
  validateMutation(current, { graph: wal.graph, event: wal.event }, sessionId)
}

function assertGraphIdentity(graph: AgentTaskGraphV2, sessionId: string): void {
  if (graph.schemaVersion !== 'agent-task-graph/v2') {
    throw storeError('UNSUPPORTED_SCHEMA_VERSION', `Expected agent-task-graph/v2 for session ${sessionId}.`)
  }
  if (graph.sessionId !== sessionId) throw storeError('REVISION_CONFLICT', 'Graph session identity is immutable.')
}

async function appendEventIdempotently(path: string, event: AgentTaskEvent): Promise<void> {
  await truncateInvalidJsonlTail(path)
  const events = await readEventLog(path)
  const sameId = events.find((candidate) => candidate.eventId === event.eventId)
  if (sameId) {
    if (stableJson(sameId) !== stableJson(event)) {
      throw storeError('EVENT_SEQUENCE_CONFLICT', `Event ${event.eventId} was replayed with different bytes.`)
    }
    return
  }
  const sameSeq = events.find((candidate) => candidate.eventSeq === event.eventSeq)
  if (sameSeq) throw storeError('EVENT_SEQUENCE_CONFLICT', `Event sequence ${event.eventSeq} is already occupied.`)
  await mkdir(dirname(path), { recursive: true })
  await appendFile(path, `${JSON.stringify(event)}\n`, 'utf8')
  const handle = await open(path, 'r')
  try { await handle.sync() } finally { await handle.close() }
}

async function truncateInvalidJsonlTail(path: string): Promise<void> {
  let text: string
  try { text = await readFile(path, 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  if (!text || text.endsWith('\n')) return
  const lastNewline = text.lastIndexOf('\n')
  const tail = text.slice(lastNewline + 1).trim()
  if (!tail) return
  try {
    JSON.parse(tail)
    await writeFile(path, `${text}\n`, 'utf8')
  } catch {
    await writeFile(path, text.slice(0, lastNewline + 1), 'utf8')
  }
}

async function readEventLog(path: string): Promise<AgentTaskEvent[]> {
  let text: string
  try { text = await readFile(path, 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const lines = text.split('\n')
  const events: AgentTaskEvent[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim()
    if (!line) continue
    try { events.push(JSON.parse(line) as AgentTaskEvent) } catch (error) {
      const isTruncatedTail = index === lines.length - 1 && !text.endsWith('\n')
      if (!isTruncatedTail) throw error
    }
  }
  return events
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  const handle = await open(temporary, 'r')
  try { await handle.sync() } finally { await handle.close() }
  await rename(temporary, path)
}

async function ensureFile(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, '', { flag: 'a' })
}

async function readJsonIfPresent<T>(path: string): Promise<T | undefined> {
  try { return JSON.parse(await readFile(path, 'utf8')) as T } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

function storeError(
  code: 'GRAPH_ALREADY_EXISTS' | 'GRAPH_NOT_FOUND' | 'REVISION_CONFLICT' | 'EVENT_SEQUENCE_CONFLICT' | 'UNSUPPORTED_SCHEMA_VERSION' | 'POLICY_VIOLATION' | 'INVALID_TRANSITION' | 'TASK_NOT_FOUND' | 'STALE_LEASE' | 'LEASE_EXPIRED',
  message: string,
  expectedRevision?: number,
  actualRevision?: number,
): Error & { code: string; expectedRevision?: number; actualRevision?: number } {
  return Object.assign(new Error(message), { code, expectedRevision, actualRevision })
}

function stableJson(value: unknown): string { return JSON.stringify(value) }
function clone<T>(value: T): T { return structuredClone(value) }
