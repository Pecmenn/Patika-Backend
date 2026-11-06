import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { Db } from '../db.ts';
import type { Deps } from '../deps.ts';
import { ApiError, parse } from '../http.ts';
import { PhotoName } from '../photos/routes.ts';
import { freeTimes } from './hours.ts';
import { IdParams } from './schema.ts';

// Klinik sayısı binleri geçerse bölgeye göre indirmeye geçilir (bkz. PROJE-PLANI.md).
const MAX_LIST = 2000;

// Herkese görünen alanlar. Sicil numarası, hesap ve onay durumu dışarı verilmez.
const PUBLIC_COLUMNS = [
  'id',
  'name',
  'vet_name',
  'phone',
  'address',
  'area',
  'lat',
  'lng',
  'hours',
  'slot_minutes',
  'species',
  'services',
  'description',
  'website',
  'instagram',
  'photo_path',
] as const;

async function findApproved(db: Db, params: unknown) {
  const { id } = parse(IdParams, params);
  const clinic = await db
    .selectFrom('clinics')
    .select(PUBLIC_COLUMNS)
    .where('id', '=', id)
    .where('status', '=', 'approved')
    .executeTakeFirst();
  if (!clinic) {
    throw new ApiError(404, 'not_found');
  }
  return clinic;
}

// Liste giriş istemez: Android'de girişsiz denenirken de görünür.
// Konum sunucuya hiç gelmez. Liste indirilir, yakınlık sıralaması telefonda yapılır.
export function registerPublicClinicRoutes(app: FastifyInstance, { db, photos, rateLimits }: Deps) {
  const options = { config: { rateLimit: { max: rateLimits.publicRead, timeWindow: '1 minute' } } };

  app.get('/v1/public/clinics', options, async () => ({
    clinics: await db
      .selectFrom('clinics')
      .select(PUBLIC_COLUMNS)
      .where('status', '=', 'approved')
      .orderBy('name')
      .limit(MAX_LIST)
      .execute(),
  }));

  app.get('/v1/public/clinics/:id', options, async (request) => ({
    clinic: await findApproved(db, request.params),
  }));

  // Yalnızca boş saatler döner, kimin randevusu olduğu görünmez.
  app.get('/v1/public/clinics/:id/slots', options, async (request) => {
    const clinic = await findApproved(db, request.params);
    const { date } = parse(z.object({ date: z.iso.date() }), request.query);
    return { times: await freeTimes(db, clinic, date) };
  });

  app.get('/v1/public/clinic-photos/:file', options, async (request, reply) => {
    const { file } = parse(z.object({ file: PhotoName }), request.params);
    const bytes = await photos.readClinicPhoto(file);
    if (!bytes) {
      throw new ApiError(404, 'not_found');
    }
    return reply.type('image/jpeg').header('cache-control', 'public, max-age=3600').send(bytes);
  });
}
