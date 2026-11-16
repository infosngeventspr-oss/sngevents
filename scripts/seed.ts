/**
 * Crea el primer usuario ADMIN en Firestore (emulador o proyecto real).
 * Uso:
 *   $env:FIRESTORE_EMULATOR_HOST="localhost:8080"   # opcional, para el emulador
 *   $env:ADMIN_EMAIL="admin@tu-dominio.com"; $env:ADMIN_PASSWORD="ClaveSegura123"
 *   npm run seed
 * Requiere las mismas variables de .env.example en el entorno.
 */
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { loadConfig } from '../src/config/env';
import { buildDeps } from '../src/deps';
import { FirestoreDb } from '../src/lib/firestoreDb';
import { ConsoleMailer } from '../src/lib/mailer';
import { createAdmin } from '../src/modules/auth/authService';

async function main() {
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password) throw new Error('Defina ADMIN_EMAIL y ADMIN_PASSWORD');
  initializeApp();
  const deps = buildDeps({ db: new FirestoreDb(getFirestore()), mailer: new ConsoleMailer(true), config: loadConfig() });
  const id = await createAdmin(deps, email.trim().toLowerCase(), password);
  console.log(`ADMIN creado: ${id}`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
