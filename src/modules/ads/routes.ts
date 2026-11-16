import { Router } from 'express';
import type { Deps } from '../../deps';
import { Errors } from '../../lib/errors';
import { paramId, validateBody } from '../../lib/validation';
import { asyncHandler, authenticate, requireActiveStudent, requireRole } from '../../middleware/auth';
import { campaignSchema, campaignStats, createCampaign, getFeed, registerClick, requestInfo, reviewCampaign, reviewSchema } from './adsService';

export function adsRoutes(deps: Deps): Router {
  const r = Router();
  r.use(authenticate(deps));

  // ---- Estudiante ----
  r.get(
    '/feed',
    requireRole('STUDENT'),
    requireActiveStudent(deps),
    asyncHandler(async (req, res) => {
      res.json(await getFeed(deps, req.auth!.sub));
    }),
  );

  r.post(
    '/:id/click',
    requireRole('STUDENT'),
    asyncHandler(async (req, res) => {
      res.json(await registerClick(deps, paramId(req.params.id)));
    }),
  );

  r.post(
    '/:id/request-info',
    requireRole('STUDENT'),
    requireActiveStudent(deps),
    asyncHandler(async (req, res) => {
      res.json(await requestInfo(deps, req.auth!.sub, paramId(req.params.id), req.ip));
    }),
  );

  // ---- Universidad ----
  r.post(
    '/campaigns',
    requireRole('UNIVERSITY'),
    validateBody(campaignSchema),
    asyncHandler(async (req, res) => {
      if (!req.auth!.orgId) throw Errors.forbidden();
      res.status(201).json(await createCampaign(deps, req.auth!.orgId, req.body));
    }),
  );

  r.get(
    '/campaigns/:id/stats',
    requireRole('UNIVERSITY'),
    asyncHandler(async (req, res) => {
      res.json(await campaignStats(deps, req.auth!.orgId ?? '', paramId(req.params.id)));
    }),
  );

  // ---- Admin: revisión editorial obligatoria ----
  r.patch(
    '/campaigns/:id/review',
    requireRole('ADMIN'),
    validateBody(reviewSchema),
    asyncHandler(async (req, res) => {
      res.json(await reviewCampaign(deps, paramId(req.params.id), req.body.status));
    }),
  );

  return r;
}
