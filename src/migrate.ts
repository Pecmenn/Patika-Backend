import { readdir, readFile } from 'node:fs/promises';

import { createConnection } from 'mysql2/promise';

const MIGRATIONS_DIR = new URL('../migrations/', import.meta.url);
const LOCK_TIMEOUT_SECONDS = 30;

// migrations klasöründeki SQL dosyalarını sırayla ve yalnızca bir kez çalıştırır.
// Uygulanan dosyalar schema_migrations tablosunda tutulur.
export async function runMigrations(databaseUrl: string) {
  // Birden çok komutu tek seferde çalıştırma izni yalnızca burada açık, istek işleyen bağlantılarda kapalı.
  const connection = await createConnection({
    uri: databaseUrl,
    multipleStatements: true,
    timezone: 'Z',
    charset: 'utf8mb4',
  });
  try {
    const [locks] = await connection.query('SELECT GET_LOCK(?, ?) AS acquired', [
      'patika_migrations',
      LOCK_TIMEOUT_SECONDS,
    ]);
    if ((locks as { acquired: number | null }[])[0]?.acquired !== 1) {
      throw new Error('Veritabanı değişikliği kilidi alınamadı');
    }
    await connection.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name VARCHAR(100) NOT NULL PRIMARY KEY,
      applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    )`);
    const [rows] = await connection.query('SELECT name FROM schema_migrations');
    const applied = new Set((rows as { name: string }[]).map((row) => row.name));

    const files = (await readdir(MIGRATIONS_DIR)).filter((file) => file.endsWith('.sql')).sort();
    for (const file of files) {
      if (!applied.has(file)) {
        await connection.query(await readFile(new URL(file, MIGRATIONS_DIR), 'utf8'));
        await connection.query('INSERT INTO schema_migrations (name) VALUES (?)', [file]);
      }
    }
  } finally {
    await connection.query('SELECT RELEASE_LOCK(?)', ['patika_migrations']).catch(() => undefined);
    await connection.end();
  }
}
