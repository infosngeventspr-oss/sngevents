import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { C, type Deps } from '../../deps';
import { Errors } from '../../lib/errors';
import { validateBody } from '../../lib/validation';
import { asyncHandler, authenticate, requireRole } from '../../middleware/auth';
import type { ConsentRecord, StudentPii, UserAccount } from '../../types';
import { parentDecision, sendParentConsentRequest, sendStudentVerification, verifyStudentEmail } from './consentService';

const tokenSchema = z.string().regex(/^[A-Za-z0-9_-]{20,128}$/, 'Token inválido');

/**
 * Endpoints públicos de verificación. Son POST (no GET) a propósito: los
 * escáneres de enlaces de los proveedores de correo hacen GET automáticos y
 * podrían "aprobar" un consentimiento sin intervención humana.
 */
export function consentRoutes(deps: Deps): Router {
  const r = Router();
  const limiter = rateLimit({ windowMs: 15 * 60_000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false });

  /** POST /v1/consent/verify-email { token } */
  r.post(
    '/verify-email',
    limiter,
    validateBody(z.object({ token: tokenSchema }).strict()),
    asyncHandler(async (req, res) => {
      const status = await verifyStudentEmail(deps, req.body.token, req.ip ?? 'unknown');
      res.json({ status });
    }),
  );

  /** POST /v1/consent/parent — el tutor aprueba o rechaza; puede autorizar (o no) transferencia a terceros. */
  r.post(
    '/parent',
    limiter,
    validateBody(
      z
        .object({
          token: tokenSchema,
          decision: z.enum(['APPROVE', 'DENY']),
          allowThirdPartyTransfer: z.boolean().default(false),
          attestGuardian: z.literal(true, { errorMap: () => ({ message: 'Debe declarar que es el padre, madre o tutor legal' }) }),
        })
        .strict(),
    ),
    asyncHandler(async (req, res) => {
      res.json(
        await parentDecision(deps, {
          token: req.body.token,
          decision: req.body.decision,
          allowThirdPartyTransfer: req.body.allowThirdPartyTransfer,
          ip: req.ip ?? 'unknown',
        }),
      );
    }),
  );

  /** POST /v1/consent/resend — reenvía los correos de verificación pendientes. */
  r.post(
    '/resend',
    limiter,
    authenticate(deps),
    requireRole('STUDENT'),
    asyncHandler(async (req, res) => {
      const id = req.auth!.sub;
      const [user, consent, pii] = await Promise.all([
        deps.db.get<UserAccount>(C.users, id),
        deps.db.get<ConsentRecord>(C.consents, id),
        deps.db.get<StudentPii>(C.studentPii, id),
      ]);
      if (!user || !consent || !pii) throw Errors.notFound();
      const sent: string[] = [];
      if (!consent.studentEmailVerifiedAt) {
        await sendStudentVerification(deps, id, pii.email);
        sent.push('STUDENT_EMAIL');
      }
      if (consent.isMinor && !consent.parentVerifiedAt && pii.parentEmail) {
        await sendParentConsentRequest(deps, id, pii.parentEmail, pii.firstName);
        sent.push('PARENT_CONSENT');
      }
      res.json({ sent });
    }),
  );

  return r;
}
