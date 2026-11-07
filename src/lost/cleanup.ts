import type { Db } from '../db.ts';
import type { PhotoStore } from '../photos/store.ts';
import type { Hub } from '../realtime/hub.ts';

// Yönetici ilanı kaldırır: sayfa kapanır, herkese açık fotoğraf silinir, sahibi uygulamada görür.
// İhbarlar sahibinde kalır, sahibi hayvan hâlâ kayıpsa yeni ilan açabilir.
export async function takeDownReport(db: Db, photos: PhotoStore, hub: Hub, id: string) {
  const report = await db
    .selectFrom('lost_reports')
    .select(['owner_id', 'pet_name', 'photo_path', 'found_at'])
    .where('id', '=', id)
    .executeTakeFirst();
  if (!report) {
    return false;
  }
  // Önce dosya: silme başarısız olursa yeniden denemede fotoğrafın yolu hâlâ bilinir.
  if (report.photo_path) {
    await photos.deleteLostPhoto(report.photo_path);
  }
  const now = new Date();
  await db
    .updateTable('lost_reports')
    .set({ removed_at: now, found_at: report.found_at ?? now, photo_path: null })
    .where('id', '=', id)
    .execute();
  hub.publish(report.owner_id, { type: 'lost_removed', report_id: id, pet_name: report.pet_name });
  return true;
}

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
