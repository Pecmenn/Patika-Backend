import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { cancelUpcomingOfClinic } from '../appointments/lifecycle.ts';
import { IdParams } from '../clinics/schema.ts';
import type { Db } from '../db.ts';
import type { Deps } from '../deps.ts';
import { ApiError, parse } from '../http.ts';
import { Offset, pageOf, PAGE_SIZE } from './paging.ts';

const ListQuery = z.object({
  status: z.enum(['pending', 'approved', 'rejected', 'all']).default('pending'),
  offset: Offset,
});

// Yöneticinin gördüğü kimlik bilgileri. Panel açıkken değiştiyse kontrol edilmemiş bilgi onaylanmasın.
const SeenIdentity = z.object({
  name: z.string(),
  vet_name: z.string(),
  license_no: z.string(),
});

// Panel sicil numarasını ve hesabın e-postasını görür: onay bunlar olmadan verilemez.
function clinicRows(db: Db) {
  return db
    .selectFrom('clinics')
    .innerJoin('users', 'users.id', 'clinics.owner_id')
    .select([
      'clinics.id',
      'clinics.status',
      'clinics.name',
      'clinics.vet_name',
      'clinics.license_no',
      'clinics.phone',
      'clinics.address',
      'clinics.area',
      'clinics.hours',
      'clinics.slot_minutes',
      'clinics.species',
      'clinics.services',
      'clinics.description',
      'clinics.website',
      'clinics.instagram',
      'clinics.photo_path',
      'clinics.created_at',
      'users.email as owner_email',
      'users.suspended_at as owner_suspended_at',
    ])
    .select((eb) =>
      eb
        .selectFrom('appointments')
        .select(eb.fn.countAll<number>().as('total'))
        .whereRef('appointments.clinic_id', '=', 'clinics.id')
        .where('appointments.status', 'in', ['pending', 'confirmed'])
        .where('appointments.starts_at', '>', new Date())
        .as('upcoming_appointments'),
    );
}

type ClinicRow = Awaited<ReturnType<ReturnType<typeof clinicRows>['execute']>>[number];

function clinicJson(row: ClinicRow) {
  return { ...row, upcoming_appointments: Number(row.upcoming_appointments) };
}

async function findClinic(db: Db, params: unknown) {
  const { id } = parse(IdParams, params);
  const clinic = await clinicRows(db).where('clinics.id', '=', id).executeTakeFirst();
  if (!clinic) {
    throw new ApiError(404, 'not_found');
  }
  return clinic;
}

export function registerAdminClinicRoutes(app: FastifyInstance, { db, hub }: Deps) {
  // Bekleyenlerde en eski başvuru en üstte: sırası gelen önce görülür.
  app.get('/clinics', async (request) => {
    const { status, offset } = parse(ListQuery, request.query);
    let query = clinicRows(db).limit(PAGE_SIZE + 1).offset(offset);
    if (status !== 'all') {
      query = query.where('clinics.status', '=', status);
    }
    query =
      status === 'pending'
        ? query.orderBy('clinics.created_at', 'asc')
        : query.orderBy('clinics.name', 'asc');
    const { items, has_more: hasMore } = pageOf(await query.orderBy('clinics.id').execute());
    return { clinics: items.map(clinicJson), has_more: hasMore };
  });

  app.post('/clinics/:id/approve', async (request) => {
    const clinic = await findClinic(db, request.params);
    const seen = parse(SeenIdentity, request.body);
    // Kapatılan hesabın kliniği listeye girerse randevu istekleri kimseye ulaşmaz.
    if (clinic.owner_suspended_at) {
      throw new ApiError(409, 'account_suspended');
    }
    if (
      seen.name !== clinic.name ||
      seen.vet_name !== clinic.vet_name ||
      seen.license_no !== clinic.license_no
    ) {
      throw new ApiError(409, 'clinic_changed');
    }
    await db.updateTable('clinics').set({ status: 'approved' }).where('id', '=', clinic.id).execute();
    return { clinic: clinicJson(await findClinic(db, request.params)) };
  });

  // Listeden kalkan kliniğin yaklaşan randevuları iptal olur, sahipler boşuna gitmez.
  app.post('/clinics/:id/reject', async (request) => {
    const clinic = await findClinic(db, request.params);
    await db.updateTable('clinics').set({ status: 'rejected' }).where('id', '=', clinic.id).execute();
    await cancelUpcomingOfClinic(db, hub, clinic.id);
    return { clinic: clinicJson(await findClinic(db, request.params)) };
  });
}
