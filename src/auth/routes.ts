import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { cancelUpcomingOfClinic, prepareOwnerDeletion } from '../appointments/lifecycle.ts';
import { isDuplicateKey, type Db } from '../db.ts';
import type { Deps } from '../deps.ts';
import { ApiError, parse } from '../http.ts';
import { verifyAppleToken } from './apple.ts';
import { decoyHash, hashPassword, verifyPassword } from './passwords.ts';
import { createSession, revokeSession } from './sessions.ts';

const AppleLogin = z.object({
  identity_token: z.string().min(1).max(8192),
  full_name: z.string().trim().max(200).nullish(),
  given_name: z.string().trim().max(100).nullish(),
  family_name: z.string().trim().max(100).nullish(),
});

// Küçük harfe çevrilir: aynı adres farklı yazılışla ikinci hesap açamasın.
const VetEmail = z.preprocess(
  (value) => (typeof value === 'string' ? value.trim().toLowerCase() : value),
  z.email().max(320),
);
const NewVetLogin = z.object({ email: VetEmail, password: z.string().min(8).max(200) });
const VetLogin = z.object({ email: VetEmail, password: z.string().min(1).max(200) });

function providerOf(role: string, appleSub: string | null) {
  if (role === 'vet') {
    return 'email';
  }
  return appleSub ? 'apple' : 'development';
}

async function loadUser(db: Db, userId: string) {
  const user = await db
    .selectFrom('users')
    .select(['id', 'apple_sub', 'email', 'full_name', 'given_name', 'family_name', 'role'])
    .where('id', '=', userId)
    .executeTakeFirst();
  if (!user) {
    throw new ApiError(401, 'unauthorized');
  }
  const { apple_sub: appleSub, ...visible } = user;
  return { ...visible, provider: providerOf(user.role, appleSub) };
}

async function findOrCreateAppleUser(
  db: Db,
  apple: { sub: string; email: string | null },
  names: z.infer<typeof AppleLogin>,
) {
  // Apple adı yalnızca ilk girişte gönderir. Sonraki girişlerde boş gelen ad silinmez.
  const known = {
    ...(apple.email ? { email: apple.email } : {}),
    ...(names.full_name ? { full_name: names.full_name } : {}),
    ...(names.given_name ? { given_name: names.given_name } : {}),
    ...(names.family_name ? { family_name: names.family_name } : {}),
  };
  const findExisting = () =>
    db.selectFrom('users').select('id').where('apple_sub', '=', apple.sub).executeTakeFirst();

  const existing = await findExisting();
  if (existing) {
    if (Object.keys(known).length > 0) {
      await db.updateTable('users').set(known).where('id', '=', existing.id).execute();
    }
    return existing.id;
  }
  const id = randomUUID();
  try {
    await db.insertInto('users').values({ id, apple_sub: apple.sub, ...known }).execute();
    return id;
  } catch (error) {
    // Aynı anda iki istek gelirse ikincisi ilkinin hesabını kullanır.
    if (isDuplicateKey(error)) {
      const winner = await findExisting();
      if (winner) {
        return winner.id;
      }
    }
    throw error;
  }
}

export function registerPublicAuthRoutes(
  app: FastifyInstance,
  { config, db, appleKeys, rateLimits }: Deps,
) {
  const rateLimit = { max: rateLimits.auth, timeWindow: '1 minute' };

  app.post('/v1/auth/apple', { config: { rateLimit } }, async (request) => {
    const body = parse(AppleLogin, request.body);
    const apple = await verifyAppleToken(body.identity_token, appleKeys, config.APPLE_AUDIENCES);
    const userId = await findOrCreateAppleUser(db, apple, body);
    return { token: await createSession(db, userId), user: await loadUser(db, userId) };
  });

  // Veteriner hesabı. Sahip hesaplarından ayrıdır, Apple girişiyle karışmaz.
  app.post('/v1/auth/vet/register', { config: { rateLimit } }, async (request, reply) => {
    const { email, password } = parse(NewVetLogin, request.body);
    const id = randomUUID();
    const passwordHash = await hashPassword(password);
    try {
      await db.transaction().execute(async (trx) => {
        await trx.insertInto('users').values({ id, email, role: 'vet' }).execute();
        await trx
          .insertInto('vet_logins')
          .values({ user_id: id, email, password_hash: passwordHash })
          .execute();
      });
    } catch (error) {
      if (isDuplicateKey(error)) {
        throw new ApiError(409, 'email_taken');
      }
      throw error;
    }
    return reply
      .status(201)
      .send({ token: await createSession(db, id), user: await loadUser(db, id) });
  });

  // Yanlış şifre ve kayıtsız e-posta aynı cevabı alır.
  app.post('/v1/auth/vet/login', { config: { rateLimit } }, async (request) => {
    const { email, password } = parse(VetLogin, request.body);
    const login = await db
      .selectFrom('vet_logins')
      .select(['user_id', 'password_hash'])
      .where('email', '=', email)
      .executeTakeFirst();
    const isValid = await verifyPassword(password, login?.password_hash ?? (await decoyHash()));
    if (!login || !isValid) {
      throw new ApiError(401, 'invalid_credentials');
    }
    return {
      token: await createSession(db, login.user_id),
      user: await loadUser(db, login.user_id),
    };
  });

  // Yalnızca geliştirirken: taklitçi ve testler Apple olmadan giriş yapabilsin.
  // Her çağrı boş, yeni bir hesap açar, kimsenin verisine ulaştırmaz.
  if (config.ALLOW_DEV_LOGIN) {
    app.post('/v1/auth/dev', { config: { rateLimit } }, async () => {
      const id = randomUUID();
      await db.insertInto('users').values({ id }).execute();
      return { token: await createSession(db, id), user: await loadUser(db, id) };
    });
  }
}

export function registerAccountRoutes(app: FastifyInstance, { db, photos, hub }: Deps) {
  app.get('/v1/me', async (request) => ({ user: await loadUser(db, request.userId) }));

  // Yalnızca bu telefondaki oturum kapanır.
  app.post('/v1/auth/logout', async (request, reply) => {
    await revokeSession(db, request.sessionToken);
    hub.closeSession(request.userId, request.sessionToken);
    return reply.status(204).send();
  });

  // Hesap silme. Önce veritabanı (bağlı satırlar kullanıcıyla silinir), sonra dosyalar:
  // silme başarısız olursa hesap fotoğrafsız kalmasın.
  app.delete('/v1/me', async (request, reply) => {
    const reports = await db
      .selectFrom('lost_reports')
      .select('photo_path')
      .where('owner_id', '=', request.userId)
      .execute();
    const clinic = await db
      .selectFrom('clinics')
      .select(['id', 'photo_path'])
      .where('owner_id', '=', request.userId)
      .executeTakeFirst();
    // Klinik silinirse yaklaşan randevular iptal olur, sahip silinirse klinik listesi yenilenir.
    if (clinic) {
      await cancelUpcomingOfClinic(db, hub, clinic.id);
    }
    const notifyClinics = await prepareOwnerDeletion(db, hub, request.userId);
    await db.deleteFrom('users').where('id', '=', request.userId).execute();
    notifyClinics();
    hub.closeUser(request.userId);
    // Hesap artık yok: telefona hata dönülürse kullanıcı silinmedi sanır, yeniden denemesi de işe yaramaz.
    // Silinemeyen dosya kayda geçer, elle temizlenir.
    const files = await Promise.allSettled([
      ...reports.flatMap(({ photo_path: path }) => (path ? [photos.deleteLostPhoto(path)] : [])),
      ...(clinic?.photo_path ? [photos.deleteClinicPhoto(clinic.photo_path)] : []),
      photos.deleteAllPetPhotos(request.userId),
    ]);
    const failed = files.filter(({ status }) => status === 'rejected').length;
    if (failed > 0) {
      request.log.error({ userId: request.userId, failed }, 'Hesap silindi, bazı fotoğraflar silinemedi');
    }
    return reply.status(204).send();
  });
}
