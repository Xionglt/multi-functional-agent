import type {
  ActionBinding,
  BrowserActionClockV1,
  ResultFreshnessVerdict,
} from './async-task-contracts.js'

export function assessAsyncTaskResultFreshness(
  actionBinding: ActionBinding,
  actionClock: BrowserActionClockV1,
): ResultFreshnessVerdict {
  if (actionBinding.kind === 'not_action_bound') {
    return { kind: 'not_action_bound', validity: 'not_applicable' }
  }
  if (!Number.isSafeInteger(actionBinding.sourceActionSeq) || actionBinding.sourceActionSeq < 0
    || !Number.isSafeInteger(actionClock.currentActionSeq) || actionClock.currentActionSeq < 0
    || actionBinding.sourceActionSeq > actionClock.currentActionSeq) {
    throw Object.assign(
      new Error('sourceActionSeq must be a non-negative integer no greater than the Main Agent browser action clock.'),
      { code: 'INVALID_SOURCE_ACTION_SEQ' as const },
    )
  }
  return {
    kind: 'assessed',
    sourceActionSeq: actionBinding.sourceActionSeq,
    assessedAgainstActionSeq: actionClock.currentActionSeq,
    validity: actionBinding.sourceActionSeq < actionClock.currentActionSeq ? 'stale' : 'unverified',
  }
}
