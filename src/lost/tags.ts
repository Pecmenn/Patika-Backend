import { randomBytes } from 'node:crypto';

import type { Db } from '../db.ts';

const ATTEMPTS = 3;

async function findCode(db: Db, ownerId: string, petId: string) {
  const tag = await db
    .selectFrom('pet_tags')
    .select('public_code')
    .where('owner_id', '=', ownerId)
    .where('pet_id', '=', petId)
    .executeTakeFirst();
  return tag?.public_code ?? null;
}

// Hayvanın değişmeyen kodunu döner, yoksa oluşturur. QR kodu bu kodu taşır.
export async function ensurePublicCode(db: Db, ownerId: string, petId: string) {
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    const existing = await findCode(db, ownerId, petId);
    if (existing) {
      return existing;
    }
    // Aynı anda iki istek gelirse ya da rastgele kod başkasınınkiyle çakışırsa yeniden denenir.
    await db
      .insertInto('pet_tags')
      .ignore()
      .values({ owner_id: ownerId, pet_id: petId, public_code: randomBytes(6).toString('hex') })
      .execute();
  }
  const created = await findCode(db, ownerId, petId);
  if (!created) {
    throw new Error('Hayvan kodu oluşturulamadı');
  }
  return created;
}
