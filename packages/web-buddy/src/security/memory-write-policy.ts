import type {
  ContentOrigin,
  ContentSensitivity,
  ContentTrust,
} from '../task/contracts.js'
import type { MemoryRecord } from '../memory/types.js'
import { redactSensitiveData } from './redaction.js'

export interface MemoryWriteSecurityContext {
  origin: ContentOrigin
  trust: ContentTrust
  sensitivity: ContentSensitivity
  provenanceId: string
}

export interface MemoryWriteDecision {
  schemaVersion: 'memory-write-decision/v1'
  action: 'allow' | 'deny'
  reasonCode: 'trusted_source' | 'secret_rejected' | 'untrusted_source_rejected' | 'credential_detected'
  reason: string
}

export function evaluateMemoryWritePolicy(
  record: MemoryRecord,
  security: MemoryWriteSecurityContext,
): MemoryWriteDecision {
  if (record.sensitivity === 'secret' || security.sensitivity === 'secret' || security.sensitivity === 'auth') {
    return deny('secret_rejected', 'Secret/auth material cannot be written to reusable memory.')
  }
  if (security.origin === 'web'
    || security.origin === 'tool'
    || security.origin === 'download'
    || security.origin === 'memory'
    || security.origin === 'subagent'
    || security.trust === 'untrusted_external'
    || security.trust === 'derived_untrusted'
    || security.trust === 'non_authoritative') {
    return deny('untrusted_source_rejected', 'Untrusted or non-authoritative content cannot write reusable memory.')
  }
  if (redactSensitiveData(record).changed) {
    return deny('credential_detected', 'Credential-like content was detected and rejected before persistence.')
  }
  return {
    schemaVersion: 'memory-write-decision/v1',
    action: 'allow',
    reasonCode: 'trusted_source',
    reason: `Trusted ${security.origin} content may be persisted with provenance ${security.provenanceId}.`,
  }
}

function deny(
  reasonCode: Exclude<MemoryWriteDecision['reasonCode'], 'trusted_source'>,
  reason: string,
): MemoryWriteDecision {
  return {
    schemaVersion: 'memory-write-decision/v1',
    action: 'deny',
    reasonCode,
    reason,
  }
}
