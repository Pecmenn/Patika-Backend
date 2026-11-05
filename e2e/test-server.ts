// Playwright testleri için sunucu: test veritabanını sıfırlar ve 4100 numaralı kapıda çalışır.
import { resetDatabase, startApp } from '../tests/helpers.ts';

await resetDatabase();
const server = await startApp();
await server.app.listen({ host: '127.0.0.1', port: 4100 });

async function shutdown() {
  await server.stop();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
