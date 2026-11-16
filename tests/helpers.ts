import request from 'supertest';
import { createApp } from '../src/app';
import type { AppConfig } from '../src/config/env';
import { LEGAL } from '../src/config/legal';
import { buildDeps, type Deps } from '../src/deps';
import { MemoryDb } from '../src/lib/db';
import { MemoryMailer } from '../src/lib/mailer';
import { createAdmin, createOrganization } from '../src/modules/auth/authService';

export const NOW = new Date('2026-11-06T12:00:00Z');

export function setup() {
  const db = new MemoryDb();
  const mailer = new MemoryMailer();
  const config: AppConfig = {
    jwtSecret: 'test-jwt-secret-'.padEnd(48, 'x'),
    jwtTtlSeconds: 900,
    pseudonymKey: Buffer.alloc(32, 7),
    tokenPepper: 'test-pepper-'.padEnd(48, 'y'),
    appBaseUrl: 'http://test.local',
    corsOrigins: [],
    isProduction: false,
  };
  const deps: Deps = buildDeps({ db, mailer, config, now: () => NOW });
  const app = createApp(deps);
  return { db, mailer, deps, app, http: () => request(app) };
}
export type Ctx = ReturnType<typeof setup>;

export function lastToken(ctx: Ctx, to: string): string {
  const mail = [...ctx.mailer.sent].reverse().find((m) => m.to === to);
  const match = mail?.text.match(/token=([A-Za-z0-9_-]+)/);
  if (!match) throw new Error(`No hay token enviado a ${to}`);
  return match[1];
}

let counter = 0;
export function studentPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> & { email: string; password: string; firstName: string; lastName: string } {
  counter++;
  return {
    email: `estudiante${counter}@example.com`,
    password: 'Password1234',
    firstName: 'Ana',
    lastName: `Rivera${counter}`,
    birthDate: '2008-01-01', // 18 años en NOW (adulto en US)
    country: 'US',
    region: 'US-FL',
    gradeLevel: 'HS_SENIOR',
    gpa: 3.6,
    interests: ['AREA_TECH', 'INVESTIGATIVE'],
    intendedStartYear: 2027,
    acceptTerms: true,
    acceptPrivacy: true,
    tosVersion: LEGAL.TOS_VERSION,
    ...overrides,
  };
}

export async function login(ctx: Ctx, email: string, password: string): Promise<string> {
  const res = await ctx.http().post('/v1/auth/login').send({ email, password });
  if (res.status !== 200) throw new Error(`login ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.accessToken;
}

/** Registra un estudiante y completa el doble opt-in. */
export async function createActiveStudent(
  ctx: Ctx,
  opts: {
    overrides?: Record<string, unknown>;
    transfer?: boolean;
    discoverable?: boolean;
    parentAllowsTransfer?: boolean;
    personalizedAds?: boolean;
  } = {},
) {
  const body = studentPayload(opts.overrides);
  const reg = await ctx.http().post('/v1/auth/register/student').send(body);
  if (reg.status !== 201) throw new Error(`register ${reg.status} ${JSON.stringify(reg.body)}`);
  await ctx.http().post('/v1/consent/verify-email').send({ token: lastToken(ctx, body.email) });
  if (reg.body.requiresParentalConsent) {
    await ctx
      .http()
      .post('/v1/consent/parent')
      .send({
        token: lastToken(ctx, String(body.parentEmail)),
        decision: 'APPROVE',
        allowThirdPartyTransfer: opts.parentAllowsTransfer ?? true,
        attestGuardian: true,
      });
  }
  const token = await login(ctx, body.email, body.password);
  await ctx
    .http()
    .patch('/v1/students/me/consent')
    .set('Authorization', `Bearer ${token}`)
    .send({
      thirdPartyTransferConsent: opts.transfer ?? false,
      profileDiscoverable: opts.discoverable ?? true,
      personalizedAdsInternal: opts.personalizedAds ?? false,
    });
  return { studentId: reg.body.studentId as string, token, email: body.email, firstName: body.firstName, lastName: body.lastName };
}

export async function createUniversity(ctx: Ctx, name = 'Universidad Demo') {
  const email = `admisiones${++counter}@uni.example.edu`;
  const { orgId } = await createOrganization(ctx.deps, {
    type: 'UNIVERSITY',
    name,
    country: 'US',
    region: 'US-FL',
    accountEmail: email,
    initialPassword: 'UniPassword123',
  });
  return { orgId, token: await login(ctx, email, 'UniPassword123') };
}

export async function createAdminToken(ctx: Ctx) {
  const email = `admin${++counter}@plataforma.example`;
  await createAdmin(ctx.deps, email, 'AdminPassword123');
  return login(ctx, email, 'AdminPassword123');
}

export const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
