import type { RequestHandler } from 'express';
import jwt from 'jsonwebtoken';
import type { Deps } from '../deps';
import { C } from '../deps';
import { Errors } from '../lib/errors';
import type { Role, UserAccount } from '../types';

export interface AuthClaims {
  sub: string;
  role: Role;
  orgId?: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthClaims;
    }
  }
}

const ISSUER = 'vocacional-crm';
const AUDIENCE = 'vocacional-crm-api';

export function signToken(deps: Deps, user: UserAccount): string {
  return jwt.sign({ role: user.role, orgId: user.orgId }, deps.config.jwtSecret, {
    algorithm: 'HS256',
    subject: user.id,
    issuer: ISSUER,
    audience: AUDIENCE,
    expiresIn: deps.config.jwtTtlSeconds,
  });
}

/**
 * Verifica el JWT y, además, que la cuenta siga existiendo y no esté
 * suspendida/eliminada (revocación inmediata sin esperar a que expire el token).
 */
export function authenticate(deps: Deps): RequestHandler {
  return async (req, _res, next) => {
    try {
      const header = req.headers.authorization;
      if (!header?.startsWith('Bearer ')) throw Errors.unauthorized();
      let payload: jwt.JwtPayload;
      try {
        payload = jwt.verify(header.slice(7), deps.config.jwtSecret, {
          algorithms: ['HS256'],
          issuer: ISSUER,
          audience: AUDIENCE,
        }) as jwt.JwtPayload;
      } catch {
        throw Errors.unauthorized('Token inválido o expirado');
      }
      const user = await deps.db.get<UserAccount>(C.users, String(payload.sub));
      if (!user || user.status === 'SUSPENDED' || user.status === 'DELETED') {
        throw Errors.unauthorized('Cuenta no disponible');
      }
      req.auth = { sub: user.id, role: user.role, orgId: user.orgId };
      next();
    } catch (e) {
      next(e);
    }
  };
}

export function requireRole(...roles: Role[]): RequestHandler {
  return (req, _res, next) => {
    if (!req.auth || !roles.includes(req.auth.role)) return next(Errors.forbidden());
    next();
  };
}

/** Para endpoints de estudiante que requieren el doble opt-in completo. */
export function requireActiveStudent(deps: Deps): RequestHandler {
  return async (req, _res, next) => {
    try {
      const user = await deps.db.get<UserAccount>(C.users, req.auth!.sub);
      if (user?.status !== 'ACTIVE') {
        throw Errors.forbidden('CONSENT_INCOMPLETE', 'La cuenta requiere verificación de correo y/o aprobación del padre o tutor');
      }
      next();
    } catch (e) {
      next(e);
    }
  };
}

export function asyncHandler(fn: RequestHandler): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
