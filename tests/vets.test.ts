// Veteriner hesabı, klinik ve randevu senaryoları. Gerçek MySQL'de, ayrı test veritabanında: npm test
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { JPEG, resetDatabase, startApp, type TestApp } from './helpers.ts';

let t: TestApp;
let counter = 0;

before(async () => {
  await resetDatabase();
  t = await startApp();
});
after(() => t.stop());

const WEEK = [
  { open: '09:00', close: '12:00' },
  { open: '09:00', close: '12:00' },
  { open: '09:00', close: '12:00' },
  { open: '09:00', close: '12:00' },
  { open: '09:00', close: '12:00' },
  { open: '09:00', close: '12:00' },
  { open: '09:00', close: '12:00' },
];

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
    services: ['exam', 'vaccine'],
    description: 'Mahallenin kliniği.',
    website: 'https://moda.example',
    instagram: '@modavet',
    ...overrides,
  };
}

async function newVet() {
  counter += 1;
  const email = `vet${counter}@example.com`;
  const { json, status } = await t.call('POST', '/v1/auth/vet/register', {
    body: { email, password: 'gizli-sifre-1' },
  });
  assert.equal(status, 201);
  return { token: json.token as string, id: json.user.id as string, email };
}

async function approvedClinic(overrides: object = {}) {
  const vet = await newVet();
  const { json } = await t.call('PUT', '/v1/clinic', { token: vet.token, body: clinicBody(overrides) });
  await t.db.updateTable('clinics').set({ status: 'approved' }).where('id', '=', json.clinic.id).execute();
  return { ...vet, clinicId: json.clinic.id as string };
}

// Türkiye saatiyle gün sonra: testler günün hangi saatinde çalışırsa çalışsın saatler gelecekte kalsın.
function dayAfter(days: number) {
  return new Date(Date.now() + 3 * 3600_000 + days * 86_400_000).toISOString().slice(0, 10);
}

function booking(clinicId: string, overrides: object = {}) {
  return {
    clinic_id: clinicId,
    pet_id: 'p1',
    pet_name: 'Zeytin',
    species: 'dog',
    breed: 'Melez',
    pet_age: '3 yaş',
    owner_name: 'Emir Yılmaz',
    owner_phone: '0532 555 00 11',
    reason: 'Aşı',
    note: 'Yemek yemiyor',
    date: dayAfter(3),
    time: '09:30',
    ...overrides,
  };
}

async function requestAppointment(clinicId: string, owner: { token: string }, overrides: object = {}) {
  const { json, status } = await t.call('POST', '/v1/appointments', {
    token: owner.token,
    body: booking(clinicId, overrides),
  });
  assert.equal(status, 201);
  return json.id as string;
}

async function ownerAppointment(owner: { token: string }, id: string) {
  const { json } = await t.call('GET', '/v1/appointments', { token: owner.token });
  return json.appointments.find((row: { id: string }) => row.id === id);
}

async function visitOf(owner: { token: string }, id: string) {
  const { json } = await t.call('GET', '/v1/items', { token: owner.token });
  return json.items.find((row: { id: string }) => row.id === `appointment-${id}`);
}

describe('veteriner hesabı', () => {
  test('kayıt olur, rolü ve giriş yöntemi görünür, şifre ve özeti dönmez', async () => {
    const { status, json, raw } = await t.call('POST', '/v1/auth/vet/register', {
      body: { email: 'Kayit@Example.COM', password: 'gizli-sifre-1' },
    });
    assert.equal(status, 201);
    assert.equal(json.user.role, 'vet');
    assert.equal(json.user.provider, 'email');
    assert.equal(json.user.email, 'kayit@example.com');
    assert.ok(!raw.toString().includes('gizli-sifre-1'));
    assert.ok(!raw.toString().includes('scrypt'));
  });

  test('şifre düz metin saklanmaz, aynı şifre iki hesapta farklı özet verir', async () => {
    const a = await newVet();
    const b = await newVet();
    const rows = await t.db
      .selectFrom('vet_logins')
      .select('password_hash')
      .where('user_id', 'in', [a.id, b.id])
      .execute();
    assert.ok(rows.every((row) => row.password_hash.startsWith('scrypt$')));
    assert.ok(rows.every((row) => !row.password_hash.includes('gizli-sifre-1')));
    assert.notEqual(rows[0]?.password_hash, rows[1]?.password_hash);
  });

  test('aynı e-posta büyük harfle de ikinci kez kaydolamaz', async () => {
    const vet = await newVet();
    const { status, json } = await t.call('POST', '/v1/auth/vet/register', {
      body: { email: vet.email.toUpperCase(), password: 'baska-sifre-2' },
    });
    assert.equal(status, 409);
    assert.equal(json.error, 'email_taken');
  });

  test('geçersiz kayıtlar reddedilir', async () => {
    for (const body of [
      { email: 'adres-degil', password: 'gizli-sifre-1' },
      { email: 'a@example.com', password: 'kisa' },
      { email: 'a@example.com' },
      {},
    ]) {
      assert.equal((await t.call('POST', '/v1/auth/vet/register', { body })).status, 400);
    }
  });

  test('doğru şifreyle girer, yanlış şifre ve kayıtsız e-posta aynı cevabı alır', async () => {
    const vet = await newVet();
    const ok = await t.call('POST', '/v1/auth/vet/login', {
      body: { email: vet.email.toUpperCase(), password: 'gizli-sifre-1' },
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.user.id, vet.id);
    assert.equal((await t.call('GET', '/v1/me', { token: ok.json.token })).json.user.role, 'vet');

    const wrong = await t.call('POST', '/v1/auth/vet/login', {
      body: { email: vet.email, password: 'yanlis-sifre' },
    });
    const unknown = await t.call('POST', '/v1/auth/vet/login', {
      body: { email: 'yok@example.com', password: 'yanlis-sifre' },
    });
    assert.equal(wrong.status, 401);
    assert.equal(unknown.status, 401);
    assert.deepEqual(wrong.json, unknown.json);
    assert.equal(wrong.json.error, 'invalid_credentials');
  });

  test('sahip hesabı varsayılan olarak sahip rolündedir', async () => {
    const { json } = await t.call('POST', '/v1/auth/dev');
    assert.equal(json.user.role, 'owner');
  });
});

describe('roller birbirine karışmaz', () => {
  test('veteriner sahip uçlarına giremez', async () => {
    const vet = await newVet();
    for (const [method, url] of [
      ['GET', '/v1/items'],
      ['PUT', '/v1/items'],
      ['PUT', '/v1/photos/a.jpg'],
      ['GET', '/v1/lost-reports'],
      ['POST', '/v1/lost-reports'],
      ['GET', '/v1/pet-messages'],
      ['GET', '/v1/appointments'],
      ['POST', '/v1/appointments'],
    ] as const) {
      assert.equal((await t.call(method, url, { token: vet.token })).status, 403, `${method} ${url}`);
    }
  });

  test('sahip veteriner uçlarına giremez', async () => {
    const owner = await t.newUser();
    for (const [method, url] of [
      ['GET', '/v1/clinic'],
      ['PUT', '/v1/clinic'],
      ['PUT', '/v1/clinic/photo'],
      ['GET', '/v1/clinic/appointments'],
    ] as const) {
      assert.equal((await t.call(method, url, { token: owner.token })).status, 403, `${method} ${url}`);
    }
  });

  test('girişsiz istek 401 alır', async () => {
    for (const [method, url] of [
      ['GET', '/v1/clinic'],
      ['GET', '/v1/appointments'],
      ['POST', '/v1/appointments'],
    ] as const) {
      assert.equal((await t.call(method, url)).status, 401, url);
    }
  });
});

describe('klinik profili ve onay', () => {
  test('yeni klinik onay bekler, listede görünmez', async () => {
    const vet = await newVet();
    assert.equal((await t.call('GET', '/v1/clinic', { token: vet.token })).json.clinic, null);
    const { status, json } = await t.call('PUT', '/v1/clinic', { token: vet.token, body: clinicBody() });
    assert.equal(status, 200);
    assert.equal(json.clinic.status, 'pending');
    assert.equal(json.clinic.license_no, 'IST-12345');

    const list = await t.call('GET', '/v1/public/clinics');
    assert.ok(!list.json.clinics.some((row: { id: string }) => row.id === json.clinic.id));
    assert.equal((await t.call('GET', `/v1/public/clinics/${json.clinic.id}`)).status, 404);
    const slots = await t.call('GET', `/v1/public/clinics/${json.clinic.id}/slots?date=${dayAfter(3)}`);
    assert.equal(slots.status, 404);
  });

  test('onaylanınca listede görünür, sicil, hesap ve durum herkese verilmez', async () => {
    const { clinicId, id } = await approvedClinic({ name: 'Görünür Klinik' });
    const list = await t.call('GET', '/v1/public/clinics');
    const row = list.json.clinics.find((clinic: { id: string }) => clinic.id === clinicId);
    assert.equal(row.name, 'Görünür Klinik');
    assert.deepEqual(row.hours, WEEK);
    assert.deepEqual(row.species, ['cat', 'dog']);
    for (const hidden of ['license_no', 'owner_id', 'status', 'created_at']) {
      assert.equal(hidden in row, false, hidden);
    }
    assert.ok(!JSON.stringify(list.json).includes(id));
    assert.ok(!JSON.stringify(list.json).includes('IST-12345'));
  });

  test('geçersiz bilgiler reddedilir', async () => {
    const vet = await newVet();
    const closed = Array.from({ length: 7 }, () => null);
    const cases: object[] = [
      { name: '' },
      { vet_name: '   ' },
      { license_no: '' },
      { phone: 'ara beni' },
      { address: '' },
      { lat: 200 },
      { hours: closed },
      { hours: WEEK.slice(0, 6) },
      { hours: [{ open: '18:00', close: '09:00' }, ...WEEK.slice(1)] },
      { hours: [{ open: '25:00', close: '26:00' }, ...WEEK.slice(1)] },
      { slot_minutes: 7 },
      { species: [] },
      { species: ['dinozor'] },
      { services: ['uçak'] },
      { website: 'javascript:alert(1)' },
      { instagram: 'boşluk var' },
      { description: 'x'.repeat(601) },
    ];
    for (const overrides of cases) {
      const { status } = await t.call('PUT', '/v1/clinic', {
        token: vet.token,
        body: clinicBody(overrides),
      });
      assert.equal(status, 400, JSON.stringify(overrides).slice(0, 80));
    }
  });

  test('onaylı klinik telefon değiştirirse listede kalır', async () => {
    const vet = await approvedClinic();
    const { json } = await t.call('PUT', '/v1/clinic', {
      token: vet.token,
      body: clinicBody({ phone: '0216 000 00 00' }),
    });
    assert.equal(json.clinic.status, 'approved');
    assert.equal(json.clinic.id, vet.clinicId, 'ikinci klinik açılmaz');
  });

  test('onaylı klinik ad, hekim ya da sicil değiştirirse yeniden onaya gider', async () => {
    for (const change of [{ name: 'Başka Klinik' }, { vet_name: 'Dr. Başkası' }, { license_no: 'ANK-1' }]) {
      const vet = await approvedClinic();
      const { json } = await t.call('PUT', '/v1/clinic', { token: vet.token, body: clinicBody(change) });
      assert.equal(json.clinic.status, 'pending', JSON.stringify(change));
      assert.equal((await t.call('GET', `/v1/public/clinics/${vet.clinicId}`)).status, 404);
    }
  });

  test('reddedilen klinik düzeltince yeniden onaya gider', async () => {
    const vet = await approvedClinic();
    await t.db.updateTable('clinics').set({ status: 'rejected' }).where('id', '=', vet.clinicId).execute();
    const { json } = await t.call('PUT', '/v1/clinic', { token: vet.token, body: clinicBody() });
    assert.equal(json.clinic.status, 'pending');
  });

  test('fotoğraf: üst veri silinir, herkese açılır, değişince eskisi gider', async () => {
    const noClinic = await newVet();
    assert.equal((await t.call('PUT', '/v1/clinic/photo', { token: noClinic.token, raw: JPEG })).status, 404);

    const vet = await approvedClinic();
    assert.equal(
      (await t.call('PUT', '/v1/clinic/photo', { token: vet.token, raw: Buffer.from('resim-degil') })).status,
      400,
    );
    const comment = Buffer.from('GPS-KONUM');
    const segment = Buffer.concat([
      Buffer.from([0xff, 0xfe, 0x00, comment.length + 2]),
      comment,
    ]);
    const withMetadata = Buffer.concat([JPEG.subarray(0, 2), segment, JPEG.subarray(2)]);
    const first = await t.call('PUT', '/v1/clinic/photo', { token: vet.token, raw: withMetadata });
    assert.equal(first.status, 200);
    const saved = await t.call('GET', `/v1/public/clinic-photos/${first.json.photo_path}`);
    assert.equal(saved.status, 200);
    assert.ok(!saved.raw.toString('latin1').includes('GPS-KONUM'));

    const second = await t.call('PUT', '/v1/clinic/photo', { token: vet.token, raw: JPEG });
    assert.equal((await t.call('GET', `/v1/public/clinic-photos/${first.json.photo_path}`)).status, 404);
    assert.equal((await t.call('GET', `/v1/public/clinic-photos/${second.json.photo_path}`)).status, 200);
    assert.equal((await t.call('GET', '/v1/public/clinic-photos/..%2F..%2Fsecret')).status, 400);
  });
});

describe('boş saatler', () => {
  test('çalışma saatlerine ve randevu aralığına göre hesaplanır', async () => {
    const { clinicId } = await approvedClinic();
    const { json } = await t.call('GET', `/v1/public/clinics/${clinicId}/slots?date=${dayAfter(3)}`);
    assert.deepEqual(json.times, ['09:00', '09:30', '10:00', '10:30', '11:00', '11:30']);

    const hourly = await approvedClinic({ slot_minutes: 60 });
    const slots = await t.call('GET', `/v1/public/clinics/${hourly.clinicId}/slots?date=${dayAfter(3)}`);
    assert.deepEqual(slots.json.times, ['09:00', '10:00', '11:00']);
  });

  test('kapalı gün boş döner, pazartesi ve pazar doğru eşleşir', async () => {
    // 9 Kasım 2026 pazartesi. Tarih sabit olamaz (sınırlı pencere), bu yüzden gelecek pazartesi aranır.
    const dates = Array.from({ length: 7 }, (_, index) => dayAfter(index + 1));
    const monday = dates.find((date) => new Date(`${date}T12:00:00+03:00`).getUTCDay() === 1);
    const sunday = dates.find((date) => new Date(`${date}T12:00:00+03:00`).getUTCDay() === 0);
    const { clinicId } = await approvedClinic({
      hours: [null, ...WEEK.slice(1, 6), { open: '10:00', close: '11:00' }],
    });
    const closedMonday = await t.call('GET', `/v1/public/clinics/${clinicId}/slots?date=${monday}`);
    assert.deepEqual(closedMonday.json.times, []);
    const openSunday = await t.call('GET', `/v1/public/clinics/${clinicId}/slots?date=${sunday}`);
    assert.deepEqual(openSunday.json.times, ['10:00', '10:30']);
  });

  test('geçmiş gün ve 60 günden uzak tarih boş döner, bozuk tarih reddedilir', async () => {
    const { clinicId } = await approvedClinic();
    const past = await t.call('GET', `/v1/public/clinics/${clinicId}/slots?date=${dayAfter(-2)}`);
    assert.deepEqual(past.json.times, []);
    const far = await t.call('GET', `/v1/public/clinics/${clinicId}/slots?date=${dayAfter(70)}`);
    assert.deepEqual(far.json.times, []);
    assert.equal((await t.call('GET', `/v1/public/clinics/${clinicId}/slots?date=dun`)).status, 400);
    assert.equal((await t.call('GET', `/v1/public/clinics/${clinicId}/slots`)).status, 400);
  });

  test('bekleyen istek saati kapatmaz, onaylanan kapatır, iptal açar', async () => {
    const vet = await approvedClinic();
    const owner = await t.newUser();
    const id = await requestAppointment(vet.clinicId, owner);
    const url = `/v1/public/clinics/${vet.clinicId}/slots?date=${dayAfter(3)}`;
    assert.ok((await t.call('GET', url)).json.times.includes('09:30'));

    await t.call('POST', `/v1/clinic/appointments/${id}/confirm`, { token: vet.token });
    assert.ok(!(await t.call('GET', url)).json.times.includes('09:30'));

    await t.call('POST', `/v1/clinic/appointments/${id}/cancel`, { token: vet.token });
    assert.ok((await t.call('GET', url)).json.times.includes('09:30'));
  });

  test('cevapta kimin randevusu olduğu görünmez', async () => {
    const vet = await approvedClinic();
    const owner = await t.newUser();
    await requestAppointment(vet.clinicId, owner);
    const { raw } = await t.call('GET', `/v1/public/clinics/${vet.clinicId}/slots?date=${dayAfter(3)}`);
    for (const secret of ['Emir', '0532', 'Zeytin']) {
      assert.ok(!raw.toString().includes(secret), secret);
    }
  });
});

describe('randevu isteği', () => {
  test('istek gönderilir, veteriner sahibin bilgilerini görür, sahip de listesinde görür', async () => {
    const vet = await approvedClinic();
    const owner = await t.newUser();
    const id = await requestAppointment(vet.clinicId, owner);

    const { json } = await t.call('GET', '/v1/clinic/appointments', { token: vet.token });
    const row = json.appointments.find((item: { id: string }) => item.id === id);
    assert.equal(row.status, 'pending');
    assert.equal(row.owner_name, 'Emir Yılmaz');
    assert.equal(row.owner_phone, '0532 555 00 11');
    assert.equal(row.pet_name, 'Zeytin');
    assert.equal(row.breed, 'Melez');
    assert.equal(row.pet_age, '3 yaş');
    assert.equal(row.reason, 'Aşı');
    assert.equal(row.date, dayAfter(3));
    assert.equal(row.time, '09:30');

    const mine = await ownerAppointment(owner, id);
    assert.equal(mine.status, 'pending');
    assert.equal(mine.clinic_name, 'Moda Veteriner');
    assert.equal(mine.clinic_phone, '0216 555 11 22');
    assert.equal(mine.time, '09:30');
    assert.equal(mine.owner_phone, '0532 555 00 11', 'sonraki istekte hazır gelsin');

    const one = await t.call('GET', `/v1/clinic/appointments/${id}`, { token: vet.token });
    assert.equal(one.json.appointment.owner_name, 'Emir Yılmaz');
    const other = await approvedClinic();
    assert.equal((await t.call('GET', `/v1/clinic/appointments/${id}`, { token: other.token })).status, 404);
  });

  test('saat dışı, kapalı gün, geçmiş ve ızgara dışı istekler reddedilir', async () => {
    const vet = await approvedClinic();
    const owner = await t.newUser();
    for (const overrides of [
      { time: '08:00' },
      { time: '12:00' },
      { time: '09:15' },
      { date: dayAfter(-1) },
      { date: dayAfter(70) },
    ]) {
      const { status, json } = await t.call('POST', '/v1/appointments', {
        token: owner.token,
        body: booking(vet.clinicId, overrides),
      });
      assert.equal(status, 409, JSON.stringify(overrides));
      assert.equal(json.error, 'slot_unavailable');
    }
  });

  test('onaylı saate istek gönderilemez, onaylanmamış kliniğe gönderilemez', async () => {
    const vet = await approvedClinic();
    const first = await t.newUser();
    const id = await requestAppointment(vet.clinicId, first);
    await t.call('POST', `/v1/clinic/appointments/${id}/confirm`, { token: vet.token });
    const second = await t.newUser();
    const taken = await t.call('POST', '/v1/appointments', {
      token: second.token,
      body: booking(vet.clinicId),
    });
    assert.equal(taken.status, 409);

    const pending = await newVet();
    const { json } = await t.call('PUT', '/v1/clinic', { token: pending.token, body: clinicBody() });
    const notApproved = await t.call('POST', '/v1/appointments', {
      token: second.token,
      body: booking(json.clinic.id),
    });
    assert.equal(notApproved.status, 404);
  });

  test('geçersiz bilgiler reddedilir', async () => {
    const vet = await approvedClinic();
    const owner = await t.newUser();
    for (const overrides of [
      { owner_phone: 'yok' },
      { owner_name: 'E' },
      { reason: '' },
      { species: 'dinozor' },
      { date: 'yarın' },
      { time: '9' },
      { clinic_id: 'klinik' },
      { note: 'x'.repeat(501) },
    ]) {
      const { status } = await t.call('POST', '/v1/appointments', {
        token: owner.token,
        body: booking(vet.clinicId, overrides),
      });
      assert.equal(status, 400, JSON.stringify(overrides));
    }
  });

  test('aynı istek iki kez gönderilemez, bekleyen istek sayısı sınırlıdır', async () => {
    const vet = await approvedClinic();
    const owner = await t.newUser();
    await requestAppointment(vet.clinicId, owner);
    const repeat = await t.call('POST', '/v1/appointments', {
      token: owner.token,
      body: booking(vet.clinicId),
    });
    assert.equal(repeat.status, 409);
    assert.equal(repeat.json.error, 'already_requested');

    for (const time of ['10:00', '10:30', '11:00', '11:30']) {
      await requestAppointment(vet.clinicId, owner, { time });
    }
    const tooMany = await t.call('POST', '/v1/appointments', {
      token: owner.token,
      body: booking(vet.clinicId, { time: '09:00' }),
    });
    assert.equal(tooMany.status, 429);
    assert.equal(tooMany.json.error, 'too_many_requests');
  });
});

describe('randevuya cevap', () => {
  test('onaylanınca sahibin ziyaretlerine düşer', async () => {
    const vet = await approvedClinic();
    const owner = await t.newUser();
    const id = await requestAppointment(vet.clinicId, owner);
    const { status } = await t.call('POST', `/v1/clinic/appointments/${id}/confirm`, {
      token: vet.token,
      body: { note: 'Aç karnına gelin' },
    });
    assert.equal(status, 200);

    const mine = await ownerAppointment(owner, id);
    assert.equal(mine.status, 'confirmed');
    assert.equal(mine.vet_note, 'Aç karnına gelin');

    const visit = await visitOf(owner, id);
    assert.equal(visit.collection, 'visits');
    assert.equal(visit.deleted, false);
    assert.deepEqual(visit.data, {
      id: `appointment-${id}`,
      petId: 'p1',
      reason: 'Aşı',
      date: dayAfter(3),
      time: '09:30',
      clinic: 'Moda Veteriner',
      note: 'Yemek yemiyor',
    });
  });

  test('aynı saate iki istek: ilki onaylanır, ikincisi onaylanamaz', async () => {
    const vet = await approvedClinic();
    const first = await requestAppointment(vet.clinicId, await t.newUser());
    const second = await requestAppointment(vet.clinicId, await t.newUser());
    assert.equal((await t.call('POST', `/v1/clinic/appointments/${first}/confirm`, { token: vet.token })).status, 200);
    const conflict = await t.call('POST', `/v1/clinic/appointments/${second}/confirm`, { token: vet.token });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.json.error, 'slot_taken');
  });

  test('reddedilince sebebi sahibe gider, ziyaret oluşmaz, yeniden cevaplanamaz', async () => {
    const vet = await approvedClinic();
    const owner = await t.newUser();
    const id = await requestAppointment(vet.clinicId, owner);
    await t.call('POST', `/v1/clinic/appointments/${id}/reject`, {
      token: vet.token,
      body: { note: 'O gün doluyuz' },
    });
    const mine = await ownerAppointment(owner, id);
    assert.equal(mine.status, 'rejected');
    assert.equal(mine.vet_note, 'O gün doluyuz');
    assert.equal(await visitOf(owner, id), undefined);
    assert.equal((await t.call('POST', `/v1/clinic/appointments/${id}/confirm`, { token: vet.token })).status, 409);
    assert.equal((await t.call('POST', `/v1/clinic/appointments/${id}/reject`, { token: vet.token })).status, 409);
  });

  test('veteriner onaylı randevuyu iptal edince sahibin ziyareti de kalkar', async () => {
    const vet = await approvedClinic();
    const owner = await t.newUser();
    const id = await requestAppointment(vet.clinicId, owner);
    await t.call('POST', `/v1/clinic/appointments/${id}/confirm`, { token: vet.token });
    await t.call('POST', `/v1/clinic/appointments/${id}/cancel`, {
      token: vet.token,
      body: { note: 'Hekim izinli' },
    });
    const mine = await ownerAppointment(owner, id);
    assert.equal(mine.status, 'cancelled');
    assert.equal(mine.cancelled_by, 'vet');
    assert.equal(mine.vet_note, 'Hekim izinli');
    const visit = await visitOf(owner, id);
    assert.equal(visit.deleted, true);
    assert.equal(visit.data, null);
  });

  test('bekleyen istek "iptal" ile değil "reddet" ile cevaplanır', async () => {
    const vet = await approvedClinic();
    const id = await requestAppointment(vet.clinicId, await t.newUser());
    assert.equal((await t.call('POST', `/v1/clinic/appointments/${id}/cancel`, { token: vet.token })).status, 409);
  });

  test('başka kliniğin randevusuna dokunulamaz, sahibi görünmez', async () => {
    const vet = await approvedClinic();
    const other = await approvedClinic();
    const id = await requestAppointment(vet.clinicId, await t.newUser());
    for (const action of ['confirm', 'reject', 'cancel']) {
      const { status } = await t.call('POST', `/v1/clinic/appointments/${id}/${action}`, { token: other.token });
      assert.equal(status, 404, action);
    }
    const { json } = await t.call('GET', '/v1/clinic/appointments', { token: other.token });
    assert.deepEqual(json.appointments, []);
  });

  test('saati geçen cevapsız istek "süresi doldu" görünür, onaylanamaz', async () => {
    const vet = await approvedClinic();
    const owner = await t.newUser();
    const id = await requestAppointment(vet.clinicId, owner);
    await t.db
      .updateTable('appointments')
      .set({ starts_at: new Date(Date.now() - 3600_000) })
      .where('id', '=', id)
      .execute();
    assert.equal((await ownerAppointment(owner, id)).status, 'expired');
    assert.equal((await t.call('POST', `/v1/clinic/appointments/${id}/confirm`, { token: vet.token })).status, 409);

    const active = await t.call('GET', '/v1/clinic/appointments', { token: vet.token });
    assert.ok(!active.json.appointments.some((row: { id: string }) => row.id === id));
    const past = await t.call('GET', '/v1/clinic/appointments?scope=past', { token: vet.token });
    assert.equal(past.json.appointments.find((row: { id: string }) => row.id === id).status, 'expired');
  });
});

describe('sahip iptali ve silmeler', () => {
  test('sahip bekleyen ve onaylı randevusunu iptal eder, ziyaret kalkar', async () => {
    const vet = await approvedClinic();
    const owner = await t.newUser();
    const pending = await requestAppointment(vet.clinicId, owner);
    assert.equal((await t.call('POST', `/v1/appointments/${pending}/cancel`, { token: owner.token })).status, 204);
    assert.equal((await ownerAppointment(owner, pending)).cancelled_by, 'owner');

    const confirmed = await requestAppointment(vet.clinicId, owner, { time: '10:00' });
    await t.call('POST', `/v1/clinic/appointments/${confirmed}/confirm`, { token: vet.token });
    assert.equal((await t.call('POST', `/v1/appointments/${confirmed}/cancel`, { token: owner.token })).status, 204);
    assert.equal((await visitOf(owner, confirmed)).deleted, true);
    assert.equal((await t.call('POST', `/v1/appointments/${confirmed}/cancel`, { token: owner.token })).status, 409);
  });

  test('başkasının randevusu iptal edilemez ve görünmez', async () => {
    const vet = await approvedClinic();
    const owner = await t.newUser();
    const stranger = await t.newUser();
    const id = await requestAppointment(vet.clinicId, owner);
    assert.equal((await t.call('POST', `/v1/appointments/${id}/cancel`, { token: stranger.token })).status, 404);
    assert.equal(await ownerAppointment(stranger, id), undefined);
    assert.equal((await ownerAppointment(owner, id)).status, 'pending');
  });

  test('hayvan silinince yaklaşan randevuları iptal olur, başka hayvanınki durur', async () => {
    const vet = await approvedClinic();
    const owner = await t.newUser();
    const confirmed = await requestAppointment(vet.clinicId, owner);
    await t.call('POST', `/v1/clinic/appointments/${confirmed}/confirm`, { token: vet.token });
    const other = await requestAppointment(vet.clinicId, owner, { pet_id: 'p2', pet_name: 'Mia', time: '10:00' });

    const { status } = await t.call('PUT', '/v1/items', {
      token: owner.token,
      body: { items: [{ collection: 'pets', id: 'p1', data: null, updated_at: new Date().toISOString() }] },
    });
    assert.equal(status, 200);
    assert.equal((await ownerAppointment(owner, confirmed)).status, 'cancelled');
    assert.equal((await visitOf(owner, confirmed)).deleted, true);
    assert.equal((await ownerAppointment(owner, other)).status, 'pending');
  });

  test('veteriner hesabını silince klinik ve fotoğraf gider, randevu sahipte iptal olarak kalır', async () => {
    const vet = await approvedClinic();
    const { json: photo } = await t.call('PUT', '/v1/clinic/photo', { token: vet.token, raw: JPEG });
    const owner = await t.newUser();
    const id = await requestAppointment(vet.clinicId, owner);
    await t.call('POST', `/v1/clinic/appointments/${id}/confirm`, { token: vet.token });

    assert.equal((await t.call('DELETE', '/v1/me', { token: vet.token })).status, 204);

    assert.equal((await t.call('GET', `/v1/public/clinics/${vet.clinicId}`)).status, 404);
    assert.equal((await t.call('GET', `/v1/public/clinic-photos/${photo.photo_path}`)).status, 404);
    assert.equal((await readdir(join(t.photoDir, 'clinics'))).includes(photo.photo_path), false);
    const login = await t.call('POST', '/v1/auth/vet/login', {
      body: { email: vet.email, password: 'gizli-sifre-1' },
    });
    assert.equal(login.status, 401, 'giriş bilgisi de silinir');

    const mine = await ownerAppointment(owner, id);
    assert.equal(mine.status, 'cancelled');
    assert.equal(mine.cancelled_by, 'vet');
    assert.equal(mine.clinic_id, null);
    assert.equal(mine.clinic_name, 'Moda Veteriner');
    assert.equal(mine.clinic_phone, null);
    assert.equal((await visitOf(owner, id)).deleted, true);
  });

  test('sahip hesabını silince adı ve telefonu klinikte kalmaz', async () => {
    const vet = await approvedClinic();
    const owner = await t.newUser();
    await requestAppointment(vet.clinicId, owner);
    assert.equal((await t.call('DELETE', '/v1/me', { token: owner.token })).status, 204);
    const { json } = await t.call('GET', '/v1/clinic/appointments', { token: vet.token });
    assert.deepEqual(json.appointments, []);
    const past = await t.call('GET', '/v1/clinic/appointments?scope=past', { token: vet.token });
    assert.deepEqual(past.json.appointments, []);
  });
});

describe('canlı bildirim', () => {
  let port = 0;
  let live: TestApp;

  before(async () => {
    live = await startApp();
    await live.app.listen({ host: '127.0.0.1', port: 0 });
    port = (live.app.server.address() as { port: number }).port;
  });
  after(() => live.stop());

  async function connect(token: string) {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/events`);
    const messages: any[] = [];
    socket.addEventListener('message', (event) => messages.push(JSON.parse(String(event.data))));
    await new Promise((resolve) => socket.addEventListener('open', resolve));
    socket.send(JSON.stringify({ type: 'auth', token }));
    const until = async (check: () => boolean) => {
      const deadline = Date.now() + 3000;
      while (!check()) {
        if (Date.now() > deadline) {
          throw new Error('Beklenen olay gelmedi');
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };
    await until(() => messages.some((message) => message.type === 'ready'));
    return { socket, messages, until };
  }

  test('yeni istek veterinere, cevap sahibine anında gider, telefon başkasına gitmez', async () => {
    const register = await live.call('POST', '/v1/auth/vet/register', {
      body: { email: 'canli@example.com', password: 'gizli-sifre-1' },
    });
    const vetToken = register.json.token as string;
    const saved = await live.call('PUT', '/v1/clinic', { token: vetToken, body: clinicBody() });
    await live.db.updateTable('clinics').set({ status: 'approved' }).where('id', '=', saved.json.clinic.id).execute();
    const owner = await live.newUser();
    const stranger = await live.newUser();

    const vetSocket = await connect(vetToken);
    const ownerSocket = await connect(owner.token);
    const strangerSocket = await connect(stranger.token);

    const created = await live.call('POST', '/v1/appointments', {
      token: owner.token,
      body: booking(saved.json.clinic.id),
    });
    await vetSocket.until(() => vetSocket.messages.some((message) => message.type === 'appointment'));
    const toVet = vetSocket.messages.find((message) => message.type === 'appointment');
    assert.equal(toVet.status, 'pending');
    assert.equal(toVet.pet_name, 'Zeytin');
    assert.equal(toVet.time, '09:30');

    await live.call('POST', `/v1/clinic/appointments/${created.json.id}/confirm`, { token: vetToken });
    await ownerSocket.until(() => ownerSocket.messages.some((message) => message.type === 'appointment'));
    const toOwner = ownerSocket.messages.find((message) => message.type === 'appointment');
    assert.equal(toOwner.status, 'confirmed');
    assert.equal(toOwner.clinic_name, 'Moda Veteriner');
    assert.equal(JSON.stringify(toOwner).includes('0532'), false, 'telefon olayda gitmez');

    assert.equal(strangerSocket.messages.filter((message) => message.type === 'appointment').length, 0);
    for (const { socket } of [vetSocket, ownerSocket, strangerSocket]) {
      socket.close();
    }
  });
});
