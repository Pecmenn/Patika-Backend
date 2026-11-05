import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { z } from 'zod';

import type { Deps } from '../deps.ts';
import { ApiError, parse } from '../http.ts';
import { removePetLostData } from '../lost/cleanup.ts';

const COLLECTIONS = ['pets', 'health_records', 'visits', 'tasks', 'weights', 'weight_ranges'] as const;
// Her gün yapılan görevin tarih listesi yıllar içinde büyür, sınır buna göre geniş tutuldu.
const MAX_ITEM_BYTES = 64 * 1024;
const MAX_BATCH = 200;
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const DEFAULT_PAGE = 500;
const MAX_PAGE = 1000;
// Telefonun saati ileride olabilir. Sınırlanmazsa o kayıt sonraki tüm düzenlemeleri "eski" sayar.
const MAX_CLOCK_AHEAD_MS = 5 * 60 * 1000;

const Item = z.object({
  collection: z.enum(COLLECTIONS),
  id: z.string().min(1).max(100),
  // Boş veri kaydın silindiği anlamına gelir.
  data: z.record(z.string(), z.unknown()).nullable(),
  updated_at: z.iso.datetime(),
});

const PushBody = z.object({ items: z.array(Item).min(1).max(MAX_BATCH) });

const PullQuery = z.object({
  since: z.iso.datetime().optional(),
  after: z.string().max(400).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE).default(DEFAULT_PAGE),
});

const PageKey = z.tuple([z.iso.datetime(), z.string(), z.string()]);

function encodeKey(syncedAt: Date, collection: string, id: string) {
  return Buffer.from(JSON.stringify([syncedAt.toISOString(), collection, id])).toString('base64url');
}

function decodeKey(key: string) {
  try {
    return parse(PageKey, JSON.parse(Buffer.from(key, 'base64url').toString()));
  } catch {
    throw new ApiError(400, 'invalid_request');
  }
}

// Eşlenmemiş yarım emoji metinde kalırsa MySQL kaydı reddeder ve eşitleme takılır.
const LONE_SURROGATE = /\\ud[89ab][0-9a-f]{2}(?!\\ud[c-f][0-9a-f]{2})|(?<!\\ud[89ab][0-9a-f]{2})\\ud[c-f][0-9a-f]{2}/gi;

export function registerSyncRoutes(app: FastifyInstance, { db, photos }: Deps) {
  app.get('/v1/items', async (request) => {
    const { since, after, limit } = parse(PullQuery, request.query);

    let query = db
      .selectFrom('user_items')
      .select(['collection', 'id', 'data', 'deleted', 'updated_at', 'synced_at'])
      .where('owner_id', '=', request.userId);

    if (after) {
      const [syncedAt, collection, id] = decodeKey(after);
      const pageStart = new Date(syncedAt);
      query = query.where((eb) =>
        eb.or([
          eb('synced_at', '>', pageStart),
          eb.and([
            eb('synced_at', '=', pageStart),
            eb.or([
              eb('collection', '>', collection),
              eb.and([eb('collection', '=', collection), eb('id', '>', id)]),
            ]),
          ]),
        ]),
      );
    } else if (since) {
      query = query.where('synced_at', '>', new Date(since));
    }

    const rows = await query
      .orderBy('synced_at')
      .orderBy('collection')
      .orderBy('id')
      .limit(limit + 1)
      .execute();

    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map((row) => ({ ...row, deleted: Boolean(row.deleted) })),
      next: rows.length > limit && last ? encodeKey(last.synced_at, last.collection, last.id) : null,
    };
  });

  app.put('/v1/items', { bodyLimit: MAX_BODY_BYTES }, async (request) => {
    const { items } = parse(PushBody, request.body);
    const latestAllowed = Date.now() + MAX_CLOCK_AHEAD_MS;
    const encoded = items.map((item) => {
      const data = item.data === null ? null : JSON.stringify(item.data).replace(LONE_SURROGATE, '\\ufffd');
      if (data !== null && Buffer.byteLength(data) > MAX_ITEM_BYTES) {
        throw new ApiError(413, 'too_large');
      }
      return { ...item, data, updatedAt: new Date(Math.min(Date.parse(item.updated_at), latestAllowed)) };
    });

    const rows = sql.join(
      encoded.map(
        (item) =>
          sql`(${request.userId}, ${item.collection}, ${item.id}, CAST(${item.data} AS JSON), ${item.data === null}, ${item.updatedAt})`,
      ),
    );

    // Son değişiklik kazanır: telefondan gelen kayıt eskiyse sunucudaki olduğu gibi kalır.
    // updated_at en sonda: MySQL atamaları sırayla yapar, önceki satırlar eski değeri görmeli.
    await sql`
      INSERT INTO user_items (owner_id, collection, id, data, deleted, updated_at)
      VALUES ${rows} AS incoming
      ON DUPLICATE KEY UPDATE
        data = IF(incoming.updated_at >= user_items.updated_at, incoming.data, user_items.data),
        deleted = IF(incoming.updated_at >= user_items.updated_at, incoming.deleted, user_items.deleted),
        synced_at = IF(incoming.updated_at >= user_items.updated_at, CURRENT_TIMESTAMP(3), user_items.synced_at),
        updated_at = GREATEST(incoming.updated_at, user_items.updated_at)
    `.execute(db);

    // Hayvan başka telefondan ya da internetsiz silinmiş olabilir: QR'ı, ilanları ve ihbarları da
    // burada temizlenir, yoksa QR çalışmaya ve haber almaya devam ederdi.
    const removedPets = items.filter((item) => item.collection === 'pets' && item.data === null);
    if (removedPets.length > 0) {
      const confirmed = await db
        .selectFrom('user_items')
        .select('id')
        .where('owner_id', '=', request.userId)
        .where('collection', '=', 'pets')
        .where('deleted', '=', 1)
        .where('id', 'in', removedPets.map((item) => item.id))
        .execute();
      for (const { id } of confirmed) {
        await removePetLostData(db, photos, request.userId, id);
      }
    }

    return { accepted: items.length };
  });
}
