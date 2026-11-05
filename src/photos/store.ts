import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export type PhotoStore = ReturnType<typeof createPhotoStore>;

async function readIfExists(path: string) {
  try {
    return await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

// Fotoğraflar diskte iki ayrı klasörde durur:
// pets/<kullanıcı>/ yalnızca giriş yapmış sahibine, lost/ ise herkese açık ilan fotoğraflarına.
// Dosya adları buraya gelmeden önce denetlenmiş olmalı (bkz. photos/routes.ts).
export function createPhotoStore(root: string) {
  const petDir = (userId: string) => join(root, 'pets', userId);
  const lostDir = join(root, 'lost');

  return {
    async savePetPhoto(userId: string, name: string, bytes: Buffer) {
      await mkdir(petDir(userId), { recursive: true });
      await writeFile(join(petDir(userId), name), bytes);
    },
    readPetPhoto: (userId: string, name: string) => readIfExists(join(petDir(userId), name)),
    deletePetPhoto: (userId: string, name: string) =>
      rm(join(petDir(userId), name), { force: true }),
    deleteAllPetPhotos: (userId: string) => rm(petDir(userId), { recursive: true, force: true }),

    async saveLostPhoto(bytes: Buffer) {
      await mkdir(lostDir, { recursive: true });
      // Rastgele ad: bağlantıyı bilmeyen fotoğrafı tahmin edemez.
      const file = `${randomUUID()}.jpg`;
      await writeFile(join(lostDir, file), bytes);
      return file;
    },
    readLostPhoto: (file: string) => readIfExists(join(lostDir, file)),
    deleteLostPhoto: (file: string) => rm(join(lostDir, file), { force: true }),
  };
}
