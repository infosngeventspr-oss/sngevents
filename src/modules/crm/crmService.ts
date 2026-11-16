/**
 * CRM B2B PARA UNIVERSIDADES — Consent-based Matching.
 *  - Búsqueda: solo perfiles ACTIVOS que optaron por ser descubribles, devueltos
 *    ANONIMIZADOS (sin nombre, correo, fecha de nacimiento ni escuela) con un
 *    ID de candidato seudónimo exclusivo para esa universidad.
 *  - k-anonimato: si el filtro deja menos de K personas, no se devuelve nada.
 *  - Contacto: la universidad envía una solicitud; el estudiante decide.
 *  - PII: solo vía Privacy Guard (match ACEPTADO + flag de transferencia + tutor).
 */
import crypto from 'node:crypto';
import { z } from 'zod';
import { LEGAL, SUPPORTED_JURISDICTIONS } from '../../config/legal';
import { C, type Deps } from '../../deps';
import { Errors } from '../../lib/errors';
import { regionCode, safeText } from '../../lib/validation';
import type { ContactRequest, Organization, StudentProfile } from '../../types';
import { releaseContactData, type ReleasedContact } from '../compliance/privacyGuard';
import { GRADE_LEVELS, INTEREST_TAGS } from '../vocational/taxonomy';

export const searchSchema = z
  .object({
    interests: z.array(z.enum(INTEREST_TAGS)).max(10).optional(),
    countries: z.array(z.enum(SUPPORTED_JURISDICTIONS)).max(20).optional(),
    regions: z.array(regionCode).max(30).optional(),
    gradeLevels: z.array(z.enum(GRADE_LEVELS)).optional(),
    gpaMin: z.number().min(0).max(4).optional(),
    intendedStartYear: z.number().int().min(2024).max(2040).optional(),
    page: z.number().int().min(0).max(100).default(0),
    pageSize: z.number().int().min(1).max(50).default(25),
  })
  .strict();
export type SearchInput = z.infer<typeof searchSchema>;

export interface AnonymizedCandidate {
  candidateId: string;
  country: string;
  region: string;
  gradeLevel: string;
  gpaBand?: string;
  interests: string[];
  intendedStartYear?: number;
  audience: 'MINOR' | 'ADULT';
}

/** El GPA exacto es casi identificador en grupos pequeños: se publica por rangos. */
export function gpaBand(gpa?: number): string | undefined {
  if (gpa === undefined) return undefined;
  if (gpa >= 3.5) return '3.5-4.0';
  if (gpa >= 3.0) return '3.0-3.49';
  if (gpa >= 2.5) return '2.5-2.99';
  return '<2.5';
}

function matchesFilters(p: StudentProfile, f: SearchInput): boolean {
  if (f.interests?.length && !f.interests.some((t) => p.interests.includes(t))) return false;
  if (f.countries?.length && !f.countries.includes(p.country)) return false;
  if (f.regions?.length && !f.regions.includes(p.region)) return false;
  if (f.gradeLevels?.length && !f.gradeLevels.includes(p.gradeLevel)) return false;
  if (f.gpaMin !== undefined && (p.gpa === undefined || p.gpa < f.gpaMin)) return false;
  if (f.intendedStartYear !== undefined && p.intendedStartYear !== f.intendedStartYear) return false;
  return true;
}

async function discoverableProfiles(deps: Deps): Promise<StudentProfile[]> {
  // MVP: filtro grueso en Firestore + fino en memoria. A escala: índice de búsqueda dedicado.
  return deps.db.find<StudentProfile>(
    C.studentProfiles,
    [
      ['status', '==', 'ACTIVE'],
      ['discoverable', '==', true],
    ],
    { limit: 5000 },
  );
}

export async function searchCandidates(deps: Deps, universityId: string, f: SearchInput) {
  const matched = (await discoverableProfiles(deps)).filter((p) => matchesFilters(p, f));
  if (matched.length < LEGAL.K_ANONYMITY_MIN) {
    return { total: null, suppressed: true, results: [] as AnonymizedCandidate[] };
  }
  matched.sort((a, b) => a.studentId.localeCompare(b.studentId)); // orden estable para paginar
  const results = matched.slice(f.page * f.pageSize, (f.page + 1) * f.pageSize).map(
    (p): AnonymizedCandidate => ({
      candidateId: deps.pseudonymizer.encode(universityId, p.studentId),
      country: p.country,
      region: p.region,
      gradeLevel: p.gradeLevel,
      gpaBand: gpaBand(p.gpa),
      interests: p.interests,
      intendedStartYear: p.intendedStartYear,
      audience: p.isMinor ? 'MINOR' : 'ADULT',
    }),
  );
  return { total: matched.length, suppressed: false, results };
}

/** Agregados por dimensión con supresión de celdas pequeñas (< K). */
export async function aggregateInsights(profiles: StudentProfile[]) {
  const count = (key: (p: StudentProfile) => string[]) => {
    const m = new Map<string, number>();
    for (const p of profiles) for (const k of key(p)) m.set(k, (m.get(k) ?? 0) + 1);
    return [...m.entries()]
      .map(([k, n]) => ({ key: k, count: n >= LEGAL.K_ANONYMITY_MIN ? n : `<${LEGAL.K_ANONYMITY_MIN}` }))
      .sort((a, b) => a.key.localeCompare(b.key));
  };
  return {
    total: profiles.length >= LEGAL.K_ANONYMITY_MIN ? profiles.length : `<${LEGAL.K_ANONYMITY_MIN}`,
    byRegion: count((p) => [p.region]),
    byInterest: count((p) => p.interests),
    byGradeLevel: count((p) => [p.gradeLevel]),
  };
}

export async function universityInsights(deps: Deps) {
  return aggregateInsights(await discoverableProfiles(deps));
}

export const contactRequestSchema = z
  .object({
    candidateId: z.string().min(10).max(200),
    programId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional(),
    message: safeText(500),
  })
  .strict();

export async function createContactRequest(deps: Deps, universityId: string, input: z.infer<typeof contactRequestSchema>) {
  const studentId = deps.pseudonymizer.decode(universityId, input.candidateId);
  if (!studentId) throw Errors.notFound('Candidato no encontrado');

  const profile = await deps.db.get<StudentProfile>(C.studentProfiles, studentId);
  if (!profile || profile.status !== 'ACTIVE' || profile.discoverable !== true) throw Errors.notFound('Candidato no encontrado');

  const org = await deps.db.get<Organization>(C.organizations, universityId);
  if (!org || org.type !== 'UNIVERSITY' || !org.verified) throw Errors.forbidden();

  const existing = await deps.db.find<ContactRequest>(C.contactRequests, [
    ['universityId', '==', universityId],
    ['studentId', '==', studentId],
  ]);
  if (existing.some((e) => e.status === 'PENDING' || e.status === 'ACCEPTED')) {
    throw Errors.conflict('DUPLICATE_REQUEST', 'Ya existe una solicitud activa para este candidato');
  }
  if (existing.some((e) => e.status === 'DECLINED' || e.status === 'REVOKED')) {
    // Respeto a la decisión del estudiante: no se puede insistir.
    throw Errors.conflict('STUDENT_DECLINED', 'El candidato ya rechazó o revocó el contacto con su institución');
  }

  const now = deps.now();
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
  const today = await deps.db.find<ContactRequest>(C.contactRequests, [
    ['universityId', '==', universityId],
    ['createdAt', '>=', dayStart],
  ]);
  if (today.length >= LEGAL.MAX_CONTACT_REQUESTS_PER_DAY) throw Errors.tooMany('Límite diario de solicitudes alcanzado');

  const id = crypto.randomUUID();
  const request: ContactRequest = {
    id,
    universityId,
    universityName: org.name,
    studentId,
    programId: input.programId,
    message: input.message,
    status: 'PENDING',
    initiatedBy: 'UNIVERSITY',
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + LEGAL.CONTACT_REQUEST_TTL_DAYS * 86400_000).toISOString(),
  };
  await deps.db.create<ContactRequest>(C.contactRequests, id, request);
  return { id, status: request.status, expiresAt: request.expiresAt };
}

export interface UniversityRequestView {
  id: string;
  candidateId: string;
  status: ContactRequest['status'];
  programId?: string;
  createdAt: string;
  respondedAt?: string;
  /** Presente SOLO si el Privacy Guard lo autoriza. */
  contact?: ReleasedContact;
  /** Si el estudiante revocó, la universidad debe eliminar los datos recibidos previamente. */
  deletionRequired?: boolean;
}

export async function listUniversityRequests(deps: Deps, universityId: string, ip?: string): Promise<UniversityRequestView[]> {
  const list = await deps.db.find<ContactRequest>(C.contactRequests, [['universityId', '==', universityId]], {
    orderBy: { field: 'createdAt', direction: 'desc' },
    limit: 500,
  });
  const accepted = list.filter((r) => r.status === 'ACCEPTED');
  const released = await releaseContactData(deps, universityId, accepted, 'CONTACT_VIEW', ip);
  return list.map((r) => ({
    id: r.id,
    candidateId: deps.pseudonymizer.encode(universityId, r.studentId),
    status: r.status,
    programId: r.programId,
    createdAt: r.createdAt,
    respondedAt: r.respondedAt,
    contact: released.get(r.id),
    deletionRequired: r.status === 'REVOKED' && Boolean(r.respondedAt) ? true : undefined,
  }));
}

/** Previene inyección de fórmulas al abrir el CSV en Excel/Sheets. */
export function csvCell(v: unknown): string {
  let s = v === undefined || v === null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

/**
 * Exportación. Es la única vía de extracción masiva y SOLO incluye estudiantes
 * con match ACEPTADO con esta universidad y `thirdPartyTransferConsent === true`
 * (y aprobación del tutor si es menor). Cada exportación queda auditada.
 */
export async function exportContacts(deps: Deps, universityId: string, ip?: string): Promise<{ csv: string; rows: number }> {
  const accepted = await deps.db.find<ContactRequest>(
    C.contactRequests,
    [
      ['universityId', '==', universityId],
      ['status', '==', 'ACCEPTED'],
    ],
    { limit: LEGAL.MAX_EXPORT_ROWS },
  );
  const released = await releaseContactData(deps, universityId, accepted, 'EXPORT', ip);
  const header = ['candidateId', 'firstName', 'lastName', 'email', 'country', 'region', 'isMinor', 'guardianEmail', 'programId', 'acceptedAt'];
  const lines = [header.map(csvCell).join(',')];
  for (const r of accepted) {
    const c = released.get(r.id);
    if (!c) continue; // el guard rechazó este registro: no se exporta
    lines.push(
      [
        deps.pseudonymizer.encode(universityId, r.studentId),
        c.firstName,
        c.lastName,
        c.email,
        c.country,
        c.region,
        c.isMinor,
        c.guardianEmail,
        r.programId,
        r.respondedAt,
      ]
        .map(csvCell)
        .join(','),
    );
  }
  return { csv: lines.join('\r\n'), rows: lines.length - 1 };
}
