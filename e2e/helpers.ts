import { readFile } from 'node:fs/promises';

import type { APIRequestContext, Page } from '@playwright/test';

const PET_PHOTO = readFile(new URL('./fixtures/pet.jpg', import.meta.url));

// Ekran görüntüleri her seferinde aynı olsun diye sabit tarih.
export const LAST_SEEN = '2026-11-01T15:40:00.000Z';

export type Owner = { token: string; api: APIRequestContext };

export async function newOwner(api: APIRequestContext): Promise<Owner> {
  const response = await api.post('/v1/auth/dev');
  const { token } = (await response.json()) as { token: string };
  return { token, api };
}

const auth = (owner: Owner) => ({ authorization: `Bearer ${owner.token}` });

export async function publicCode(owner: Owner, petId: string) {
  const response = await owner.api.get(`/v1/pets/${petId}/public-code`, { headers: auth(owner) });
  return ((await response.json()) as { public_code: string }).public_code;
}

type ReportOptions = {
  petId?: string;
  name?: string;
  species?: string;
  breed?: string | null;
  description?: string | null;
  area?: string;
  withPhoto?: boolean;
};

export async function openReport(owner: Owner, options: ReportOptions = {}) {
  const petId = options.petId ?? 'zeytin';
  const created = await owner.api.post('/v1/lost-reports', {
    headers: auth(owner),
    data: {
      pet_id: petId,
      pet_name: options.name ?? 'Zeytin',
      species: options.species ?? 'dog',
      breed: options.breed === undefined ? 'Melez' : options.breed,
      description:
        options.description === undefined
          ? 'Mavi tasmalı, çekingen. Lütfen kovalamayın.'
          : options.description,
      last_seen_area: options.area ?? 'Moda, Kadıköy',
      last_seen_lat: 40.987654,
      last_seen_lng: 29.123456,
      last_seen_at: LAST_SEEN,
    },
  });
  const { id } = (await created.json()) as { id: string };
  if (options.withPhoto) {
    await owner.api.put(`/v1/lost-reports/${id}/photo`, {
      headers: { ...auth(owner), 'content-type': 'image/jpeg' },
      data: await PET_PHOTO,
    });
  }
  return { id, code: await publicCode(owner, petId) };
}

export async function markFound(owner: Owner, id: string) {
  await owner.api.post(`/v1/lost-reports/${id}/found`, { headers: auth(owner) });
}

export async function sightingsOf(owner: Owner, id: string) {
  const response = await owner.api.get(`/v1/lost-reports/${id}`, { headers: auth(owner) });
  return ((await response.json()) as { sightings: Record<string, unknown>[] }).sightings;
}

export async function messagesOf(owner: Owner) {
  const response = await owner.api.get('/v1/pet-messages', { headers: auth(owner) });
  return ((await response.json()) as { messages: Record<string, unknown>[] }).messages;
}

// Tarih sabitlenir: "az önce" yazısı ve tarih her çalıştırmada aynı kalır.
export async function freezeClock(page: Page) {
  await page.clock.setFixedTime(new Date('2026-01-01T09:00:00.000Z'));
}

// Sayfa yazı tipleri ve fotoğraf yüklenene kadar bekler, ekran görüntüsü yarım kalmasın.
export async function settle(page: Page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(
      [...document.images].map((image) =>
        image.complete ? null : new Promise((resolve) => (image.onload = image.onerror = resolve)),
      ),
    );
  });
}

export function failGeolocation(page: Page, code: 1 | 2) {
  return page.addInitScript((errorCode) => {
    navigator.geolocation.getCurrentPosition = (_success, error) => {
      error?.({
        code: errorCode,
        message: 'test',
        PERMISSION_DENIED: 1,
        POSITION_UNAVAILABLE: 2,
        TIMEOUT: 3,
      });
    };
  }, code);
}

export function fakeGeolocation(page: Page, latitude: number, longitude: number) {
  return page.addInitScript(
    ([lat, lng]) => {
      navigator.geolocation.getCurrentPosition = (success) => {
        success({
          coords: {
            latitude: lat,
            longitude: lng,
            accuracy: 10,
            altitude: null,
            altitudeAccuracy: null,
            heading: null,
            speed: null,
          },
          timestamp: Date.now(),
        } as GeolocationPosition);
      };
    },
    [latitude, longitude],
  );
}
