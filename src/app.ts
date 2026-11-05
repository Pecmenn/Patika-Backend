import { fileURLToPath } from 'node:url';

import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyServerOptions } from 'fastify';
import { sql } from 'kysely';

import { registerAccountRoutes, registerPublicAuthRoutes } from './auth/routes.ts';
import { requireUser } from './auth/sessions.ts';
import type { Deps } from './deps.ts';
import { ApiError, handleError, handleNotFound } from './http.ts';
import { registerPublicLostRoutes } from './lost/public-routes.ts';
import { registerLostRoutes } from './lost/routes.ts';
import { MAX_PHOTO_BYTES, registerPhotoRoutes } from './photos/routes.ts';
import { registerRealtimeRoutes } from './realtime/routes.ts';
import { registerSyncRoutes } from './sync/routes.ts';

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));

// Kayıp sayfası kendi dosyaları ve bu sunucu dışında hiçbir yerle konuşamaz.
const PAGE_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "font-src 'self'",
  "connect-src 'self'",
  "img-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

// Kayıtlara yöntem ve adres yazılır. Ziyaretçi adresi kişisel veri, gerekmedikçe tutulmaz.
const REQUEST_LOGGER = {
  serializers: {
    req: (request: { method: string; url: string }) => ({
      method: request.method,
      url: request.url,
    }),
  },
};

export async function buildApp(deps: Deps, logger: FastifyServerOptions['logger'] = REQUEST_LOGGER) {
  const { config, db } = deps;
  const app = Fastify({
    logger,
    trustProxy: config.TRUST_PROXY,
    bodyLimit: 1024 * 1024,
    routerOptions: { ignoreTrailingSlash: true },
  });

  app.setErrorHandler(handleError);
  app.setNotFoundHandler(handleNotFound);

  app.addContentTypeParser(
    'image/jpeg',
    { parseAs: 'buffer', bodyLimit: MAX_PHOTO_BYTES },
    (_request, body, done) => done(null, body),
  );

  await app.register(rateLimit, {
    global: false,
    errorResponseBuilder: () => new ApiError(429, 'rate_limited'),
  });
  await app.register(websocket, { options: { maxPayload: 4096 } });
  if (config.CORS_ORIGINS.length > 0) {
    await app.register(cors, { origin: config.CORS_ORIGINS });
  }

  app.addHook('onSend', async (_request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Robots-Tag', 'noindex');
    reply.header('Content-Security-Policy', PAGE_POLICY);
    reply.header('Permissions-Policy', 'geolocation=(self), camera=(), microphone=()');
  });

  // Kayıp sayfası: QR kodu /p/<kod> adresini açar, kodu sayfanın kendisi okur.
  // Bozuk adres de sayfayı açar, sayfa "bulunamadı" der: yabancıya ham sunucu cevabı gösterilmez.
  await app.register(fastifyStatic, { root: PUBLIC_DIR, wildcard: false });
  app.get('/p/*', (_request, reply) => reply.sendFile('index.html'));

  app.get('/health', async () => {
    await sql`SELECT 1`.execute(db);
    return { ok: true };
  });

  registerPublicAuthRoutes(app, deps);
  registerPublicLostRoutes(app, deps);
  registerRealtimeRoutes(app, deps);

  // Bu blok içindeki her uç giriş ister. Yeni uç eklenirse varsayılan olarak korunur.
  await app.register(async (scope) => {
    scope.addHook('onRequest', requireUser(db));
    registerAccountRoutes(scope, deps);
    registerSyncRoutes(scope, deps);
    registerPhotoRoutes(scope, deps);
    registerLostRoutes(scope, deps);
  });

  return app;
}
