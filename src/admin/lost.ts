import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { IdParams } from '../clinics/schema.ts';
import type { Deps } from '../deps.ts';
import { ApiError, parse } from '../http.ts';
import { takeDownReport } from '../lost/cleanup.ts';
import { Offset, pageOf, PAGE_SIZE } from './paging.ts';

const ListQuery = z.object({ state: z.enum(['open', 'closed']).default('open'), offset: Offset });

// Denetim için gerekenler. Tam konum dönmez: uygunsuz içerik yazıdan ve fotoğraftan anlaşılır,
// hayvanın evinin yakını olabilecek nokta yöneticiye de gerekmez.
export function registerAdminLostRoutes(app: FastifyInstance, { db, photos, hub }: Deps) {
  app.get('/lost-reports', async (request) => {
    const { state, offset } = parse(ListQuery, request.query);
    const rows = await db
      .selectFrom('lost_reports')
      .innerJoin('users', 'users.id', 'lost_reports.owner_id')
      .select([
        'lost_reports.id',
        'lost_reports.pet_name',
        'lost_reports.species',
        'lost_reports.breed',
        'lost_reports.description',
        'lost_reports.photo_path',
        'lost_reports.last_seen_area',
        'lost_reports.started_at',
        'lost_reports.found_at',
        'lost_reports.removed_at',
        'users.email as owner_email',
        'users.full_name as owner_name',
      ])
      .select((eb) =>
        eb
          .selectFrom('sightings')
          .select(eb.fn.countAll<number>().as('total'))
          .whereRef('sightings.report_id', '=', 'lost_reports.id')
          .as('sightings'),
      )
      .where('lost_reports.found_at', state === 'open' ? 'is' : 'is not', null)
      .orderBy('lost_reports.started_at', 'desc')
      .orderBy('lost_reports.id')
      .limit(PAGE_SIZE + 1)
      .offset(offset)
      .execute();
    const { items, has_more: hasMore } = pageOf(rows);
    return {
      reports: items.map((row) => ({ ...row, sightings: Number(row.sightings) })),
      has_more: hasMore,
    };
  });

  app.get('/lost-reports/:id/sightings', async (request) => {
    const { id } = parse(IdParams, request.params);
    const rows = await db
      .selectFrom('sightings')
      .select(['id', 'place', 'lat', 'message', 'contact', 'created_at'])
      .where('report_id', '=', id)
      .orderBy('created_at', 'desc')
      .limit(500)
      .execute();
    return {
      sightings: rows.map(({ lat, ...row }) => ({ ...row, has_location: lat !== null })),
    };
  });

  app.post('/lost-reports/:id/remove', async (request, reply) => {
    const { id } = parse(IdParams, request.params);
    if (!(await takeDownReport(db, photos, hub, id))) {
      throw new ApiError(404, 'not_found');
    }
    return reply.status(204).send();
  });

  app.delete('/sightings/:id', async (request, reply) => {
    const { id } = parse(IdParams, request.params);
    const { numDeletedRows } = await db.deleteFrom('sightings').where('id', '=', id).executeTakeFirst();
    if (numDeletedRows === 0n) {
      throw new ApiError(404, 'not_found');
    }
    return reply.status(204).send();
  });
}
