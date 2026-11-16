/**
 * Punto de entrada de Cloud Functions (2ª gen).
 * Expone toda la API como una sola función HTTPS `api` y una tarea programada
 * que expira solicitudes de contacto sin respuesta.
 */
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { setGlobalOptions } from 'firebase-functions/v2';
import { onRequest } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { defineSecret } from 'firebase-functions/params';
import { createApp } from './app';
import { loadConfig } from './config/env';
import { buildDeps, C, type Deps } from './deps';
import { FirestoreDb } from './lib/firestoreDb';
import { ConsoleMailer } from './lib/mailer';
import type { ContactRequest } from './types';

initializeApp();
// Región: elegir la más cercana a los usuarios y compatible con requisitos de residencia de datos.
setGlobalOptions({ region: 'us-east1', maxInstances: 20 });

const JWT_SECRET = defineSecret('JWT_SECRET');
const PSEUDONYM_KEY = defineSecret('PSEUDONYM_KEY');
const TOKEN_PEPPER = defineSecret('TOKEN_PEPPER');
const secrets = [JWT_SECRET, PSEUDONYM_KEY, TOKEN_PEPPER];

let cached: Deps | undefined;
function deps(): Deps {
  if (!cached) {
    const config = loadConfig(process.env);
    cached = buildDeps({
      db: new FirestoreDb(getFirestore()),
      // TODO: reemplazar por proveedor transaccional real antes de producción.
      mailer: new ConsoleMailer(!config.isProduction),
      config,
    });
  }
  return cached;
}

let app: ReturnType<typeof createApp> | undefined;
export const api = onRequest({ secrets, cors: false }, (req, res) => {
  app ??= createApp(deps());
  app(req, res);
});

/** Expira diariamente las solicitudes PENDING vencidas. */
export const expireContactRequests = onSchedule({ schedule: 'every day 03:00', secrets }, async () => {
  const d = deps();
  const nowIso = d.now().toISOString();
  const pending = await d.db.find<ContactRequest>(C.contactRequests, [['status', '==', 'PENDING']], { limit: 5000 });
  for (const r of pending.filter((p) => p.expiresAt < nowIso)) {
    await d.db.update<ContactRequest>(C.contactRequests, r.id, { status: 'EXPIRED' });
  }
});
