/**
 * Servidor LOCAL de demostración (sin Firebase): base de datos en memoria,
 * correos capturados en un buzón visible y datos de ejemplo precargados.
 *   npm run dev  ->  http://localhost:4000
 * NUNCA usar en producción.
 */
import express from 'express';
import path from 'node:path';
import { createApp } from '../src/app';
import type { AppConfig } from '../src/config/env';
import { LEGAL } from '../src/config/legal';
import { buildDeps, C } from '../src/deps';
import { MemoryDb } from '../src/lib/db';
import { MemoryMailer } from '../src/lib/mailer';
import { createAdmin, createOrganization, registerStudent } from '../src/modules/auth/authService';
import { parentDecision, updateConsent, verifyStudentEmail } from '../src/modules/compliance/consentService';
import type { AdCampaign, Program } from '../src/types';

const PORT = Number(process.env.PORT ?? 4000);
// En Vercel se usa la URL pública del proyecto para los enlaces de los correos simulados.
const BASE_URL = process.env.VERCEL_PROJECT_PRODUCTION_URL
  ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
  : `http://localhost:${PORT}`;
const db = new MemoryDb();
const mailer = new MemoryMailer();
const config: AppConfig = {
  jwtSecret: 'dev-only-jwt-secret-'.padEnd(48, 'x'),
  jwtTtlSeconds: 8 * 3600,
  pseudonymKey: Buffer.alloc(32, 9),
  tokenPepper: 'dev-only-pepper-'.padEnd(48, 'y'),
  appBaseUrl: BASE_URL,
  corsOrigins: [BASE_URL],
  isProduction: false,
};
const deps = buildDeps({ db, mailer, config });

const tokenFor = (to: string) => {
  const m = [...mailer.sent].reverse().find((x) => x.to === to);
  return m!.text.match(/token=([A-Za-z0-9_-]+)/)![1];
};

export const DEMO = {
  admin: { email: 'admin@demo.local', password: 'AdminDemo123' },
  university: { email: 'admisiones@uniCaribe.demo', password: 'UniDemo12345' },
  school: { email: 'direccion@colegio.demo', password: 'SchoolDemo123' },
  student: { email: 'ana@demo.local', password: 'Estudiante123' },
  minor: { email: 'luis@demo.local', password: 'Estudiante123', parentEmail: 'tutor.luis@demo.local' },
};

async function seed() {
  await createAdmin(deps, DEMO.admin.email, DEMO.admin.password);
  const uni = await createOrganization(deps, {
    type: 'UNIVERSITY', name: 'Universidad del Caribe (demo)', country: 'PR', region: 'PR-SJ',
    accountEmail: DEMO.university.email, initialPassword: DEMO.university.password,
  });
  const school = await createOrganization(deps, {
    type: 'SCHOOL', name: 'Colegio San Juan (demo)', country: 'PR', region: 'PR-SJ',
    accountEmail: DEMO.school.email, initialPassword: DEMO.school.password,
  });

  const programs: Array<Partial<Program>> = [
    { name: 'Ciencias de Computación', area: 'AREA_TECH', riasec: ['INVESTIGATIVE', 'REALISTIC'], minGpa: 3.0, region: 'PR-SJ', modality: 'ONSITE' },
    { name: 'Ingeniería Civil', area: 'AREA_ENGINEERING', riasec: ['REALISTIC', 'INVESTIGATIVE'], minGpa: 3.2, region: 'PR-MAY', modality: 'ONSITE' },
    { name: 'Enfermería', area: 'AREA_HEALTH', riasec: ['SOCIAL', 'INVESTIGATIVE'], minGpa: 2.8, region: 'PR-SJ', modality: 'HYBRID' },
    { name: 'Administración de Empresas', area: 'AREA_BUSINESS', riasec: ['ENTERPRISING', 'CONVENTIONAL'], minGpa: 2.5, region: 'PR-PO', modality: 'ONLINE' },
    { name: 'Diseño Gráfico', area: 'AREA_ARTS', riasec: ['ARTISTIC'], minGpa: 2.5, region: 'PR-SJ', modality: 'ONSITE' },
    { name: 'Medicina (pre-médica)', area: 'AREA_HEALTH', riasec: ['INVESTIGATIVE'], minGpa: 3.7, region: 'PR-SJ', modality: 'ONSITE' },
  ];
  for (const [i, p] of programs.entries()) {
    const id = `prog_${i + 1}`;
    await db.create<Program>(C.programs, id, {
      id, universityId: uni.orgId, universityName: 'Universidad del Caribe (demo)', country: 'PR', active: true,
      ...(p as Required<Pick<Program, 'name' | 'area' | 'riasec' | 'region' | 'modality'>>), minGpa: p.minGpa,
    });
  }

  const now = Date.now();
  await db.create<AdCampaign>(C.adCampaigns, 'ad_demo_1', {
    id: 'ad_demo_1', universityId: uni.orgId, universityName: 'Universidad del Caribe (demo)',
    title: 'Open House de Ingeniería', body: 'Conoce nuestros laboratorios y becas disponibles.',
    ctaLabel: 'MORE_INFO', programId: 'prog_2', targeting: {}, status: 'ACTIVE',
    startsAt: new Date(now - 86400_000).toISOString(), endsAt: new Date(now + 30 * 86400_000).toISOString(),
    impressions: 0, clicks: 0, infoRequests: 0, createdAt: new Date().toISOString(),
  });

  const base = {
    country: 'PR' as const, region: 'PR-SJ', gradeLevel: 'HS_SENIOR' as const, intendedStartYear: 2027,
    acceptTerms: true as const, acceptPrivacy: true as const, tosVersion: LEGAL.TOS_VERSION,
    allowThirdPartyTransfer: false, profileDiscoverable: true, schoolId: school.orgId,
  };
  // Adulta (PR: mayoría a los 21) — 22 años.
  const students = [
    { ...DEMO.student, firstName: 'Ana', lastName: 'Rivera', birthDate: '2004-03-10', gpa: 3.6, interests: ['AREA_TECH', 'INVESTIGATIVE'] },
    { email: 'carla@demo.local', password: 'Estudiante123', firstName: 'Carla', lastName: 'Ortiz', birthDate: '2003-07-01', gpa: 3.2, interests: ['AREA_HEALTH', 'SOCIAL'] },
    { email: 'diego@demo.local', password: 'Estudiante123', firstName: 'Diego', lastName: 'Santos', birthDate: '2004-01-20', gpa: 3.9, interests: ['AREA_ENGINEERING', 'REALISTIC'] },
    { email: 'elena@demo.local', password: 'Estudiante123', firstName: 'Elena', lastName: 'Cruz', birthDate: '2003-11-11', gpa: 2.9, interests: ['AREA_ARTS', 'ARTISTIC'] },
    { email: 'felix@demo.local', password: 'Estudiante123', firstName: 'Félix', lastName: 'Matos', birthDate: '2004-05-05', gpa: 3.4, interests: ['AREA_BUSINESS', 'ENTERPRISING'] },
    // Menor (17 años) con tutor
    { email: DEMO.minor.email, password: DEMO.minor.password, parentEmail: DEMO.minor.parentEmail, firstName: 'Luis', lastName: 'Pérez', birthDate: '2009-02-14', gpa: 3.5, interests: ['AREA_TECH', 'REALISTIC'] },
  ];
  for (const s of students) {
    const r = await registerStudent(deps, { ...base, ...s } as Parameters<typeof registerStudent>[1], '127.0.0.1');
    await verifyStudentEmail(deps, tokenFor(s.email), '127.0.0.1');
    if ('parentEmail' in s && s.parentEmail) {
      await parentDecision(deps, { token: tokenFor(s.parentEmail), decision: 'APPROVE', allowThirdPartyTransfer: true, ip: '127.0.0.1' });
    }
    await updateConsent(deps, r.studentId, { profileDiscoverable: true }, '127.0.0.1');
  }
}

/** Crea la app de demo con datos precargados. La usan `npm run dev` y la función de Vercel (api/index.ts). */
export async function createDemoApp(): Promise<express.Express> {
  await seed();
  const outer = express();
  outer.use(express.json());
  outer.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'dev-console.html')));
  outer.get('/dev/demo-accounts', (_req, res) => res.json(DEMO));
  outer.get('/dev/mailbox', (_req, res) => res.json([...mailer.sent].reverse().slice(0, 50)));
  outer.get('/dev/stats', async (_req, res) => {
    const [students, orgs, programs, requests] = await Promise.all([
      db.find(C.studentProfiles, []),
      db.find(C.organizations, []),
      db.find(C.programs, []),
      db.find<{ status: string }>(C.contactRequests, []),
    ]);
    res.json({
      students: students.length,
      institutions: orgs.length,
      programs: programs.length,
      pendingRequests: requests.filter((r) => r.status === 'PENDING').length,
    });
  });
  outer.use(createApp(deps));
  return outer;
}

if (require.main === module) {
  createDemoApp()
    .then((app) =>
      app.listen(PORT, '127.0.0.1', () => {
        console.log(`\n  Consola de demo:  http://localhost:${PORT}`);
        console.log(`  API:              http://localhost:${PORT}/v1/health\n`);
      }),
    )
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
