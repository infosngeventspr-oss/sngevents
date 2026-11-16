/**
 * PRIVACY GUARD
 * =============
 * ÚNICO punto del sistema autorizado a leer `studentPii` para entregarla a un
 * tercero (universidad). Toda vista de contacto y toda exportación pasa por
 * `releaseContactData`, que aplica `evaluateTransfer` registro por registro.
 *
 * Regla dura: sin `thirdPartyTransferConsent === true` (comparación estricta
 * contra el booleano, no "truthy") NO se libera ningún dato de contacto, ni
 * siquiera si existe un "Match" aceptado.
 */
import { LEGAL } from '../../config/legal';
import { C, type Deps } from '../../deps';
import type { ConsentRecord, ContactRequest, DataTransferLog, StudentPii, StudentProfile } from '../../types';
import { logConsentEvent } from './consentService';

export type TransferDenialReason =
  | 'STUDENT_NOT_FOUND'
  | 'ACCOUNT_NOT_ACTIVE'
  | 'NO_TRANSFER_CONSENT'
  | 'PARENT_APPROVAL_MISSING'
  | 'TOS_OUTDATED'
  | 'NO_ACCEPTED_MATCH'
  | 'UNIVERSITY_MISMATCH';

export type TransferDecision = { allowed: true } | { allowed: false; reason: TransferDenialReason };

/** Consentimiento propio del estudiante (+ tutor si es menor), sin considerar un match específico. */
export function evaluateStudentTransferConsent(
  profile: StudentProfile | null,
  consent: ConsentRecord | null,
): TransferDecision {
  if (!profile || !consent) return { allowed: false, reason: 'STUDENT_NOT_FOUND' };
  if (profile.status !== 'ACTIVE') return { allowed: false, reason: 'ACCOUNT_NOT_ACTIVE' };
  if (consent.tosVersion !== LEGAL.TOS_VERSION) return { allowed: false, reason: 'TOS_OUTDATED' };
  if (consent.thirdPartyTransferConsent !== true) return { allowed: false, reason: 'NO_TRANSFER_CONSENT' };
  if (consent.isMinor) {
    if (!consent.parentVerifiedAt || consent.parentTransferApproval !== true) {
      return { allowed: false, reason: 'PARENT_APPROVAL_MISSING' };
    }
  }
  return { allowed: true };
}

/** Decisión completa para liberar PII de un estudiante a una universidad concreta. */
export function evaluateTransfer(ctx: {
  universityId: string;
  request: ContactRequest | null;
  profile: StudentProfile | null;
  consent: ConsentRecord | null;
}): TransferDecision {
  const base = evaluateStudentTransferConsent(ctx.profile, ctx.consent);
  if (!base.allowed) return base;
  if (!ctx.request || ctx.request.status !== 'ACCEPTED') return { allowed: false, reason: 'NO_ACCEPTED_MATCH' };
  if (ctx.request.universityId !== ctx.universityId) return { allowed: false, reason: 'UNIVERSITY_MISMATCH' };
  if (ctx.request.studentId !== ctx.profile!.studentId) return { allowed: false, reason: 'UNIVERSITY_MISMATCH' };
  return { allowed: true };
}

export interface ReleasedContact {
  firstName: string;
  lastName: string;
  email: string;
  country: string;
  region: string;
  isMinor: boolean;
  /** Para menores: la universidad debe incluir al tutor en sus comunicaciones. */
  guardianEmail?: string;
}

/**
 * Libera datos de contacto SOLO para las solicitudes que superan el guard y
 * deja registro de auditoría (`dataTransfers` + `consentEvents`).
 */
export async function releaseContactData(
  deps: Deps,
  universityId: string,
  requests: ContactRequest[],
  channel: DataTransferLog['channel'],
  ip?: string,
): Promise<Map<string, ReleasedContact>> {
  const released = new Map<string, ReleasedContact>();
  const at = deps.now().toISOString();

  for (const request of requests) {
    const [profile, consent] = await Promise.all([
      deps.db.get<StudentProfile>(C.studentProfiles, request.studentId),
      deps.db.get<ConsentRecord>(C.consents, request.studentId),
    ]);
    const decision = evaluateTransfer({ universityId, request, profile, consent });
    if (!decision.allowed) continue;

    const pii = await deps.db.get<StudentPii>(C.studentPii, request.studentId);
    if (!pii) continue;

    released.set(request.id, {
      firstName: pii.firstName,
      lastName: pii.lastName,
      email: pii.email,
      country: profile!.country,
      region: profile!.region,
      isMinor: consent!.isMinor,
      guardianEmail: consent!.isMinor ? pii.parentEmail : undefined,
    });
  }

  if (released.size > 0) {
    const studentIds = requests.filter((r) => released.has(r.id)).map((r) => r.studentId);
    await deps.db.add<DataTransferLog>(C.dataTransfers, { universityId, studentIds, channel, at, ip });
    if (channel === 'EXPORT') {
      await Promise.all(
        studentIds.map((studentId) =>
          logConsentEvent(deps, { studentId, type: 'DATA_EXPORTED', actor: 'UNIVERSITY', ip, details: { universityId } }),
        ),
      );
    }
  }
  return released;
}
