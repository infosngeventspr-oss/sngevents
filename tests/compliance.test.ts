import { LEGAL } from '../src/config/legal';
import type { ConsentEvent, ConsentRecord, StudentPii, UserAccount } from '../src/types';
import { lastToken, setup, studentPayload } from './helpers';

describe('Compliance Engine: registro y doble opt-in', () => {
  it('rechaza menores de 13 años SIN almacenar ningún dato (COPPA)', async () => {
    const ctx = setup();
    const res = await ctx.http().post('/v1/auth/register/student').send(studentPayload({ birthDate: '2015-01-01', parentEmail: 'papa@example.com' }));
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('AGE_BELOW_MINIMUM');
    expect(await ctx.db.find<UserAccount>('users', [])).toHaveLength(0);
    expect(await ctx.db.find<StudentPii>('studentPii', [])).toHaveLength(0);
    expect(ctx.mailer.sent).toHaveLength(0);
  });

  it('exige correo del tutor a menores de edad', async () => {
    const ctx = setup();
    const res = await ctx.http().post('/v1/auth/register/student').send(studentPayload({ birthDate: '2010-05-01' }));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('PARENT_EMAIL_REQUIRED');
  });

  it('exige aceptar la versión vigente de los Términos', async () => {
    const ctx = setup();
    const old = await ctx.http().post('/v1/auth/register/student').send(studentPayload({ tosVersion: '2020-01-01' }));
    expect(old.status).toBe(409);
    const noAccept = await ctx.http().post('/v1/auth/register/student').send(studentPayload({ acceptTerms: false }));
    expect(noAccept.status).toBe(400);
  });

  it('rechaza campos desconocidos (protección contra asignación masiva)', async () => {
    const ctx = setup();
    const res = await ctx.http().post('/v1/auth/register/student').send(studentPayload({ role: 'ADMIN' }));
    expect(res.status).toBe(400);
  });

  it('en Puerto Rico un estudiante de 19 años es menor (mayoría de edad 21)', async () => {
    const ctx = setup();
    const res = await ctx
      .http()
      .post('/v1/auth/register/student')
      .send(studentPayload({ birthDate: '2007-01-01', country: 'PR', region: 'PR-SJ', parentEmail: 'madre@example.com' }));
    expect(res.status).toBe(201);
    expect(res.body.requiresParentalConsent).toBe(true);
  });

  it('flujo completo de menor: PENDING_EMAIL -> PENDING_PARENT -> ACTIVE con metadatos de auditoría', async () => {
    const ctx = setup();
    const body = studentPayload({ birthDate: '2010-05-01', parentEmail: 'tutor@example.com' });
    const reg = await ctx.http().post('/v1/auth/register/student').send(body);
    expect(reg.status).toBe(201);
    expect(reg.body).toMatchObject({ status: 'PENDING_EMAIL', requiresParentalConsent: true });

    const v = await ctx.http().post('/v1/consent/verify-email').send({ token: lastToken(ctx, body.email) });
    expect(v.body.status).toBe('PENDING_PARENT');

    const p = await ctx
      .http()
      .post('/v1/consent/parent')
      .send({ token: lastToken(ctx, 'tutor@example.com'), decision: 'APPROVE', allowThirdPartyTransfer: false, attestGuardian: true });
    expect(p.body.status).toBe('ACTIVE');

    const consent = (await ctx.db.get<ConsentRecord>('consents', reg.body.studentId))!;
    expect(consent.registrationIp).toBeTruthy();
    expect(consent.registeredAt).toBe('2026-11-06T12:00:00.000Z');
    expect(consent.tosVersion).toBe(LEGAL.TOS_VERSION);
    expect(consent.parentEmail).toBe('tutor@example.com');
    expect(consent.parentVerifiedAt).toBeTruthy();
    expect(consent.parentTransferApproval).toBe(false);
    // Privacidad por defecto
    expect(consent.thirdPartyTransferConsent).toBe(false);
    expect(consent.personalizedAdsInternal).toBe(false);

    const events = await ctx.db.find<ConsentEvent>('consentEvents', [['studentId', '==', reg.body.studentId]]);
    expect(events.map((e) => e.type)).toEqual(['REGISTERED', 'STUDENT_EMAIL_VERIFIED', 'PARENT_APPROVED']);
  });

  it('los tokens de verificación son de un solo uso', async () => {
    const ctx = setup();
    const body = studentPayload();
    await ctx.http().post('/v1/auth/register/student').send(body);
    const token = lastToken(ctx, body.email);
    expect((await ctx.http().post('/v1/consent/verify-email').send({ token })).status).toBe(200);
    const again = await ctx.http().post('/v1/consent/verify-email').send({ token });
    expect(again.status).toBe(400);
    expect(again.body.error).toBe('TOKEN_USED');
  });

  it('si el tutor rechaza, se elimina la PII del menor', async () => {
    const ctx = setup();
    const body = studentPayload({ birthDate: '2010-05-01', parentEmail: 'tutor2@example.com' });
    const reg = await ctx.http().post('/v1/auth/register/student').send(body);
    const res = await ctx
      .http()
      .post('/v1/consent/parent')
      .send({ token: lastToken(ctx, 'tutor2@example.com'), decision: 'DENY', attestGuardian: true });
    expect(res.body.status).toBe('DELETED');
    expect(await ctx.db.get('studentPii', reg.body.studentId)).toBeNull();
    const user = await ctx.db.get<UserAccount>('users', reg.body.studentId);
    expect(user?.status).toBe('DELETED');
    expect(user?.email).not.toBe(body.email);
  });

  it('no inicia sesión con credenciales inválidas y no revela si el correo existe', async () => {
    const ctx = setup();
    const a = await ctx.http().post('/v1/auth/login').send({ email: 'noexiste@example.com', password: 'x' });
    expect(a.status).toBe(401);
    expect(a.body.message).toBe('Credenciales inválidas');
  });
});
