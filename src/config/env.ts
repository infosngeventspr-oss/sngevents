export interface AppConfig {
  jwtSecret: string;
  jwtTtlSeconds: number;
  /** Clave maestra (32 bytes) para seudonimizar IDs de estudiantes ante universidades. */
  pseudonymKey: Buffer;
  /** Secreto para HMAC de tokens de verificación e índice de correos. */
  tokenPepper: string;
  appBaseUrl: string;
  corsOrigins: string[];
  isProduction: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const required = (k: string): string => {
    const v = env[k];
    if (!v) throw new Error(`Falta la variable de entorno ${k}`);
    return v;
  };

  const jwtSecret = required('JWT_SECRET');
  if (jwtSecret.length < 32) throw new Error('JWT_SECRET debe tener al menos 32 caracteres');

  const pseudonymKey = Buffer.from(required('PSEUDONYM_KEY'), 'hex');
  if (pseudonymKey.length !== 32) throw new Error('PSEUDONYM_KEY debe ser 32 bytes en hex (64 caracteres)');

  const tokenPepper = required('TOKEN_PEPPER');
  if (tokenPepper.length < 32) throw new Error('TOKEN_PEPPER debe tener al menos 32 caracteres');

  return {
    jwtSecret,
    jwtTtlSeconds: 15 * 60,
    pseudonymKey,
    tokenPepper,
    appBaseUrl: env.APP_BASE_URL ?? 'http://localhost:3000',
    corsOrigins: (env.CORS_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    isProduction: env.NODE_ENV === 'production',
  };
}
