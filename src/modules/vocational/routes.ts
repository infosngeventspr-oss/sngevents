import { Router } from 'express';
import crypto from 'node:crypto';
import { z } from 'zod';
import { SUPPORTED_JURISDICTIONS } from '../../config/legal';
import { C, type Deps } from '../../deps';
import { Errors } from '../../lib/errors';
import { getQuery, regionCode, safeText, validateBody, validateQuery } from '../../lib/validation';
import { asyncHandler, authenticate, requireRole } from '../../middleware/auth';
import type { Organization, Program, StudentProfile } from '../../types';
import { recommend } from './engine';
import { AREAS, INTEREST_TAGS, RIASEC } from './taxonomy';

const programSchema = z
  .object({
    name: safeText(120),
    area: z.enum(AREAS),
    riasec: z.array(z.enum(RIASEC)).min(1).max(3),
    minGpa: z.number().min(0).max(4).optional(),
    country: z.enum(SUPPORTED_JURISDICTIONS),
    region: regionCode,
    modality: z.enum(['ONSITE', 'ONLINE', 'HYBRID']),
  })
  .strict();

export function vocationalRoutes(deps: Deps): Router {
  const r = Router();
  r.use(authenticate(deps));

  /** GET /v1/vocational/taxonomy — catálogo cerrado de intereses (público para usuarios autenticados). */
  r.get('/taxonomy', (_req, res) => {
    res.json({ interests: INTEREST_TAGS });
  });

  /** GET /v1/vocational/recommendations — recomendaciones para el estudiante autenticado. */
  r.get(
    '/recommendations',
    requireRole('STUDENT'),
    validateQuery(z.object({ limit: z.coerce.number().int().min(1).max(50).default(20) })),
    asyncHandler(async (req, res) => {
      const profile = await deps.db.get<StudentProfile>(C.studentProfiles, req.auth!.sub);
      if (!profile) throw Errors.notFound();
      // MVP: puntuación en memoria sobre el catálogo activo. A escala: precálculo por lotes o motor de búsqueda.
      const programs = await deps.db.find<Program>(C.programs, [['active', '==', true]], { limit: 2000 });
      const { limit } = getQuery<{ limit: number }>(req);
      res.json({ disclaimer: 'Resultados orgánicos; no influenciados por anuncios.', results: recommend(profile, programs, limit) });
    }),
  );

  /** POST /v1/vocational/programs — una universidad publica su oferta académica. */
  r.post(
    '/programs',
    requireRole('UNIVERSITY'),
    validateBody(programSchema),
    asyncHandler(async (req, res) => {
      const org = await deps.db.get<Organization>(C.organizations, req.auth!.orgId ?? '');
      if (!org) throw Errors.forbidden();
      const id = crypto.randomUUID();
      const program: Program = { id, universityId: org.id, universityName: org.name, active: true, ...req.body };
      await deps.db.create<Program>(C.programs, id, program);
      res.status(201).json(program);
    }),
  );

  return r;
}
