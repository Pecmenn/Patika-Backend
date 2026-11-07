import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { cancelUpcomingOfClinic, cancelUpcomingOfOwner } from '../appointments/lifecycle.ts';
import { providerOf } from '../auth/routes.ts';
import { IdParams } from '../clinics/schema.ts';
import type { Deps } from '../deps.ts';
import { ApiError, parse } from '../http.ts';
import { takeDownReport } from '../lost/cleanup.ts';
import { Offset, pageOf, PAGE_SIZE } from './paging.ts';

const ListQuery = z.object({
  q: z.string().trim().max(100).default(''),
  filter: z.enum(['all', 'owner', 'vet', 'suspended']).default('all'),
  offset: Offset,
});

// Arama metnindeki % ve _ joker karakter sayılmasın.
function likePattern(text: string) {
  return `%${text.replace(/[\\%_]/g, '\\$&')}%`;
}

function displayName(row: {
  full_name: string | null;
  given_name: string | null;
  family_name: string | null;
}) {
  return row.full_name || [row.given_name, row.family_name].filter(Boolean).join(' ') || null;
}

// Yalnızca hesabı tanımaya ve yönetmeye yarayan bilgiler. Sağlık kayıtları, hayvanların bilgileri,
// şifre ve Apple kimliği buradan dönmez. Hayvanlar yalnızca sayı olarak görünür.
export function registerAdminUserRoutes(app: FastifyInstance, { db, photos, hub }: Deps) {
  app.get('/users', async (request) => {
    const { q, filter, offset } = parse(ListQuery, request.query);
    const now = new Date();
    let query = db
      .selectFrom('users')
      .leftJoin('clinics', 'clinics.owner_id', 'users.id')
      .select([
        'users.id',
        'users.role',
        'users.apple_sub',
        'users.email',
        'users.full_name',
        'users.given_name',
        'users.family_name',
        'users.created_at',
        'users.suspended_at',
        'clinics.name as clinic_name',
        'clinics.status as clinic_status',
      ])
      .select((eb) => [
        eb
          .selectFrom('sessions')
          .select((inner) => inner.fn.max('sessions.last_used_at').as('value'))
          .whereRef('sessions.user_id', '=', 'users.id')
          .as('last_seen_at'),
        eb
          .selectFrom('user_items')
          .select(eb.fn.countAll<number>().as('total'))
          .whereRef('user_items.owner_id', '=', 'users.id')
          .where('user_items.collection', '=', 'pets')
          .where('user_items.deleted', '=', 0)
          .as('pets'),
        eb
          .selectFrom('lost_reports')
          .select(eb.fn.countAll<number>().as('total'))
          .whereRef('lost_reports.owner_id', '=', 'users.id')
          .where('lost_reports.found_at', 'is', null)
          .as('open_reports'),
        eb
          .selectFrom('appointments')
          .select(eb.fn.countAll<number>().as('total'))
          .whereRef('appointments.owner_id', '=', 'users.id')
          .where('appointments.status', 'in', ['pending', 'confirmed'])
          .where('appointments.starts_at', '>', now)
          .as('upcoming_appointments'),
      ])
      .orderBy('users.created_at', 'desc')
      .orderBy('users.id')
      .limit(PAGE_SIZE + 1)
      .offset(offset);

    if (q) {
      const pattern = likePattern(q);
      query = query.where((eb) =>
        eb.or([
          eb('users.email', 'like', pattern),
          eb('users.full_name', 'like', pattern),
          eb('users.given_name', 'like', pattern),
          eb('users.family_name', 'like', pattern),
          eb('clinics.name', 'like', pattern),
        ]),
      );
    }
    if (filter === 'suspended') {
      query = query.where('users.suspended_at', 'is not', null);
    } else if (filter !== 'all') {
      query = query.where('users.role', '=', filter);
    }

    const { items, has_more: hasMore } = pageOf(await query.execute());
    return {
      users: items.map((row) => ({
        id: row.id,
        role: row.role,
        provider: providerOf(row.role, row.apple_sub),
        email: row.email,
        name: displayName(row),
        created_at: row.created_at,
        suspended_at: row.suspended_at,
        last_seen_at: row.last_seen_at,
        clinic_name: row.clinic_name,
        clinic_status: row.clinic_status,
        pets: Number(row.pets),
        open_reports: Number(row.open_reports),
        upcoming_appointments: Number(row.upcoming_appointments),
      })),
      has_more: hasMore,
    };
  });

  // Hesap kapatma geri alınabilir, veri silinmez. Adımlar yarıda kalırsa tekrar çağrılabilir:
  // panelde hesabı açıp yeniden kapatmak kalan adımları tamamlar.
  app.post('/users/:id/suspend', async (request, reply) => {
    const { id } = parse(IdParams, request.params);
    const user = await db
      .selectFrom('users')
      .select('suspended_at')
      .where('id', '=', id)
      .executeTakeFirst();
    if (!user) {
      throw new ApiError(404, 'not_found');
    }
    await db.transaction().execute(async (trx) => {
      await trx
        .updateTable('users')
        .set({ suspended_at: user.suspended_at ?? new Date() })
        .where('id', '=', id)
        .execute();
      await trx.deleteFrom('sessions').where('user_id', '=', id).execute();
      // Klinik hesapla aynı işlemde listeden kalkar: sonraki adım hata verse de listede kalmaz.
      await trx.updateTable('clinics').set({ status: 'rejected' }).where('owner_id', '=', id).execute();
    });
    hub.closeUser(id);

    const clinic = await db
      .selectFrom('clinics')
      .select('id')
      .where('owner_id', '=', id)
      .executeTakeFirst();
    if (clinic) {
      await cancelUpcomingOfClinic(db, hub, clinic.id);
    }
    await cancelUpcomingOfOwner(db, hub, id);

    const openReports = await db
      .selectFrom('lost_reports')
      .select('id')
      .where('owner_id', '=', id)
      .where('found_at', 'is', null)
      .execute();
    for (const report of openReports) {
      await takeDownReport(db, photos, hub, report.id);
    }
    return reply.status(204).send();
  });

  // Hesap yeniden girebilir. Kaldırılan ilan ve reddedilen klinik kendiliğinden geri gelmez.
  app.post('/users/:id/unsuspend', async (request, reply) => {
    const { id } = parse(IdParams, request.params);
    const { numUpdatedRows } = await db
      .updateTable('users')
      .set({ suspended_at: null })
      .where('id', '=', id)
      .executeTakeFirst();
    const exists =
      numUpdatedRows > 0n ||
      (await db.selectFrom('users').select('id').where('id', '=', id).executeTakeFirst());
    if (!exists) {
      throw new ApiError(404, 'not_found');
    }
    return reply.status(204).send();
  });
}
