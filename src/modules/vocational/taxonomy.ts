/**
 * Taxonomía CERRADA de intereses. No se aceptan intereses en texto libre: así
 * se evita que el estudiante (o una universidad vía filtros) introduzca datos
 * sensibles (salud, religión, orientación, etnia, etc.) en el sistema.
 */
export const RIASEC = ['REALISTIC', 'INVESTIGATIVE', 'ARTISTIC', 'SOCIAL', 'ENTERPRISING', 'CONVENTIONAL'] as const;

export const AREAS = [
  'AREA_HEALTH',
  'AREA_ENGINEERING',
  'AREA_TECH',
  'AREA_BUSINESS',
  'AREA_ARTS',
  'AREA_EDUCATION',
  'AREA_LAW',
  'AREA_SCIENCE',
  'AREA_SOCIAL_SCIENCES',
  'AREA_AGRO',
  'AREA_COMMUNICATIONS',
  'AREA_TOURISM',
] as const;

export const INTEREST_TAGS = [...RIASEC, ...AREAS] as const;
export type InterestTag = (typeof INTEREST_TAGS)[number];

export const GRADE_LEVELS = ['HS_JUNIOR', 'HS_SENIOR', 'UNDERGRAD', 'TRANSFER'] as const;
export type GradeLevel = (typeof GRADE_LEVELS)[number];

export const isArea = (t: InterestTag) => t.startsWith('AREA_');
