import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { Deps } from '../deps.ts';
import { ApiError, parse } from '../http.ts';

export const MAX_PHOTO_BYTES = 5 * 1024 * 1024;

// Dosya adında klasör ayracı ya da ".." olamaz: başka bir dosyaya ulaşılmasın.
export const PhotoName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/);
const PhotoParams = z.object({ name: PhotoName });

// Yalnızca JPEG kabul edilir. Dosyanın ilk baytlarına bakılır, gönderenin beyanına değil.
export function assertJpeg(body: unknown): asserts body is Buffer {
  if (
    !Buffer.isBuffer(body) ||
    body.length < 3 ||
    body[0] !== 0xff ||
    body[1] !== 0xd8 ||
    body[2] !== 0xff
  ) {
    throw new ApiError(400, 'invalid_photo');
  }
}

export function registerPhotoRoutes(app: FastifyInstance, { photos }: Deps) {
  app.put('/v1/photos/:name', async (request, reply) => {
    const { name } = parse(PhotoParams, request.params);
    assertJpeg(request.body);
    await photos.savePetPhoto(request.userId, name, request.body);
    return reply.status(204).send();
  });

  app.get('/v1/photos/:name', async (request, reply) => {
    const { name } = parse(PhotoParams, request.params);
    const bytes = await photos.readPetPhoto(request.userId, name);
    if (!bytes) {
      throw new ApiError(404, 'not_found');
    }
    return reply.type('image/jpeg').header('cache-control', 'private, no-store').send(bytes);
  });

  app.delete('/v1/photos/:name', async (request, reply) => {
    const { name } = parse(PhotoParams, request.params);
    await photos.deletePetPhoto(request.userId, name);
    return reply.status(204).send();
  });
}
