/**
 * MARCO LEGAL Y DE PRIVACIDAD (HARDCODED)
 * ---------------------------------------
 * Estas constantes son la "fuente de verdad" del Compliance Engine. Están
 * congeladas (Object.freeze) y NO se leen de variables de entorno ni de la base
 * de datos a propósito: cambiar una política de privacidad exige un cambio de
 * código revisado (code review + revisión legal) y un nuevo despliegue.
 *
 * Referencias (resumen, NO es asesoría legal; validar con abogado local):
 *  - COPPA (EE.UU./Puerto Rico): prohíbe recolectar datos de < 13 años sin
 *    consentimiento parental verificable. Política de la plataforma: NO se
 *    aceptan registros de < 13 años (no se almacena ningún dato).
 *  - FERPA (EE.UU./PR): regula los expedientes académicos en poder de escuelas.
 *    La plataforma solo usa datos autodeclarados por el estudiante; las
 *    escuelas solo ven agregados (nunca registros individuales).
 *  - GDPR art. 8 (UE): edad de consentimiento digital 13–16 según país.
 *  - LGPD art. 14 (Brasil), Ley 1581/2012 (Colombia), LFPDPPP (México),
 *    Ley 25.326 (Argentina), Ley 19.628/21.719 (Chile), Ley 29733 (Perú):
 *    tratamiento de datos de menores requiere autorización de representante.
 *
 * Política unificada (más estricta que el mínimo legal): TODO estudiante menor
 * de la mayoría de edad de su jurisdicción requiere doble opt-in (verificación
 * del correo del estudiante + aprobación verificada del padre/tutor legal).
 */

export const SUPPORTED_JURISDICTIONS = [
  'PR', 'US', 'MX', 'CO', 'AR', 'CL', 'PE', 'BR', 'DO', 'EC', 'UY', 'CR', 'PA', 'GT', 'SV', 'HN', 'PY', 'BO', 'VE', 'ES',
] as const;
export type Jurisdiction = (typeof SUPPORTED_JURISDICTIONS)[number];

export const LEGAL = Object.freeze({
  /** Versión vigente de Términos y Condiciones. Cambiarla bloquea transferencias hasta re-aceptación. */
  TOS_VERSION: '2026-11-01',
  /** Versión vigente del Aviso de Privacidad. */
  PRIVACY_VERSION: '2026-11-01',

  /** COPPA: por debajo de esta edad el registro se rechaza y no se guarda nada. */
  MIN_REGISTRATION_AGE: 13,

  /** Mayoría de edad por jurisdicción (por debajo => doble opt-in parental). */
  AGE_OF_MAJORITY: Object.freeze<Record<Jurisdiction, number>>({
    PR: 21, // Puerto Rico: mayoría de edad a los 21 años.
    US: 18, MX: 18, CO: 18, AR: 18, CL: 18, PE: 18, BR: 18, DO: 18, EC: 18,
    UY: 18, CR: 18, PA: 18, GT: 18, SV: 18, HN: 18, PY: 18, BO: 18, VE: 18, ES: 18,
  }),

  /** Vigencia de enlaces de verificación (estudiante/padre). */
  CONSENT_TOKEN_TTL_HOURS: 72,

  /** k-anonimato: no se muestran resultados ni métricas con menos de K personas. */
  K_ANONYMITY_MIN: 5,

  /** Límite de filas por exportación (aun con consentimiento). */
  MAX_EXPORT_ROWS: 500,

  /** Anti-spam: solicitudes de contacto por universidad por día. */
  MAX_CONTACT_REQUESTS_PER_DAY: 200,

  /** Vigencia de una solicitud de contacto sin respuesta. */
  CONTACT_REQUEST_TTL_DAYS: 30,
});

export function ageOfMajority(j: Jurisdiction): number {
  return LEGAL.AGE_OF_MAJORITY[j];
}
