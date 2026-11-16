/**
 * MOTOR DE ORIENTACIÓN VOCACIONAL
 * Puntuación determinista y explicable (el estudiante ve POR QUÉ se le recomienda algo).
 *
 *   score = 0.5 * afinidad de intereses + 0.3 * ajuste académico + 0.2 * cercanía geográfica
 *
 * Principio de integridad: las recomendaciones son ORGÁNICAS. La inversión
 * publicitaria de una universidad nunca altera este ranking (la pauta vive en
 * el módulo de anuncios, separada y etiquetada como "Patrocinado").
 */
import type { Program, StudentProfile } from '../../types';
import { isArea, type InterestTag } from './taxonomy';

export const WEIGHTS = Object.freeze({ interest: 0.5, academic: 0.3, geo: 0.2 });

export interface Recommendation {
  programId: string;
  programName: string;
  universityId: string;
  universityName: string;
  modality: Program['modality'];
  score: number;
  fit: 'SAFE' | 'MATCH' | 'REACH';
  reasons: string[];
}

type ScoringProfile = Pick<StudentProfile, 'interests' | 'gpa' | 'country' | 'region'>;

export function interestScore(interests: InterestTag[], program: Program): { score: number; reasons: string[] } {
  if (interests.length === 0) return { score: 0.5, reasons: [] };
  const set = new Set(interests);
  const reasons: string[] = [];
  const studentAreas = interests.filter(isArea);
  const studentRiasec = interests.filter((t) => !isArea(t));

  let areaPart = studentAreas.length === 0 ? 0.5 : 0;
  if (set.has(program.area)) {
    areaPart = 1;
    reasons.push(`Coincide con tu área de interés (${program.area})`);
  }

  let riasecPart = 0.5;
  if (studentRiasec.length > 0 && program.riasec.length > 0) {
    const overlap = program.riasec.filter((t) => set.has(t));
    riasecPart = overlap.length / program.riasec.length;
    if (overlap.length > 0) reasons.push(`Perfil de intereses compatible: ${overlap.join(', ')}`);
  }
  return { score: 0.6 * areaPart + 0.4 * riasecPart, reasons };
}

export function academicScore(gpa: number | undefined, minGpa: number | undefined): { score: number; fit: Recommendation['fit']; reason?: string } {
  if (gpa === undefined || minGpa === undefined) return { score: 0.7, fit: 'MATCH' };
  if (gpa >= minGpa + 0.5) return { score: 1, fit: 'SAFE', reason: 'Tu promedio supera ampliamente el requisito' };
  if (gpa >= minGpa) return { score: 0.9, fit: 'MATCH', reason: 'Tu promedio cumple el requisito' };
  if (gpa >= minGpa - 0.3) return { score: 0.5, fit: 'REACH', reason: 'Tu promedio está cerca del requisito' };
  return { score: 0.1, fit: 'REACH' };
}

export function geoScore(student: Pick<StudentProfile, 'country' | 'region'>, program: Program): { score: number; reason?: string } {
  if (program.modality === 'ONLINE') return { score: 0.9, reason: 'Modalidad en línea' };
  if (program.region === student.region) return { score: 1, reason: 'Cerca de tu zona' };
  if (program.country === student.country) return { score: 0.6 };
  return { score: 0.2 };
}

export function recommend(profile: ScoringProfile, programs: Program[], limit = 20): Recommendation[] {
  return programs
    .filter((p) => p.active)
    .map((p) => {
      const i = interestScore(profile.interests, p);
      const a = academicScore(profile.gpa, p.minGpa);
      const g = geoScore(profile, p);
      const score = WEIGHTS.interest * i.score + WEIGHTS.academic * a.score + WEIGHTS.geo * g.score;
      return {
        programId: p.id,
        programName: p.name,
        universityId: p.universityId,
        universityName: p.universityName,
        modality: p.modality,
        score: Math.round(score * 1000) / 1000,
        fit: a.fit,
        reasons: [...i.reasons, a.reason, g.reason].filter((x): x is string => Boolean(x)),
      };
    })
    .sort((x, y) => y.score - x.score || x.programName.localeCompare(y.programName))
    .slice(0, limit);
}
