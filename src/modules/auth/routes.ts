import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import type { Deps } from '../../deps';
import { validateBody } from '../../lib/validation';
import { asyncHandler, authenticate, requireRole } from '../../middleware/auth';
import { createOrganization, createOrganizationSchema, login, loginSchema, registerStudent, registerStudentSchema } from './authService';

export function authRoutes(deps: Deps): Router {
  const r = Router();
  const authLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false });

  /** POST /v1/auth/register/student — registro + consentimiento inicial + doble opt-in. */
  r.post(
    '/register/student',
    authLimiter,
    validateBody(registerStudentSchema),
    asyncHandler(async (req, res) => {
      const result = await registerStudent(deps, req.body, req.ip ?? 'unknown');
      res.status(201).json(result);
    }),
  );

  /** POST /v1/auth/login */
  r.post(
    '/login',
    authLimiter,
    validateBody(loginSchema),
    asyncHandler(async (req, res) => {
      res.json(await login(deps, req.body.email, req.body.password));
    }),
  );

  /** POST /v1/auth/organizations — alta de escuela/universidad (solo ADMIN). */
  r.post(
    '/organizations',
    authenticate(deps),
    requireRole('ADMIN'),
    validateBody(createOrganizationSchema),
    asyncHandler(async (req, res) => {
      res.status(201).json(await createOrganization(deps, req.body));
    }),
  );

  return r;
}
