import { auth, createActiveStudent, createUniversity, setup, type Ctx } from './helpers';

async function populate(ctx: Ctx, n: number, opts: Parameters<typeof createActiveStudent>[1] = {}) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(await createActiveStudent(ctx, opts));
  return out;
}

describe('CRM B2B: Consent-based Matching', () => {
  it('suprime resultados cuando hay menos de K perfiles (k-anonimato)', async () => {
    const ctx = setup();
    await populate(ctx, 3);
    const uni = await createUniversity(ctx);
    const res = await ctx.http().post('/v1/crm/search').set(auth(uni.token)).send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ total: null, suppressed: true, results: [] });
  });

  it('devuelve perfiles ANONIMIZADOS, sin PII', async () => {
    const ctx = setup();
    const students = await populate(ctx, 5);
    const uni = await createUniversity(ctx);
    const res = await ctx.http().post('/v1/crm/search').set(auth(uni.token)).send({ interests: ['AREA_TECH'] });
    expect(res.body.total).toBe(5);
    const raw = JSON.stringify(res.body);
    for (const s of students) {
      expect(raw).not.toContain(s.email);
      expect(raw).not.toContain(s.lastName);
      expect(raw).not.toContain(s.studentId);
    }
    expect(raw).not.toContain('birthDate');
    expect(res.body.results[0]).toMatchObject({ gpaBand: '3.5-4.0', audience: 'ADULT' });
    expect(res.body.results[0].candidateId).toMatch(/^cand_/);
  });

  it('no incluye perfiles que no optaron por ser descubribles', async () => {
    const ctx = setup();
    await populate(ctx, 5, { discoverable: false });
    const uni = await createUniversity(ctx);
    const res = await ctx.http().post('/v1/crm/search').set(auth(uni.token)).send({});
    expect(res.body.suppressed).toBe(true);
  });

  it('un candidateId emitido a la Universidad A no sirve a la Universidad B', async () => {
    const ctx = setup();
    await populate(ctx, 5);
    const a = await createUniversity(ctx, 'A');
    const b = await createUniversity(ctx, 'B');
    const search = await ctx.http().post('/v1/crm/search').set(auth(a.token)).send({});
    const candidateId = search.body.results[0].candidateId;
    const res = await ctx.http().post('/v1/crm/contact-requests').set(auth(b.token)).send({ candidateId, message: 'Hola' });
    expect(res.status).toBe(404);
  });

  it('estudiantes no pueden usar el CRM', async () => {
    const ctx = setup();
    const s = await createActiveStudent(ctx);
    const res = await ctx.http().post('/v1/crm/search').set(auth(s.token)).send({});
    expect(res.status).toBe(403);
  });

  it('flujo completo: solicitud -> aceptación -> contacto visible -> revocación', async () => {
    const ctx = setup();
    const students = await populate(ctx, 5);
    const target = students[0];
    const uni = await createUniversity(ctx, 'Universidad del Caribe');

    const search = await ctx.http().post('/v1/crm/search').set(auth(uni.token)).send({ pageSize: 50 });
    const candidateId = ctx.deps.pseudonymizer.encode(uni.orgId, target.studentId);
    expect(search.body.results.map((r: { candidateId: string }) => r.candidateId)).toContain(candidateId);

    const cr = await ctx.http().post('/v1/crm/contact-requests').set(auth(uni.token)).send({ candidateId, message: 'Te invitamos a conocer Ingeniería' });
    expect(cr.status).toBe(201);

    // Pendiente: la universidad no ve contacto.
    let list = await ctx.http().get('/v1/crm/contact-requests').set(auth(uni.token));
    expect(list.body[0].contact).toBeUndefined();

    // Sin flag de transferencia el estudiante no puede aceptar.
    const tryAccept = await ctx.http().post(`/v1/students/me/contact-requests/${cr.body.id}/respond`).set(auth(target.token)).send({ decision: 'ACCEPT' });
    expect(tryAccept.status).toBe(409);
    expect(tryAccept.body.error).toBe('NO_TRANSFER_CONSENT');

    await ctx.http().patch('/v1/students/me/consent').set(auth(target.token)).send({ thirdPartyTransferConsent: true });
    const accept = await ctx.http().post(`/v1/students/me/contact-requests/${cr.body.id}/respond`).set(auth(target.token)).send({ decision: 'ACCEPT' });
    expect(accept.body.status).toBe('ACCEPTED');

    list = await ctx.http().get('/v1/crm/contact-requests').set(auth(uni.token));
    expect(list.body[0].contact).toMatchObject({ email: target.email, firstName: 'Ana' });

    const exp = await ctx.http().get('/v1/crm/contacts/export').set(auth(uni.token));
    expect(exp.status).toBe(200);
    expect(exp.headers['x-export-rows']).toBe('1');
    expect(exp.text).toContain(target.email);

    // Solo ese estudiante: los otros 4 nunca aparecen en la exportación.
    for (const s of students.slice(1)) expect(exp.text).not.toContain(s.email);

    // Revocar el consentimiento de transferencia anula el match y bloquea la exportación.
    await ctx.http().patch('/v1/students/me/consent').set(auth(target.token)).send({ thirdPartyTransferConsent: false });
    const exp2 = await ctx.http().get('/v1/crm/contacts/export').set(auth(uni.token));
    expect(exp2.headers['x-export-rows']).toBe('0');
    expect(exp2.text).not.toContain(target.email);
    list = await ctx.http().get('/v1/crm/contact-requests').set(auth(uni.token));
    expect(list.body[0]).toMatchObject({ status: 'REVOKED', deletionRequired: true });
    expect(list.body[0].contact).toBeUndefined();

    // Tras revocar, la universidad no puede insistir.
    const again = await ctx.http().post('/v1/crm/contact-requests').set(auth(uni.token)).send({ candidateId, message: 'Otra vez' });
    expect(again.status).toBe(409);
  });

  it('un menor con transferencia activa pero sin autorización del tutor no puede aceptar', async () => {
    const ctx = setup();
    const minors = await populate(ctx, 5, {
      overrides: { birthDate: '2010-05-01', parentEmail: 'tutor@example.com' },
      transfer: true,
      parentAllowsTransfer: false,
    });
    const uni = await createUniversity(ctx);
    const candidateId = ctx.deps.pseudonymizer.encode(uni.orgId, minors[0].studentId);
    const cr = await ctx.http().post('/v1/crm/contact-requests').set(auth(uni.token)).send({ candidateId, message: 'Hola' });
    const res = await ctx.http().post(`/v1/students/me/contact-requests/${cr.body.id}/respond`).set(auth(minors[0].token)).send({ decision: 'ACCEPT' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('PARENT_APPROVAL_MISSING');
  });

  it('escapa celdas CSV para prevenir inyección de fórmulas', async () => {
    const { csvCell } = await import('../src/modules/crm/crmService');
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('Ana')).toBe('"Ana"');
  });
});
