import { academicScore, recommend } from '../src/modules/vocational/engine';
import { createPseudonymizer } from '../src/lib/crypto';
import type { Program } from '../src/types';

const program = (p: Partial<Program>): Program => ({
  id: 'p',
  universityId: 'u',
  universityName: 'U',
  name: 'Programa',
  area: 'AREA_TECH',
  riasec: ['INVESTIGATIVE'],
  country: 'PR',
  region: 'PR-SJ',
  modality: 'ONSITE',
  active: true,
  ...p,
});

describe('Motor vocacional', () => {
  const student = { interests: ['AREA_TECH', 'INVESTIGATIVE'] as const, gpa: 3.4, country: 'PR' as const, region: 'PR-SJ' };

  it('prioriza afinidad de intereses, ajuste académico y cercanía', () => {
    const results = recommend({ ...student, interests: [...student.interests] }, [
      program({ id: 'cs-local', name: 'Ciencias de Computación', minGpa: 3.0 }),
      program({ id: 'cs-far', name: 'Computación (lejos)', region: 'PR-MAY', country: 'PR', minGpa: 3.0 }),
      program({ id: 'law', name: 'Derecho', area: 'AREA_LAW', riasec: ['ENTERPRISING'], minGpa: 3.0 }),
      program({ id: 'med', name: 'Medicina', area: 'AREA_HEALTH', riasec: ['INVESTIGATIVE'], minGpa: 3.6 }),
    ]);
    // cs-local 0.97 · cs-far 0.89 · med 0.55 (RIASEC compatible, "reach") · law 0.47
    expect(results.map((r) => r.programId)).toEqual(['cs-local', 'cs-far', 'med', 'law']);
    expect(results[0].reasons.length).toBeGreaterThan(0);
  });

  it('excluye programas inactivos', () => {
    expect(recommend({ ...student, interests: [] }, [program({ active: false })])).toHaveLength(0);
  });

  it('clasifica el ajuste académico', () => {
    expect(academicScore(3.9, 3.0).fit).toBe('SAFE');
    expect(academicScore(3.1, 3.0).fit).toBe('MATCH');
    expect(academicScore(2.8, 3.0).fit).toBe('REACH');
    expect(academicScore(undefined, 3.0).fit).toBe('MATCH');
  });
});

describe('Seudonimización', () => {
  const p = createPseudonymizer(Buffer.alloc(32, 1));

  it('es determinista por universidad y reversible solo por ella', () => {
    const a1 = p.encode('uniA', 'student-1');
    expect(p.encode('uniA', 'student-1')).toBe(a1);
    expect(p.encode('uniB', 'student-1')).not.toBe(a1);
    expect(p.decode('uniA', a1)).toBe('student-1');
    expect(p.decode('uniB', a1)).toBeNull();
  });

  it('rechaza tokens manipulados', () => {
    const t = p.encode('uniA', 'student-1');
    const tampered = t.slice(0, -2) + (t.endsWith('A') ? 'BB' : 'AA');
    expect(p.decode('uniA', tampered)).toBeNull();
    expect(p.decode('uniA', 'cand_basura')).toBeNull();
  });
});
