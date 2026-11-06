import { createHash, randomBytes } from 'node:crypto';

import type { FastifyRequest } from 'fastify';

import type { Db, Role } from '../db.ts';
import { ApiError } from '../http.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
// Telefon uzun süre internetsiz kalabilir, kullanıcıyı sebepsiz yere çıkarmamak için süre uzun.
const SESSION_MS = 180 * DAY_MS;

declare module 'fastify' {
  interface FastifyRequest {
    userId: string;
    userRole: Role;
    sessionToken: string;
  }
}

function hashToken(token: string) {
  return createHash('sha256').update(token).digest('hex');
}

export async function createSession(db: Db, userId: string) {
  const token = randomBytes(32).toString('base64url');
  await db
    .deleteFrom('sessions')
    .where('user_id', '=', userId)
    .where('expires_at', '<', new Date())
    .execute();
  await db
    .insertInto('sessions')
    .values({
      token_hash: hashToken(token),
      user_id: userId,
      expires_at: new Date(Date.now() + SESSION_MS),
    })
    .execute();
  return token;
}

export async function userForToken(db: Db, token: string) {
  const tokenHash = hashToken(token);
  const session = await db
    .selectFrom('sessions')
    .innerJoin('users', 'users.id', 'sessions.user_id')
    .select(['sessions.user_id', 'sessions.last_used_at', 'sessions.expires_at', 'users.role'])
    .where('sessions.token_hash', '=', tokenHash)
    .executeTakeFirst();
  const now = Date.now();
  if (!session || session.expires_at.getTime() <= now) {
    return null;
  }
  // Kullanılan oturumun süresi uzar. Her istekte yazmamak için günde en fazla bir kez.
  if (now - session.last_used_at.getTime() > DAY_MS) {
    await db
      .updateTable('sessions')
      .set({ last_used_at: new Date(now), expires_at: new Date(now + SESSION_MS) })
      .where('token_hash', '=', tokenHash)
      .execute();
  }
  return { id: session.user_id, role: session.role };
}

export async function revokeSession(db: Db, token: string) {
  await db.deleteFrom('sessions').where('token_hash', '=', hashToken(token)).execute();
}

// Giriş gerektiren her uç bundan geçer. Geçerli oturum yoksa istek burada biter.
export function requireUser(db: Db) {
  return async (request: FastifyRequest) => {
    const header = request.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;
    const user = token ? await userForToken(db, token) : null;
    if (!token || !user) {
      throw new ApiError(401, 'unauthorized');
    }
    request.userId = user.id;
    request.userRole = user.role;
    request.sessionToken = token;
  };
}

// Sahip ve veteriner uçları birbirinden ayrıdır: yanlış rol burada durur.
export function requireRole(role: Role) {
  return async (request: FastifyRequest) => {
    if (request.userRole !== role) {
      throw new ApiError(403, 'forbidden');
    }
  };
}
