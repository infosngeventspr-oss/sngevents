import type { Jurisdiction } from './config/legal';
import type { InterestTag, GradeLevel } from './modules/vocational/taxonomy';

export type Role = 'STUDENT' | 'SCHOOL' | 'UNIVERSITY' | 'ADMIN';

/** PENDING_EMAIL -> (menor) PENDING_PARENT -> ACTIVE. */
export type AccountStatus = 'PENDING_EMAIL' | 'PENDING_PARENT' | 'ACTIVE' | 'SUSPENDED' | 'DELETED';

/** Colección `users`: credenciales y rol. */
export interface UserAccount {
  id: string;
  role: Role;
  email: string;
  passwordHash: string;
  status: AccountStatus;
  orgId?: string;
  createdAt: string;
}

/** Colección `organizations`: escuelas y universidades (alta solo por ADMIN, con KYC). */
export interface Organization {
  id: string;
  type: 'SCHOOL' | 'UNIVERSITY';
  name: string;
  country: Jurisdiction;
  region: string;
  verified: boolean;
  createdAt: string;
}

/**
 * Colección `studentPii`: Información Personal Identificable.
 * Aislada en su propia colección: SOLO se lee a través del Privacy Guard
 * (o por el propio estudiante para ejercer su derecho de acceso).
 */
export interface StudentPii {
  studentId: string;
  firstName: string;
  lastName: string;
  email: string;
  birthDate: string; // YYYY-MM-DD
  parentEmail?: string;
}

/** Colección `studentProfiles`: datos no identificables usados para matching y búsqueda. */
export interface StudentProfile {
  studentId: string;
  status: AccountStatus;
  country: Jurisdiction;
  region: string;
  gradeLevel: GradeLevel;
  gpa?: number;
  interests: InterestTag[];
  intendedStartYear?: number;
  schoolId?: string;
  isMinor: boolean;
  /** Opt-in explícito para aparecer (anonimizado) en búsquedas de universidades. */
  discoverable: boolean;
  updatedAt: string;
}

/**
 * Colección `consents`: estado vigente de consentimiento + metadatos de auditoría
 * obligatorios (IP, timestamp, versión de T&C, correo verificado del tutor).
 */
export interface ConsentRecord {
  studentId: string;
  jurisdiction: Jurisdiction;
  isMinor: boolean;
  // --- Auditoría de registro ---
  registrationIp: string;
  registeredAt: string;
  tosVersion: string;
  tosAcceptedAt: string;
  privacyVersion: string;
  // --- Doble opt-in ---
  studentEmailVerifiedAt?: string;
  parentEmail?: string;
  parentVerifiedAt?: string;
  parentVerificationIp?: string;
  /** Autorización del tutor para transferir datos de contacto a terceros (solo menores). */
  parentTransferApproval: boolean;
  // --- Flags de consentimiento (todos false por defecto: privacidad por diseño) ---
  /** "Consentimiento de Transferencia a Terceros". Sin este flag en `true` NO sale PII. */
  thirdPartyTransferConsent: boolean;
  thirdPartyTransferConsentAt?: string;
  profileDiscoverable: boolean;
  /** Permite segmentar anuncios internos con su perfil (si false: solo anuncios no segmentados). */
  personalizedAdsInternal: boolean;
  updatedAt: string;
}

export type ConsentEventType =
  | 'REGISTERED'
  | 'STUDENT_EMAIL_VERIFIED'
  | 'PARENT_APPROVED'
  | 'PARENT_DENIED'
  | 'CONSENT_UPDATED'
  | 'TOS_REACCEPTED'
  | 'CONTACT_ACCEPTED'
  | 'CONTACT_DECLINED'
  | 'CONTACT_REVOKED'
  | 'DATA_EXPORTED'
  | 'ACCOUNT_ERASED';

/** Colección `consentEvents`: bitácora append-only (nunca se actualiza ni borra). */
export interface ConsentEvent {
  studentId: string;
  type: ConsentEventType;
  at: string;
  ip?: string;
  actor: 'STUDENT' | 'PARENT' | 'UNIVERSITY' | 'SYSTEM' | 'ADMIN';
  details?: Record<string, unknown>;
}

export type ContactRequestStatus = 'PENDING' | 'ACCEPTED' | 'DECLINED' | 'REVOKED' | 'EXPIRED';

/** Colección `contactRequests`: el "Match" estudiante–universidad. */
export interface ContactRequest {
  id: string;
  universityId: string;
  universityName: string;
  studentId: string;
  programId?: string;
  message: string;
  status: ContactRequestStatus;
  initiatedBy: 'UNIVERSITY' | 'STUDENT';
  createdAt: string;
  expiresAt: string;
  respondedAt?: string;
  revokedAt?: string;
}

/** Colección `programs`: oferta académica de universidades (para el motor vocacional). */
export interface Program {
  id: string;
  universityId: string;
  universityName: string;
  name: string;
  area: InterestTag;
  riasec: InterestTag[];
  minGpa?: number;
  country: Jurisdiction;
  region: string;
  modality: 'ONSITE' | 'ONLINE' | 'HYBRID';
  active: boolean;
}

export type AdStatus = 'PENDING_REVIEW' | 'ACTIVE' | 'PAUSED' | 'REJECTED' | 'ENDED';

/** Colección `adCampaigns`: anuncios nativos internos (sin enlaces externos ni pixeles). */
export interface AdCampaign {
  id: string;
  universityId: string;
  universityName: string;
  title: string;
  body: string;
  ctaLabel: 'MORE_INFO' | 'APPLY' | 'VISIT_PROGRAM';
  programId?: string;
  targeting: {
    interests?: InterestTag[];
    countries?: Jurisdiction[];
    regions?: string[];
    gradeLevels?: GradeLevel[];
  };
  status: AdStatus;
  startsAt: string;
  endsAt: string;
  impressions: number;
  clicks: number;
  infoRequests: number;
  createdAt: string;
}

/** Colección `dataTransfers`: registro de cada liberación de PII a un tercero. */
export interface DataTransferLog {
  universityId: string;
  studentIds: string[];
  channel: 'CONTACT_VIEW' | 'EXPORT';
  at: string;
  ip?: string;
}
