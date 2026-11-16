import type { ContactRequest } from '../src/types';
import { auth, createActiveStudent, createAdminToken, createUniversity, setup, type Ctx } from './helpers';

const baseCampaign = {
  title: 'Estudia Ingeniería',
  body: 'Programas acreditados con becas disponibles.',
  ctaLabel: 'MORE_INFO',
  startsAt: '2026-11-01T00:00:00.000Z',
  endsAt: '2026-12-31T00:00:00.000Z',
};

async function approvedCampaign(ctx: Ctx, uniToken: string, adminToken: string, extra: Record<string, unknown> = {}) {
  const c = await ctx.http().post('/v1/ads/campaigns').set(auth(uniToken)).send({ ...baseCampaign, ...extra });
  expect(c.status).toBe(201);
  await ctx.http().patch(`/v1/ads/campaigns/${c.body.id}/review`).set(auth(adminToken)).send({ status: 'ACTIVE' });
  return c.body.id as string;
}

describe('AdTech interno', () => {
  it('las campañas requieren revisión antes de mostrarse', async () => {
    const ctx = setup();
    const uni = await createUniversity(ctx);
    const s = await createActiveStudent(ctx);
    await ctx.http().post('/v1/ads/campaigns').set(auth(uni.token)).send(baseCampaign);
    const feed = await ctx.http().get('/v1/ads/feed').set(auth(s.token));
    expect(feed.body).toEqual([]);
  });

  it('rechaza enlaces externos en anuncios', async () => {
    const ctx = setup();
    const uni = await createUniversity(ctx);
    const res = await ctx.http().post('/v1/ads/campaigns').set(auth(uni.token)).send({ ...baseCampaign, body: 'Visita https://tracker.example' });
    expect(res.status).toBe(400);
  });

  it('sin consentimiento de personalización solo se muestran anuncios no segmentados', async () => {
    const ctx = setup();
    const uni = await createUniversity(ctx, 'Uni Ads');
    const admin = await createAdminToken(ctx);
    const generic = await approvedCampaign(ctx, uni.token, admin);
    const targeted = await approvedCampaign(ctx, uni.token, admin, { targeting: { interests: ['AREA_TECH'] } });

    const noPerso = await createActiveStudent(ctx, { personalizedAds: false });
    const feed1 = await ctx.http().get('/v1/ads/feed').set(auth(noPerso.token));
    expect(feed1.body.map((a: { id: string }) => a.id)).toEqual([generic]);
    expect(feed1.body[0]).toMatchObject({ sponsored: true, advertiser: 'Uni Ads' });

    const perso = await createActiveStudent(ctx, { personalizedAds: true });
    const feed2 = await ctx.http().get('/v1/ads/feed').set(auth(perso.token));
    expect(feed2.body.map((a: { id: string }) => a.id).sort()).toEqual([generic, targeted].sort());
  });

  it('las métricas son agregadas y se suprimen por debajo de K', async () => {
    const ctx = setup();
    const uni = await createUniversity(ctx);
    const admin = await createAdminToken(ctx);
    const id = await approvedCampaign(ctx, uni.token, admin);
    const s = await createActiveStudent(ctx);
    await ctx.http().get('/v1/ads/feed').set(auth(s.token));
    await ctx.http().post(`/v1/ads/${id}/click`).set(auth(s.token));
    const stats = await ctx.http().get(`/v1/ads/campaigns/${id}/stats`).set(auth(uni.token));
    expect(stats.body).toMatchObject({ impressions: '<5', clicks: '<5' });
    expect(JSON.stringify(stats.body)).not.toContain(s.studentId);
  });

  it('"Solicitar información" exige consentimiento de transferencia y crea un match iniciado por el estudiante', async () => {
    const ctx = setup();
    const uni = await createUniversity(ctx);
    const admin = await createAdminToken(ctx);
    const id = await approvedCampaign(ctx, uni.token, admin);

    const noConsent = await createActiveStudent(ctx, { transfer: false });
    const r1 = await ctx.http().post(`/v1/ads/${id}/request-info`).set(auth(noConsent.token));
    expect(r1.status).toBe(409);

    const withConsent = await createActiveStudent(ctx, { transfer: true });
    const r2 = await ctx.http().post(`/v1/ads/${id}/request-info`).set(auth(withConsent.token));
    expect(r2.body.status).toBe('ACCEPTED');
    const matches = await ctx.db.find<ContactRequest>('contactRequests', [['studentId', '==', withConsent.studentId]]);
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ initiatedBy: 'STUDENT', status: 'ACCEPTED', universityId: uni.orgId });

    const list = await ctx.http().get('/v1/crm/contact-requests').set(auth(uni.token));
    expect(list.body[0].contact.email).toBe(withConsent.email);
  });
});
