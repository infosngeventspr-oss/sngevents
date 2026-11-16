/**
 * COMPLIANCE ENGINE — gestión del ciclo de vida del consentimiento.
 *  - Tokens de verificación de un solo uso (hash HMAC, TTL, marca atómica de uso).
 *  - Doble opt-in: correo del estudiante + aprobación del padre/tutor (menores).
 *  - Cambios de consentimiento con bitácora append-only y revocación en cascada.
 *  - Derecho de supresión (borrado de PII).
 */
import { LEGAL } from '../../config/legal';
import { C, type Deps } from '../../deps';
import { hmacHex, randomToken } from '../../lib/crypto';
import { Errors } from '../../lib/errors';
import type {
  AccountStatus,
  ConsentEvent,
  ConsentRecord,
  ContactRequest,
  StudentPii,
  StudentProfile,
  UserAccount,
} from '../../types';

export type TokenPurpose = 'STUDENT_EMAIL' | 'PARENT_CONSENT';

interface ConsentToken {
  studentId: string;
  purpose: TokenPurpose;
  expiresAt: string;
  createdAt: string;
}

export async function logConsentEvent(deps: Deps, e: Omit<ConsentEvent, 'at'>): Promise<void> {
  await deps.db.add<ConsentEvent>(C.consentEvents, { ...e, at: deps.now().toISOString() });
}

export async function issueToken(deps: Deps, studentId: string, purpose: TokenPurpose): Promise<string> {
  const token = randomToken();
  const now = deps.now();
  await deps.db.set<ConsentToken>(C.consentTokens, hmacHex(token, deps.config.tokenPepper), {
    studentId,
    purpose,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + LEGAL.CONSENT_TOKEN_TTL_HOURS * 3600_000).toISOString(),
  });
  return token;
}

/** Consume un token: valida propósito y vigencia, y lo marca como usado de forma atómica (create). */
export async function consumeToken(deps: Deps, token: string, purpose: TokenPurpose): Promise<string> {
  const id = hmacHex(token, deps.config.tokenPepper);
  const t = await deps.db.get<ConsentToken>(C.consentTokens, id);
  if (!t || t.purpose !== purpose) throw Errors.badRequest('INVALID_TOKEN', 'Enlace inválido');
  if (new Date(t.expiresAt) < deps.now()) throw Errors.badRequest('TOKEN_EXPIRED', 'El enlace expiró');
  try {
    await deps.db.create(C.consentTokenUses, id, { usedAt: deps.now().toISOString() });
  } catch {
    throw Errors.badRequest('TOKEN_USED', 'El enlace ya fue utilizado');
  }
  return t.studentId;
}

export async function sendStudentVerification(deps: Deps, studentId: string, email: string): Promise<void> {
  const token = await issueToken(deps, studentId, 'STUDENT_EMAIL');
  await deps.mailer.send({
    to: email,
    subject: 'Confirma tu correo',
    text: `Confirma tu cuenta: ${deps.config.appBaseUrl}/verificar?token=${token}\nEl enlace vence en ${LEGAL.CONSENT_TOKEN_TTL_HOURS} horas.`,
  });
}

export async function sendParentConsentRequest(deps: Deps, studentId: string, parentEmail: string, studentFirstName: string): Promise<void> {
  const token = await issueToken(deps, studentId, 'PARENT_CONSENT');
  await deps.mailer.send({
    to: parentEmail,
    subject: 'Autorización requerida: cuenta de orientación vocacional de su hijo/a',
    text:
      `${studentFirstName} solicitó crear una cuenta de orientación vocacional. Por ser menor de edad, ` +
      `necesitamos su autorización como padre, madre o tutor legal.\n\n` +
      `Revise qué datos recopilamos (Términos v${LEGAL.TOS_VERSION}, Privacidad v${LEGAL.PRIVACY_VERSION}) ` +
      `y apruebe o rechace aquí: ${deps.config.appBaseUrl}/consentimiento-tutor?token=${token}\n\n` +
      `Si rechaza, eliminaremos los datos del menor. El enlace vence en ${LEGAL.CONSENT_TOKEN_TTL_HOURS} horas.`,
  });
}

/** Recalcula el estado de la cuenta a partir del consentimiento (fuente de verdad). */
export async function recomputeStatus(deps: Deps, studentId: string): Promise<AccountStatus> {
  const consent = await deps.db.get<ConsentRecord>(C.consents, studentId);
  const user = await deps.db.get<UserAccount>(C.users, studentId);
  if (!consent || !user) throw Errors.notFound();
  if (user.status === 'SUSPENDED' || user.status === 'DELETED') return user.status;

  let status: AccountStatus;
  if (!consent.studentEmailVerifiedAt) status = 'PENDING_EMAIL';
  else if (consent.isMinor && !consent.parentVerifiedAt) status = 'PENDING_PARENT';
  else status = 'ACTIVE';

  const ts = deps.now().toISOString();
  await deps.db.update<UserAccount>(C.users, studentId, { status });
  await deps.db.update<StudentProfile>(C.studentProfiles, studentId, {
    status,
    // Un perfil solo es descubrible si la cuenta está activa Y el estudiante lo autorizó.
    discoverable: status === 'ACTIVE' && consent.profileDiscoverable === true,
    updatedAt: ts,
  });
  return status;
}

export async function verifyStudentEmail(deps: Deps, token: string, ip: string): Promise<AccountStatus> {
  const studentId = await consumeToken(deps, token, 'STUDENT_EMAIL');
  const ts = deps.now().toISOString();
  await deps.db.update<ConsentRecord>(C.consents, studentId, { studentEmailVerifiedAt: ts, updatedAt: ts });
  await logConsentEvent(deps, { studentId, type: 'STUDENT_EMAIL_VERIFIED', actor: 'STUDENT', ip });
  return recomputeStatus(deps, studentId);
}

export async function parentDecision(
  deps: Deps,
  input: { token: string; decision: 'APPROVE' | 'DENY'; allowThirdPartyTransfer: boolean; ip: string },
): Promise<{ status: AccountStatus }> {
  const studentId = await consumeToken(deps, input.token, 'PARENT_CONSENT');
  const consent = await deps.db.get<ConsentRecord>(C.consents, studentId);
  if (!consent) throw Errors.notFound();

  if (input.decision === 'DENY') {
    await logConsentEvent(deps, { studentId, type: 'PARENT_DENIED', actor: 'PARENT', ip: input.ip });
    await eraseStudent(deps, studentId, 'PARENT', input.ip);
    return { status: 'DELETED' };
  }

  const ts = deps.now().toISOString();
  await deps.db.update<ConsentRecord>(C.consents, studentId, {
    parentVerifiedAt: ts,
    parentVerificationIp: input.ip,
    parentTransferApproval: input.allowThirdPartyTransfer === true,
    updatedAt: ts,
  });
  await logConsentEvent(deps, {
    studentId,
    type: 'PARENT_APPROVED',
    actor: 'PARENT',
    ip: input.ip,
    details: { allowThirdPartyTransfer: input.allowThirdPartyTransfer === true, tosVersion: LEGAL.TOS_VERSION },
  });
  return { status: await recomputeStatus(deps, studentId) };
}

export interface ConsentPatch {
  thirdPartyTransferConsent?: boolean;
  profileDiscoverable?: boolean;
  personalizedAdsInternal?: boolean;
  acceptTosVersion?: string;
}

export async function updateConsent(deps: Deps, studentId: string, patch: ConsentPatch, ip: string): Promise<ConsentRecord> {
  const current = await deps.db.get<ConsentRecord>(C.consents, studentId);
  if (!current) throw Errors.notFound();
  const ts = deps.now().toISOString();
  const next: Partial<ConsentRecord> = { updatedAt: ts };

  if (patch.acceptTosVersion !== undefined) {
    if (patch.acceptTosVersion !== LEGAL.TOS_VERSION) {
      throw Errors.conflict('TOS_VERSION_MISMATCH', `La versión vigente de los términos es ${LEGAL.TOS_VERSION}`);
    }
    next.tosVersion = LEGAL.TOS_VERSION;
    next.tosAcceptedAt = ts;
    next.privacyVersion = LEGAL.PRIVACY_VERSION;
    await logConsentEvent(deps, { studentId, type: 'TOS_REACCEPTED', actor: 'STUDENT', ip, details: { tosVersion: LEGAL.TOS_VERSION } });
  }
  if (patch.thirdPartyTransferConsent !== undefined) {
    next.thirdPartyTransferConsent = patch.thirdPartyTransferConsent;
    next.thirdPartyTransferConsentAt = ts;
  }
  if (patch.profileDiscoverable !== undefined) next.profileDiscoverable = patch.profileDiscoverable;
  if (patch.personalizedAdsInternal !== undefined) next.personalizedAdsInternal = patch.personalizedAdsInternal;

  await deps.db.update<ConsentRecord>(C.consents, studentId, next);
  await logConsentEvent(deps, {
    studentId,
    type: 'CONSENT_UPDATED',
    actor: 'STUDENT',
    ip,
    details: {
      thirdPartyTransferConsent: patch.thirdPartyTransferConsent,
      profileDiscoverable: patch.profileDiscoverable,
      personalizedAdsInternal: patch.personalizedAdsInternal,
    },
  });

  // Revocación en cascada: retirar el consentimiento de transferencia anula todos los matches.
  if (patch.thirdPartyTransferConsent === false && current.thirdPartyTransferConsent === true) {
    await revokeAllMatches(deps, studentId, ip);
  }
  await recomputeStatus(deps, studentId);
  return (await deps.db.get<ConsentRecord>(C.consents, studentId))!;
}

export async function revokeAllMatches(deps: Deps, studentId: string, ip?: string): Promise<number> {
  const active = await deps.db.find<ContactRequest>(C.contactRequests, [
    ['studentId', '==', studentId],
    ['status', 'in', ['PENDING', 'ACCEPTED']],
  ]);
  const ts = deps.now().toISOString();
  for (const r of active) {
    await deps.db.update<ContactRequest>(C.contactRequests, r.id, { status: 'REVOKED', revokedAt: ts });
    await logConsentEvent(deps, { studentId, type: 'CONTACT_REVOKED', actor: 'STUDENT', ip, details: { universityId: r.universityId } });
  }
  return active.length;
}

/**
 * Derecho de supresión / cancelación. Borra la PII y desactiva el perfil.
 * Se conserva la bitácora de consentimiento (prueba legal del consentimiento),
 * que solo contiene IDs internos, IP y marcas de tiempo; definir su plazo de
 * retención en la política de privacidad.
 */
export async function eraseStudent(deps: Deps, studentId: string, actor: ConsentEvent['actor'], ip?: string): Promise<void> {
  const user = await deps.db.get<UserAccount>(C.users, studentId);
  await revokeAllMatches(deps, studentId, ip);
  if (user) {
    await deps.db.delete(C.emailIndex, hmacHex(user.email, deps.config.tokenPepper));
    await deps.db.update<UserAccount>(C.users, studentId, { status: 'DELETED', email: `deleted+${studentId}@invalid`, passwordHash: '!' });
  }
  await deps.db.delete(C.studentPii, studentId);
  const ts = deps.now().toISOString();
  const profile = await deps.db.get<StudentProfile>(C.studentProfiles, studentId);
  if (profile) {
    await deps.db.update<StudentProfile>(C.studentProfiles, studentId, {
      status: 'DELETED',
      discoverable: false,
      interests: [],
      gpa: undefined,
      schoolId: undefined,
      updatedAt: ts,
    });
  }
  const consent = await deps.db.get<ConsentRecord>(C.consents, studentId);
  if (consent) {
    await deps.db.update<ConsentRecord>(C.consents, studentId, {
      thirdPartyTransferConsent: false,
      profileDiscoverable: false,
      personalizedAdsInternal: false,
      parentEmail: undefined,
      updatedAt: ts,
    });
  }
  await logConsentEvent(deps, { studentId, type: 'ACCOUNT_ERASED', actor, ip });
}

/** Vista del estudiante sobre sus propios datos (derecho de acceso / portabilidad). */
export async function exportOwnData(deps: Deps, studentId: string) {
  const [pii, profile, consent, events, requests] = await Promise.all([
    deps.db.get<StudentPii>(C.studentPii, studentId),
    deps.db.get<StudentProfile>(C.studentProfiles, studentId),
    deps.db.get<ConsentRecord>(C.consents, studentId),
    deps.db.find<ConsentEvent>(C.consentEvents, [['studentId', '==', studentId]], { orderBy: { field: 'at', direction: 'asc' } }),
    deps.db.find<ContactRequest>(C.contactRequests, [['studentId', '==', studentId]]),
  ]);
  return {
    generatedAt: deps.now().toISOString(),
    personalData: pii,
    profile,
    consent,
    consentHistory: events,
    universityMatches: requests.map((r) => ({
      universityName: r.universityName,
      status: r.status,
      initiatedBy: r.initiatedBy,
      createdAt: r.createdAt,
      respondedAt: r.respondedAt,
    })),
  };
}
