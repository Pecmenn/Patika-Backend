import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { APPOINTMENT_COLUMNS, appointmentJson } from '../appointments/json.ts';
import { publishAppointment, removeVisit, writeVisit } from '../appointments/lifecycle.ts';
import { isDuplicateKey, type Db } from '../db.ts';
import type { Deps } from '../deps.ts';
import { ApiError, parse } from '../http.ts';
import { stripJpegMetadata } from '../photos/jpeg.ts';
import { assertJpeg } from '../photos/routes.ts';
import { ClinicBody, IdParams } from './schema.ts';

const MAX_LIST = 200;

const ListQuery = z.object({ scope: z.enum(['active', 'past']).default('active') });
const Response = z.object({
  note: z
    .string()
    .trim()
    .max(300)
    .nullish()
    .transform((value) => value || null),
});

function ownClinic(db: Db, userId: string) {
  return db.selectFrom('clinics').selectAll().where('owner_id', '=', userId).executeTakeFirst();
}

async function requireOwnClinic(db: Db, userId: string) {
  const clinic = await ownClinic(db, userId);
  if (!clinic) {
    throw new ApiError(404, 'no_clinic');
  }
  return clinic;
}

// Yalnızca bu kliniğin randevusu: başka kliniğinkine "yok" denir.
async function findOwnAppointment(db: Db, clinicId: string, params: unknown) {
  const { id } = parse(IdParams, params);
  const appointment = await db
    .selectFrom('appointments')
    .selectAll()
    .where('id', '=', id)
    .where('clinic_id', '=', clinicId)
    .executeTakeFirst();
  if (!appointment) {
    throw new ApiError(404, 'not_found');
  }
  return appointment;
}

// Veterinerin kendi işletmesi ve randevuları. Bu uçlara yalnızca veteriner hesabı girer.
export function registerClinicRoutes(app: FastifyInstance, { db, photos, hub }: Deps) {
  app.get('/v1/clinic', async (request) => ({
    clinic: (await ownClinic(db, request.userId)) ?? null,
  }));

  app.put('/v1/clinic', async (request) => {
    const body = parse(ClinicBody, request.body);
    const values = {
      ...body,
      hours: JSON.stringify(body.hours),
      species: JSON.stringify([...new Set(body.species)]),
      services: JSON.stringify([...new Set(body.services)]),
    };
    const existing = await ownClinic(db, request.userId);
    if (existing) {
      // Onaydan sonra kimlik bilgisi değişirse yeniden kontrol gerekir: onaylı kliniğin adı
      // başka bir kliniğe çevrilip listede kalamasın.
      const isSameIdentity =
        existing.name === body.name &&
        existing.vet_name === body.vet_name &&
        existing.license_no === body.license_no;
      // Onay sürüyorsa durum hiç yazılmaz: aynı anda verilen ret kararı geri alınmasın.
      const stays = existing.status === 'approved' && isSameIdentity;
      await db
        .updateTable('clinics')
        .set({ ...values, ...(stays ? {} : { status: 'pending' as const }) })
        .where('id', '=', existing.id)
        .execute();
    } else {
      try {
        await db
          .insertInto('clinics')
          .values({ ...values, id: randomUUID(), owner_id: request.userId, status: 'pending', photo_path: null })
          .execute();
      } catch (error) {
        if (isDuplicateKey(error)) {
          throw new ApiError(409, 'conflict');
        }
        throw error;
      }
    }
    return { clinic: await ownClinic(db, request.userId) };
  });

  app.put('/v1/clinic/photo', async (request) => {
    const clinic = await requireOwnClinic(db, request.userId);
    assertJpeg(request.body);
    // Fotoğraf herkese açık: içindeki GPS ve diğer üst veriler silinir.
    const file = await photos.saveClinicPhoto(stripJpegMetadata(request.body));
    await db.updateTable('clinics').set({ photo_path: file }).where('id', '=', clinic.id).execute();
    if (clinic.photo_path) {
      await photos.deleteClinicPhoto(clinic.photo_path);
    }
    return { photo_path: file };
  });

  app.get('/v1/clinic/appointments', async (request) => {
    const { scope } = parse(ListQuery, request.query);
    const clinic = await ownClinic(db, request.userId);
    if (!clinic) {
      return { appointments: [] };
    }
    const now = new Date();
    const base = db
      .selectFrom('appointments')
      .select(APPOINTMENT_COLUMNS)
      .where('appointments.clinic_id', '=', clinic.id);
    const rows =
      scope === 'active'
        ? await base
            .where('appointments.status', 'in', ['pending', 'confirmed'])
            .where('appointments.starts_at', '>', now)
            .orderBy('appointments.starts_at')
            .limit(MAX_LIST)
            .execute()
        : await base
            .where((eb) =>
              eb.or([
                eb('appointments.status', 'in', ['rejected', 'cancelled']),
                eb('appointments.starts_at', '<=', now),
              ]),
            )
            .orderBy('appointments.starts_at', 'desc')
            .limit(MAX_LIST)
            .execute();
    return { appointments: rows.map((row) => appointmentJson(row, now)) };
  });

  app.get('/v1/clinic/appointments/:id', async (request) => {
    const clinic = await requireOwnClinic(db, request.userId);
    const { id } = parse(IdParams, request.params);
    const row = await db
      .selectFrom('appointments')
      .select(APPOINTMENT_COLUMNS)
      .where('appointments.id', '=', id)
      .where('appointments.clinic_id', '=', clinic.id)
      .executeTakeFirst();
    if (!row) {
      throw new ApiError(404, 'not_found');
    }
    return { appointment: appointmentJson(row) };
  });

  app.post('/v1/clinic/appointments/:id/confirm', async (request) => {
    const clinic = await requireOwnClinic(db, request.userId);
    const appointment = await findOwnAppointment(db, clinic.id, request.params);
    const { note } = parse(Response, request.body ?? {});
    const now = new Date();
    if (appointment.status !== 'pending' || appointment.starts_at <= now) {
      throw new ApiError(409, 'not_pending');
    }
    try {
      await db.transaction().execute(async (trx) => {
        await trx
          .updateTable('appointments')
          .set({ status: 'confirmed', vet_note: note, responded_at: now })
          .where('id', '=', appointment.id)
          .execute();
        await writeVisit(trx, appointment);
      });
    } catch (error) {
      // Aynı saate başka bir randevu önce onaylanmış.
      if (isDuplicateKey(error)) {
        throw new ApiError(409, 'slot_taken');
      }
      throw error;
    }
    publishAppointment(hub, appointment.owner_id, 'confirmed', appointment);
    return { status: 'confirmed' };
  });

  app.post('/v1/clinic/appointments/:id/reject', async (request) => {
    const clinic = await requireOwnClinic(db, request.userId);
    const appointment = await findOwnAppointment(db, clinic.id, request.params);
    const { note } = parse(Response, request.body ?? {});
    if (appointment.status !== 'pending') {
      throw new ApiError(409, 'not_pending');
    }
    await db
      .updateTable('appointments')
      .set({ status: 'rejected', vet_note: note, responded_at: new Date() })
      .where('id', '=', appointment.id)
      .execute();
    publishAppointment(hub, appointment.owner_id, 'rejected', appointment);
    return { status: 'rejected' };
  });

  // Onaylanmış randevunun iptali: sahibin ziyaretlerinden de kalkar, saat yeniden boşalır.
  app.post('/v1/clinic/appointments/:id/cancel', async (request) => {
    const clinic = await requireOwnClinic(db, request.userId);
    const appointment = await findOwnAppointment(db, clinic.id, request.params);
    const { note } = parse(Response, request.body ?? {});
    const now = new Date();
    if (appointment.status !== 'confirmed' || appointment.starts_at <= now) {
      throw new ApiError(409, 'not_cancellable');
    }
    await db.transaction().execute(async (trx) => {
      await trx
        .updateTable('appointments')
        .set({ status: 'cancelled', cancelled_by: 'vet', vet_note: note, responded_at: now })
        .where('id', '=', appointment.id)
        .execute();
      await removeVisit(trx, appointment.owner_id, appointment.id);
    });
    publishAppointment(hub, appointment.owner_id, 'cancelled', appointment);
    return { status: 'cancelled' };
  });
}
