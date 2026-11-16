import { Router } from 'express';
import { z } from 'zod';
import { C, type Deps } from '../../deps';
import { Errors } from '../../lib/errors';
import { paramId, regionCode, validateBody } from '../../lib/validation';
import { asyncHandler, authenticate, requireActiveStudent, requireRole } from '../../middleware/auth';
import type { ConsentRecord, ContactRequest, StudentProfile } from '../../types';
import { eraseStudent, exportOwnData, logConsentEvent, updateConsent } from '../compliance/consentService';
import { evaluateStudentTransferConsent } from '../compliance/privacyGuard';
import { GRADE_LEVELS, INTEREST_TAGS } from '../vocational/taxonomy';

const consentPatchSchema = z
  .object({
    thirdPartyTransferConsent: z.boolean().optional(),
    profileDiscoverable: z.boolean().optional(),
    personalizedAdsInternal: z.boolean().optional(),
    acceptTosVersion: z.string().max(32).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Debe enviar al menos un campo');

const profilePatchSchema = z
  .object({
    region: regionCode.optional(),
    gradeLevel: z.enum(GRADE_LEVELS).optional(),
    gpa: z.number().min(0).max(4).optional(),
    interests: z.array(z.enum(INTEREST_TAGS)).max(10).optional(),
    intendedStartYear: z.number().int().min(2024).max(2040).optional(),
  })
  .strict();

/** Rutas /v1/students/me — el estudiante gestiona su perfil, consentimiento y matches. */
export function studentRoutes(deps: Deps): Router {
  const r = Router();
  r.use(authenticate(deps), requireRole('STUDENT'));

  r.get(
    '/me/consent',
    asyncHandler(async (req, res) => {
      res.json(await deps.db.get<ConsentRecord>(C.consents, req.auth!.sub));
    }),
  );

  r.patch(
    '/me/consent',
    validateBody(consentPatchSchema),
    asyncHandler(async (req, res) => {
      res.json(await updateConsent(deps, req.auth!.sub, req.body, req.ip ?? 'unknown'));
    }),
  );

  r.patch(
    '/me/profile',
    validateBody(profilePatchSchema),
    asyncHandler(async (req, res) => {
      const id = req.auth!.sub;
      const profile = await deps.db.get<StudentProfile>(C.studentProfiles, id);
      if (!profile) throw Errors.notFound();
      if (req.body.region && !req.body.region.startsWith(`${profile.country}-`)) {
        throw Errors.badRequest('REGION_COUNTRY_MISMATCH', 'La región no corresponde al país');
      }
      const patch = { ...req.body, updatedAt: deps.now().toISOString() };
      if (patch.interests) patch.interests = [...new Set(patch.interests)];
      await deps.db.update<StudentProfile>(C.studentProfiles, id, patch);
      res.json(await deps.db.get<StudentProfile>(C.studentProfiles, id));
    }),
  );

  /** Derecho de acceso / portabilidad: todos mis datos y el historial de consentimiento. */
  r.get(
    '/me/data',
    asyncHandler(async (req, res) => {
      res.json(await exportOwnData(deps, req.auth!.sub));
    }),
  );

  /** Derecho de supresión. Requiere confirmación explícita. */
  r.delete(
    '/me',
    validateBody(z.object({ confirm: z.literal('ELIMINAR MI CUENTA') }).strict()),
    asyncHandler(async (req, res) => {
      await eraseStudent(deps, req.auth!.sub, 'STUDENT', req.ip);
      res.status(204).end();
    }),
  );

  /** Solicitudes de contacto recibidas (el estudiante ve el nombre de la universidad; la universidad no lo ve a él). */
  r.get(
    '/me/contact-requests',
    asyncHandler(async (req, res) => {
      const list = await deps.db.find<ContactRequest>(C.contactRequests, [['studentId', '==', req.auth!.sub]], {
        orderBy: { field: 'createdAt', direction: 'desc' },
        limit: 200,
      });
      res.json(
        list.map((c) => ({
          id: c.id,
          universityId: c.universityId,
          universityName: c.universityName,
          programId: c.programId,
          message: c.message,
          status: c.status,
          initiatedBy: c.initiatedBy,
          createdAt: c.createdAt,
          expiresAt: c.expiresAt,
        })),
      );
    }),
  );

  /** El "Match": aceptar comparte los datos de contacto SOLO con esa universidad. */
  r.post(
    '/me/contact-requests/:id/respond',
    requireActiveStudent(deps),
    validateBody(z.object({ decision: z.enum(['ACCEPT', 'DECLINE']) }).strict()),
    asyncHandler(async (req, res) => {
      const studentId = req.auth!.sub;
      const id = paramId(req.params.id);
      const cr = await deps.db.get<ContactRequest>(C.contactRequests, id);
      if (!cr || cr.studentId !== studentId) throw Errors.notFound();
      if (cr.status !== 'PENDING') throw Errors.conflict('NOT_PENDING', 'La solicitud ya fue respondida');
      if (new Date(cr.expiresAt) < deps.now()) {
        await deps.db.update<ContactRequest>(C.contactRequests, id, { status: 'EXPIRED' });
        throw Errors.conflict('EXPIRED', 'La solicitud expiró');
      }

      if (req.body.decision === 'ACCEPT') {
        const [profile, consent] = await Promise.all([
          deps.db.get<StudentProfile>(C.studentProfiles, studentId),
          deps.db.get<ConsentRecord>(C.consents, studentId),
        ]);
        const check = evaluateStudentTransferConsent(profile, consent);
        if (!check.allowed) {
          throw Errors.conflict(
            check.reason,
            check.reason === 'PARENT_APPROVAL_MISSING'
              ? 'Tu padre, madre o tutor debe autorizar compartir tus datos con universidades'
              : 'Primero debes activar el consentimiento de transferencia de datos a terceros',
          );
        }
      }

      const status = req.body.decision === 'ACCEPT' ? 'ACCEPTED' : 'DECLINED';
      await deps.db.update<ContactRequest>(C.contactRequests, id, { status, respondedAt: deps.now().toISOString() });
      await logConsentEvent(deps, {
        studentId,
        type: status === 'ACCEPTED' ? 'CONTACT_ACCEPTED' : 'CONTACT_DECLINED',
        actor: 'STUDENT',
        ip: req.ip,
        details: { universityId: cr.universityId, contactRequestId: id },
      });
      res.json({ id, status });
    }),
  );

  /** Revocar un match específico (la universidad deja de ver los datos y se le notifica que debe eliminarlos). */
  r.post(
    '/me/contact-requests/:id/revoke',
    asyncHandler(async (req, res) => {
      const studentId = req.auth!.sub;
      const id = paramId(req.params.id);
      const cr = await deps.db.get<ContactRequest>(C.contactRequests, id);
      if (!cr || cr.studentId !== studentId) throw Errors.notFound();
      if (cr.status !== 'ACCEPTED' && cr.status !== 'PENDING') throw Errors.conflict('NOT_REVOCABLE', 'La solicitud no está activa');
      await deps.db.update<ContactRequest>(C.contactRequests, id, { status: 'REVOKED', revokedAt: deps.now().toISOString() });
      await logConsentEvent(deps, { studentId, type: 'CONTACT_REVOKED', actor: 'STUDENT', ip: req.ip, details: { universityId: cr.universityId } });
      res.json({ id, status: 'REVOKED' });
    }),
  );

  return r;
}
