import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { decoyHash, verifyPassword } from '../auth/passwords.ts';
import { LoginEmail } from '../auth/routes.ts';
import type { Deps } from '../deps.ts';
import { ApiError, parse } from '../http.ts';
import { registerAdminClinicRoutes } from './clinics.ts';
import { registerAdminLostRoutes } from './lost.ts';
import { endAdminSession, requireAdmin, requireSameOrigin, startAdminSession } from './sessions.ts';
import { readSummary } from './summary.ts';
import { registerAdminUserRoutes } from './users.ts';

const Login = z.object({ email: LoginEmail, password: z.string().min(1).max(200) });

const MAX_FAILURES = 5;
const LOCK_MS = 15 * 60 * 1000;
const MAX_TRACKED = 10000;

// Adres başına sınır, adres değiştiren saldırıyı durdurmaz. Bu yüzden e-posta başına da sayılır.
function createLoginThrottle() {
  const failures = new Map<string, { count: number; until: number }>();
  return {
    isLocked(email: string) {
      const entry = failures.get(email);
      if (entry && entry.until <= Date.now()) {
        failures.delete(email);
        return false;
      }
      return (entry?.count ?? 0) >= MAX_FAILURES;
    },
    recordFailure(email: string) {
      // Sürekli farklı e-postayla deneyen biri belleği dolduramasın.
      if (failures.size >= MAX_TRACKED) {
        failures.clear();
      }
      const count = (failures.get(email)?.count ?? 0) + 1;
      failures.set(email, { count, until: Date.now() + LOCK_MS });
    },
    clear(email: string) {
      failures.delete(email);
    },
  };
}

// Yönetim paneli. Sayfa public/admin içinde herkese açıktır ama veri taşımaz, veri bu uçlardan gelir.
export async function registerAdminRoutes(app: FastifyInstance, deps: Deps) {
  const { db, rateLimits } = deps;
  const throttle = createLoginThrottle();

  await app.register(
    async (admin) => {
      admin.addHook('onRequest', requireSameOrigin);
      // Kişisel veri taşıyan cevaplar tarayıcının önbelleğinde kalmasın.
      admin.addHook('onSend', async (_request, reply) => {
        reply.header('cache-control', 'no-store');
      });

      // Yanlış şifre ve kayıtsız e-posta aynı cevabı ve aynı süreyi alır.
      admin.post(
        '/login',
        { config: { rateLimit: { max: rateLimits.auth, timeWindow: '1 minute' } } },
        async (request, reply) => {
          const { email, password } = parse(Login, request.body);
          if (throttle.isLocked(email)) {
            throw new ApiError(429, 'rate_limited');
          }
          const row = await db
            .selectFrom('admins')
            .select(['id', 'email', 'password_hash'])
            .where('email', '=', email)
            .executeTakeFirst();
          const isValid = await verifyPassword(password, row?.password_hash ?? (await decoyHash()));
          if (!row || !isValid) {
            throttle.recordFailure(email);
            throw new ApiError(401, 'invalid_credentials');
          }
          throttle.clear(email);
          await startAdminSession(db, request, reply, row.id);
          return { email: row.email };
        },
      );

      // Bu blok içindeki her uç yönetici oturumu ister. Yeni uç eklenirse varsayılan olarak korunur.
      await admin.register(async (secured) => {
        secured.addHook('onRequest', requireAdmin(db));

        secured.get('/me', async (request) => ({ email: request.adminEmail }));

        secured.post('/logout', async (request, reply) => {
          await endAdminSession(db, request, reply);
          return reply.status(204).send();
        });

        secured.get('/summary', async () => readSummary(db));

        registerAdminClinicRoutes(secured, deps);
        registerAdminLostRoutes(secured, deps);
        registerAdminUserRoutes(secured, deps);
      });
    },
    { prefix: '/admin/api' },
  );
}
