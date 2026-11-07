import { sql } from 'kysely';

import type { Db } from '../db.ts';

const count = (expression: ReturnType<typeof sql.raw>) =>
  sql<string>`COALESCE(SUM(${expression}), 0)`;

// Yalnızca sayılar. Kişi bilgisi içermez.
export async function readSummary(db: Db) {
  const now = new Date();
  const [users, pets, clinics, reports, sightings, appointments] = await Promise.all([
    db
      .selectFrom('users')
      .select([
        count(sql.raw(`role = 'owner' AND suspended_at IS NULL`)).as('owners'),
        count(sql.raw(`role = 'vet' AND suspended_at IS NULL`)).as('vets'),
        count(sql.raw('suspended_at IS NOT NULL')).as('suspended'),
      ])
      .executeTakeFirstOrThrow(),
    db
      .selectFrom('user_items')
      .select((eb) => eb.fn.countAll<number>().as('total'))
      .where('collection', '=', 'pets')
      .where('deleted', '=', 0)
      .executeTakeFirstOrThrow(),
    db
      .selectFrom('clinics')
      .select([
        count(sql.raw(`status = 'pending'`)).as('pending'),
        count(sql.raw(`status = 'approved'`)).as('approved'),
        count(sql.raw(`status = 'rejected'`)).as('rejected'),
      ])
      .executeTakeFirstOrThrow(),
    db
      .selectFrom('lost_reports')
      .select([
        count(sql.raw('found_at IS NULL')).as('open'),
        count(sql.raw('found_at IS NOT NULL AND removed_at IS NULL')).as('found'),
        count(sql.raw('removed_at IS NOT NULL')).as('removed'),
      ])
      .executeTakeFirstOrThrow(),
    db
      .selectFrom('sightings')
      .select((eb) => eb.fn.countAll<number>().as('total'))
      .executeTakeFirstOrThrow(),
    db
      .selectFrom('appointments')
      .select((eb) => [
        eb.fn.countAll<number>().as('total'),
        sql<string>`COALESCE(SUM(status = 'pending' AND starts_at > ${now}), 0)`.as('pending'),
        sql<string>`COALESCE(SUM(status = 'confirmed' AND starts_at > ${now}), 0)`.as('confirmed'),
      ])
      .executeTakeFirstOrThrow(),
  ]);

  return {
    owners: Number(users.owners),
    vets: Number(users.vets),
    suspended: Number(users.suspended),
    pets: Number(pets.total),
    clinics_pending: Number(clinics.pending),
    clinics_approved: Number(clinics.approved),
    clinics_rejected: Number(clinics.rejected),
    reports_open: Number(reports.open),
    reports_found: Number(reports.found),
    reports_removed: Number(reports.removed),
    sightings: Number(sightings.total),
    appointments_pending: Number(appointments.pending),
    appointments_confirmed: Number(appointments.confirmed),
    appointments_total: Number(appointments.total),
  };
}
