import { buildApp } from './app.ts';
import { createAppleKeys } from './auth/apple.ts';
import { loadConfig } from './config.ts';
import { createDb } from './db.ts';
import { runMigrations } from './migrate.ts';
import { createPhotoStore } from './photos/store.ts';
import { createHub } from './realtime/hub.ts';

const config = loadConfig();
await runMigrations(config.DATABASE_URL);

const db = createDb(config.DATABASE_URL);
const app = await buildApp({
  config,
  db,
  photos: createPhotoStore(config.PHOTO_DIR),
  hub: createHub(),
  appleKeys: createAppleKeys(),
  rateLimits: { auth: 30, publicRead: 120, publicWrite: 10 },
});

async function shutdown() {
  await app.close();
  await db.destroy();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

await app.listen({ host: config.HOST, port: config.PORT });
