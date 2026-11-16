import type { AppConfig } from './config/env';
import type { Db } from './lib/db';
import type { Mailer } from './lib/mailer';
import { createPseudonymizer, type Pseudonymizer } from './lib/crypto';

/** Dependencias inyectadas (facilita pruebas sin Firestore ni correo real). */
export interface Deps {
  db: Db;
  mailer: Mailer;
  config: AppConfig;
  now: () => Date;
  pseudonymizer: Pseudonymizer;
}

export function buildDeps(input: Omit<Deps, 'pseudonymizer' | 'now'> & { now?: () => Date }): Deps {
  return {
    ...input,
    now: input.now ?? (() => new Date()),
    pseudonymizer: createPseudonymizer(input.config.pseudonymKey),
  };
}

export const C = {
  users: 'users',
  emailIndex: 'emailIndex',
  organizations: 'organizations',
  studentPii: 'studentPii',
  studentProfiles: 'studentProfiles',
  consents: 'consents',
  consentEvents: 'consentEvents',
  consentTokens: 'consentTokens',
  consentTokenUses: 'consentTokenUses',
  contactRequests: 'contactRequests',
  programs: 'programs',
  adCampaigns: 'adCampaigns',
  dataTransfers: 'dataTransfers',
} as const;
