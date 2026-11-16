import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { z } from 'zod';
import { LEGAL, SUPPORTED_JURISDICTIONS, ageOfMajority } from '../../config/legal';
import { C, type Deps } from '../../deps';
import { hmacHex } from '../../lib/crypto';
import { Errors } from '../../lib/errors';
import { ageOn, emailSchema, isoDate, regionCode, safeText } from '../../lib/validation';
import { signToken } from '../../middleware/auth';
import type { ConsentRecord, Organization, StudentPii, StudentProfile, UserAccount } from '../../types';
import { logConsentEvent, sendParentConsentRequest, sendStudentVerification } from '../compliance/consentService';
import { GRADE_LEVELS, INTEREST_TAGS } from '../vocational/taxonomy';

// 12 rondas en producción; 4 solo bajo Jest (NODE_ENV=test) para que las pruebas sean rápidas.
const BCRYPT_ROUNDS = process.env.NODE_ENV === 'test' ? 4 : 12;
/** Normalización dentro del servicio (no depender solo de zod): el índice de correos es sensible a mayúsculas. */
const normEmail = (e: string) => e.trim().toLowerCase();
const passwordSchema = z
  .string()
  .min(10, 'Mínimo 10 caracteres')
  .max(128)
  .refine((p) => /[A-Za-z]/.test(p) && /\d/.test(p), 'Debe contener letras y números');

export const registerStudentSchema = z
  .object({
    email: emailSchema,
    password: passwordSchema,
    firstName: safeText(60),
    lastName: safeText(60),
    birthDate: isoDate,
    country: z.enum(SUPPORTED_JURISDICTIONS),
    region: regionCode,
    gradeLevel: z.enum(GRADE_LEVELS),
    gpa: z.number().min(0).max(4).optional(),
    interests: z.array(z.enum(INTEREST_TAGS)).max(10).default([]),
    intendedStartYear: z.number().int().min(2024).max(2040).optional(),
    schoolId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional(),
    parentEmail: emailSchema.optional(),
    // Consentimientos: T&C y privacidad son obligatorios; los demás son opt-in separados (no agrupados).
    acceptTerms: z.literal(true, { errorMap: () => ({ message: 'Debe aceptar los Términos y Condiciones' }) }),
    acceptPrivacy: z.literal(true, { errorMap: () => ({ message: 'Debe aceptar el Aviso de Privacidad' }) }),
    tosVersion: z.string().max(32),
    allowThirdPartyTransfer: z.boolean().default(false),
    profileDiscoverable: z.boolean().default(false),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (!v.region.startsWith(`${v.country}-`)) {
      ctx.addIssue({ code: 'custom', path: ['region'], message: 'La región no corresponde al país' });
    }
    if (v.parentEmail && v.parentEmail === v.email) {
      ctx.addIssue({ code: 'custom', path: ['parentEmail'], message: 'El correo del tutor debe ser distinto al del estudiante' });
    }
  });
export type RegisterStudentInput = z.infer<typeof registerStudentSchema>;

export async function registerStudent(deps: Deps, input: RegisterStudentInput, ip: string) {
  if (input.tosVersion !== LEGAL.TOS_VERSION) {
    throw Errors.conflict('TOS_VERSION_MISMATCH', `La versión vigente de los términos es ${LEGAL.TOS_VERSION}`);
  }

  const now = deps.now();
  const age = ageOn(input.birthDate, now);

  // COPPA: rechazo SIN persistir ningún dato del menor de 13 años.
  if (age < LEGAL.MIN_REGISTRATION_AGE) {
    throw Errors.forbidden('AGE_BELOW_MINIMUM', `El servicio requiere al menos ${LEGAL.MIN_REGISTRATION_AGE} años`);
  }
  if (age > 100) throw Errors.badRequest('INVALID_BIRTHDATE', 'Fecha de nacimiento inválida');

  const isMinor = age < ageOfMajority(input.country);
  if (isMinor && !input.parentEmail) {
    throw Errors.badRequest('PARENT_EMAIL_REQUIRED', 'Los menores de edad deben indicar el correo de su padre, madre o tutor legal');
  }

  const studentId = crypto.randomUUID();
  // Índice único de correo (create atómico). El ID es un HMAC: no expone el correo.
  try {
    await deps.db.create(C.emailIndex, hmacHex(input.email, deps.config.tokenPepper), { userId: studentId });
  } catch {
    throw Errors.conflict('EMAIL_IN_USE', 'Ya existe una cuenta con ese correo');
  }

  const ts = now.toISOString();
  await deps.db.create<UserAccount>(C.users, studentId, {
    id: studentId,
    role: 'STUDENT',
    email: input.email,
    passwordHash: await bcrypt.hash(input.password, BCRYPT_ROUNDS),
    status: 'PENDING_EMAIL',
    createdAt: ts,
  });
  await deps.db.create<StudentPii>(C.studentPii, studentId, {
    studentId,
    firstName: input.firstName,
    lastName: input.lastName,
    email: input.email,
    birthDate: input.birthDate,
    parentEmail: isMinor ? input.parentEmail : undefined,
  });
  await deps.db.create<StudentProfile>(C.studentProfiles, studentId, {
    studentId,
    status: 'PENDING_EMAIL',
    country: input.country,
    region: input.region,
    gradeLevel: input.gradeLevel,
    gpa: input.gpa,
    interests: [...new Set(input.interests)],
    intendedStartYear: input.intendedStartYear,
    schoolId: input.schoolId,
    isMinor,
    discoverable: false,
    updatedAt: ts,
  });
  await deps.db.create<ConsentRecord>(C.consents, studentId, {
    studentId,
    jurisdiction: input.country,
    isMinor,
    registrationIp: ip,
    registeredAt: ts,
    tosVersion: LEGAL.TOS_VERSION,
    tosAcceptedAt: ts,
    privacyVersion: LEGAL.PRIVACY_VERSION,
    parentEmail: isMinor ? input.parentEmail : undefined,
    parentTransferApproval: false,
    thirdPartyTransferConsent: input.allowThirdPartyTransfer,
    thirdPartyTransferConsentAt: input.allowThirdPartyTransfer ? ts : undefined,
    profileDiscoverable: input.profileDiscoverable,
    personalizedAdsInternal: false,
    updatedAt: ts,
  });
  await logConsentEvent(deps, {
    studentId,
    type: 'REGISTERED',
    actor: 'STUDENT',
    ip,
    details: {
      tosVersion: LEGAL.TOS_VERSION,
      privacyVersion: LEGAL.PRIVACY_VERSION,
      isMinor,
      allowThirdPartyTransfer: input.allowThirdPartyTransfer,
      profileDiscoverable: input.profileDiscoverable,
    },
  });

  await sendStudentVerification(deps, studentId, input.email);
  if (isMinor) await sendParentConsentRequest(deps, studentId, input.parentEmail!, input.firstName);

  return { studentId, status: 'PENDING_EMAIL' as const, requiresParentalConsent: isMinor };
}

export const loginSchema = z.object({ email: emailSchema, password: z.string().min(1).max(128) }).strict();

// Hash ficticio para igualar tiempos cuando el usuario no existe (evita enumeración de cuentas).
const DUMMY_HASH = bcrypt.hashSync('dummy-password-for-timing', BCRYPT_ROUNDS);

export async function login(deps: Deps, email: string, password: string) {
  const idx = await deps.db.get<{ userId: string }>(C.emailIndex, hmacHex(normEmail(email), deps.config.tokenPepper));
  const user = idx ? await deps.db.get<UserAccount>(C.users, idx.userId) : null;
  const ok = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_HASH);
  if (!user || !ok || user.status === 'SUSPENDED' || user.status === 'DELETED') {
    throw Errors.unauthorized('Credenciales inválidas');
  }
  return {
    accessToken: signToken(deps, user),
    tokenType: 'Bearer',
    expiresIn: deps.config.jwtTtlSeconds,
    role: user.role,
    status: user.status,
  };
}

export const createOrganizationSchema = z
  .object({
    type: z.enum(['SCHOOL', 'UNIVERSITY']),
    name: safeText(120),
    country: z.enum(SUPPORTED_JURISDICTIONS),
    region: regionCode,
    accountEmail: emailSchema,
    initialPassword: passwordSchema,
  })
  .strict();

/** Alta de instituciones: solo ADMIN, tras verificación (KYC) fuera de banda. */
export async function createOrganization(deps: Deps, input: z.infer<typeof createOrganizationSchema>) {
  const orgId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const accountEmail = normEmail(input.accountEmail);
  try {
    await deps.db.create(C.emailIndex, hmacHex(accountEmail, deps.config.tokenPepper), { userId });
  } catch {
    throw Errors.conflict('EMAIL_IN_USE', 'Ya existe una cuenta con ese correo');
  }
  const ts = deps.now().toISOString();
  await deps.db.create<Organization>(C.organizations, orgId, {
    id: orgId,
    type: input.type,
    name: input.name,
    country: input.country,
    region: input.region,
    verified: true,
    createdAt: ts,
  });
  await deps.db.create<UserAccount>(C.users, userId, {
    id: userId,
    role: input.type,
    email: accountEmail,
    passwordHash: await bcrypt.hash(input.initialPassword, BCRYPT_ROUNDS),
    status: 'ACTIVE',
    orgId,
    createdAt: ts,
  });
  return { orgId, userId };
}

/** Crea el primer ADMIN (usado por scripts/seed.ts, nunca expuesto por HTTP). */
export async function createAdmin(deps: Deps, email: string, password: string) {
  passwordSchema.parse(password);
  email = normEmail(email);
  const id = crypto.randomUUID();
  await deps.db.create(C.emailIndex, hmacHex(email, deps.config.tokenPepper), { userId: id });
  await deps.db.create<UserAccount>(C.users, id, {
    id,
    role: 'ADMIN',
    email,
    passwordHash: await bcrypt.hash(password, BCRYPT_ROUNDS),
    status: 'ACTIVE',
    createdAt: deps.now().toISOString(),
  });
  return id;
}
