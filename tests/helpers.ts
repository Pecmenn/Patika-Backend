import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createConnection } from 'mysql2/promise';

import { buildApp } from '../src/app.ts';
import type { Config } from '../src/config.ts';
import { createDb, type Db } from '../src/db.ts';
import type { RateLimits } from '../src/deps.ts';
import { runMigrations } from '../src/migrate.ts';
import { createPhotoStore, type PhotoStore } from '../src/photos/store.ts';
import { createHub } from '../src/realtime/hub.ts';

export const APPLE_AUDIENCE = 'host.exp.Exponent';
export const APPLE_ISSUER = 'https://appleid.apple.com';
export const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

function testDatabaseUrl() {
  const url = process.env.TEST_DATABASE_URL;
  // Testler tabloları siler. Asıl veritabanına yanlışlıkla bağlanmasın.
  if (!url || !new URL(url).pathname.endsWith('_test')) {
    throw new Error('TEST_DATABASE_URL adı _test ile bitmeli');
  }
  return url;
}

export async function resetDatabase() {
  const url = testDatabaseUrl();
  const connection = await createConnection({ uri: url, multipleStatements: true });
  const [tables] = await connection.query(
    'SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE()',
  );
  const drops = (tables as { name: string }[]).map(({ name }) => `DROP TABLE \`${name}\`;`).join('');
  await connection.query(`SET FOREIGN_KEY_CHECKS = 0; ${drops} SET FOREIGN_KEY_CHECKS = 1;`);
  await connection.end();
  await runMigrations(url);
}

const appleKeyPair = await generateKeyPair('RS256', { extractable: true });
const applePublic = await exportJWK(appleKeyPair.publicKey);
const appleKeys = createLocalJWKSet({
  keys: [{ ...applePublic, kid: 'test', alg: 'RS256', use: 'sig' }],
});

// Apple'ın vereceği belgenin aynısını test anahtarıyla üretir.
export function appleToken(
  sub: string,
  options: { audience?: string; issuer?: string; expires?: string; email?: string } = {},
) {
  return new SignJWT(options.email ? { email: options.email } : {})
    .setProtectedHeader({ alg: 'RS256', kid: 'test' })
    .setIssuer(options.issuer ?? APPLE_ISSUER)
    .setAudience(options.audience ?? APPLE_AUDIENCE)
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime(options.expires ?? '10m')
    .sign(appleKeyPair.privateKey);
}

export type TestApp = Awaited<ReturnType<typeof startApp>>;

export async function startApp(
  overrides: {
    config?: Partial<Config>;
    rateLimits?: Partial<RateLimits>;
    photos?: Partial<PhotoStore>;
  } = {},
) {
  const url = testDatabaseUrl();
  const photoDir = await mkdtemp(join(tmpdir(), 'patika-test-'));
  const db: Db = createDb(url);
  const config: Config = {
    DATABASE_URL: url,
    PORT: 0,
    HOST: '127.0.0.1',
    PHOTO_DIR: photoDir,
    APPLE_AUDIENCES: [APPLE_AUDIENCE],
    ALLOW_DEV_LOGIN: true,
    CORS_ORIGINS: [],
    TRUST_PROXY: false,
    ...overrides.config,
  };
  const app = await buildApp(
    {
      config,
      db,
      photos: { ...createPhotoStore(photoDir), ...overrides.photos },
      hub: createHub(),
      appleKeys,
      rateLimits: { auth: 100000, publicRead: 100000, publicWrite: 100000, ...overrides.rateLimits },
    },
    false,
  );

  type CallOptions = {
    token?: string;
    body?: unknown;
    raw?: Buffer;
    headers?: Record<string, string>;
  };

  async function call(method: string, url: string, options: CallOptions = {}) {
    const headers: Record<string, string> = { ...options.headers };
    if (options.token) {
      headers.authorization = `Bearer ${options.token}`;
    }
    if (options.raw) {
      headers['content-type'] = headers['content-type'] ?? 'image/jpeg';
    }
    const response = await app.inject({
      method: method as 'GET',
      url,
      headers,
      ...(options.raw ? { payload: options.raw } : {}),
      ...(options.body !== undefined ? { payload: options.body as object } : {}),
    });
    let json: any = null;
    try {
      json = response.json();
    } catch {
      // Gövdesi JSON olmayan cevaplar (204, resim, sayfa).
    }
    return { status: response.statusCode, json, headers: response.headers, raw: response.rawPayload };
  }

  async function newUser() {
    const { json } = await call('POST', '/v1/auth/dev');
    return { token: json.token as string, id: json.user.id as string };
  }

  return {
    app,
    db,
    call,
    newUser,
    photoDir,
    async stop() {
      await app.close();
      await db.destroy();
      await rm(photoDir, { recursive: true, force: true });
    },
  };
}

export function newReport(petId: string, overrides: object = {}) {
  return {
    pet_id: petId,
    pet_name: 'Zeytin',
    species: 'dog',
    breed: 'Melez',
    description: 'Mavi tasma',
    last_seen_area: 'Moda, Kadıköy',
    last_seen_lat: 40.987654,
    last_seen_lng: 29.123456,
    last_seen_at: new Date().toISOString(),
    ...overrides,
  };
}
