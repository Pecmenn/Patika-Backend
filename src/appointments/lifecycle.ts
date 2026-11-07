import { toLocalParts } from '../clinics/hours.ts';
import type { Db } from '../db.ts';
import type { Hub } from '../realtime/hub.ts';

type VisitSource = {
  id: string;
  owner_id: string;
  pet_id: string;
  reason: string;
  note: string | null;
  clinic_name: string;
  starts_at: Date;
};

type EventSource = { clinic_name: string; pet_name: string; starts_at: Date };

const visitId = (appointmentId: string) => `appointment-${appointmentId}`;

// Onaylanan randevu sahibin ziyaretlerine düşer: telefon sonraki eşitlemede alır, hatırlatmalar kurulur.
export async function writeVisit(db: Db, appointment: VisitSource) {
  const now = new Date();
  const id = visitId(appointment.id);
  const data = JSON.stringify({
    id,
    petId: appointment.pet_id,
    reason: appointment.reason,
    ...toLocalParts(appointment.starts_at),
    clinic: appointment.clinic_name,
    note: appointment.note,
  });
  await db
    .insertInto('user_items')
    .values({
      owner_id: appointment.owner_id,
      collection: 'visits',
      id,
      data,
      deleted: false,
      updated_at: now,
    })
    .onDuplicateKeyUpdate({ data, deleted: false, updated_at: now, synced_at: now })
    .execute();
}

export async function removeVisit(db: Db, ownerId: string, appointmentId: string) {
  const now = new Date();
  await db
    .updateTable('user_items')
    .set({ data: null, deleted: true, updated_at: now, synced_at: now })
    .where('owner_id', '=', ownerId)
    .where('collection', '=', 'visits')
    .where('id', '=', visitId(appointmentId))
    .execute();
}

// Uygulama açıksa ekran yenilenir ve bildirim gösterilir.
export function publishAppointment(
  hub: Hub,
  userId: string,
  status: string,
  { clinic_name: clinicName, pet_name: petName, starts_at: startsAt }: EventSource,
) {
  hub.publish(userId, {
    type: 'appointment',
    status,
    clinic_name: clinicName,
    pet_name: petName,
    ...toLocalParts(startsAt),
  });
}

function upcoming(db: Db) {
  return db
    .selectFrom('appointments')
    .select(['id', 'owner_id', 'clinic_id', 'clinic_name', 'pet_name', 'starts_at', 'status'])
    .where('status', 'in', ['pending', 'confirmed'])
    .where('starts_at', '>', new Date());
}

async function clinicOwners(db: Db, clinicIds: string[]) {
  if (clinicIds.length === 0) {
    return new Map<string, string>();
  }
  const rows = await db
    .selectFrom('clinics')
    .select(['id', 'owner_id'])
    .where('id', 'in', clinicIds)
    .execute();
  return new Map(rows.map(({ id, owner_id: ownerId }) => [id, ownerId]));
}

type Upcoming = Awaited<ReturnType<ReturnType<typeof upcoming>['execute']>>;

async function cancelRows(db: Db, rows: Upcoming, cancelledBy: 'owner' | 'vet') {
  const now = new Date();
  for (const row of rows) {
    await db.transaction().execute(async (trx) => {
      await trx
        .updateTable('appointments')
        .set({ status: 'cancelled', cancelled_by: cancelledBy, responded_at: now })
        .where('id', '=', row.id)
        .execute();
      if (row.status === 'confirmed') {
        await removeVisit(trx, row.owner_id, row.id);
      }
    });
  }
}

// Klinik hesabını silerken: yaklaşan randevular iptal olur, sahipler ziyaretlerinde boşuna beklemez.
export async function cancelUpcomingOfClinic(db: Db, hub: Hub, clinicId: string) {
  const rows = await upcoming(db).where('clinic_id', '=', clinicId).execute();
  await cancelRows(db, rows, 'vet');
  for (const row of rows) {
    publishAppointment(hub, row.owner_id, 'cancelled', row);
  }
}

async function cancelForOwner(db: Db, hub: Hub, rows: Upcoming) {
  await cancelRows(db, rows, 'owner');
  const owners = await clinicOwners(db, rows.flatMap((row) => row.clinic_id ?? []));
  for (const row of rows) {
    const clinicOwner = row.clinic_id && owners.get(row.clinic_id);
    if (clinicOwner) {
      publishAppointment(hub, clinicOwner, 'cancelled', row);
    }
  }
}

// Hayvan silinince yaklaşan randevuları iptal olur, klinik boşuna beklemez.
export async function cancelUpcomingOfPet(db: Db, hub: Hub, ownerId: string, petId: string) {
  const rows = await upcoming(db)
    .where('owner_id', '=', ownerId)
    .where('pet_id', '=', petId)
    .execute();
  await cancelForOwner(db, hub, rows);
}

// Yönetici sahibin hesabını kapatınca randevuları iptal olur, klinik boşuna beklemez.
export async function cancelUpcomingOfOwner(db: Db, hub: Hub, ownerId: string) {
  await cancelForOwner(db, hub, await upcoming(db).where('owner_id', '=', ownerId).execute());
}

// Sahip hesabını silince randevular da silinir. Kliniklerin listesi yenilensin diye önceden toplanır.
export async function prepareOwnerDeletion(db: Db, hub: Hub, ownerId: string) {
  const rows = await upcoming(db).where('owner_id', '=', ownerId).execute();
  const owners = await clinicOwners(db, rows.flatMap((row) => row.clinic_id ?? []));
  return () => {
    for (const row of rows) {
      const clinicOwner = row.clinic_id && owners.get(row.clinic_id);
      if (clinicOwner) {
        publishAppointment(hub, clinicOwner, 'cancelled', row);
      }
    }
  };
}
