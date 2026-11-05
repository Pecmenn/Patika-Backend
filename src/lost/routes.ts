import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import type { Selectable } from 'kysely';
import { z } from 'zod';

import { isDuplicateKey, type LostReportsTable, type SightingsTable } from '../db.ts';
import type { Deps } from '../deps.ts';
import { ApiError, parse } from '../http.ts';
import { stripJpegMetadata } from '../photos/jpeg.ts';
import { assertJpeg } from '../photos/routes.ts';
import { removePetLostData } from './cleanup.ts';
import { ensurePublicCode } from './tags.ts';

const PetId = z.string().min(1).max(100);
const IdParams = z.object({ id: z.uuid() });
const PetParams = z.object({ petId: PetId });

const NewReport = z.object({
  pet_id: PetId,
  pet_name: z.string().trim().min(1).max(30),
  species: z.enum(['cat', 'dog', 'rabbit', 'bird']),
  breed: z.string().trim().max(40).nullish(),
  description: z.string().trim().max(300).nullish(),
  last_seen_area: z.string().trim().min(1).max(80),
  last_seen_lat: z.number().min(-90).max(90),
  last_seen_lng: z.number().min(-180).max(180),
  last_seen_at: z.iso.datetime(),
});

export function reportJson(row: Selectable<LostReportsTable>) {
  const { owner_id: _owner, active_pet_id: _active, ...visible } = row;
  return visible;
}

export function sightingJson(row: Selectable<SightingsTable>) {
  const { owner_id: _owner, ...visible } = row;
  return visible;
}

export function registerLostRoutes(app: FastifyInstance, { db, photos }: Deps) {
  app.get('/v1/lost-reports', async (request) => {
    const { active } = parse(
      z.object({ active: z.enum(['true', 'false']).optional() }),
      request.query,
    );
    let query = db
      .selectFrom('lost_reports')
      .selectAll()
      .where('owner_id', '=', request.userId)
      .orderBy('started_at', 'desc');
    if (active === 'true') {
      query = query.where('found_at', 'is', null);
    }
    return { reports: (await query.execute()).map(reportJson) };
  });

  app.post('/v1/lost-reports', async (request, reply) => {
    const body = parse(NewReport, request.body);
    const ownerId = request.userId;
    await ensurePublicCode(db, ownerId, body.pet_id);

    const openReport = async () => {
      const open = await db
        .selectFrom('lost_reports')
        .select(['id', 'photo_path'])
        .where('owner_id', '=', ownerId)
        .where('active_pet_id', '=', body.pet_id)
        .executeTakeFirstOrThrow();
      // Önceki başlatma yarım kaldıysa uygulama fotoğrafı yeniden göndersin diye bildirilir.
      return { id: open.id, already_open: true, has_photo: open.photo_path !== null };
    };

    const id = randomUUID();
    try {
      await db.transaction().execute(async (trx) => {
        await trx
          .insertInto('lost_reports')
          .values({
            id,
            owner_id: ownerId,
            pet_id: body.pet_id,
            pet_name: body.pet_name,
            species: body.species,
            breed: body.breed || null,
            description: body.description || null,
            last_seen_area: body.last_seen_area,
            last_seen_lat: body.last_seen_lat,
            last_seen_lng: body.last_seen_lng,
            last_seen_at: new Date(body.last_seen_at),
          })
          .execute();
        // Daha önce gelen haberler ilana eklenir, haritada görünür.
        await trx
          .updateTable('sightings')
          .set({ report_id: id })
          .where('owner_id', '=', ownerId)
          .where('pet_id', '=', body.pet_id)
          .where('report_id', 'is', null)
          .execute();
      });
    } catch (error) {
      // Bu hayvanın zaten açık bir ilanı varsa yenisi açılmaz, ona gidilir.
      if (isDuplicateKey(error)) {
        return reply.status(200).send(await openReport());
      }
      throw error;
    }
    return reply.status(201).send({ id, already_open: false, has_photo: false });
  });

  app.get('/v1/lost-reports/:id', async (request) => {
    const { id } = parse(IdParams, request.params);
    const report = await db
      .selectFrom('lost_reports')
      .selectAll()
      .where('id', '=', id)
      .where('owner_id', '=', request.userId)
      .executeTakeFirst();
    if (!report) {
      throw new ApiError(404, 'not_found');
    }
    const sightings = await db
      .selectFrom('sightings')
      .selectAll()
      .where('report_id', '=', id)
      .where('owner_id', '=', request.userId)
      .orderBy('created_at', 'desc')
      .execute();
    return {
      report: reportJson(report),
      sightings: sightings.map(sightingJson),
      public_code: await ensurePublicCode(db, request.userId, report.pet_id),
    };
  });

  // İlan fotoğrafı herkese açıktır. Yalnızca açık ilana eklenebilir.
  app.put('/v1/lost-reports/:id/photo', async (request, reply) => {
    const { id } = parse(IdParams, request.params);
    assertJpeg(request.body);
    const report = await db
      .selectFrom('lost_reports')
      .select('photo_path')
      .where('id', '=', id)
      .where('owner_id', '=', request.userId)
      .where('found_at', 'is', null)
      .executeTakeFirst();
    if (!report) {
      throw new ApiError(404, 'not_found');
    }
    const file = await photos.saveLostPhoto(stripJpegMetadata(request.body));
    const { numUpdatedRows } = await db
      .updateTable('lost_reports')
      .set({ photo_path: file })
      .where('id', '=', id)
      .where('found_at', 'is', null)
      .executeTakeFirst();
    // Yükleme sürerken ilan kapandıysa fotoğraf herkese açık kalmasın.
    if (numUpdatedRows === 0n) {
      await photos.deleteLostPhoto(file);
      throw new ApiError(404, 'not_found');
    }
    if (report.photo_path) {
      await photos.deleteLostPhoto(report.photo_path);
    }
    return reply.status(204).send();
  });

  // Bulununca herkese açık fotoğraf silinir.
  app.post('/v1/lost-reports/:id/found', async (request, reply) => {
    const { id } = parse(IdParams, request.params);
    const report = await db
      .selectFrom('lost_reports')
      .select(['photo_path', 'found_at'])
      .where('id', '=', id)
      .where('owner_id', '=', request.userId)
      .executeTakeFirst();
    if (!report) {
      throw new ApiError(404, 'not_found');
    }
    if (!report.found_at) {
      await db
        .updateTable('lost_reports')
        .set({ found_at: new Date(), photo_path: null })
        .where('id', '=', id)
        .execute();
    }
    if (report.photo_path) {
      await photos.deleteLostPhoto(report.photo_path);
    }
    return reply.status(204).send();
  });

  app.get('/v1/pets/:petId/public-code', async (request) => {
    const { petId } = parse(PetParams, request.params);
    return { public_code: await ensurePublicCode(db, request.userId, petId) };
  });

  // Hayvan silinince ona ait her şey gider: ilanlar, fotoğraflar, ihbarlar ve kod.
  app.delete('/v1/pets/:petId/lost-data', async (request, reply) => {
    const { petId } = parse(PetParams, request.params);
    await removePetLostData(db, photos, request.userId, petId);
    return reply.status(204).send();
  });

  // Kayıp modu kapalıyken QR'dan gelen haberler.
  app.get('/v1/pet-messages', async (request) => {
    const rows = await db
      .selectFrom('sightings')
      .selectAll()
      .where('owner_id', '=', request.userId)
      .where('report_id', 'is', null)
      .orderBy('created_at', 'desc')
      .execute();
    return { messages: rows.map(sightingJson) };
  });

  app.delete('/v1/pets/:petId/messages', async (request, reply) => {
    const { petId } = parse(PetParams, request.params);
    await db
      .deleteFrom('sightings')
      .where('owner_id', '=', request.userId)
      .where('pet_id', '=', petId)
      .where('report_id', 'is', null)
      .execute();
    return reply.status(204).send();
  });
}
