// Playwright testleri için sunucu: test veritabanını sıfırlar ve 4100 numaralı kapıda çalışır.
import { randomUUID } from 'node:crypto';

import { hashPassword } from '../src/auth/passwords.ts';
import { resetDatabase, startApp } from '../tests/helpers.ts';

// Yalnızca test veritabanında geçerli deneme yöneticisi.
export const ADMIN_EMAIL = 'yonetici@example.com';
export const ADMIN_PASSWORD = 'yonetici-deneme-sifresi';

if (process.argv[1]?.endsWith('test-server.ts')) {
  await resetDatabase();
  const server = await startApp();
  await server.db
    .insertInto('admins')
    .values({ id: randomUUID(), email: ADMIN_EMAIL, password_hash: await hashPassword(ADMIN_PASSWORD) })
    .execute();
  await server.app.listen({ host: '127.0.0.1', port: 4100 });

  const shutdown = async () => {
    await server.stop();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
