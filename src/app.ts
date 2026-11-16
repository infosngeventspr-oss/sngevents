import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import type { Deps } from './deps';
import { errorHandler } from './lib/errors';
import { adsRoutes } from './modules/ads/routes';
import { authRoutes } from './modules/auth/routes';
import { consentRoutes } from './modules/compliance/routes';
import { crmRoutes } from './modules/crm/routes';
import { schoolRoutes } from './modules/schools/routes';
import { studentRoutes } from './modules/students/routes';
import { vocationalRoutes } from './modules/vocational/routes';

export function createApp(deps: Deps): express.Express {
  const app = express();

  // Cloud Functions / Cloud Run están detrás del balanceador de Google: confiar en 1 salto para req.ip.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(
    cors({
      origin: (origin, cb) => {
        // Sin Origin (server-to-server, curl) se permite; con Origin, solo la lista blanca.
        if (!origin || deps.config.corsOrigins.includes(origin)) return cb(null, true);
        cb(null, false);
      },
      methods: ['GET', 'POST', 'PATCH', 'DELETE'],
      allowedHeaders: ['Content-Type', 'Authorization'],
      maxAge: 600,
    }),
  );
  app.use(express.json({ limit: '50kb' }));
  // Las respuestas pueden contener PII: nunca en cachés intermedias.
  app.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  app.get('/v1/health', (_req, res) => {
    res.json({ ok: true });
  });
  app.use('/v1/auth', authRoutes(deps));
  app.use('/v1/consent', consentRoutes(deps));
  app.use('/v1/students', studentRoutes(deps));
  app.use('/v1/vocational', vocationalRoutes(deps));
  app.use('/v1/crm', crmRoutes(deps));
  app.use('/v1/ads', adsRoutes(deps));
  app.use('/v1/schools', schoolRoutes(deps));

  app.use((_req, res) => {
    res.status(404).json({ error: 'NOT_FOUND' });
  });
  app.use(errorHandler);
  return app;
}
