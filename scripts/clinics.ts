// Klinik onayı, şimdilik buradan: npm run clinic -- list | approve <kimlik> | reject <kimlik>
// Onaylamadan önce oda sicil numarası Türk Veteriner Hekimleri Birliği kayıtlarından kontrol edilmeli.
import { createDb } from '../src/db.ts';

const [command, id] = process.argv.slice(2);
const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error('DATABASE_URL ayarlanmamış');
}
const db = createDb(url);

async function setStatus(clinicId: string | undefined, status: 'approved' | 'rejected') {
  if (!clinicId) {
    throw new Error('Klinik kimliği gerekli');
  }
  const { numUpdatedRows } = await db
    .updateTable('clinics')
    .set({ status })
    .where('id', '=', clinicId)
    .executeTakeFirst();
  console.log(numUpdatedRows > 0n ? `${clinicId}: ${status}` : `${clinicId}: bulunamadı`);
}

try {
  if (command === 'list') {
    const clinics = await db
      .selectFrom('clinics')
      .select(['id', 'status', 'name', 'vet_name', 'license_no', 'phone', 'area', 'created_at'])
      .orderBy('created_at', 'desc')
      .execute();
    console.table(clinics);
  } else if (command === 'approve') {
    await setStatus(id, 'approved');
  } else if (command === 'reject') {
    await setStatus(id, 'rejected');
  } else {
    console.log('Kullanım: npm run clinic -- list | approve <kimlik> | reject <kimlik>');
  }
} finally {
  await db.destroy();
}
