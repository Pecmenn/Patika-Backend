// Yönetim paneli senaryoları. Gerçek MySQL'de, ayrı test veritabanında: npm test
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { loggedUrl } from '../src/app.ts';
import { hashPassword } from '../src/auth/passwords.ts';
import { appleToken, JPEG, newReport, resetDatabase, startApp, type TestApp } from './helpers.ts';

let t: TestApp;
let counter = 0;
const ADMIN_EMAIL = 'yonetici@example.com';
const ADMIN_PASSWORD = 'yonetici-deneme-sifresi';
const OTHER_ID = '00000000-0000-4000-8000-000000000000';
const IDENTITY = { name: 'X', vet_name: 'X', license_no: 'X' };

async function createAdmin(app: TestApp, email: string, password: string) {
  await app.db
    .insertInto('admins')
    .values({ id: randomUUID(), email, password_hash: await hashPassword(password) })
    .execute();
}

function cookieOf(headers: Record<string, unknown>) {
  const value = String(headers['set-cookie'] ?? '');
  return value.split(';')[0] ?? '';
}

async function logIn(app: TestApp = t, email = ADMIN_EMAIL, password = ADMIN_PASSWORD) {
  const response = await app.call('POST', '/admin/api/login', { body: { email, password } });
  assert.equal(response.status, 200);
  return cookieOf(response.headers);
}

let cookie: string;

before(async () => {
  await resetDatabase();
  t = await startApp();
  await createAdmin(t, ADMIN_EMAIL, ADMIN_PASSWORD);
  cookie = await logIn();
});
after(() => t.stop());

const panel = (method: string, url: string, body?: unknown, extra: Record<string, string> = {}) =>
  t.call(method, `/admin/api${url}`, {
    headers: { cookie, ...extra },
    ...(body !== undefined ? { body } : {}),
  });

const WEEK = Array.from({ length: 7 }, () => ({ open: '09:00', close: '12:00' }));

function clinicBody(overrides: object = {}) {
  return {
    name: 'Moda Veteriner',
    vet_name: 'Dr. Selin Aydın',
    license_no: 'IST-12345',
    phone: '0216 555 11 22',
    address: 'Moda Cad. No: 10, Kadıköy',
    area: 'Moda, Kadıköy',
    lat: 40.987,
    lng: 29.025,
    hours: WEEK,
    slot_minutes: 30,
    species: ['cat', 'dog'],
    services: ['exam'],
    ...overrides,
  };
}

async function newVet(overrides: object = {}) {
  counter += 1;
  const email = `panel-vet${counter}@example.com`;
  const { json } = await t.call('POST', '/v1/auth/vet/register', {
    body: { email, password: 'gizli-sifre-1' },
  });
  const saved = await t.call('PUT', '/v1/clinic', { token: json.token, body: clinicBody(overrides) });
  return {
    token: json.token as string,
    id: json.user.id as string,
    email,
    clinicId: saved.json.clinic.id as string,
  };
}

function dayAfter(days: number) {
  return new Date(Date.now() + 3 * 3600_000 + days * 86_400_000).toISOString().slice(0, 10);
}

async function book(clinicId: string, owner: { token: string }, time = '09:30') {
  const { json, status } = await t.call('POST', '/v1/appointments', {
    token: owner.token,
    body: {
      clinic_id: clinicId,
      pet_id: `p-${randomUUID()}`,
      pet_name: 'Zeytin',
      species: 'dog',
      owner_name: 'Ayşe Yılmaz',
      owner_phone: '0532 555 00 11',
      reason: 'Aşı',
      date: dayAfter(3),
      time,
    },
  });
  assert.equal(status, 201);
  return json.id as string;
}

async function appointmentStatus(id: string) {
  const row = await t.db
    .selectFrom('appointments')
    .select(['status', 'cancelled_by'])
    .where('id', '=', id)
    .executeTakeFirstOrThrow();
  return row;
}

// Telefonun yedeklediği kayıtlar. Yazılamazsa "panelde görünmez" testleri boşuna geçer, bu yüzden denetlenir.
async function saveItems(owner: { token: string }, items: { collection: string; id: string; data: object }[]) {
  const { status } = await t.call('PUT', '/v1/items', {
    token: owner.token,
    body: { items: items.map((item) => ({ ...item, updated_at: new Date().toISOString() })) },
  });
  assert.equal(status, 200);
}

// Panelin yaptığı gibi: onay, yöneticinin o an gördüğü kimlik bilgileriyle gider.
async function approve(clinicId: string, extra: Record<string, string> = {}) {
  const seen = await t.db
    .selectFrom('clinics')
    .select(['name', 'vet_name', 'license_no'])
    .where('id', '=', clinicId)
    .executeTakeFirstOrThrow();
  return panel('POST', `/clinics/${clinicId}/approve`, seen, extra);
}

async function openListing(owner: { token: string }, overrides: object = {}, withPhoto = false) {
  const petId = `pet-${randomUUID()}`;
  const { json } = await t.call('POST', '/v1/lost-reports', {
    token: owner.token,
    body: newReport(petId, overrides),
  });
  if (withPhoto) {
    await t.call('PUT', `/v1/lost-reports/${json.id}/photo`, { token: owner.token, raw: JPEG });
  }
  const details = await t.call('GET', `/v1/lost-reports/${json.id}`, { token: owner.token });
  return { id: json.id as string, petId, code: details.json.public_code as string };
}

describe('panele giriş', () => {
  test('doğru şifre oturum açar, çerez korumalı gelir', async () => {
    const response = await t.call('POST', '/admin/api/login', {
      body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(response.json, { email: ADMIN_EMAIL });
    const setCookie = String(response.headers['set-cookie']);
    assert.match(setCookie, /^patika_admin=[\w-]{20,};/);
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Strict/);
    assert.match(setCookie, /Path=\/admin/);
    // Anahtarın kendisi veritabanına yazılmaz.
    const token = cookieOf(response.headers).split('=')[1]!;
    const rows = await t.db
      .selectFrom('admin_sessions')
      .select('token_hash')
      .where('token_hash', '=', token)
      .execute();
    assert.equal(rows.length, 0);
  });

  test('HTTPS arkasında çerez Secure olur', async () => {
    const proxied = await startApp({ config: { TRUST_PROXY: true } });
    try {
      const response = await proxied.call('POST', '/admin/api/login', {
        body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
        headers: { 'x-forwarded-proto': 'https' },
      });
      assert.equal(response.status, 200);
      assert.match(String(response.headers['set-cookie']), /; Secure/);
    } finally {
      await proxied.stop();
    }
  });

  test('yanlış şifre ve kayıtsız e-posta aynı cevabı alır', async () => {
    const wrong = await t.call('POST', '/admin/api/login', {
      body: { email: ADMIN_EMAIL, password: 'yanlis-sifre' },
    });
    const unknown = await t.call('POST', '/admin/api/login', {
      body: { email: 'yok@example.com', password: 'yanlis-sifre' },
    });
    assert.equal(wrong.status, 401);
    assert.deepEqual(wrong.json, { error: 'invalid_credentials' });
    assert.equal(unknown.status, 401);
    assert.deepEqual(unknown.json, wrong.json);
    assert.equal(wrong.headers['set-cookie'], undefined);
  });

  test('e-posta başına 5 yanlış denemeden sonra doğru şifre bile beklemeye alınır', async () => {
    const email = 'kilit@example.com';
    await createAdmin(t, email, ADMIN_PASSWORD);
    for (let i = 0; i < 5; i += 1) {
      const { status } = await t.call('POST', '/admin/api/login', {
        body: { email, password: 'yanlis-sifre' },
      });
      assert.equal(status, 401);
    }
    const locked = await t.call('POST', '/admin/api/login', {
      body: { email, password: ADMIN_PASSWORD },
    });
    assert.equal(locked.status, 429);
    assert.deepEqual(locked.json, { error: 'rate_limited' });
    // Başka yöneticinin girişi etkilenmez.
    assert.ok(await logIn());
  });

  test('doğru giriş yanlış deneme sayacını sıfırlar', async () => {
    const email = 'sayac@example.com';
    await createAdmin(t, email, ADMIN_PASSWORD);
    for (let round = 0; round < 3; round += 1) {
      for (let i = 0; i < 4; i += 1) {
        await t.call('POST', '/admin/api/login', { body: { email, password: 'yanlis-sifre' } });
      }
      assert.ok(await logIn(t, email));
    }
  });

  test('adres başına dakikalık sınır çalışır', async () => {
    const limited = await startApp({ rateLimits: { auth: 2 } });
    try {
      const attempt = () =>
        limited.call('POST', '/admin/api/login', { body: { email: 'a@example.com', password: 'x' } });
      assert.equal((await attempt()).status, 401);
      assert.equal((await attempt()).status, 401);
      assert.equal((await attempt()).status, 429);
    } finally {
      await limited.stop();
    }
  });

  test('çıkış yapınca aynı çerez bir daha işe yaramaz', async () => {
    const own = await logIn();
    const request = (method: string, url: string) =>
      t.call(method, `/admin/api${url}`, { headers: { cookie: own } });
    assert.equal((await request('GET', '/me')).status, 200);
    const out = await request('POST', '/logout');
    assert.equal(out.status, 204);
    assert.match(String(out.headers['set-cookie']), /Max-Age=0/);
    assert.equal((await request('GET', '/me')).status, 401);
  });

  test('süresi dolan oturum geçmez', async () => {
    const own = await logIn();
    await t.db
      .updateTable('admin_sessions')
      .set({ expires_at: new Date(Date.now() - 1000) })
      .where('expires_at', '>', new Date(Date.now() + 7 * 3600_000))
      .execute();
    assert.equal(
      (await t.call('GET', '/admin/api/me', { headers: { cookie: own } })).status,
      401,
    );
    // Diğer testler kendi çerezini yeniden açar.
    cookie = await logIn();
  });
});

describe('panel erişimi', () => {
  const ROUTES: [string, string][] = [
    ['GET', '/me'],
    ['POST', '/logout'],
    ['GET', '/summary'],
    ['GET', '/clinics'],
    ['POST', `/clinics/${OTHER_ID}/approve`],
    ['POST', `/clinics/${OTHER_ID}/reject`],
    ['GET', '/lost-reports'],
    ['GET', `/lost-reports/${OTHER_ID}/sightings`],
    ['POST', `/lost-reports/${OTHER_ID}/remove`],
    ['DELETE', `/sightings/${OTHER_ID}`],
    ['GET', '/users'],
    ['POST', `/users/${OTHER_ID}/suspend`],
    ['POST', `/users/${OTHER_ID}/unsuspend`],
  ];

  test('oturumsuz hiçbir uç çalışmaz', async () => {
    for (const [method, url] of ROUTES) {
      const { status, json } = await t.call(method, `/admin/api${url}`);
      assert.equal(status, 401, `${method} ${url}`);
      assert.deepEqual(json, { error: 'unauthorized' });
    }
  });

  test('uydurma çerez geçmez', async () => {
    for (const [method, url] of ROUTES) {
      const { status } = await t.call(method, `/admin/api${url}`, {
        headers: { cookie: 'patika_admin=uydurma-anahtar' },
      });
      assert.equal(status, 401, `${method} ${url}`);
    }
  });

  test('sahip ve veterinerin oturumu panele giremez', async () => {
    const owner = await t.newUser();
    const vet = await newVet();
    for (const token of [owner.token, vet.token]) {
      for (const [method, url] of ROUTES) {
        const bearer = await t.call(method, `/admin/api${url}`, { token });
        assert.equal(bearer.status, 401, `${method} ${url}`);
        // Çerez olarak denense de geçmez.
        const asCookie = await t.call(method, `/admin/api${url}`, {
          headers: { cookie: `patika_admin=${token}` },
        });
        assert.equal(asCookie.status, 401, `${method} ${url}`);
      }
    }
  });

  test('panel oturumu uygulama uçlarına giremez', async () => {
    const token = cookie.split('=')[1]!;
    assert.equal((await t.call('GET', '/v1/me', { headers: { cookie } })).status, 401);
    assert.equal((await t.call('GET', '/v1/me', { token })).status, 401);
    assert.equal((await t.call('GET', '/v1/clinic', { token })).status, 401);
  });

  test('başka siteden gelen istek reddedilir, aynı adresten gelen geçer', async () => {
    const vet = await newVet();
    for (const origin of ['https://kotu-site.example', 'null']) {
      const { status } = await panel('POST', `/clinics/${vet.clinicId}/approve`, undefined, { origin });
      assert.equal(status, 403, origin);
    }
    const login = await t.call('POST', '/admin/api/login', {
      headers: { origin: 'https://kotu-site.example' },
      body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    assert.equal(login.status, 403);

    const row = await t.db
      .selectFrom('clinics')
      .select('status')
      .where('id', '=', vet.clinicId)
      .executeTakeFirstOrThrow();
    assert.equal(row.status, 'pending');

    const same = await approve(vet.clinicId, { origin: 'http://localhost:4000', host: 'localhost:4000' });
    assert.equal(same.status, 200);
  });

  test('cevaplar önbelleğe alınmaz', async () => {
    const { headers } = await panel('GET', '/summary');
    assert.equal(headers['cache-control'], 'no-store');
  });

  test('arama metni kayıt dosyasına yazılmaz', () => {
    assert.equal(loggedUrl('/admin/api/users?q=ayse@example.com'), '/admin/api/users');
    assert.equal(loggedUrl('/v1/lost-reports?active=true'), '/v1/lost-reports?active=true');
  });

  test('panel sayfası açılır, sayfada veri yoktur', async () => {
    for (const url of ['/admin', '/admin/']) {
      const page = await t.call('GET', url);
      assert.equal(page.status, 200, url);
      assert.match(String(page.headers['content-type']), /text\/html/);
      assert.match(page.raw.toString(), /admin\.js/);
    }
    assert.match(String((await t.call('GET', '/admin')).headers['content-security-policy']), /script-src 'self'/);
    assert.equal((await t.call('GET', '/admin/admin.js')).status, 200);
    assert.equal((await t.call('GET', '/admin/admin.css')).status, 200);
  });
});

describe('özet rakamlar', () => {
  test('sayılar değişimi doğru yansıtır, kişi bilgisi içermez', async () => {
    const before = (await panel('GET', '/summary')).json;
    const owner = await t.newUser();
    const vet = await newVet({ name: 'Özet Kliniği' });
    await saveItems(owner, [{ collection: 'pets', id: `pet-${randomUUID()}`, data: { name: 'Pamuk' } }]);
    const listing = await openListing(owner);
    await t.call('POST', `/v1/public/pets/${listing.code}/sightings`, { body: { message: 'Gördüm' } });
    await approve(vet.clinicId);
    await book(vet.clinicId, owner);

    const { status, json } = await panel('GET', '/summary');
    assert.equal(status, 200);
    assert.equal(json.owners, before.owners + 1);
    assert.equal(json.vets, before.vets + 1);
    assert.equal(json.pets, before.pets + 1);
    assert.equal(json.clinics_approved, before.clinics_approved + 1);
    assert.equal(json.reports_open, before.reports_open + 1);
    assert.equal(json.sightings, before.sightings + 1);
    assert.equal(json.appointments_pending, before.appointments_pending + 1);
    assert.equal(json.appointments_total, before.appointments_total + 1);
    for (const value of Object.values(json)) {
      assert.equal(typeof value, 'number');
    }
  });
});

describe('klinik onayı', () => {
  test('bekleyen klinik sicil no ve hesap e-postasıyla görünür, en eski başvuru üstte', async () => {
    const first = await newVet({ name: 'İlk Başvuru' });
    const second = await newVet({ name: 'İkinci Başvuru', license_no: 'IST-99' });
    const { json } = await panel('GET', '/clinics?status=pending');
    const ids = json.clinics.map((clinic: { id: string }) => clinic.id);
    assert.ok(ids.indexOf(first.clinicId) < ids.indexOf(second.clinicId));
    const row = json.clinics.find((clinic: { id: string }) => clinic.id === second.clinicId);
    assert.equal(row.license_no, 'IST-99');
    assert.equal(row.owner_email, second.email);
    assert.equal(row.upcoming_appointments, 0);
    assert.equal(row.status, 'pending');
    assert.equal(row.password_hash, undefined);
  });

  test('onaylanan klinik sahiplerin listesine girer, reddedilen çıkar', async () => {
    const vet = await newVet({ name: 'Liste Kliniği' });
    const inList = async () =>
      (await t.call('GET', '/v1/public/clinics')).json.clinics.some(
        (clinic: { id: string }) => clinic.id === vet.clinicId,
      );
    assert.equal(await inList(), false);

    const approved = await approve(vet.clinicId);
    assert.equal(approved.status, 200);
    assert.equal(approved.json.clinic.status, 'approved');
    assert.equal(await inList(), true);

    const listed = await panel('GET', '/clinics?status=approved');
    assert.ok(listed.json.clinics.some((clinic: { id: string }) => clinic.id === vet.clinicId));
    const pending = await panel('GET', '/clinics?status=pending');
    assert.ok(!pending.json.clinics.some((clinic: { id: string }) => clinic.id === vet.clinicId));

    const rejected = await panel('POST', `/clinics/${vet.clinicId}/reject`);
    assert.equal(rejected.json.clinic.status, 'rejected');
    assert.equal(await inList(), false);
  });

  test('listeden kalkan kliniğin yaklaşan randevuları iptal olur, ziyaret silinir', async () => {
    const vet = await newVet();
    await approve(vet.clinicId);
    const owner = await t.newUser();
    const appointment = await book(vet.clinicId, owner);
    const confirmed = await t.call('POST', `/v1/clinic/appointments/${appointment}/confirm`, {
      token: vet.token,
      body: {},
    });
    assert.equal(confirmed.status, 200);
    const waiting = await book(vet.clinicId, await t.newUser(), '10:00');

    const listed = await panel('GET', '/clinics?status=approved');
    const row = listed.json.clinics.find((clinic: { id: string }) => clinic.id === vet.clinicId);
    assert.equal(row.upcoming_appointments, 2);

    await panel('POST', `/clinics/${vet.clinicId}/reject`);
    assert.deepEqual(await appointmentStatus(appointment), { status: 'cancelled', cancelled_by: 'vet' });
    assert.deepEqual(await appointmentStatus(waiting), { status: 'cancelled', cancelled_by: 'vet' });

    const visit = await t.db
      .selectFrom('user_items')
      .select('deleted')
      .where('owner_id', '=', owner.id)
      .where('collection', '=', 'visits')
      .executeTakeFirstOrThrow();
    assert.equal(Boolean(visit.deleted), true);
  });

  test('olmayan klinik 404, bozuk kimlik 400, bozuk süzgeç 400', async () => {
    assert.equal((await panel('POST', `/clinics/${OTHER_ID}/approve`, IDENTITY)).status, 404);
    assert.equal((await panel('POST', `/clinics/${OTHER_ID}/reject`)).status, 404);
    assert.equal((await panel('POST', '/clinics/bozuk/approve', IDENTITY)).status, 400);
    assert.equal((await panel('GET', '/clinics?status=bozuk')).status, 400);
  });

  test('kapatılan hesabın kliniği onaylanamaz', async () => {
    const vet = await newVet();
    await panel('POST', `/users/${vet.id}/suspend`);
    const { status, json } = await approve(vet.clinicId);
    assert.equal(status, 409);
    assert.deepEqual(json, { error: 'account_suspended' });
  });

  test('yönetici eski bilgiyi görerek onaylayamaz, gövdesiz onay geçmez', async () => {
    const vet = await newVet({ license_no: 'IST-ESKI' });
    const seen = { name: 'Moda Veteriner', vet_name: 'Dr. Selin Aydın', license_no: 'IST-ESKI' };
    // Panel açıkken veteriner sicil numarasını değiştirir.
    await t.call('PUT', '/v1/clinic', { token: vet.token, body: clinicBody({ license_no: 'IST-YENI' }) });
    const stale = await panel('POST', `/clinics/${vet.clinicId}/approve`, seen);
    assert.equal(stale.status, 409);
    assert.deepEqual(stale.json, { error: 'clinic_changed' });
    assert.equal((await panel('POST', `/clinics/${vet.clinicId}/approve`)).status, 400);
    const row = await t.db
      .selectFrom('clinics')
      .select('status')
      .where('id', '=', vet.clinicId)
      .executeTakeFirstOrThrow();
    assert.equal(row.status, 'pending');
    assert.equal((await approve(vet.clinicId)).status, 200);
  });

  test('onaylı klinik kimliğini değiştirmeden kaydedince onay korunur, değiştirince düşer', async () => {
    const vet = await newVet();
    await approve(vet.clinicId);
    const statusOf = async () =>
      (
        await t.db
          .selectFrom('clinics')
          .select('status')
          .where('id', '=', vet.clinicId)
          .executeTakeFirstOrThrow()
      ).status;
    await t.call('PUT', '/v1/clinic', { token: vet.token, body: clinicBody({ description: 'Yeni açıklama' }) });
    assert.equal(await statusOf(), 'approved');
    await t.call('PUT', '/v1/clinic', { token: vet.token, body: clinicBody({ license_no: 'IST-BASKA' }) });
    assert.equal(await statusOf(), 'pending');
  });

  test('klinik listesi sayfalanır, hepsi görülür, tekrar etmez', async () => {
    const tag = `Sayfa${randomUUID().slice(0, 8)}`;
    const owners = Array.from({ length: 53 }, () => randomUUID());
    await t.db.insertInto('users').values(owners.map((id) => ({ id, role: 'vet' as const }))).execute();
    await t.db
      .insertInto('clinics')
      .values(
        owners.map((owner, index) => ({
          id: randomUUID(),
          owner_id: owner,
          status: 'rejected' as const,
          name: `${tag} ${index}`,
          vet_name: 'Dr. Deneme',
          license_no: 'X',
          phone: '0',
          address: 'X',
          area: 'X',
          lat: 41,
          lng: 29,
          hours: JSON.stringify(WEEK),
          slot_minutes: 30,
          species: '[]',
          services: '[]',
          description: null,
          website: null,
          instagram: null,
          photo_path: null,
        })),
      )
      .execute();
    const seen: string[] = [];
    let offset = 0;
    let hasMore = true;
    while (hasMore) {
      const { json } = await panel('GET', `/clinics?status=rejected&offset=${offset}`);
      seen.push(...json.clinics.map((clinic: { id: string }) => clinic.id));
      offset += json.clinics.length;
      hasMore = json.has_more;
    }
    assert.equal(new Set(seen).size, seen.length);
    const rows = await t.db.selectFrom('clinics').select('id').where('name', 'like', `${tag}%`).execute();
    assert.equal(rows.length, 53);
    for (const { id } of rows) {
      assert.ok(seen.includes(id));
    }
  });
});

describe('kayıp ilanı denetimi', () => {
  test('ilan sahibin hesabıyla görünür, tam konum dönmez', async () => {
    const owner = await t.newUser();
    const listing = await openListing(owner, { pet_name: 'Karamel' });
    const { json } = await panel('GET', '/lost-reports?state=open');
    const row = json.reports.find((report: { id: string }) => report.id === listing.id);
    assert.equal(row.pet_name, 'Karamel');
    assert.equal(row.last_seen_area, 'Moda, Kadıköy');
    assert.equal(row.sightings, 0);
    assert.equal(JSON.stringify(row).includes('40.987654'), false);
    assert.equal(row.last_seen_lat, undefined);
    assert.equal(row.owner_id, undefined);
  });

  test('ihbarlar mesaj ve iletişimle görünür, konumun yalnızca varlığı döner', async () => {
    const owner = await t.newUser();
    const listing = await openListing(owner);
    await t.call('POST', `/v1/public/pets/${listing.code}/sightings`, {
      body: { message: 'Parkta gördüm', contact: '05551234567', lat: 41.111111, lng: 29.222222 },
    });
    const { json } = await panel('GET', `/lost-reports/${listing.id}/sightings`);
    assert.equal(json.sightings.length, 1);
    assert.equal(json.sightings[0].message, 'Parkta gördüm');
    assert.equal(json.sightings[0].contact, '05551234567');
    assert.equal(json.sightings[0].has_location, true);
    assert.equal(JSON.stringify(json).includes('41.111111'), false);
  });

  test('kaldırılan ilan sayfadan ve fotoğraftan çıkar, sahibi yeni ilan açabilir', async () => {
    const owner = await t.newUser();
    const listing = await openListing(owner, {}, true);
    const before = await t.call('GET', `/v1/public/pets/${listing.code}`);
    assert.equal(before.json.status, 'lost');
    const photoUrl = `/v1/public/photos/${before.json.photo_path}`;
    assert.equal((await t.call('GET', photoUrl)).status, 200);

    const removed = await panel('POST', `/lost-reports/${listing.id}/remove`);
    assert.equal(removed.status, 204);

    const after = await t.call('GET', `/v1/public/pets/${listing.code}`);
    assert.deepEqual(after.json, { status: 'none' });
    assert.equal((await t.call('GET', photoUrl)).status, 404);
    assert.deepEqual(await readdir(join(t.photoDir, 'lost')).then((files) => files.includes(before.json.photo_path)), false);

    // Sahibi uygulamada kaldırıldığını görür, açık ilan sayılmaz.
    const own = await t.call('GET', `/v1/lost-reports/${listing.id}`, { token: owner.token });
    assert.ok(own.json.report.removed_at);
    const active = await t.call('GET', '/v1/lost-reports?active=true', { token: owner.token });
    assert.equal(active.json.reports.length, 0);

    const again = await t.call('POST', '/v1/lost-reports', {
      token: owner.token,
      body: newReport(listing.petId),
    });
    assert.equal(again.status, 201);
  });

  test('eski bulunmuş ilan varken yeni ilan kaldırılınca sayfa "bulundu" demez', async () => {
    const owner = await t.newUser();
    const first = await openListing(owner, { pet_name: 'Eskiİlan' });
    await t.call('POST', `/v1/lost-reports/${first.id}/found`, { token: owner.token });
    const second = await t.call('POST', '/v1/lost-reports', {
      token: owner.token,
      body: newReport(first.petId, { pet_name: 'Eskiİlan' }),
    });
    assert.equal(second.status, 201);
    await panel('POST', `/lost-reports/${second.json.id}/remove`);
    assert.deepEqual((await t.call('GET', `/v1/public/pets/${first.code}`)).json, { status: 'none' });
  });

  test('fotoğraf silinemezse yolu unutulmaz, yeniden denenince ilan kalkar', async () => {
    let failing = true;
    const flaky = await startApp({
      photos: {
        deleteLostPhoto: async () => {
          if (failing) {
            throw new Error('disk hatası');
          }
        },
      },
    });
    try {
      await createAdmin(flaky, 'foto@example.com', ADMIN_PASSWORD);
      const own = await logIn(flaky, 'foto@example.com');
      const owner = await flaky.newUser();
      const { json } = await flaky.call('POST', '/v1/lost-reports', {
        token: owner.token,
        body: newReport('foto-pet'),
      });
      await flaky.call('PUT', `/v1/lost-reports/${json.id}/photo`, { token: owner.token, raw: JPEG });
      const remove = () =>
        flaky.call('POST', `/admin/api/lost-reports/${json.id}/remove`, { headers: { cookie: own } });
      const photoOf = async () =>
        (
          await flaky.db
            .selectFrom('lost_reports')
            .select('photo_path')
            .where('id', '=', json.id)
            .executeTakeFirstOrThrow()
        ).photo_path;

      assert.equal((await remove()).status, 500);
      assert.ok(await photoOf());
      failing = false;
      assert.equal((await remove()).status, 204);
      assert.equal(await photoOf(), null);
    } finally {
      await flaky.stop();
    }
  });

  test('daha önce bulunan ilan kaldırılınca sayfada adı da kalmaz', async () => {
    const owner = await t.newUser();
    const listing = await openListing(owner);
    await t.call('POST', `/v1/lost-reports/${listing.id}/found`, { token: owner.token });
    assert.equal((await t.call('GET', `/v1/public/pets/${listing.code}`)).json.status, 'found');
    await panel('POST', `/lost-reports/${listing.id}/remove`);
    assert.deepEqual((await t.call('GET', `/v1/public/pets/${listing.code}`)).json, { status: 'none' });
  });

  test('açık ve kapanan süzgeci doğru çalışır', async () => {
    const owner = await t.newUser();
    const open = await openListing(owner, { pet_name: 'Açıkİlan' });
    const closed = await openListing(owner, { pet_name: 'Kapalıİlan' });
    await panel('POST', `/lost-reports/${closed.id}/remove`);
    const ids = async (state: string) =>
      (await panel('GET', `/lost-reports?state=${state}`)).json.reports.map(
        (report: { id: string }) => report.id,
      );
    const openIds = await ids('open');
    const closedIds = await ids('closed');
    assert.ok(openIds.includes(open.id));
    assert.ok(!openIds.includes(closed.id));
    assert.ok(closedIds.includes(closed.id));
    assert.ok(!closedIds.includes(open.id));
  });

  test('ihbar silinir, ilanın sahibi de göremez', async () => {
    const owner = await t.newUser();
    const listing = await openListing(owner);
    await t.call('POST', `/v1/public/pets/${listing.code}/sightings`, { body: { message: 'Sahte ihbar' } });
    const { json } = await panel('GET', `/lost-reports/${listing.id}/sightings`);
    const id = json.sightings[0].id;
    assert.equal((await panel('DELETE', `/sightings/${id}`)).status, 204);
    const own = await t.call('GET', `/v1/lost-reports/${listing.id}`, { token: owner.token });
    assert.equal(own.json.sightings.length, 0);
    assert.equal((await panel('DELETE', `/sightings/${id}`)).status, 404);
  });

  test('olmayan ilan 404', async () => {
    assert.equal((await panel('POST', `/lost-reports/${OTHER_ID}/remove`)).status, 404);
    assert.deepEqual((await panel('GET', `/lost-reports/${OTHER_ID}/sightings`)).json, { sightings: [] });
  });
});

describe('kullanıcı yönetimi', () => {
  async function appleUser(sub: string, email: string) {
    const { json, status } = await t.call('POST', '/v1/auth/apple', {
      body: { identity_token: await appleToken(sub, { email }), full_name: 'Ayşe Demir' },
    });
    assert.equal(status, 200);
    return { token: json.token as string, id: json.user.id as string };
  }

  const findUser = async (id: string, query = '') => {
    const { json } = await panel('GET', `/users${query}`);
    return json.users.find((user: { id: string }) => user.id === id);
  };

  test('liste sayılar ve hesap bilgisi taşır, gizli alanlar dönmez', async () => {
    const owner = await appleUser('apple-liste', 'ayse.liste@example.com');
    await saveItems(owner, [
      { collection: 'pets', id: 'pet-liste', data: { name: 'Çok Gizli Hayvan' } },
      { collection: 'health_records', id: 'kayit-liste', data: { name: 'Çok Gizli Aşı' } },
    ]);
    await openListing(owner);

    const { json } = await panel('GET', '/users?q=ayse.liste');
    assert.equal(json.users.length, 1);
    const [row] = json.users;
    assert.equal(row.id, owner.id);
    assert.equal(row.name, 'Ayşe Demir');
    assert.equal(row.email, 'ayse.liste@example.com');
    assert.equal(row.provider, 'apple');
    assert.equal(row.role, 'owner');
    assert.equal(row.pets, 1);
    assert.equal(row.open_reports, 1);
    assert.ok(row.last_seen_at);

    const text = JSON.stringify(json);
    for (const secret of ['Çok Gizli', 'apple-liste', 'apple_sub', 'password', 'token']) {
      assert.equal(text.includes(secret), false, secret);
    }
  });

  test('sağlık kayıtları panelin hiçbir ucunda görünmez', async () => {
    const owner = await t.newUser();
    await saveItems(owner, [
      { collection: 'health_records', id: 'kuduz-kaydi', data: { name: 'Kuduz aşısı sırrı' } },
    ]);
    for (const url of ['/summary', '/clinics?status=all', '/lost-reports', '/users']) {
      const { json } = await panel('GET', url);
      assert.equal(JSON.stringify(json).includes('sırrı'), false, url);
    }
  });

  test('arama ad ve e-postada çalışır, joker karakter işe yaramaz', async () => {
    const owner = await appleUser('apple-arama', 'bulunacak_kisi@example.com');
    assert.ok(await findUser(owner.id, '?q=BULUNACAK'));
    assert.ok(await findUser(owner.id, '?q=Ayşe'));
    assert.ok(await findUser(owner.id, '?q=bulunacak_kisi'));
    assert.equal(await findUser(owner.id, '?q=bulunacak%25xkisi'), undefined);
    const wildcard = await panel('GET', '/users?q=%25');
    assert.equal(wildcard.json.users.some((user: { email: string | null }) => !user.email?.includes('%')), false);
    assert.equal(await findUser(owner.id, '?q=baskabiri'), undefined);
  });

  test('süzgeçler rol ve kapalı hesaba göre ayırır', async () => {
    const vet = await newVet({ name: 'Süzgeç Kliniği' });
    const owner = await appleUser('apple-suzgec', 'suzgec@example.com');
    assert.ok(await findUser(vet.id, '?filter=vet&q=panel-vet'));
    assert.equal(await findUser(owner.id, '?filter=vet&q=suzgec'), undefined);
    assert.ok(await findUser(owner.id, '?filter=owner&q=suzgec'));
    assert.equal(await findUser(owner.id, '?filter=suspended&q=suzgec'), undefined);
    await panel('POST', `/users/${owner.id}/suspend`);
    assert.ok(await findUser(owner.id, '?filter=suspended&q=suzgec'));
    // Klinik adıyla da bulunur.
    assert.ok(await findUser(vet.id, `?q=${encodeURIComponent('Süzgeç Kliniği')}`));
    const clinicRow = await findUser(vet.id, '?q=S%C3%BCzge%C3%A7');
    assert.equal(clinicRow.clinic_name, 'Süzgeç Kliniği');
    assert.equal(clinicRow.clinic_status, 'pending');
    assert.equal(clinicRow.provider, 'email');
  });

  test('sayfalama: 50 satırdan fazlası sonraki sayfada, tekrar etmez', async () => {
    const tag = `sayfa${randomUUID().slice(0, 8)}`;
    await t.db
      .insertInto('users')
      .values(Array.from({ length: 53 }, (_, i) => ({ id: randomUUID(), email: `${tag}-${i}@example.com` })))
      .execute();
    const first = await panel('GET', `/users?q=${tag}`);
    assert.equal(first.json.users.length, 50);
    assert.equal(first.json.has_more, true);
    const second = await panel('GET', `/users?q=${tag}&offset=50`);
    assert.equal(second.json.users.length, 3);
    assert.equal(second.json.has_more, false);
    const seen = new Set([...first.json.users, ...second.json.users].map((user: { id: string }) => user.id));
    assert.equal(seen.size, 53);
  });

  test('kapatılan sahip: oturum düşer, giremez, ilanı kalkar, randevusu iptal olur', async () => {
    const owner = await appleUser('apple-kapanan', 'kapanan@example.com');
    const listing = await openListing(owner, {}, true);
    const vet = await newVet();
    await approve(vet.clinicId);
    const appointment = await book(vet.clinicId, owner);

    assert.equal((await t.call('GET', '/v1/me', { token: owner.token })).status, 200);
    assert.equal((await panel('POST', `/users/${owner.id}/suspend`)).status, 204);

    assert.equal((await t.call('GET', '/v1/me', { token: owner.token })).status, 401);
    const again = await t.call('POST', '/v1/auth/apple', {
      body: { identity_token: await appleToken('apple-kapanan') },
    });
    assert.equal(again.status, 403);
    assert.deepEqual(again.json, { error: 'account_suspended' });

    // QR sayfası kapanır: bulan kişi kimsenin okuyamayacağı mesaj bırakamaz.
    const page = await t.call('GET', `/v1/public/pets/${listing.code}`);
    assert.equal(page.status, 404);
    assert.deepEqual(page.json, { error: 'unknown_code' });
    const message = await t.call('POST', `/v1/public/pets/${listing.code}/sightings`, {
      body: { message: 'Kimse okuyamaz' },
    });
    assert.equal(message.status, 404);
    assert.deepEqual(await appointmentStatus(appointment), { status: 'cancelled', cancelled_by: 'owner' });

    const row = await findUser(owner.id, '?q=kapanan');
    assert.ok(row.suspended_at);
    assert.equal(row.open_reports, 0);
    assert.equal(row.upcoming_appointments, 0);

    // Veriler silinmez, hesap yeniden açılınca geri gelir. İlan kendiliğinden geri gelmez.
    assert.equal((await panel('POST', `/users/${owner.id}/unsuspend`)).status, 204);
    const back = await t.call('POST', '/v1/auth/apple', {
      body: { identity_token: await appleToken('apple-kapanan') },
    });
    assert.equal(back.status, 200);
    assert.equal(back.json.user.id, owner.id);
    assert.deepEqual((await t.call('GET', `/v1/public/pets/${listing.code}`)).json, { status: 'none' });
  });

  test('kapatılan veteriner: şifre doğru olsa da giremez, klinik listeden kalkar', async () => {
    const vet = await newVet();
    await approve(vet.clinicId);
    const owner = await t.newUser();
    const appointment = await book(vet.clinicId, owner);

    await panel('POST', `/users/${vet.id}/suspend`);

    assert.equal((await t.call('GET', '/v1/clinic', { token: vet.token })).status, 401);
    const wrong = await t.call('POST', '/v1/auth/vet/login', {
      body: { email: vet.email, password: 'yanlis-sifre-1' },
    });
    // Şifreyi bilmeyen hesabın kapatıldığını öğrenemez.
    assert.equal(wrong.status, 401);
    assert.deepEqual(wrong.json, { error: 'invalid_credentials' });
    const right = await t.call('POST', '/v1/auth/vet/login', {
      body: { email: vet.email, password: 'gizli-sifre-1' },
    });
    assert.equal(right.status, 403);
    assert.deepEqual(right.json, { error: 'account_suspended' });

    const list = await t.call('GET', '/v1/public/clinics');
    assert.ok(!list.json.clinics.some((clinic: { id: string }) => clinic.id === vet.clinicId));
    assert.deepEqual(await appointmentStatus(appointment), { status: 'cancelled', cancelled_by: 'vet' });

    // Yeniden açılınca girer ama klinik yeniden onay ister.
    await panel('POST', `/users/${vet.id}/unsuspend`);
    const back = await t.call('POST', '/v1/auth/vet/login', {
      body: { email: vet.email, password: 'gizli-sifre-1' },
    });
    assert.equal(back.status, 200);
    const stillOut = await t.call('GET', '/v1/public/clinics');
    assert.ok(!stillOut.json.clinics.some((clinic: { id: string }) => clinic.id === vet.clinicId));
  });

  test('oturum silinmemiş olsa bile kapalı hesabın anahtarı çalışmaz', async () => {
    // Kapatma sırasında aynı anda açılan oturum silinmekten kurtulabilir: ikinci koruma budur.
    const owner = await t.newUser();
    await t.db.updateTable('users').set({ suspended_at: new Date() }).where('id', '=', owner.id).execute();
    assert.equal((await t.call('GET', '/v1/me', { token: owner.token })).status, 401);
    await t.db.updateTable('users').set({ suspended_at: null }).where('id', '=', owner.id).execute();
    assert.equal((await t.call('GET', '/v1/me', { token: owner.token })).status, 200);
  });

  test('kapatma ikinci kez çağrılınca da bozulmaz, tarih değişmez', async () => {
    const owner = await t.newUser();
    await panel('POST', `/users/${owner.id}/suspend`);
    const first = await t.db
      .selectFrom('users')
      .select('suspended_at')
      .where('id', '=', owner.id)
      .executeTakeFirstOrThrow();
    assert.equal((await panel('POST', `/users/${owner.id}/suspend`)).status, 204);
    const second = await t.db
      .selectFrom('users')
      .select('suspended_at')
      .where('id', '=', owner.id)
      .executeTakeFirstOrThrow();
    assert.deepEqual(second.suspended_at, first.suspended_at);
  });

  test('olmayan hesap 404, açık hesabı yeniden açmak hata vermez', async () => {
    assert.equal((await panel('POST', `/users/${OTHER_ID}/suspend`)).status, 404);
    assert.equal((await panel('POST', `/users/${OTHER_ID}/unsuspend`)).status, 404);
    const owner = await t.newUser();
    assert.equal((await panel('POST', `/users/${owner.id}/unsuspend`)).status, 204);
  });

  test('kapatılan hesabın açık bağlantısı kapanır', async () => {
    const owner = await t.newUser();
    await t.app.ready();
    const socket = await t.app.injectWS('/v1/events');
    const ready = new Promise((resolve) => socket.once('message', resolve));
    socket.send(JSON.stringify({ type: 'auth', token: owner.token }));
    await ready;
    const closed = new Promise<number>((resolve) => socket.once('close', resolve));
    await panel('POST', `/users/${owner.id}/suspend`);
    assert.equal(await closed, 4401);
  });

  test('ilan kaldırılınca sahibinin açık uygulamasına haber gider', async () => {
    const owner = await t.newUser();
    const listing = await openListing(owner, { pet_name: 'Haberli' });
    await t.app.ready();
    const socket = await t.app.injectWS('/v1/events');
    const ready = new Promise((resolve) => socket.once('message', resolve));
    socket.send(JSON.stringify({ type: 'auth', token: owner.token }));
    await ready;
    const event = new Promise<string>((resolve) =>
      socket.once('message', (raw: Buffer) => resolve(raw.toString())),
    );
    await panel('POST', `/lost-reports/${listing.id}/remove`);
    assert.deepEqual(JSON.parse(await event), {
      type: 'lost_removed',
      report_id: listing.id,
      pet_name: 'Haberli',
    });
    socket.terminate();
  });
});
