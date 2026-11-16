# Backend: CRM de orientación vocacional basado en consentimiento

Backend serverless en **Firebase Cloud Functions (2.ª gen) + Firestore + Express + TypeScript**.

> ⚠️ Este código implementa controles técnicos de privacidad, pero **no sustituye la asesoría legal**.
> Antes de producción, un abogado de cada jurisdicción debe validar `src/config/legal.ts`, los textos de
> consentimiento y la política de retención.

## Arquitectura

```
src/
├─ index.ts                  Cloud Functions: `api` (HTTPS) + `expireContactRequests` (cron)
├─ app.ts                    Express: helmet, CORS con lista blanca, JSON 50kb, no-store
├─ config/legal.ts           ⚖️ Marco legal HARDCODED (edades, versiones T&C, k-anonimato, límites)
├─ config/env.ts             Secretos (JWT, clave de seudónimos, pepper)
├─ lib/                      db (Firestore/memoria), crypto, errores, validación, mailer
├─ middleware/auth.ts        JWT + rol + verificación de cuenta activa
└─ modules/
   ├─ auth/                  Registro estudiante, login, alta de instituciones (ADMIN)
   ├─ compliance/            🛡️ Compliance Engine + Privacy Guard
   ├─ students/              Perfil, consentimiento, matches, acceso y supresión de datos
   ├─ vocational/            Motor de recomendación explicable + catálogo de programas
   ├─ crm/                   Búsqueda anonimizada, solicitudes de contacto, exportación
   ├─ ads/                   Pauta nativa interna con revisión editorial
   └─ schools/               Agregados k-anónimos para colegios
```

### Separación de datos en Firestore

| Colección | Contenido | ¿Quién la lee? |
|---|---|---|
| `studentPii` | Nombre, correo, fecha de nacimiento, correo del tutor | **Solo** el Privacy Guard y el propio estudiante |
| `studentProfiles` | Región, nivel, GPA, intereses (taxonomía cerrada) | Motor vocacional, búsqueda anonimizada, anuncios |
| `consents` | Estado vigente + auditoría (IP, timestamp, versión T&C, tutor) | Compliance Engine |
| `consentEvents` | Bitácora append-only de cada cambio | Auditoría / derecho de acceso |
| `contactRequests` | El "Match" universidad↔estudiante | CRM + estudiante |
| `dataTransfers` | Registro de cada liberación de PII a un tercero | Auditoría |

`firestore.rules` niega todo acceso directo de clientes: todo pasa por las Functions.

## Controles de privacidad implementados

1. **COPPA**: registro de menores de 13 años rechazado sin persistir nada.
2. **Doble opt-in**: verificación de correo del estudiante + aprobación del tutor (todo menor de la
   mayoría de edad de su país; PR = 21). Si el tutor rechaza, se borra la PII.
3. **Auditoría por registro**: IP, timestamp, versión de T&C/Privacidad, correo del tutor, IP y fecha de
   la aprobación parental. Bitácora append-only.
4. **Privacidad por defecto**: transferencia a terceros, visibilidad y anuncios personalizados en `false`.
   Consentimientos separados (no agrupados con los T&C).
5. **Anonimización**: las universidades ven perfiles sin nombre, correo, fecha de nacimiento ni escuela,
   GPA en rangos, y un `candidateId` cifrado (AES-256-GCM) **distinto por universidad**.
6. **k-anonimato** (K=5): búsquedas y métricas con menos de 5 personas se suprimen.
7. **Privacy Guard**: la PII solo sale con match `ACCEPTED` + `thirdPartyTransferConsent === true`
   (comparación estricta) + T&C vigentes + aprobación del tutor para menores. Exportación limitada,
   auditada y protegida contra inyección de fórmulas CSV.
8. **Revocación en cascada**: retirar el consentimiento anula todos los matches; la universidad ve
   `deletionRequired: true` y no puede volver a contactar.
9. **AdTech sin fuga de datos**: segmentación en servidor, sin URLs externas ni pixeles, revisión editorial,
   etiqueta "Patrocinado", métricas agregadas. Las recomendaciones vocacionales nunca se ven afectadas por la pauta.
10. **Derechos ARCO/GDPR**: `GET /students/me/data` (acceso/portabilidad), `DELETE /students/me` (supresión).
11. **Seguridad**: zod `.strict()` en todas las entradas, bcrypt (12 rondas), JWT HS256 con issuer/audience
    y revalidación de cuenta, rate limiting, helmet, tokens de verificación hasheados y de un solo uso,
    verificación por POST (los escáneres de correo no pueden "aprobar" por accidente).

## API (prefijo `/v1`)

| Método | Ruta | Rol | Descripción |
|---|---|---|---|
| POST | `/auth/register/student` | público | Registro + consentimiento inicial |
| POST | `/auth/login` | público | Devuelve JWT (15 min) |
| POST | `/auth/organizations` | ADMIN | Alta de colegio/universidad (tras KYC) |
| POST | `/consent/verify-email` | público | `{token}` del correo del estudiante |
| POST | `/consent/parent` | público | `{token, decision, allowThirdPartyTransfer, attestGuardian}` |
| POST | `/consent/resend` | STUDENT | Reenvía verificaciones pendientes |
| GET/PATCH | `/students/me/consent` | STUDENT | Ver/cambiar flags; `acceptTosVersion` para re-aceptar |
| PATCH | `/students/me/profile` | STUDENT | Región, GPA, intereses… |
| GET | `/students/me/data` | STUDENT | Exportación de mis datos |
| DELETE | `/students/me` | STUDENT | `{confirm:"ELIMINAR MI CUENTA"}` |
| GET | `/students/me/contact-requests` | STUDENT | Solicitudes recibidas |
| POST | `/students/me/contact-requests/:id/respond` | STUDENT activo | `{decision: ACCEPT|DECLINE}` |
| POST | `/students/me/contact-requests/:id/revoke` | STUDENT | Revoca un match |
| GET | `/vocational/recommendations` | STUDENT | Recomendaciones explicadas |
| POST | `/vocational/programs` | UNIVERSITY | Publica un programa |
| POST | `/crm/search` | UNIVERSITY | Búsqueda anonimizada |
| GET | `/crm/insights` | UNIVERSITY | Agregados |
| POST/GET | `/crm/contact-requests` | UNIVERSITY | Solicitar contacto / ver estado y contactos autorizados |
| GET | `/crm/contacts/export` | UNIVERSITY | CSV solo de matches autorizados |
| GET | `/ads/feed` | STUDENT activo | Anuncios |
| POST | `/ads/:id/click` · `/ads/:id/request-info` | STUDENT | Clic / match iniciado por el estudiante |
| POST | `/ads/campaigns` | UNIVERSITY | Crea campaña (queda en revisión) |
| GET | `/ads/campaigns/:id/stats` | UNIVERSITY | Métricas k-anónimas |
| PATCH | `/ads/campaigns/:id/review` | ADMIN | Aprueba/rechaza |
| GET | `/schools/me/insights` | SCHOOL | Agregados de sus estudiantes |

## Puesta en marcha

Requisitos: Node.js 20, Firebase CLI (`npm i -g firebase-tools`), Java 11+ (emulador de Firestore).

```powershell
cd vocacional-crm-backend
npm install
npm run typecheck
npm test                 # Jest + Supertest con base de datos en memoria (no requiere Firebase)
npm run test:coverage
```

### Emulador local

```powershell
Copy-Item .env.example .env      # y reemplace los valores
firebase login
firebase use --add               # seleccione su proyecto
npm run serve                    # API en http://localhost:5001/<proyecto>/us-east1/api/v1/health
```

### Despliegue a producción

```powershell
# 1) Secretos en Secret Manager (nunca en el repositorio)
firebase functions:secrets:set JWT_SECRET
firebase functions:secrets:set PSEUDONYM_KEY     # 64 caracteres hex
firebase functions:secrets:set TOKEN_PEPPER
# 2) Variables no secretas: cree .env.<proyecto> con APP_BASE_URL y CORS_ORIGINS
# 3) Desplegar funciones, reglas e índices
npm run deploy
# 4) Crear el primer ADMIN
$env:ADMIN_EMAIL="admin@su-dominio.com"; $env:ADMIN_PASSWORD="UnaClaveLarga123"; npm run seed
```

> `PSEUDONYM_KEY` no debe rotarse sin un plan de migración: cambiarla invalida todos los `candidateId`
> que las universidades tengan guardados.

## Pendientes antes de producción

- **Correo**: sustituir `ConsoleMailer` por un proveedor transaccional (SendGrid, SES, Postmark).
- **Verificación parental más fuerte** para menores de 13 si en el futuro se admiten (COPPA exige métodos
  como tarjeta, documento o videollamada; el correo solo no basta en ese caso).
- **Escala**: la búsqueda y el motor vocacional filtran en memoria (hasta ~5.000 perfiles). Para más volumen,
  usar un índice de búsqueda dedicado (Typesense/Algolia/Elastic) que solo contenga `studentProfiles`.
- **Refresh tokens** y MFA para cuentas de universidad/admin.
- **Rate limiting distribuido**: `express-rate-limit` usa memoria por instancia; para límites globales,
  usar Redis/Memorystore o Cloud Armor.
- **Retención**: definir y automatizar plazos de borrado de `consentEvents`, `dataTransfers` e IPs.
- **Residencia de datos**: elegir región de Firestore acorde a las leyes aplicables (p. ej. UE para España).
- **Transacciones**: algunos flujos multi-documento (registro, revocación) no son atómicos; migrar a
  transacciones de Firestore si se requiere consistencia estricta.
