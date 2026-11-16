/**
 * Función de Vercel: sirve la consola de DEMO (base de datos en memoria y datos de ejemplo).
 * Los datos se reinician cada vez que Vercel arranca una instancia nueva.
 * No es el backend de producción (ese se despliega en Firebase Functions: src/index.ts).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createDemoApp } from '../scripts/dev-server';

const appPromise = createDemoApp();

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  const app = await appPromise;
  app(req as Parameters<typeof app>[0], res as Parameters<typeof app>[1]);
}
