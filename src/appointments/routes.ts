import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { freeTimes, toInstant } from '../clinics/hours.ts';
import { IdParams, Phone, SPECIES, Time } from '../clinics/schema.ts';
import type { Deps } from '../deps.ts';
import { ApiError, parse } from '../http.ts';
import { APPOINTMENT_COLUMNS, appointmentJson } from './json.ts';
import { publishAppointment, removeVisit } from './lifecycle.ts';

// Bir sahip kliniklere sınırsız istek gönderip takvimleri dolduramasın.
const MAX_OPEN_REQUESTS = 5;
const MAX_LIST = 100;

const NewAppointment = z.object({
  clinic_id: z.uuid(),
  pet_id: z.string().min(1).max(100),
  pet_name: z.string().trim().min(1).max(30),
  species: z.enum(SPECIES),
  breed: z.string().trim().max(40).nullish(),
  pet_age: z.string().trim().max(30).nullish(),
  owner_name: z.string().trim().min(2).max(100),
  owner_phone: Phone,
  reason: z.string().trim().min(1).max(60),
  note: z.string().trim().max(500).nullish(),
  date: z.iso.date(),
  time: Time,
});

// Sahibin randevuları. Kliniğin telefonu ve adresi, klinik hesabını sildiyse boş döner.
export function registerAppointmentRoutes(app: FastifyInstance, { db, hub }: Deps) {
  app.get('/v1/appointments', async (request) => {
    const rows = await db
      .selectFrom('appointments')
      .leftJoin('clinics', 'clinics.id', 'appointments.clinic_id')
      .select([
        ...APPOINTMENT_COLUMNS,
        'clinics.phone as clinic_phone',
        'clinics.address as clinic_address',
      ])
      .where('appointments.owner_id', '=', request.userId)
      .orderBy('appointments.starts_at', 'desc')
      .limit(MAX_LIST)
      .execute();
    return { appointments: rows.map((row) => appointmentJson(row)) };
  });

  app.post('/v1/appointments', async (request, reply) => {
    const body = parse(NewAppointment, request.body);
    const clinic = await db
      .selectFrom('clinics')
      .select(['id', 'owner_id', 'name', 'hours', 'slot_minutes'])
      .where('id', '=', body.clinic_id)
      .where('status', '=', 'approved')
      .executeTakeFirst();
    if (!clinic) {
      throw new ApiError(404, 'not_found');
    }
    if (!(await freeTimes(db, clinic, body.date)).includes(body.time)) {
      throw new ApiError(409, 'slot_unavailable');
    }

    const now = new Date();
    const startsAt = toInstant(body.date, body.time);
    const open = await db
      .selectFrom('appointments')
      .select(['clinic_id', 'pet_id', 'starts_at'])
      .where('owner_id', '=', request.userId)
      .where('status', '=', 'pending')
      .where('starts_at', '>', now)
      .execute();
    const isRepeat = open.some(
      (row) =>
        row.clinic_id === clinic.id &&
        row.pet_id === body.pet_id &&
        row.starts_at.getTime() === startsAt.getTime(),
    );
    if (isRepeat) {
      throw new ApiError(409, 'already_requested');
    }
    if (open.length >= MAX_OPEN_REQUESTS) {
      throw new ApiError(429, 'too_many_requests');
    }

    const appointment = {
      id: randomUUID(),
      clinic_id: clinic.id,
      clinic_name: clinic.name,
      owner_id: request.userId,
      pet_id: body.pet_id,
      pet_name: body.pet_name,
      species: body.species,
      breed: body.breed || null,
      pet_age: body.pet_age || null,
      owner_name: body.owner_name,
      owner_phone: body.owner_phone,
      reason: body.reason,
      note: body.note || null,
      starts_at: startsAt,
      cancelled_by: null,
      vet_note: null,
    };
    await db.insertInto('appointments').values(appointment).execute();
    publishAppointment(hub, clinic.owner_id, 'pending', appointment);
    return reply.status(201).send({ id: appointment.id });
  });

  app.post('/v1/appointments/:id/cancel', async (request, reply) => {
    const { id } = parse(IdParams, request.params);
    const appointment = await db
      .selectFrom('appointments')
      .select(['id', 'owner_id', 'clinic_id', 'clinic_name', 'pet_name', 'starts_at', 'status'])
      .where('id', '=', id)
      .where('owner_id', '=', request.userId)
      .executeTakeFirst();
    if (!appointment) {
      throw new ApiError(404, 'not_found');
    }
    const now = new Date();
    const isOpen = appointment.status === 'pending' || appointment.status === 'confirmed';
    if (!isOpen || appointment.starts_at <= now) {
      throw new ApiError(409, 'not_cancellable');
    }
    await db.transaction().execute(async (trx) => {
      await trx
        .updateTable('appointments')
        .set({ status: 'cancelled', cancelled_by: 'owner', responded_at: now })
        .where('id', '=', id)
        .execute();
      if (appointment.status === 'confirmed') {
        await removeVisit(trx, request.userId, id);
      }
    });
    if (appointment.clinic_id) {
      const clinic = await db
        .selectFrom('clinics')
        .select('owner_id')
        .where('id', '=', appointment.clinic_id)
        .executeTakeFirst();
      if (clinic) {
        publishAppointment(hub, clinic.owner_id, 'cancelled', appointment);
      }
    }
    return reply.status(204).send();
  });
}
