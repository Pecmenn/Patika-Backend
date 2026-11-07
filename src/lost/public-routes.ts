import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { z } from 'zod';

import type { Db } from '../db.ts';
import type { Deps } from '../deps.ts';
import { ApiError, parse } from '../http.ts';
import { PhotoName } from '../photos/routes.ts';
import { sightingJson } from './routes.ts';

const CodeParams = z.object({ code: z.string().regex(/^[0-9a-f]{12}$/) });
const HOURLY_LIMIT = 30;
const TOTAL_LIMIT = 500;

const NewSighting = z.object({
  place: z.string().max(80).nullish(),
  lat: z.number().min(-90).max(90).nullish(),
  lng: z.number().min(-180).max(180).nullish(),
  message: z.string().max(500).nullish(),
  contact: z.string().max(80).nullish(),
});

function cleanText(value: string | null | undefined) {
  return value?.trim() || null;
}

async function findTag(db: Db, params: unknown) {
  const parsed = CodeParams.safeParse(params);
  const tag = parsed.success
    ? await db
        .selectFrom('pet_tags')
        .innerJoin('users', 'users.id', 'pet_tags.owner_id')
        .select(['pet_tags.owner_id', 'pet_tags.pet_id'])
        .where('pet_tags.public_code', '=', parsed.data.code)
        // Kapatılan hesabın sayfası kapanır: bulan kişi kimsenin okuyamayacağı bir mesaj bırakmasın.
        .where('users.suspended_at', 'is', null)
        .executeTakeFirst()
    : undefined;
  if (!tag) {
    throw new ApiError(404, 'unknown_code');
  }
  return tag;
}

// Giriş gerektirmeyen uçlar. Tam konum, sahip ve ihbarlar buradan asla dönmez.
export function registerPublicLostRoutes(
  app: FastifyInstance,
  { db, photos, hub, rateLimits }: Deps,
) {
  app.get(
    '/v1/public/pets/:code',
    { config: { rateLimit: { max: rateLimits.publicRead, timeWindow: '1 minute' } } },
    async (request) => {
      const tag = await findTag(db, request.params);
      // Açık ilan varsa o, yoksa en son ilan.
      const report = await db
        .selectFrom('lost_reports')
        .select([
          'pet_name',
          'species',
          'breed',
          'description',
          'photo_path',
          'last_seen_area',
          'last_seen_at',
          'started_at',
          'found_at',
          'removed_at',
        ])
        .where('owner_id', '=', tag.owner_id)
        .where('pet_id', '=', tag.pet_id)
        .orderBy(sql`found_at IS NULL`, 'desc')
        .orderBy('started_at', 'desc')
        .limit(1)
        .executeTakeFirst();

      // Yöneticinin kaldırdığı ilan sayfada hiç görünmez, eski bir ilana da dönülmez.
      if (!report || report.removed_at) {
        return { status: 'none' };
      }
      // Bulunan ilanda yalnızca ad ve durum kalır.
      if (report.found_at) {
        return { status: 'found', pet_name: report.pet_name };
      }
      const { found_at: _found, removed_at: _removed, ...visible } = report;
      return { status: 'lost', ...visible };
    },
  );

  app.post(
    '/v1/public/pets/:code/sightings',
    { config: { rateLimit: { max: rateLimits.publicWrite, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const tag = await findTag(db, request.params);
      const body = parse(NewSighting, request.body);
      const place = cleanText(body.place);
      const message = cleanText(body.message);
      const contact = cleanText(body.contact);
      const lat = body.lat ?? null;
      const lng = body.lng ?? null;

      if ((lat === null) !== (lng === null)) {
        throw new ApiError(400, 'invalid_location');
      }
      if (!place && !message && lat === null) {
        throw new ApiError(400, 'empty_sighting');
      }

      const active = await db
        .selectFrom('lost_reports')
        .select(['id', 'started_at'])
        .where('owner_id', '=', tag.owner_id)
        .where('active_pet_id', '=', tag.pet_id)
        .executeTakeFirst();
      const reportId = active?.id ?? null;

      // Kötüye kullanıma karşı sınır: ilan ya da ilansız haberler için ayrı sayılır.
      // İlanın sayacı ilan açılınca başlar. Yoksa QR'ı bilen biri önceden bıraktığı haberlerle
      // sınırı doldurup hayvan gerçekten kaybolduğunda ihbarları engelleyebilirdi.
      let counting = db
        .selectFrom('sightings')
        .select((eb) => [
          eb.fn.countAll<number>().as('total'),
          sql<number>`COALESCE(SUM(created_at > NOW(3) - INTERVAL 1 HOUR), 0)`.as('last_hour'),
        ])
        .where('owner_id', '=', tag.owner_id)
        .where('pet_id', '=', tag.pet_id)
        .where('report_id', reportId === null ? 'is' : '=', reportId);
      if (active) {
        counting = counting.where('created_at', '>=', active.started_at);
      }
      const counts = await counting.executeTakeFirstOrThrow();
      if (Number(counts.last_hour) >= HOURLY_LIMIT || Number(counts.total) >= TOTAL_LIMIT) {
        throw new ApiError(429, 'too_many_sightings');
      }

      const id = randomUUID();
      await db
        .insertInto('sightings')
        .values({
          id,
          report_id: reportId,
          owner_id: tag.owner_id,
          pet_id: tag.pet_id,
          place,
          lat,
          lng,
          message,
          contact,
        })
        .execute();

      const row = await db
        .selectFrom('sightings')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirstOrThrow();
      hub.publish(tag.owner_id, { type: 'sighting', sighting: sightingJson(row) });
      return reply.status(201).send({ ok: true });
    },
  );

  app.get(
    '/v1/public/photos/:file',
    { config: { rateLimit: { max: rateLimits.publicRead, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const parsed = PhotoName.safeParse((request.params as { file: string }).file);
      const bytes = parsed.success ? await photos.readLostPhoto(parsed.data) : null;
      if (!bytes) {
        throw new ApiError(404, 'not_found');
      }
      // Kısa önbellek: bulununca silinen fotoğraf uzun süre dolaşmasın.
      return reply.type('image/jpeg').header('cache-control', 'public, max-age=300').send(bytes);
    },
  );
}
