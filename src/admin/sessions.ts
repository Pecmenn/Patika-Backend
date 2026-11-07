import { randomBytes } from 'node:crypto';

import type { FastifyReply, FastifyRequest } from 'fastify';

import { hashToken } from '../auth/sessions.ts';
import type { Db } from '../db.ts';
import { ApiError } from '../http.ts';

const COOKIE = 'patika_admin';
// Panel ara sıra açılır: oturum kısa tutulur ve uzatılmaz. Çalınan bir çerez en fazla 8 saat işe yarar.
const SESSION_SECONDS = 8 * 60 * 60;

declare module 'fastify' {
  interface FastifyRequest {
    adminEmail: string;
  }
}

function readToken(request: FastifyRequest) {
  for (const part of request.headers.cookie?.split(';') ?? []) {
    const [name, value] = part.trim().split('=');
    if (name === COOKIE && value) {
      return value;
    }
  }
  return null;
}

// HttpOnly: sayfadaki kod çerezi okuyamaz. SameSite=Strict: başka siteden gelen istekte gönderilmez.
// Path=/admin: uygulamanın uçlarına hiç gitmez. Secure: HTTPS varsa yalnızca HTTPS üzerinden gider.
function writeCookie(request: FastifyRequest, reply: FastifyReply, value: string, maxAge: number) {
  const parts = [
    `${COOKIE}=${value}`,
    'Path=/admin',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${maxAge}`,
  ];
  if (request.protocol === 'https') {
    parts.push('Secure');
  }
  reply.header('set-cookie', parts.join('; '));
}

export async function startAdminSession(
  db: Db,
  request: FastifyRequest,
  reply: FastifyReply,
  adminId: string,
) {
  const token = randomBytes(32).toString('base64url');
  const now = Date.now();
  await db.deleteFrom('admin_sessions').where('expires_at', '<', new Date(now)).execute();
  await db
    .insertInto('admin_sessions')
    .values({
      token_hash: hashToken(token),
      admin_id: adminId,
      expires_at: new Date(now + SESSION_SECONDS * 1000),
    })
    .execute();
  writeCookie(request, reply, token, SESSION_SECONDS);
}

export async function endAdminSession(db: Db, request: FastifyRequest, reply: FastifyReply) {
  const token = readToken(request);
  if (token) {
    await db.deleteFrom('admin_sessions').where('token_hash', '=', hashToken(token)).execute();
  }
  writeCookie(request, reply, '', 0);
}

// Panelin giriş gerektiren her ucu bundan geçer. Geçerli yönetici oturumu yoksa istek burada biter.
export function requireAdmin(db: Db) {
  return async (request: FastifyRequest) => {
    const token = readToken(request);
    const admin = token
      ? await db
          .selectFrom('admin_sessions')
          .innerJoin('admins', 'admins.id', 'admin_sessions.admin_id')
          .select('admins.email')
          .where('admin_sessions.token_hash', '=', hashToken(token))
          .where('admin_sessions.expires_at', '>', new Date())
          .executeTakeFirst()
      : undefined;
    if (!admin) {
      throw new ApiError(401, 'unauthorized');
    }
    request.adminEmail = admin.email;
  };
}

// Başka bir sitenin, yöneticinin tarayıcısı üzerinden panele iş yaptırmasını engeller.
export async function requireSameOrigin(request: FastifyRequest) {
  const origin = request.headers.origin;
  if (request.method === 'GET' || origin === undefined) {
    return;
  }
  let host: string | null = null;
  try {
    host = new URL(origin).host;
  } catch {
    // "null" gibi adres olmayan değerler aşağıda reddedilir.
  }
  if (host !== request.host) {
    throw new ApiError(403, 'forbidden');
  }
}
