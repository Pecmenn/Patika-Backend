import type { Db } from '../db.ts';
import type { PhotoStore } from '../photos/store.ts';

// Bir hayvana ait kayıp verisinin tamamını siler: ilanlar, herkese açık fotoğraflar, ihbarlar ve QR kodu.
export async function removePetLostData(db: Db, photos: PhotoStore, ownerId: string, petId: string) {
  const reports = await db
    .selectFrom('lost_reports')
    .select('photo_path')
    .where('owner_id', '=', ownerId)
    .where('pet_id', '=', petId)
    .execute();
  await db.transaction().execute(async (trx) => {
    await trx
      .deleteFrom('sightings')
      .where('owner_id', '=', ownerId)
      .where('pet_id', '=', petId)
      .execute();
    await trx
      .deleteFrom('lost_reports')
      .where('owner_id', '=', ownerId)
      .where('pet_id', '=', petId)
      .execute();
    await trx
      .deleteFrom('pet_tags')
      .where('owner_id', '=', ownerId)
      .where('pet_id', '=', petId)
      .execute();
  });
  await Promise.all(
    reports.flatMap(({ photo_path: path }) => (path ? [photos.deleteLostPhoto(path)] : [])),
  );
}
