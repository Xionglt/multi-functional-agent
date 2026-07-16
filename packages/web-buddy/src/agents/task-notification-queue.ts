import { randomUUID } from 'node:crypto'
import type {
  IsoUtcTimestamp,
  TaskNotificationAcknowledgementV1,
  TaskNotificationDelivery,
  TaskNotificationPromptAttachmentV1,
  TaskNotificationQueueV1,
  TaskNotificationV1,
} from './async-task-contracts.js'

interface QueueRecord {
  notification: TaskNotificationV1
  delivery: TaskNotificationDelivery
}

/** In-process FIFO transport with durable identities supplied by the graph outbox. */
export class TaskNotificationQueue implements TaskNotificationQueueV1 {
  readonly contractVersion = 'agent-task-notification-queue/v1' as const
  private readonly recordsById = new Map<string, QueueRecord>()
  private readonly sessionOrder = new Map<string, string[]>()
  private readonly waiters = new Map<string, Set<() => void>>()

  enqueue(notification: TaskNotificationV1): boolean {
    const existing = this.recordsById.get(notification.notificationId)
    if (existing) {
      if (JSON.stringify(existing.notification) !== JSON.stringify(notification)) {
        throw queueError(`Notification ${notification.notificationId} was enqueued with conflicting bytes.`)
      }
      return false
    }
    const delivery: TaskNotificationDelivery = {
      schemaVersion: 'agent-task-notification-delivery/v1',
      deliveryId: `delivery_${notification.notificationId}`,
      notificationId: notification.notificationId,
      sessionId: notification.sessionId,
      state: 'available',
    }
    this.recordsById.set(notification.notificationId, { notification: clone(notification), delivery })
    const order = this.sessionOrder.get(notification.sessionId) ?? []
    order.push(notification.notificationId)
    this.sessionOrder.set(notification.sessionId, order)
    this.signalChange(notification.sessionId)
    return true
  }

  async claimAvailable(
    sessionId: string,
    claimantId: string,
    claimLeaseMs: number,
  ): Promise<Array<{ notification: TaskNotificationV1; delivery: Extract<TaskNotificationDelivery, { state: 'claimed' }> }>> {
    if (!Number.isFinite(claimLeaseMs) || claimLeaseMs <= 0) throw new Error('claimLeaseMs must be positive.')
    const claimedAt = new Date().toISOString()
    const claimExpiresAt = new Date(Date.parse(claimedAt) + claimLeaseMs).toISOString()
    const claimed: Array<{
      notification: TaskNotificationV1
      delivery: Extract<TaskNotificationDelivery, { state: 'claimed' }>
    }> = []
    for (const notificationId of this.sessionOrder.get(sessionId) ?? []) {
      const record = this.recordsById.get(notificationId)
      if (!record || record.delivery.state !== 'available') continue
      const delivery: Extract<TaskNotificationDelivery, { state: 'claimed' }> = {
        schemaVersion: 'agent-task-notification-delivery/v1',
        deliveryId: record.delivery.deliveryId,
        notificationId,
        sessionId,
        state: 'claimed',
        claimId: `claim_${randomUUID()}`,
        claimantId,
        claimedAt,
        claimExpiresAt,
      }
      record.delivery = delivery
      claimed.push({ notification: clone(record.notification), delivery: clone(delivery) })
    }
    return claimed
  }

  async acknowledge(acknowledgement: TaskNotificationAcknowledgementV1): Promise<void> {
    const record = this.recordsById.get(acknowledgement.notificationId)
    if (!record) throw queueError(`Notification ${acknowledgement.notificationId} is not queued.`)
    if (record.delivery.state === 'acknowledged') {
      if (JSON.stringify(record.delivery.acknowledgement) === JSON.stringify(acknowledgement)) return
      throw queueError(`Notification ${acknowledgement.notificationId} has a conflicting acknowledgement.`)
    }
    if (record.delivery.state !== 'claimed'
      || record.delivery.deliveryId !== acknowledgement.deliveryId
      || record.delivery.claimId !== acknowledgement.claimId) {
      throw queueError(`Acknowledgement fence does not match notification ${acknowledgement.notificationId}.`)
    }
    record.delivery = {
      schemaVersion: 'agent-task-notification-delivery/v1',
      deliveryId: record.delivery.deliveryId,
      notificationId: record.notification.notificationId,
      sessionId: record.notification.sessionId,
      state: 'acknowledged',
      acknowledgement: clone(acknowledgement),
    }
  }

  async reconcilePersistedPromptAttachments(
    attachments: readonly TaskNotificationPromptAttachmentV1[],
  ): Promise<number> {
    let reconciled = 0
    for (const attachment of attachments) {
      for (const notificationId of attachment.notificationIds) {
        const record = this.recordsById.get(notificationId)
        if (!record || record.delivery.state === 'acknowledged') continue
        if (record.notification.sessionId !== attachment.sessionId) {
          throw queueError(`Prompt attachment session does not match notification ${notificationId}.`)
        }
        const claimed = record.delivery.state === 'claimed'
          ? record.delivery
          : this.claimForReconciliation(record, attachment.persistedAt)
        await this.acknowledge({
          schemaVersion: 'agent-task-notification-ack/v1',
          acknowledgementId: `ack_${claimed.deliveryId}_${attachment.promptMessageId}`,
          notificationId,
          deliveryId: claimed.deliveryId,
          claimId: claimed.claimId,
          injectedPromptMessageId: attachment.promptMessageId,
          acknowledgedAt: attachment.persistedAt,
        })
        reconciled += 1
      }
    }
    return reconciled
  }

  async releaseExpiredClaims(now: IsoUtcTimestamp): Promise<number> {
    let released = 0
    for (const record of this.recordsById.values()) {
      if (record.delivery.state !== 'claimed' || record.delivery.claimExpiresAt > now) continue
      record.delivery = {
        schemaVersion: 'agent-task-notification-delivery/v1',
        deliveryId: record.delivery.deliveryId,
        notificationId: record.notification.notificationId,
        sessionId: record.notification.sessionId,
        state: 'available',
      }
      released += 1
      this.signalChange(record.notification.sessionId)
    }
    return released
  }

  async waitForChange(
    sessionId: string,
    signal: AbortSignal,
    timeoutMs: number,
  ): Promise<'changed' | 'timeout' | 'aborted'> {
    if (signal.aborted) return 'aborted'
    if ((this.sessionOrder.get(sessionId) ?? []).some((id) => this.recordsById.get(id)?.delivery.state === 'available')) {
      return 'changed'
    }
    return new Promise((resolve) => {
      let settled = false
      const waiters = this.waiters.get(sessionId) ?? new Set<() => void>()
      const finish = (result: 'changed' | 'timeout' | 'aborted'): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        waiters.delete(onChange)
        if (waiters.size === 0) this.waiters.delete(sessionId)
        resolve(result)
      }
      const onChange = (): void => finish('changed')
      const onAbort = (): void => finish('aborted')
      waiters.add(onChange)
      this.waiters.set(sessionId, waiters)
      const timer = setTimeout(() => finish('timeout'), Math.max(0, timeoutMs))
      signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  snapshot(sessionId: string): Array<{ notification: TaskNotificationV1; delivery: TaskNotificationDelivery }> {
    return (this.sessionOrder.get(sessionId) ?? []).flatMap((id) => {
      const record = this.recordsById.get(id)
      return record ? [{ notification: clone(record.notification), delivery: clone(record.delivery) }] : []
    })
  }

  private claimForReconciliation(
    record: QueueRecord,
    claimedAt: string,
  ): Extract<TaskNotificationDelivery, { state: 'claimed' }> {
    const delivery: Extract<TaskNotificationDelivery, { state: 'claimed' }> = {
      schemaVersion: 'agent-task-notification-delivery/v1',
      deliveryId: record.delivery.deliveryId,
      notificationId: record.notification.notificationId,
      sessionId: record.notification.sessionId,
      state: 'claimed',
      claimId: `claim_reconcile_${randomUUID()}`,
      claimantId: 'prompt_attachment_reconciler',
      claimedAt,
      claimExpiresAt: claimedAt,
    }
    record.delivery = delivery
    return delivery
  }

  private signalChange(sessionId: string): void {
    for (const waiter of [...(this.waiters.get(sessionId) ?? [])]) waiter()
  }
}

function queueError(message: string): Error & { code: 'NOTIFICATION_ACK_CONFLICT' } {
  return Object.assign(new Error(message), { code: 'NOTIFICATION_ACK_CONFLICT' as const })
}

function clone<T>(value: T): T { return structuredClone(value) }
