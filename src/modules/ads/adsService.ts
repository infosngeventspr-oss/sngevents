/**
 * ADTECH / PAUTA INTERNA
 *  - Anuncios nativos que viven DENTRO del portal: sin URLs externas, sin
 *    pixeles ni scripts de terceros. El CTA apunta a un programa interno.
 *  - La segmentación se resuelve en el servidor: la universidad NUNCA recibe
 *    la lista de estudiantes que vieron o hicieron clic en su anuncio.
 *  - Sin `personalizedAdsInternal`, el estudiante solo ve anuncios NO segmentados.
 *  - Revisión humana (ADMIN) obligatoria antes de publicar (audiencia de menores).
 *  - Métricas agregadas con supresión k-anónima.
 *  - El dato solo sale del ecosistema si el estudiante pulsa "Solicitar
 *    información", lo que crea un Match iniciado por él (sujeto al Privacy Guard).
 */
import crypto from 'node:crypto';
import { z } from 'zod';
import { LEGAL, SUPPORTED_JURISDICTIONS } from '../../config/legal';
import { C, type Deps } from '../../deps';
import { Errors } from '../../lib/errors';
import { regionCode, safeText } from '../../lib/validation';
import type { AdCampaign, ConsentRecord, ContactRequest, Organization, StudentProfile } from '../../types';
import { logConsentEvent } from '../compliance/consentService';
import { evaluateStudentTransferConsent } from '../compliance/privacyGuard';
import { GRADE_LEVELS, INTEREST_TAGS } from '../vocational/taxonomy';

export const campaignSchema = z
  .object({
    title: safeText(80),
    body: safeText(300),
    ctaLabel: z.enum(['MORE_INFO', 'APPLY', 'VISIT_PROGRAM']),
    programId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional(),
    targeting: z
      .object({
        interests: z.array(z.enum(INTEREST_TAGS)).max(10).optional(),
        countries: z.array(z.enum(SUPPORTED_JURISDICTIONS)).max(20).optional(),
        regions: z.array(regionCode).max(30).optional(),
        gradeLevels: z.array(z.enum(GRADE_LEVELS)).optional(),
      })
      .strict()
      .default({}),
    startsAt: z.string().datetime(),
    endsAt: z.string().datetime(),
  })
  .strict()
  .refine((v) => v.endsAt > v.startsAt, { message: 'endsAt debe ser posterior a startsAt', path: ['endsAt'] })
  .refine((v) => !/(https?:\/\/|www\.)/i.test(`${v.title} ${v.body}`), {
    message: 'No se permiten enlaces externos en anuncios',
    path: ['body'],
  });

export async function createCampaign(deps: Deps, universityId: string, input: z.infer<typeof campaignSchema>) {
  const org = await deps.db.get<Organization>(C.organizations, universityId);
  if (!org || org.type !== 'UNIVERSITY') throw Errors.forbidden();
  const id = crypto.randomUUID();
  const c: AdCampaign = {
    id,
    universityId,
    universityName: org.name,
    ...input,
    status: 'PENDING_REVIEW',
    impressions: 0,
    clicks: 0,
    infoRequests: 0,
    createdAt: deps.now().toISOString(),
  };
  await deps.db.create<AdCampaign>(C.adCampaigns, id, c);
  return c;
}

export function isTargeted(c: AdCampaign): boolean {
  const t = c.targeting;
  return Boolean(t.interests?.length || t.countries?.length || t.regions?.length || t.gradeLevels?.length);
}

export function targetingMatches(c: AdCampaign, p: StudentProfile): boolean {
  const t = c.targeting;
  if (t.interests?.length && !t.interests.some((i) => p.interests.includes(i))) return false;
  if (t.countries?.length && !t.countries.includes(p.country)) return false;
  if (t.regions?.length && !t.regions.includes(p.region)) return false;
  if (t.gradeLevels?.length && !t.gradeLevels.includes(p.gradeLevel)) return false;
  return true;
}

export interface AdView {
  id: string;
  sponsored: true;
  advertiser: string;
  title: string;
  body: string;
  ctaLabel: AdCampaign['ctaLabel'];
  programId?: string;
}

export async function getFeed(deps: Deps, studentId: string, max = 3): Promise<AdView[]> {
  const [profile, consent] = await Promise.all([
    deps.db.get<StudentProfile>(C.studentProfiles, studentId),
    deps.db.get<ConsentRecord>(C.consents, studentId),
  ]);
  if (!profile || !consent) throw Errors.notFound();
  const nowIso = deps.now().toISOString();
  const active = (await deps.db.find<AdCampaign>(C.adCampaigns, [['status', '==', 'ACTIVE']], { limit: 500 })).filter(
    (c) => c.startsAt <= nowIso && c.endsAt >= nowIso,
  );
  const personalized = consent.personalizedAdsInternal === true;
  const eligible = active.filter((c) => (personalized ? targetingMatches(c, profile) : !isTargeted(c)));

  // Rotación aleatoria simple. Se cuenta la impresión SIN guardar quién la vio.
  const picked = eligible.sort(() => Math.random() - 0.5).slice(0, max);
  await Promise.all(picked.map((c) => deps.db.increment(C.adCampaigns, c.id, 'impressions', 1)));
  return picked.map((c) => ({
    id: c.id,
    sponsored: true,
    advertiser: c.universityName,
    title: c.title,
    body: c.body,
    ctaLabel: c.ctaLabel,
    programId: c.programId,
  }));
}

async function getActiveCampaign(deps: Deps, id: string): Promise<AdCampaign> {
  const c = await deps.db.get<AdCampaign>(C.adCampaigns, id);
  if (!c || c.status !== 'ACTIVE') throw Errors.notFound();
  return c;
}

export async function registerClick(deps: Deps, campaignId: string) {
  const c = await getActiveCampaign(deps, campaignId);
  await deps.db.increment(C.adCampaigns, c.id, 'clicks', 1);
  return { programId: c.programId };
}

/** El estudiante, de forma explícita, pide información: Match iniciado por el estudiante. */
export async function requestInfo(deps: Deps, studentId: string, campaignId: string, ip?: string) {
  const c = await getActiveCampaign(deps, campaignId);
  const [profile, consent] = await Promise.all([
    deps.db.get<StudentProfile>(C.studentProfiles, studentId),
    deps.db.get<ConsentRecord>(C.consents, studentId),
  ]);
  const check = evaluateStudentTransferConsent(profile, consent);
  if (!check.allowed) throw Errors.conflict(check.reason, 'Se requiere consentimiento de transferencia de datos (y del tutor si eres menor)');

  const existing = await deps.db.find<ContactRequest>(C.contactRequests, [
    ['universityId', '==', c.universityId],
    ['studentId', '==', studentId],
    ['status', 'in', ['PENDING', 'ACCEPTED']],
  ]);
  const now = deps.now();
  if (existing.length > 0) {
    const pending = existing.find((e) => e.status === 'PENDING');
    if (pending) {
      await deps.db.update<ContactRequest>(C.contactRequests, pending.id, { status: 'ACCEPTED', respondedAt: now.toISOString() });
    }
  } else {
    const id = crypto.randomUUID();
    await deps.db.create<ContactRequest>(C.contactRequests, id, {
      id,
      universityId: c.universityId,
      universityName: c.universityName,
      studentId,
      programId: c.programId,
      message: `Solicitud de información desde anuncio: ${c.title}`,
      status: 'ACCEPTED',
      initiatedBy: 'STUDENT',
      createdAt: now.toISOString(),
      respondedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + LEGAL.CONTACT_REQUEST_TTL_DAYS * 86400_000).toISOString(),
    });
  }
  await deps.db.increment(C.adCampaigns, c.id, 'infoRequests', 1);
  await logConsentEvent(deps, { studentId, type: 'CONTACT_ACCEPTED', actor: 'STUDENT', ip, details: { universityId: c.universityId, via: 'AD', campaignId } });
  return { status: 'ACCEPTED' as const, universityName: c.universityName };
}

const suppress = (n: number) => (n >= LEGAL.K_ANONYMITY_MIN ? n : `<${LEGAL.K_ANONYMITY_MIN}`);

export async function campaignStats(deps: Deps, universityId: string, campaignId: string) {
  const c = await deps.db.get<AdCampaign>(C.adCampaigns, campaignId);
  if (!c || c.universityId !== universityId) throw Errors.notFound();
  return {
    id: c.id,
    status: c.status,
    impressions: suppress(c.impressions),
    clicks: suppress(c.clicks),
    infoRequests: suppress(c.infoRequests),
  };
}

export const reviewSchema = z.object({ status: z.enum(['ACTIVE', 'REJECTED', 'PAUSED', 'ENDED']) }).strict();

export async function reviewCampaign(deps: Deps, campaignId: string, status: AdCampaign['status']) {
  const c = await deps.db.get<AdCampaign>(C.adCampaigns, campaignId);
  if (!c) throw Errors.notFound();
  await deps.db.update<AdCampaign>(C.adCampaigns, campaignId, { status });
  return { id: campaignId, status };
}
