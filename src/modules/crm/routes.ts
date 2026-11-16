import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import type { Deps } from '../../deps';
import { Errors } from '../../lib/errors';
import { validateBody } from '../../lib/validation';
import { asyncHandler, authenticate, requireRole } from '../../middleware/auth';
import {
  contactRequestSchema,
  createContactRequest,
  exportContacts,
  listUniversityRequests,
  searchCandidates,
  searchSchema,
  universityInsights,
} from './crmService';

/** Rutas /v1/crm — exclusivas para cuentas UNIVERSITY. */
export function crmRoutes(deps: Deps): Router {
  const r = Router();
  r.use(authenticate(deps), requireRole('UNIVERSITY'));
  const orgId = (req: { auth?: { orgId?: string } }) => {
    if (!req.auth?.orgId) throw Errors.forbidden();
    return req.auth.orgId;
  };
  // Limita el "scraping" de perfiles anonimizados mediante muchas búsquedas.
  const searchLimiter = rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false });

  r.post(
    '/search',
    searchLimiter,
    validateBody(searchSchema),
    asyncHandler(async (req, res) => {
      res.json(await searchCandidates(deps, orgId(req), req.body));
    }),
  );

  r.get(
    '/insights',
    asyncHandler(async (_req, res) => {
      res.json(await universityInsights(deps));
    }),
  );

  r.post(
    '/contact-requests',
    validateBody(contactRequestSchema),
    asyncHandler(async (req, res) => {
      res.status(201).json(await createContactRequest(deps, orgId(req), req.body));
    }),
  );

  r.get(
    '/contact-requests',
    asyncHandler(async (req, res) => {
      res.json(await listUniversityRequests(deps, orgId(req), req.ip));
    }),
  );

  r.get(
    '/contacts/export',
    rateLimit({ windowMs: 60 * 60_000, limit: 10, standardHeaders: 'draft-7', legacyHeaders: false }),
    asyncHandler(async (req, res) => {
      const { csv, rows } = await exportContacts(deps, orgId(req), req.ip);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="contactos-autorizados.csv"');
      res.setHeader('X-Export-Rows', String(rows));
      res.setHeader('Cache-Control', 'no-store');
      res.send(csv);
    }),
  );

  return r;
}
