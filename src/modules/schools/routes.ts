import { Router } from 'express';
import { C, type Deps } from '../../deps';
import { Errors } from '../../lib/errors';
import { asyncHandler, authenticate, requireRole } from '../../middleware/auth';
import type { StudentProfile } from '../../types';
import { aggregateInsights } from '../crm/crmService';

/**
 * Rutas /v1/schools — Institución Educativa / Colegio.
 * La escuela SOLO ve agregados k-anónimos de sus estudiantes (participación,
 * intereses, regiones). Nunca registros individuales: la plataforma no actúa
 * como canal de divulgación de expedientes educativos (FERPA) ni al revés.
 */
export function schoolRoutes(deps: Deps): Router {
  const r = Router();
  r.use(authenticate(deps), requireRole('SCHOOL'));

  r.get(
    '/me/insights',
    asyncHandler(async (req, res) => {
      const schoolId = req.auth!.orgId;
      if (!schoolId) throw Errors.forbidden();
      const profiles = await deps.db.find<StudentProfile>(C.studentProfiles, [
        ['schoolId', '==', schoolId],
        ['status', '==', 'ACTIVE'],
      ]);
      res.json(await aggregateInsights(profiles));
    }),
  );

  return r;
}
