import { LEGAL } from '../src/config/legal';
import { evaluateTransfer } from '../src/modules/compliance/privacyGuard';
import type { ConsentRecord, ContactRequest, StudentProfile } from '../src/types';

const profile: StudentProfile = {
  studentId: 's1',
  status: 'ACTIVE',
  country: 'US',
  region: 'US-FL',
  gradeLevel: 'HS_SENIOR',
  interests: [],
  isMinor: false,
  discoverable: true,
  updatedAt: '',
};
const consent: ConsentRecord = {
  studentId: 's1',
  jurisdiction: 'US',
  isMinor: false,
  registrationIp: '1.1.1.1',
  registeredAt: '',
  tosVersion: LEGAL.TOS_VERSION,
  tosAcceptedAt: '',
  privacyVersion: LEGAL.PRIVACY_VERSION,
  parentTransferApproval: false,
  thirdPartyTransferConsent: true,
  profileDiscoverable: true,
  personalizedAdsInternal: false,
  updatedAt: '',
};
const request: ContactRequest = {
  id: 'r1',
  universityId: 'u1',
  universityName: 'U',
  studentId: 's1',
  message: '',
  status: 'ACCEPTED',
  initiatedBy: 'UNIVERSITY',
  createdAt: '',
  expiresAt: '',
};

const base = { universityId: 'u1', profile, consent, request };

describe('Privacy Guard', () => {
  it('permite la transferencia con match aceptado y consentimiento vigente', () => {
    expect(evaluateTransfer(base)).toEqual({ allowed: true });
  });

  it('bloquea sin el flag booleano de transferencia (comparación estricta)', () => {
    expect(evaluateTransfer({ ...base, consent: { ...consent, thirdPartyTransferConsent: false } })).toEqual({
      allowed: false,
      reason: 'NO_TRANSFER_CONSENT',
    });
    const truthy = { ...consent, thirdPartyTransferConsent: 'true' as unknown as boolean };
    expect(evaluateTransfer({ ...base, consent: truthy }).allowed).toBe(false);
  });

  it('bloquea a menores sin aprobación del tutor para transferir', () => {
    const minor = { ...consent, isMinor: true, parentVerifiedAt: '2026-01-01', parentTransferApproval: false };
    expect(evaluateTransfer({ ...base, consent: minor })).toEqual({ allowed: false, reason: 'PARENT_APPROVAL_MISSING' });
    expect(evaluateTransfer({ ...base, consent: { ...minor, parentTransferApproval: true } }).allowed).toBe(true);
  });

  it('bloquea si los Términos aceptados no son la versión vigente', () => {
    expect(evaluateTransfer({ ...base, consent: { ...consent, tosVersion: '1999-01-01' } })).toEqual({ allowed: false, reason: 'TOS_OUTDATED' });
  });

  it('bloquea solicitudes pendientes, revocadas o de otra universidad', () => {
    expect(evaluateTransfer({ ...base, request: { ...request, status: 'PENDING' } }).allowed).toBe(false);
    expect(evaluateTransfer({ ...base, request: { ...request, status: 'REVOKED' } }).allowed).toBe(false);
    expect(evaluateTransfer({ ...base, universityId: 'u2' })).toEqual({ allowed: false, reason: 'UNIVERSITY_MISMATCH' });
  });

  it('bloquea cuentas no activas', () => {
    expect(evaluateTransfer({ ...base, profile: { ...profile, status: 'PENDING_PARENT' } })).toEqual({ allowed: false, reason: 'ACCOUNT_NOT_ACTIVE' });
  });
});
