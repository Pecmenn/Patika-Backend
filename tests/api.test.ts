// Backend senaryoları. Gerçek MySQL'de, ayrı test veritabanında çalışır: npm test
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { loadConfig } from '../src/config.ts';
import { appleToken, JPEG, newReport, resetDatabase, startApp, type TestApp } from './helpers.ts';

let t: TestApp;

before(async () => {
  await resetDatabase();
  t = await startApp();
});
after(() => t.stop());

const item = (id: string, data: object | null, updatedAt: string, collection = 'pets') => ({
  collection,
  id,
  data,
  updated_at: updatedAt,
});
const AT = (seconds: number) => new Date(Date.UTC(2026, 10, 5, 12, 0, seconds)).toISOString();

async function publicCode(token: string, petId: string) {
  const { json } = await t.call('GET', `/v1/pets/${petId}/public-code`, { token });
  return json.public_code as string;
}

async function pullAll(token: string, query = '') {
  const { json } = await t.call('GET', `/v1/items${query}`, { token });
  return json.items as any[];
}

describe('giriş ve oturum', () => {
  test('deneme hesabı oluşur, sağlayıcısı development görünür', async () => {
    const { status, json } = await t.call('POST', '/v1/auth/dev');
    assert.equal(status, 200);
    assert.ok(json.token.length >= 40);
    assert.equal(json.user.provider, 'development');
    assert.equal('apple_sub' in json.user, false, 'Apple kimliği dışarı verilmez');
  });

  test('her deneme girişi ayrı, boş bir hesap açar', async () => {
    const a = await t.newUser();
    const b = await t.newUser();
    assert.notEqual(a.id, b.id);
  });

  test('deneme girişi kapalıysa uç yoktur', async () => {
    const closed = await startApp({ config: { ALLOW_DEV_LOGIN: false } });
    const { status } = await closed.call('POST', '/v1/auth/dev');
    assert.equal(status, 404);
    await closed.stop();
  });

  test('Apple: geçerli belgeyle hesap açılır, ad ve e-posta kaydedilir', async () => {
    const { status, json } = await t.call('POST', '/v1/auth/apple', {
      body: {
        identity_token: await appleToken('apple-1', { email: 'a@privaterelay.appleid.com' }),
        full_name: 'Emir Okutan',
        given_name: 'Emir',
        family_name: 'Okutan',
      },
    });
    assert.equal(status, 200);
    assert.equal(json.user.provider, 'apple');
    assert.equal(json.user.given_name, 'Emir');
    assert.equal(json.user.email, 'a@privaterelay.appleid.com');
  });

  test('Apple: ikinci girişte aynı hesap açılır, boş gelen ad silinmez', async () => {
    const first = await t.call('POST', '/v1/auth/apple', {
      body: { identity_token: await appleToken('apple-2'), given_name: 'Ada' },
    });
    const second = await t.call('POST', '/v1/auth/apple', {
      body: { identity_token: await appleToken('apple-2') },
    });
    assert.equal(second.json.user.id, first.json.user.id);
    assert.equal(second.json.user.given_name, 'Ada');
    assert.notEqual(second.json.token, first.json.token, 'her telefonun kendi oturumu olur');
  });

  test('Apple: farklı kullanıcılar farklı hesap alır', async () => {
    const a = await t.call('POST', '/v1/auth/apple', { body: { identity_token: await appleToken('apple-3') } });
    const b = await t.call('POST', '/v1/auth/apple', { body: { identity_token: await appleToken('apple-4') } });
    assert.notEqual(a.json.user.id, b.json.user.id);
  });

  for (const [name, options] of [
    ['başka uygulama için üretilmiş', { audience: 'com.baska.uygulama' }],
    ['başka bir yayıncıdan gelen', { issuer: 'https://sahte.example.com' }],
    ['süresi dolmuş', { expires: '-1m' }],
  ] as const) {
    test(`Apple: ${name} belge reddedilir`, async () => {
      const { status, json } = await t.call('POST', '/v1/auth/apple', {
        body: { identity_token: await appleToken('apple-red', options) },
      });
      assert.equal(status, 401);
      assert.equal(json.error, 'invalid_apple_token');
    });
  }

  test('Apple: içeriği değiştirilmiş belge reddedilir', async () => {
    const [header, payload, signature] = (await appleToken('apple-kurban')).split('.');
    const forged = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(payload!, 'base64url').toString()), sub: 'apple-1' }),
    ).toString('base64url');
    const { status } = await t.call('POST', '/v1/auth/apple', {
      body: { identity_token: `${header}.${forged}.${signature}` },
    });
    assert.equal(status, 401);
  });

  test('Apple: imzasız belge reddedilir', async () => {
    const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const token = `${encode({ alg: 'none' })}.${encode({ iss: 'https://appleid.apple.com', aud: 'host.exp.Exponent', sub: 'apple-1', exp: 9999999999 })}.`;
    const { status } = await t.call('POST', '/v1/auth/apple', { body: { identity_token: token } });
    assert.equal(status, 401);
  });

  test('Apple: belge olmadan ya da bozuk belgeyle giriş olmaz', async () => {
    assert.equal((await t.call('POST', '/v1/auth/apple', { body: {} })).status, 400);
    assert.equal((await t.call('POST', '/v1/auth/apple', { body: { identity_token: 'x.y.z' } })).status, 401);
  });

  test('korunan her uç oturum ister', async () => {
    const id = '00000000-0000-4000-8000-000000000000';
    for (const [method, url] of [
      ['GET', '/v1/me'],
      ['DELETE', '/v1/me'],
      ['POST', '/v1/auth/logout'],
      ['GET', '/v1/items'],
      ['PUT', '/v1/items'],
      ['PUT', '/v1/photos/a.jpg'],
      ['GET', '/v1/photos/a.jpg'],
      ['DELETE', '/v1/photos/a.jpg'],
      ['GET', '/v1/lost-reports'],
      ['POST', '/v1/lost-reports'],
      ['GET', `/v1/lost-reports/${id}`],
      ['PUT', `/v1/lost-reports/${id}/photo`],
      ['POST', `/v1/lost-reports/${id}/found`],
      ['GET', '/v1/pets/p/public-code'],
      ['DELETE', '/v1/pets/p/lost-data'],
      ['GET', '/v1/pet-messages'],
      ['DELETE', '/v1/pets/p/messages'],
    ] as const) {
      const none = await t.call(method, url);
      assert.equal(none.status, 401, `${method} ${url} oturumsuz`);
      const wrong = await t.call(method, url, { token: 'yanlis-anahtar' });
      assert.equal(wrong.status, 401, `${method} ${url} yanlış anahtar`);
    }
  });

  test('veritabanında oturum anahtarının kendisi durmaz', async () => {
    const user = await t.newUser();
    const rows = await t.db.selectFrom('sessions').select('token_hash').where('user_id', '=', user.id).execute();
    assert.equal(rows.length, 1);
    assert.notEqual(rows[0]!.token_hash, user.token);
    assert.equal(rows[0]!.token_hash.length, 64);
  });

  test('süresi dolan oturum geçersizdir', async () => {
    const user = await t.newUser();
    await t.db.updateTable('sessions').set({ expires_at: new Date(Date.now() - 1000) }).where('user_id', '=', user.id).execute();
    assert.equal((await t.call('GET', '/v1/me', { token: user.token })).status, 401);
  });

  test('uzun süredir kullanılan oturumun süresi uzar', async () => {
    const user = await t.newUser();
    const soon = new Date(Date.now() + 60_000);
    await t.db
      .updateTable('sessions')
      .set({ last_used_at: new Date(Date.now() - 2 * 86_400_000), expires_at: soon })
      .where('user_id', '=', user.id)
      .execute();
    assert.equal((await t.call('GET', '/v1/me', { token: user.token })).status, 200);
    const row = await t.db.selectFrom('sessions').select('expires_at').where('user_id', '=', user.id).executeTakeFirstOrThrow();
    assert.ok(row.expires_at.getTime() > soon.getTime() + 86_400_000);
  });

  test('çıkış yalnızca o telefonun oturumunu kapatır', async () => {
    const first = await t.call('POST', '/v1/auth/apple', { body: { identity_token: await appleToken('apple-5') } });
    const second = await t.call('POST', '/v1/auth/apple', { body: { identity_token: await appleToken('apple-5') } });
    assert.equal((await t.call('POST', '/v1/auth/logout', { token: first.json.token })).status, 204);
    assert.equal((await t.call('GET', '/v1/me', { token: first.json.token })).status, 401);
    assert.equal((await t.call('GET', '/v1/me', { token: second.json.token })).status, 200);
  });
});

describe('eşitleme', () => {
  test('kayıt yazılır, okunur; Türkçe karakterler bozulmaz', async () => {
    const { token } = await t.newUser();
    const { status, json } = await t.call('PUT', '/v1/items', {
      token,
      body: { items: [item('a1', { id: 'a1', name: 'Şanslı Çağrı ğüöıİ 🐾' }, AT(0))] },
    });
    assert.equal(status, 200);
    assert.equal(json.accepted, 1);
    const [row] = await pullAll(token);
    assert.equal(row.id, 'a1');
    assert.equal(row.collection, 'pets');
    assert.equal(row.data.name, 'Şanslı Çağrı ğüöıİ 🐾');
    assert.equal(row.deleted, false);
    assert.equal(row.updated_at, AT(0));
    assert.ok(row.synced_at);
  });

  test('bir kullanıcı diğerinin kaydını göremez, ezemez, silemez', async () => {
    const a = await t.newUser();
    const b = await t.newUser();
    await t.call('PUT', '/v1/items', { token: a.token, body: { items: [item('ortak', { name: 'gizli' }, AT(0))] } });
    assert.deepEqual(await pullAll(b.token), []);

    // Aynı kimlikle yazmak yalnızca kendi hesabına yazar.
    await t.call('PUT', '/v1/items', { token: b.token, body: { items: [item('ortak', { name: 'degisti' }, AT(9))] } });
    await t.call('PUT', '/v1/items', { token: b.token, body: { items: [item('ortak', null, AT(10))] } });
    const [row] = await pullAll(a.token);
    assert.equal(row.data.name, 'gizli');
    assert.equal(row.deleted, false);
  });

  test('gönderilen owner_id yok sayılır, başkası adına yazılamaz', async () => {
    const a = await t.newUser();
    const b = await t.newUser();
    await t.call('PUT', '/v1/items', {
      token: b.token,
      body: { items: [{ ...item('hile', { name: 'x' }, AT(0)), owner_id: a.id }] },
    });
    assert.deepEqual(await pullAll(a.token), []);
    assert.equal((await pullAll(b.token)).length, 1);
  });

  test('son değişiklik kazanır: eski kayıt yenisini ezemez', async () => {
    const { token } = await t.newUser();
    await t.call('PUT', '/v1/items', { token, body: { items: [item('x', { v: 'yeni' }, AT(30))] } });
    const before = (await pullAll(token))[0];
    await new Promise((resolve) => setTimeout(resolve, 5));
    await t.call('PUT', '/v1/items', { token, body: { items: [item('x', { v: 'eski' }, AT(10))] } });
    const after = (await pullAll(token))[0];
    assert.equal(after.data.v, 'yeni');
    assert.equal(after.updated_at, AT(30));
    assert.equal(after.synced_at, before.synced_at, 'değişmeyen satır yeniden gönderilmez');
  });

  test('yeni değişiklik uygulanır ve sunucu zamanı ilerler', async () => {
    const { token } = await t.newUser();
    await t.call('PUT', '/v1/items', { token, body: { items: [item('x', { v: 1 }, AT(10))] } });
    const before = (await pullAll(token))[0];
    await new Promise((resolve) => setTimeout(resolve, 5));
    await t.call('PUT', '/v1/items', { token, body: { items: [item('x', { v: 2 }, AT(20))] } });
    const after = (await pullAll(token))[0];
    assert.equal(after.data.v, 2);
    assert.ok(Date.parse(after.synced_at) > Date.parse(before.synced_at));
  });

  test('silinen kayıt iz bırakır, sonra yeniden eklenebilir', async () => {
    const { token } = await t.newUser();
    await t.call('PUT', '/v1/items', { token, body: { items: [item('x', { v: 1 }, AT(10))] } });
    await t.call('PUT', '/v1/items', { token, body: { items: [item('x', null, AT(20))] } });
    let row = (await pullAll(token))[0];
    assert.equal(row.deleted, true);
    assert.equal(row.data, null);
    await t.call('PUT', '/v1/items', { token, body: { items: [item('x', { v: 3 }, AT(30))] } });
    row = (await pullAll(token))[0];
    assert.equal(row.deleted, false);
    assert.equal(row.data.v, 3);
  });

  test('eski silme yeni kaydı silemez', async () => {
    const { token } = await t.newUser();
    await t.call('PUT', '/v1/items', { token, body: { items: [item('x', { v: 2 }, AT(30))] } });
    await t.call('PUT', '/v1/items', { token, body: { items: [item('x', null, AT(10))] } });
    assert.equal((await pullAll(token))[0].deleted, false);
  });

  test('kimlikler büyük-küçük harf ayırır', async () => {
    const { token } = await t.newUser();
    await t.call('PUT', '/v1/items', { token, body: { items: [item('Abc', { v: 1 }, AT(0)), item('abc', { v: 2 }, AT(0))] } });
    assert.equal((await pullAll(token)).length, 2);
  });

  test('aynı kimlik farklı koleksiyonda ayrı kayıttır', async () => {
    const { token } = await t.newUser();
    await t.call('PUT', '/v1/items', { token, body: { items: [item('x', { v: 1 }, AT(0), 'pets'), item('x', { v: 2 }, AT(0), 'tasks')] } });
    assert.equal((await pullAll(token)).length, 2);
  });

  test('tüm koleksiyonlar kabul edilir', async () => {
    const { token } = await t.newUser();
    const names = ['pets', 'health_records', 'visits', 'tasks', 'weights', 'weight_ranges'];
    const { status } = await t.call('PUT', '/v1/items', { token, body: { items: names.map((name) => item(`i-${name}`, { v: 1 }, AT(0), name)) } });
    assert.equal(status, 200);
    assert.equal((await pullAll(token)).length, names.length);
  });

  test('geçersiz girdiler reddedilir', async () => {
    const { token } = await t.newUser();
    for (const [name, items] of [
      ['geçersiz koleksiyon', [item('x', {}, AT(0), 'gecersiz')]],
      ['boş kimlik', [item('', {}, AT(0))]],
      ['çok uzun kimlik', [item('x'.repeat(101), {}, AT(0))]],
      ['bozuk tarih', [item('x', {}, 'dun')]],
      ['dizi veri', [{ collection: 'pets', id: 'x', data: [1], updated_at: AT(0) }]],
      ['boş liste', []],
      ['fazla kayıt', Array.from({ length: 201 }, (_, i) => item(`x${i}`, {}, AT(0)))],
    ] as const) {
      const { status } = await t.call('PUT', '/v1/items', { token, body: { items } });
      assert.equal(status, 400, name);
    }
    assert.deepEqual(await pullAll(token), []);
  });

  test('çok büyük kayıt reddedilir', async () => {
    const { token } = await t.newUser();
    const { status } = await t.call('PUT', '/v1/items', { token, body: { items: [item('b', { blob: 'x'.repeat(70000) }, AT(0))] } });
    assert.equal(status, 413);
  });

  test('tek seferde en fazla 200 kayıt yazılabilir', async () => {
    const { token } = await t.newUser();
    const items = Array.from({ length: 200 }, (_, i) => item(`x${i}`, { i }, AT(0)));
    assert.equal((await t.call('PUT', '/v1/items', { token, body: { items } })).status, 200);
  });

  test('sayfalama hepsini eksiksiz ve tekrarsız getirir', async () => {
    const { token } = await t.newUser();
    const items = Array.from({ length: 25 }, (_, i) => item(`x${String(i).padStart(2, '0')}`, { i }, AT(0)));
    await t.call('PUT', '/v1/items', { token, body: { items } });
    const seen: string[] = [];
    let after: string | null = null;
    let pages = 0;
    do {
      const query: string = `/v1/items?limit=10${after ? `&after=${after}` : ''}`;
      const { json } = await t.call('GET', query, { token });
      seen.push(...json.items.map((row: any) => row.id));
      after = json.next;
      pages += 1;
    } while (after);
    assert.equal(pages, 3);
    assert.equal(seen.length, 25);
    assert.equal(new Set(seen).size, 25);
  });

  test('since yalnızca o andan sonraki değişiklikleri getirir', async () => {
    const { token } = await t.newUser();
    await t.call('PUT', '/v1/items', { token, body: { items: [item('eski', { v: 1 }, AT(0))] } });
    const cursor = (await pullAll(token))[0].synced_at;
    await new Promise((resolve) => setTimeout(resolve, 5));
    await t.call('PUT', '/v1/items', { token, body: { items: [item('yeni', { v: 1 }, AT(0))] } });
    const rows = await pullAll(token, `?since=${cursor}`);
    assert.deepEqual(rows.map((row) => row.id), ['yeni']);
  });

  test('bozuk sayfa anahtarı ve bozuk sorgu reddedilir', async () => {
    const { token } = await t.newUser();
    assert.equal((await t.call('GET', '/v1/items?after=bozuk', { token })).status, 400);
    assert.equal((await t.call('GET', '/v1/items?since=dun', { token })).status, 400);
    assert.equal((await t.call('GET', '/v1/items?limit=5000', { token })).status, 400);
  });

  test('SQL benzeri metin yazı olarak saklanır', async () => {
    const { token } = await t.newUser();
    const evil = "'); DROP TABLE users; --";
    await t.call('PUT', '/v1/items', { token, body: { items: [item(evil, { name: evil }, AT(0))] } });
    const [row] = await pullAll(token);
    assert.equal(row.id, evil);
    assert.equal(row.data.name, evil);
    assert.equal((await t.call('GET', '/v1/me', { token })).status, 200);
  });
});

describe('eşitleme: inceleme bulguları', () => {
  test('saati ileri telefon sonraki düzenlemeleri engelleyemez', async () => {
    const { token } = await t.newUser();
    const future = new Date(Date.now() + 86_400_000).toISOString();
    await t.call('PUT', '/v1/items', { token, body: { items: [item('x', { v: 'ileri' }, future)] } });
    const [stored] = await pullAll(token);
    assert.ok(Date.parse(stored.updated_at) <= Date.now() + 6 * 60_000, 'gelecek zaman sınırlandı');
    await new Promise((resolve) => setTimeout(resolve, 5));
    const later = new Date(Date.now() + 10 * 60_000).toISOString();
    await t.call('PUT', '/v1/items', { token, body: { items: [item('x', { v: 'duzeltilmis' }, later)] } });
    assert.equal((await pullAll(token))[0].data.v, 'duzeltilmis');
  });

  test('yarım emoji eşitlemeyi takmaz', async () => {
    const { token } = await t.newUser();
    const { status } = await t.call('PUT', '/v1/items', {
      token,
      body: { items: [item('y', { name: 'Şanslı\ud83d' }, AT(0))] },
    });
    assert.equal(status, 200);
    assert.ok((await pullAll(token))[0].data.name.startsWith('Şanslı'));
  });

  test('yıllar içinde büyüyen görev kaydı sığar', async () => {
    const { token } = await t.newUser();
    const completedDates = Array.from({ length: 3650 }, () => '2026-11-05');
    const { status } = await t.call('PUT', '/v1/items', { token, body: { items: [item('g', { completedDates }, AT(0), 'tasks')] } });
    assert.equal(status, 200);
  });

  test('hayvan silinip gelince QR, ilan, fotoğraf ve ihbarlar da silinir', async () => {
    const { token } = await t.newUser();
    await t.call('PUT', '/v1/items', { token, body: { items: [item('p9', { name: 'Boncuk' }, AT(0))] } });
    const report = await t.call('POST', '/v1/lost-reports', { token, body: newReport('p9') });
    const code = await publicCode(token, 'p9');
    await t.call('PUT', `/v1/lost-reports/${report.json.id}/photo`, { token, raw: JPEG });
    const photo = (await t.call('GET', `/v1/public/pets/${code}`)).json.photo_path;
    await t.call('POST', `/v1/public/pets/${code}/sightings`, { body: { message: 'x', contact: '0555' } });

    await t.call('PUT', '/v1/items', { token, body: { items: [item('p9', null, AT(10))] } });

    assert.equal((await t.call('GET', `/v1/public/pets/${code}`)).status, 404);
    assert.equal((await t.call('GET', `/v1/public/photos/${photo}`)).status, 404);
    const left = await t.db.selectFrom('sightings').select('id').where('pet_id', '=', 'p9').execute();
    assert.equal(left.length, 0);
  });

  test('eski tarihli silme, yeni kaydı olan hayvanın QR kodunu silmez', async () => {
    const { token } = await t.newUser();
    await t.call('PUT', '/v1/items', { token, body: { items: [item('p8', { name: 'Yeni' }, AT(30))] } });
    const code = await publicCode(token, 'p8');
    await t.call('PUT', '/v1/items', { token, body: { items: [item('p8', null, AT(10))] } });
    assert.equal((await t.call('GET', `/v1/public/pets/${code}`)).status, 200);
  });
});

describe('hayvan fotoğrafları', () => {
  test('sahibi yükler, okur, üstüne yazar, siler', async () => {
    const { token } = await t.newUser();
    assert.equal((await t.call('PUT', '/v1/photos/1.jpg', { token, raw: JPEG })).status, 204);
    const read = await t.call('GET', '/v1/photos/1.jpg', { token });
    assert.equal(read.status, 200);
    assert.equal(read.headers['content-type'], 'image/jpeg');
    assert.deepEqual(read.raw, JPEG);
    assert.match(String(read.headers['cache-control']), /no-store/);
    const second = Buffer.concat([JPEG, Buffer.from([1, 2])]);
    assert.equal((await t.call('PUT', '/v1/photos/1.jpg', { token, raw: second })).status, 204);
    assert.deepEqual((await t.call('GET', '/v1/photos/1.jpg', { token })).raw, second);
    assert.equal((await t.call('DELETE', '/v1/photos/1.jpg', { token })).status, 204);
    assert.equal((await t.call('GET', '/v1/photos/1.jpg', { token })).status, 404);
  });

  test('olmayan fotoğrafı silmek hata vermez', async () => {
    const { token } = await t.newUser();
    assert.equal((await t.call('DELETE', '/v1/photos/yok.jpg', { token })).status, 204);
  });

  test('başka kullanıcı okuyamaz, silemez; aynı adla yazınca kendi klasörüne yazar', async () => {
    const a = await t.newUser();
    const b = await t.newUser();
    await t.call('PUT', '/v1/photos/ozel.jpg', { token: a.token, raw: JPEG });
    assert.equal((await t.call('GET', '/v1/photos/ozel.jpg', { token: b.token })).status, 404);
    await t.call('DELETE', '/v1/photos/ozel.jpg', { token: b.token });
    await t.call('PUT', '/v1/photos/ozel.jpg', { token: b.token, raw: Buffer.concat([JPEG, JPEG]) });
    assert.deepEqual((await t.call('GET', '/v1/photos/ozel.jpg', { token: a.token })).raw, JPEG);
  });

  test('özel fotoğraf herkese açık adresten okunamaz', async () => {
    const a = await t.newUser();
    await t.call('PUT', '/v1/photos/ozel2.jpg', { token: a.token, raw: JPEG });
    assert.equal((await t.call('GET', '/v1/public/photos/ozel2.jpg')).status, 404);
    assert.equal((await t.call('GET', `/v1/public/photos/..%2Fpets%2F${a.id}%2Fozel2.jpg`)).status, 404);
  });

  test('JPEG olmayan dosya reddedilir, içerik türü ne derse desin', async () => {
    const { token } = await t.newUser();
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    assert.equal((await t.call('PUT', '/v1/photos/x.jpg', { token, raw: png })).status, 400);
    assert.equal((await t.call('PUT', '/v1/photos/x.jpg', { token, raw: Buffer.alloc(0) })).status, 400);
    const asPng = await t.call('PUT', '/v1/photos/x.jpg', { token, raw: JPEG, headers: { 'content-type': 'image/png' } });
    assert.ok(asPng.status >= 400);
  });

  test('5 MB üstü reddedilir', async () => {
    const { token } = await t.newUser();
    const big = Buffer.concat([JPEG, Buffer.alloc(5 * 1024 * 1024)]);
    assert.equal((await t.call('PUT', '/v1/photos/b.jpg', { token, raw: big })).status, 413);
  });

  test('klasör atlatan dosya adları reddedilir', async () => {
    const { token } = await t.newUser();
    for (const name of ['..%2F..%2Fetc%2Fpasswd', '.gizli', '..', 'a%2Fb.jpg', 'a%5Cb.jpg', `${'x'.repeat(101)}.jpg`]) {
      // 414: Sunucu çok uzun adresi daha işlemeden reddeder.
      const put = await t.call('PUT', `/v1/photos/${name}`, { token, raw: JPEG });
      assert.ok([400, 404, 414].includes(put.status), `yükleme ${name}: ${put.status}`);
      const get = await t.call('GET', `/v1/photos/${name}`, { token });
      assert.ok([400, 404, 414].includes(get.status), `okuma ${name}: ${get.status}`);
    }
    const files = await readdir(t.photoDir);
    assert.ok(files.every((file) => file === 'pets' || file === 'lost'));
  });
});

describe('kayıp ilanı', () => {
  test('açılır, listelenir, ayrıntısı ve kodu gelir', async () => {
    const { token } = await t.newUser();
    const created = await t.call('POST', '/v1/lost-reports', { token, body: newReport('p1') });
    assert.equal(created.status, 201);
    assert.equal(created.json.already_open, false);

    const list = await t.call('GET', '/v1/lost-reports?active=true', { token });
    assert.equal(list.json.reports.length, 1);
    assert.equal('owner_id' in list.json.reports[0], false);

    const details = await t.call('GET', `/v1/lost-reports/${created.json.id}`, { token });
    assert.equal(details.json.report.pet_name, 'Zeytin');
    assert.equal(details.json.report.last_seen_lat, 40.987654, 'sahibi tam konumu görür');
    assert.match(details.json.public_code, /^[0-9a-f]{12}$/);
    assert.deepEqual(details.json.sightings, []);
  });

  test('aynı hayvana ikinci ilan açılmaz, açık olana yönlendirir', async () => {
    const { token } = await t.newUser();
    const first = await t.call('POST', '/v1/lost-reports', { token, body: newReport('p1') });
    const second = await t.call('POST', '/v1/lost-reports', { token, body: newReport('p1') });
    assert.equal(second.status, 200);
    assert.equal(second.json.already_open, true);
    assert.equal(second.json.id, first.json.id);
  });

  test('iki hayvanın aynı anda ilanı olabilir, iki kullanıcının aynı kimlikli hayvanı karışmaz', async () => {
    const a = await t.newUser();
    const b = await t.newUser();
    assert.equal((await t.call('POST', '/v1/lost-reports', { token: a.token, body: newReport('p1') })).status, 201);
    assert.equal((await t.call('POST', '/v1/lost-reports', { token: a.token, body: newReport('p2') })).status, 201);
    assert.equal((await t.call('POST', '/v1/lost-reports', { token: b.token, body: newReport('p1') })).status, 201);
  });

  test('aynı anda gelen iki başlatma tek ilan açar', async () => {
    const { token } = await t.newUser();
    const results = await Promise.all([
      t.call('POST', '/v1/lost-reports', { token, body: newReport('p1') }),
      t.call('POST', '/v1/lost-reports', { token, body: newReport('p1') }),
      t.call('POST', '/v1/lost-reports', { token, body: newReport('p1') }),
    ]);
    assert.equal(new Set(results.map((result) => result.json.id)).size, 1);
    const list = await t.call('GET', '/v1/lost-reports', { token });
    assert.equal(list.json.reports.length, 1);
  });

  test('bulunduktan sonra aynı hayvana yeni ilan açılabilir', async () => {
    const { token } = await t.newUser();
    const first = await t.call('POST', '/v1/lost-reports', { token, body: newReport('p1') });
    await t.call('POST', `/v1/lost-reports/${first.json.id}/found`, { token });
    const second = await t.call('POST', '/v1/lost-reports', { token, body: newReport('p1') });
    assert.equal(second.status, 201);
    assert.notEqual(second.json.id, first.json.id);
    const code = await publicCode(token, 'p1');
    const page = await t.call('GET', `/v1/public/pets/${code}`);
    assert.equal(page.json.status, 'lost', 'açık ilan eski bulunan ilanın önüne geçer');
  });

  test('kod değişmez: ilan açılıp kapansa da aynı kalır', async () => {
    const { token } = await t.newUser();
    const before = await publicCode(token, 'p1');
    const report = await t.call('POST', '/v1/lost-reports', { token, body: newReport('p1') });
    await t.call('POST', `/v1/lost-reports/${report.json.id}/found`, { token });
    assert.equal(await publicCode(token, 'p1'), before);
  });

  test('geçersiz ilan verisi reddedilir', async () => {
    const { token } = await t.newUser();
    for (const [name, overrides] of [
      ['bilinmeyen tür', { species: 'at' }],
      ['boş ad', { pet_name: '   ' }],
      ['uzun ad', { pet_name: 'x'.repeat(31) }],
      ['boş semt', { last_seen_area: ' ' }],
      ['uzun semt', { last_seen_area: 'x'.repeat(81) }],
      ['uzun açıklama', { description: 'x'.repeat(301) }],
      ['uzun ırk', { breed: 'x'.repeat(41) }],
      ['geçersiz enlem', { last_seen_lat: 91 }],
      ['geçersiz boylam', { last_seen_lng: -181 }],
      ['bozuk zaman', { last_seen_at: 'bugun' }],
    ] as const) {
      const { status } = await t.call('POST', '/v1/lost-reports', { token, body: newReport('p1', overrides) });
      assert.equal(status, 400, name);
    }
  });

  test('başka kullanıcı ilanı göremez, değiştiremez, kapatamaz, fotoğraf ekleyemez', async () => {
    const a = await t.newUser();
    const b = await t.newUser();
    const { json } = await t.call('POST', '/v1/lost-reports', { token: a.token, body: newReport('p1') });
    assert.deepEqual((await t.call('GET', '/v1/lost-reports', { token: b.token })).json.reports, []);
    assert.equal((await t.call('GET', `/v1/lost-reports/${json.id}`, { token: b.token })).status, 404);
    assert.equal((await t.call('POST', `/v1/lost-reports/${json.id}/found`, { token: b.token })).status, 404);
    assert.equal((await t.call('PUT', `/v1/lost-reports/${json.id}/photo`, { token: b.token, raw: JPEG })).status, 404);
    await t.call('DELETE', '/v1/pets/p1/lost-data', { token: b.token });
    const page = await t.call('GET', `/v1/lost-reports/${json.id}`, { token: a.token });
    assert.equal(page.json.report.found_at, null);
  });

  test('ilan fotoğrafı herkese açık, bulununca silinir', async () => {
    const { token } = await t.newUser();
    const { json } = await t.call('POST', '/v1/lost-reports', { token, body: newReport('p1') });
    assert.equal((await t.call('PUT', `/v1/lost-reports/${json.id}/photo`, { token, raw: JPEG })).status, 204);
    const code = await publicCode(token, 'p1');
    const page = await t.call('GET', `/v1/public/pets/${code}`);
    const photo = await t.call('GET', `/v1/public/photos/${page.json.photo_path}`);
    assert.equal(photo.status, 200);
    assert.deepEqual(photo.raw, JPEG);

    await t.call('POST', `/v1/lost-reports/${json.id}/found`, { token });
    assert.equal((await t.call('GET', `/v1/public/photos/${page.json.photo_path}`)).status, 404);
    const after = await t.call('GET', `/v1/public/pets/${code}`);
    assert.deepEqual(after.json, { status: 'found', pet_name: 'Zeytin' });
  });

  test('ilan fotoğrafındaki GPS ve gizli bilgiler silinir, görüntü verisi kalır', async () => {
    const { token } = await t.newUser();
    const { json } = await t.call('POST', '/v1/lost-reports', { token, body: newReport('p1') });
    const segment = (marker: number, text: string) => {
      const body = Buffer.from(text);
      const head = Buffer.from([0xff, marker, 0, 0]);
      head.writeUInt16BE(body.length + 2, 2);
      return Buffer.concat([head, body]);
    };
    const scan = Buffer.from([0xff, 0xda, 0x00, 0x02, 0x11, 0x22, 0x33, 0xff, 0xd9]);
    const photo = Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      segment(0xe0, 'JFIF'),
      segment(0xe1, 'Exif GPSLatitude 40.98'),
      segment(0xe2, 'ICC gizli'),
      segment(0xfe, 'yorum gizli'),
      segment(0xdb, 'tablo'),
      scan,
    ]);
    assert.equal((await t.call('PUT', `/v1/lost-reports/${json.id}/photo`, { token, raw: photo })).status, 204);
    const code = await publicCode(token, 'p1');
    const file = (await t.call('GET', `/v1/public/pets/${code}`)).json.photo_path;
    const served = (await t.call('GET', `/v1/public/photos/${file}`)).raw;
    const text = served.toString('latin1');
    for (const secret of ['GPSLatitude', '40.98', 'gizli']) {
      assert.ok(!text.includes(secret), secret);
    }
    assert.ok(text.includes('JFIF') && text.includes('tablo'), 'temel bölümler kalır');
    assert.ok(served.subarray(-9).equals(scan), 'görüntü verisi aynen kalır');
  });

  test('bozuk JPEG ilan fotoğrafı olarak kabul edilmez', async () => {
    const { token } = await t.newUser();
    const { json } = await t.call('POST', '/v1/lost-reports', { token, body: newReport('p1') });
    const broken = Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff, 0x00]);
    assert.equal((await t.call('PUT', `/v1/lost-reports/${json.id}/photo`, { token, raw: broken })).status, 400);
  });

  test('başlatma yarım kaldıysa uygulama fotoğrafın eksik olduğunu öğrenir', async () => {
    const { token } = await t.newUser();
    const first = await t.call('POST', '/v1/lost-reports', { token, body: newReport('p1') });
    assert.equal(first.json.has_photo, false);
    const again = await t.call('POST', '/v1/lost-reports', { token, body: newReport('p1') });
    assert.equal(again.json.already_open, true);
    assert.equal(again.json.has_photo, false);
    await t.call('PUT', `/v1/lost-reports/${first.json.id}/photo`, { token, raw: JPEG });
    assert.equal((await t.call('POST', '/v1/lost-reports', { token, body: newReport('p1') })).json.has_photo, true);
  });

  test('fotoğraf değişince eskisi diskten silinir', async () => {
    const { token } = await t.newUser();
    const { json } = await t.call('POST', '/v1/lost-reports', { token, body: newReport('p1') });
    const code = await publicCode(token, 'p1');
    await t.call('PUT', `/v1/lost-reports/${json.id}/photo`, { token, raw: JPEG });
    const old = (await t.call('GET', `/v1/public/pets/${code}`)).json.photo_path;
    await t.call('PUT', `/v1/lost-reports/${json.id}/photo`, { token, raw: Buffer.concat([JPEG, JPEG]) });
    const current = (await t.call('GET', `/v1/public/pets/${code}`)).json.photo_path;
    assert.notEqual(current, old);
    assert.equal((await t.call('GET', `/v1/public/photos/${old}`)).status, 404);
  });

  test('kapanan ilana fotoğraf eklenemez, iki kez kapatmak bozmaz', async () => {
    const { token } = await t.newUser();
    const { json } = await t.call('POST', '/v1/lost-reports', { token, body: newReport('p1') });
    assert.equal((await t.call('POST', `/v1/lost-reports/${json.id}/found`, { token })).status, 204);
    const foundAt = (await t.call('GET', `/v1/lost-reports/${json.id}`, { token })).json.report.found_at;
    assert.equal((await t.call('POST', `/v1/lost-reports/${json.id}/found`, { token })).status, 204);
    assert.equal((await t.call('GET', `/v1/lost-reports/${json.id}`, { token })).json.report.found_at, foundAt);
    assert.equal((await t.call('PUT', `/v1/lost-reports/${json.id}/photo`, { token, raw: JPEG })).status, 404);
  });
});

describe('herkese açık sayfa', () => {
  test('yalnızca izinli alanlar görünür: tam konum ve sahip yok', async () => {
    const { token, id } = await t.newUser();
    await t.call('POST', '/v1/lost-reports', { token, body: newReport('p1') });
    const code = await publicCode(token, 'p1');
    const { status, json } = await t.call('GET', `/v1/public/pets/${code}`);
    assert.equal(status, 200);
    assert.equal(json.status, 'lost');
    assert.equal(json.pet_name, 'Zeytin');
    assert.equal(json.last_seen_area, 'Moda, Kadıköy');
    assert.deepEqual(
      Object.keys(json).sort(),
      ['breed', 'description', 'last_seen_area', 'last_seen_at', 'pet_name', 'photo_path', 'species', 'started_at', 'status'].sort(),
    );
    const text = JSON.stringify(json);
    assert.ok(!text.includes('40.98') && !text.includes('29.12'), 'tam konum sızmaz');
    assert.ok(!text.includes(id), 'sahip sızmaz');
  });

  test('ihbarcının bilgileri sayfada görünmez', async () => {
    const { token } = await t.newUser();
    await t.call('POST', '/v1/lost-reports', { token, body: newReport('p1') });
    const code = await publicCode(token, 'p1');
    await t.call('POST', `/v1/public/pets/${code}/sightings`, { body: { message: 'Gizli mesaj', contact: '05551234567', lat: 41.5, lng: 29.5 } });
    const text = JSON.stringify((await t.call('GET', `/v1/public/pets/${code}`)).json);
    for (const secret of ['05551234567', 'Gizli mesaj', '41.5']) {
      assert.ok(!text.includes(secret), secret);
    }
  });

  test('ilan hiç açılmadıysa none döner, ad ve sahip yok', async () => {
    const { token, id } = await t.newUser();
    const code = await publicCode(token, 'p1');
    const { json } = await t.call('GET', `/v1/public/pets/${code}`);
    assert.deepEqual(json, { status: 'none' });
    assert.ok(!JSON.stringify(json).includes(id));
  });

  test('yanlış ve bozuk kod 404 döner', async () => {
    for (const code of ['000000000000', 'yanliskod123', 'ABCDEF123456', '123', "1'%20OR%201=1"]) {
      const { status, json } = await t.call('GET', `/v1/public/pets/${code}`);
      assert.equal(status, 404, code);
      assert.equal(json.error, 'unknown_code');
    }
  });

  test('ihbar: yer, mesaj ya da konumdan biri yeterli, hepsi sahibine ulaşır', async () => {
    const { token } = await t.newUser();
    const report = await t.call('POST', '/v1/lost-reports', { token, body: newReport('p1') });
    const code = await publicCode(token, 'p1');
    for (const body of [
      { place: 'Bahariye' },
      { message: 'Parka gitti' },
      { lat: 40.99, lng: 29.03 },
      { place: 'Moda', lat: 40.99, lng: 29.03, message: 'Gördüm', contact: '0555' },
    ]) {
      assert.equal((await t.call('POST', `/v1/public/pets/${code}/sightings`, { body })).status, 201);
    }
    const details = await t.call('GET', `/v1/lost-reports/${report.json.id}`, { token });
    assert.equal(details.json.sightings.length, 4);
    assert.equal(details.json.sightings[0].contact, '0555', 'en yeni üstte');
    assert.equal('owner_id' in details.json.sightings[0], false);
  });

  test('ihbar: boşluklar temizlenir, yalnız boşluk boş sayılır', async () => {
    const { token } = await t.newUser();
    const report = await t.call('POST', '/v1/lost-reports', { token, body: newReport('p1') });
    const code = await publicCode(token, 'p1');
    assert.equal((await t.call('POST', `/v1/public/pets/${code}/sightings`, { body: { place: '  Moda  ', contact: '   ', message: '' } })).status, 201);
    const [row] = (await t.call('GET', `/v1/lost-reports/${report.json.id}`, { token })).json.sightings;
    assert.equal(row.place, 'Moda');
    assert.equal(row.contact, null);
    assert.equal(row.message, null);
  });

  test('ihbar: geçersiz girdiler reddedilir', async () => {
    const { token } = await t.newUser();
    await t.call('POST', '/v1/lost-reports', { token, body: newReport('p1') });
    const code = await publicCode(token, 'p1');
    for (const [expected, body] of [
      ['empty_sighting', {}],
      ['empty_sighting', { place: '   ', message: '  ' }],
      ['empty_sighting', { contact: '0555' }],
      ['invalid_location', { lat: 40.99 }],
      ['invalid_location', { lng: 29.03 }],
      ['invalid_request', { message: 'x'.repeat(501) }],
      ['invalid_request', { place: 'x'.repeat(81) }],
      ['invalid_request', { contact: 'x'.repeat(81) }],
      ['invalid_request', { lat: 91, lng: 29 }],
      ['invalid_request', { lat: 40, lng: 181 }],
      ['invalid_request', { lat: 'kırk', lng: 29 }],
    ] as const) {
      const { status, json } = await t.call('POST', `/v1/public/pets/${code}/sightings`, { body });
      assert.equal(status, 400, JSON.stringify(body));
      assert.equal(json.error, expected, JSON.stringify(body));
    }
  });

  test('ihbar: yanlış koda gitmez, sahibini seçemez', async () => {
    const a = await t.newUser();
    const b = await t.newUser();
    assert.equal((await t.call('POST', '/v1/public/pets/000000000000/sightings', { body: { message: 'x' } })).status, 404);
    const code = await publicCode(b.token, 'p1');
    await t.call('POST', `/v1/public/pets/${code}/sightings`, { body: { message: 'x', owner_id: a.id, report_id: 'x', pet_id: 'y' } });
    assert.deepEqual((await t.call('GET', '/v1/pet-messages', { token: a.token })).json.messages, []);
    const [message] = (await t.call('GET', '/v1/pet-messages', { token: b.token })).json.messages;
    assert.equal(message.pet_id, 'p1');
  });

  test('ihbar: HTML metni olduğu gibi saklanır', async () => {
    const { token } = await t.newUser();
    const code = await publicCode(token, 'p1');
    const evil = '<script>alert(1)</script>';
    await t.call('POST', `/v1/public/pets/${code}/sightings`, { body: { message: evil } });
    const [message] = (await t.call('GET', '/v1/pet-messages', { token })).json.messages;
    assert.equal(message.message, evil);
  });

  test('ihbar: saatte 30 sınırı', async () => {
    const { token, id } = await t.newUser();
    const report = await t.call('POST', '/v1/lost-reports', { token, body: newReport('p1') });
    const code = await publicCode(token, 'p1');
    await t.db
      .insertInto('sightings')
      .values(Array.from({ length: 30 }, () => ({ id: crypto.randomUUID(), report_id: report.json.id, owner_id: id, pet_id: 'p1', message: 'x' })))
      .execute();
    const { status, json } = await t.call('POST', `/v1/public/pets/${code}/sightings`, { body: { message: 'x' } });
    assert.equal(status, 429);
    assert.equal(json.error, 'too_many_sightings');
  });

  test('ilan öncesi bırakılan haberler gerçek ilanın ihbarlarını engelleyemez', async () => {
    const { token, id } = await t.newUser();
    const code = await publicCode(token, 'p1');
    await t.db
      .insertInto('sightings')
      .values(Array.from({ length: 500 }, () => ({ id: crypto.randomUUID(), owner_id: id, pet_id: 'p1', message: 'x', created_at: new Date(Date.now() - 30 * 60_000) })))
      .execute();
    assert.equal((await t.call('POST', `/v1/public/pets/${code}/sightings`, { body: { message: 'sinirda' } })).status, 429);
    await t.call('POST', '/v1/lost-reports', { token, body: newReport('p1') });
    assert.equal((await t.call('POST', `/v1/public/pets/${code}/sightings`, { body: { message: 'gercek' } })).status, 201);
  });

  test('ihbar: eski ihbarlar saatlik sınırı doldurmaz, toplam 500 sınırı geçerli', async () => {
    const { token, id } = await t.newUser();
    const report = await t.call('POST', '/v1/lost-reports', { token, body: newReport('p1') });
    const code = await publicCode(token, 'p1');
    await t.db.updateTable('lost_reports').set({ started_at: new Date(Date.now() - 3 * 3_600_000) }).where('id', '=', report.json.id).execute();
    const old = (count: number) =>
      t.db
        .insertInto('sightings')
        .values(Array.from({ length: count }, () => ({ id: crypto.randomUUID(), report_id: report.json.id, owner_id: id, pet_id: 'p1', message: 'x', created_at: new Date(Date.now() - 2 * 3_600_000) })))
        .execute();
    await old(100);
    assert.equal((await t.call('POST', `/v1/public/pets/${code}/sightings`, { body: { message: 'x' } })).status, 201);
    await old(399);
    assert.equal((await t.call('POST', `/v1/public/pets/${code}/sightings`, { body: { message: 'x' } })).status, 429);
  });
});

describe('ilan yokken haber', () => {
  test('sahibine haber olarak düşer, iletişim görünür', async () => {
    const { token } = await t.newUser();
    const code = await publicCode(token, 'p1');
    assert.equal((await t.call('POST', `/v1/public/pets/${code}/sightings`, { body: { lat: 41.01, lng: 29.02, message: 'Tasmada QR var', contact: '0555' } })).status, 201);
    const { json } = await t.call('GET', '/v1/pet-messages', { token });
    assert.equal(json.messages.length, 1);
    assert.equal(json.messages[0].pet_id, 'p1');
    assert.equal(json.messages[0].contact, '0555');
    assert.equal(json.messages[0].report_id, null);
  });

  test('başka kullanıcı göremez, silemez', async () => {
    const a = await t.newUser();
    const b = await t.newUser();
    const code = await publicCode(a.token, 'p1');
    await t.call('POST', `/v1/public/pets/${code}/sightings`, { body: { message: 'x' } });
    assert.deepEqual((await t.call('GET', '/v1/pet-messages', { token: b.token })).json.messages, []);
    await t.call('DELETE', '/v1/pets/p1/messages', { token: b.token });
    assert.equal((await t.call('GET', '/v1/pet-messages', { token: a.token })).json.messages.length, 1);
  });

  test('kayıp modu başlayınca haberler ilana eklenir', async () => {
    const { token } = await t.newUser();
    const code = await publicCode(token, 'p1');
    await t.call('POST', `/v1/public/pets/${code}/sightings`, { body: { message: 'x', lat: 41, lng: 29 } });
    const { json } = await t.call('POST', '/v1/lost-reports', { token, body: newReport('p1') });
    const details = await t.call('GET', `/v1/lost-reports/${json.id}`, { token });
    assert.equal(details.json.sightings.length, 1);
    assert.deepEqual((await t.call('GET', '/v1/pet-messages', { token })).json.messages, []);
  });

  test('başka hayvanın haberi ilana karışmaz', async () => {
    const { token } = await t.newUser();
    const other = await publicCode(token, 'p2');
    await t.call('POST', `/v1/public/pets/${other}/sightings`, { body: { message: 'x' } });
    const { json } = await t.call('POST', '/v1/lost-reports', { token, body: newReport('p1') });
    assert.deepEqual((await t.call('GET', `/v1/lost-reports/${json.id}`, { token })).json.sightings, []);
    assert.equal((await t.call('GET', '/v1/pet-messages', { token })).json.messages.length, 1);
  });

  test('bulunan hayvana gelen haber ilana değil sahibine gider', async () => {
    const { token } = await t.newUser();
    const report = await t.call('POST', '/v1/lost-reports', { token, body: newReport('p1') });
    const code = await publicCode(token, 'p1');
    await t.call('POST', `/v1/lost-reports/${report.json.id}/found`, { token });
    assert.equal((await t.call('POST', `/v1/public/pets/${code}/sightings`, { body: { message: 'yine kaçtı' } })).status, 201);
    assert.equal((await t.call('GET', `/v1/lost-reports/${report.json.id}`, { token })).json.sightings.length, 0);
    assert.equal((await t.call('GET', '/v1/pet-messages', { token })).json.messages.length, 1);
  });

  test('sahibi yalnızca o hayvanın ilansız haberlerini siler', async () => {
    const { token } = await t.newUser();
    const report = await t.call('POST', '/v1/lost-reports', { token, body: newReport('p1') });
    const code1 = await publicCode(token, 'p1');
    const code2 = await publicCode(token, 'p2');
    await t.call('POST', `/v1/public/pets/${code1}/sightings`, { body: { message: 'ilana' } });
    await t.call('POST', `/v1/public/pets/${code2}/sightings`, { body: { message: 'p2 haberi' } });
    await t.call('DELETE', '/v1/pets/p1/messages', { token });
    assert.equal((await t.call('GET', `/v1/lost-reports/${report.json.id}`, { token })).json.sightings.length, 1);
    assert.equal((await t.call('GET', '/v1/pet-messages', { token })).json.messages.length, 1);
  });
});

describe('silme', () => {
  test('hayvan silinince ilan, fotoğraf, ihbar ve kod gider', async () => {
    const { token } = await t.newUser();
    const report = await t.call('POST', '/v1/lost-reports', { token, body: newReport('p1') });
    const code = await publicCode(token, 'p1');
    await t.call('PUT', `/v1/lost-reports/${report.json.id}/photo`, { token, raw: JPEG });
    const photo = (await t.call('GET', `/v1/public/pets/${code}`)).json.photo_path;
    await t.call('POST', `/v1/public/pets/${code}/sightings`, { body: { message: 'x' } });

    assert.equal((await t.call('DELETE', '/v1/pets/p1/lost-data', { token })).status, 204);
    assert.equal((await t.call('GET', `/v1/public/pets/${code}`)).status, 404);
    assert.equal((await t.call('GET', `/v1/public/photos/${photo}`)).status, 404);
    assert.equal((await t.call('GET', `/v1/lost-reports/${report.json.id}`, { token })).status, 404);
    const left = await t.db.selectFrom('sightings').select('id').where('pet_id', '=', 'p1').where('report_id', '=', report.json.id).execute();
    assert.equal(left.length, 0);
  });

  test('hesap silinince her şey gider, başkasına dokunulmaz', async () => {
    const a = await t.newUser();
    const b = await t.newUser();
    await t.call('PUT', '/v1/items', { token: a.token, body: { items: [item('x', { v: 1 }, AT(0))] } });
    await t.call('PUT', '/v1/items', { token: b.token, body: { items: [item('x', { v: 1 }, AT(0))] } });
    await t.call('PUT', '/v1/photos/1.jpg', { token: a.token, raw: JPEG });
    await t.call('PUT', '/v1/photos/1.jpg', { token: b.token, raw: JPEG });
    const report = await t.call('POST', '/v1/lost-reports', { token: a.token, body: newReport('p1') });
    await t.call('PUT', `/v1/lost-reports/${report.json.id}/photo`, { token: a.token, raw: JPEG });
    const code = await publicCode(a.token, 'p1');
    const photo = (await t.call('GET', `/v1/public/pets/${code}`)).json.photo_path;

    assert.equal((await t.call('DELETE', '/v1/me', { token: a.token })).status, 204);

    assert.equal((await t.call('GET', '/v1/me', { token: a.token })).status, 401, 'oturum kapanır');
    assert.equal((await t.call('GET', `/v1/public/pets/${code}`)).status, 404, 'herkese açık sayfa kapanır');
    assert.equal((await t.call('GET', `/v1/public/photos/${photo}`)).status, 404, 'herkese açık fotoğraf gider');
    await assert.rejects(readdir(join(t.photoDir, 'pets', a.id)), 'özel fotoğraflar gider');
    for (const table of ['user_items', 'lost_reports', 'pet_tags', 'sightings'] as const) {
      const rows = await t.db.selectFrom(table).select('owner_id').where('owner_id', '=', a.id).execute();
      assert.equal(rows.length, 0, table);
    }
    assert.equal((await pullAll(b.token)).length, 1, 'diğer kullanıcının kaydı durur');
    assert.equal((await t.call('GET', '/v1/photos/1.jpg', { token: b.token })).status, 200);
  });

  test('fotoğraf silinemese de hesap silinir ve telefona başarı döner', async () => {
    const broken = await startApp({
      photos: { deleteAllPetPhotos: () => Promise.reject(new Error('disk hatası')) },
    });
    try {
      const user = await broken.newUser();
      assert.equal((await broken.call('DELETE', '/v1/me', { token: user.token })).status, 204);
      assert.equal((await broken.call('GET', '/v1/me', { token: user.token })).status, 401);
      const rows = await broken.db.selectFrom('users').select('id').where('id', '=', user.id).execute();
      assert.equal(rows.length, 0);
    } finally {
      await broken.stop();
    }
  });
});

describe('canlı bağlantı', () => {
  let port = 0;
  let live: TestApp;

  before(async () => {
    live = await startApp();
    await live.app.listen({ host: '127.0.0.1', port: 0 });
    port = (live.app.server.address() as { port: number }).port;
  });
  after(() => live.stop());

  function connect() {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/events`);
    const messages: any[] = [];
    let closeCode: number | null = null;
    const waiters: (() => void)[] = [];
    const wake = () => waiters.splice(0).forEach((resolve) => resolve());
    socket.addEventListener('message', (event) => {
      messages.push(JSON.parse(String(event.data)));
      wake();
    });
    socket.addEventListener('close', (event) => {
      closeCode = event.code;
      wake();
    });
    return {
      socket,
      messages,
      closed: () => closeCode,
      async until(check: () => boolean, ms = 3000) {
        const deadline = Date.now() + ms;
        while (!check()) {
          const left = deadline - Date.now();
          if (left <= 0) {
            throw new Error('Beklenen olay gelmedi');
          }
          await Promise.race([
            new Promise<void>((resolve) => waiters.push(resolve)),
            new Promise((resolve) => setTimeout(resolve, left)),
          ]);
        }
      },
      opened: new Promise<void>((resolve) => socket.addEventListener('open', () => resolve())),
    };
  }

  async function authed(token: string) {
    const client = connect();
    await client.opened;
    client.socket.send(JSON.stringify({ type: 'auth', token }));
    await client.until(() => client.messages.some((message) => message.type === 'ready'));
    return client;
  }

  test('yeni ihbar sahibine anında ulaşır, başkasına ulaşmaz', async () => {
    const a = await live.newUser();
    const b = await live.newUser();
    const clientA = await authed(a.token);
    const clientB = await authed(b.token);
    const { json } = await live.call('GET', '/v1/pets/p1/public-code', { token: a.token });
    await live.call('POST', `/v1/public/pets/${json.public_code}/sightings`, { body: { message: 'Canlı', contact: '0555' } });
    await clientA.until(() => clientA.messages.some((message) => message.type === 'sighting'));
    const event = clientA.messages.find((message) => message.type === 'sighting');
    assert.equal(event.sighting.message, 'Canlı');
    assert.equal(event.sighting.pet_id, 'p1');
    assert.equal('owner_id' in event.sighting, false);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(clientB.messages.filter((message) => message.type === 'sighting').length, 0);
    clientA.socket.close();
    clientB.socket.close();
  });

  test('aynı hesabın iki telefonu da haberi alır', async () => {
    const a = await live.newUser();
    const first = await authed(a.token);
    const second = await authed(a.token);
    const { json } = await live.call('GET', '/v1/pets/p1/public-code', { token: a.token });
    await live.call('POST', `/v1/public/pets/${json.public_code}/sightings`, { body: { message: 'x' } });
    await first.until(() => first.messages.some((message) => message.type === 'sighting'));
    await second.until(() => second.messages.some((message) => message.type === 'sighting'));
    first.socket.close();
    second.socket.close();
  });

  for (const [name, payload] of [
    ['yanlış anahtar', JSON.stringify({ type: 'auth', token: 'yanlis' })],
    ['bozuk mesaj', 'bozuk'],
    ['anahtarsız mesaj', JSON.stringify({ type: 'auth' })],
  ] as const) {
    test(`${name} bağlantıyı kapatır`, async () => {
      const client = connect();
      await client.opened;
      client.socket.send(payload);
      await client.until(() => client.closed() !== null);
      assert.equal(client.closed(), 4401);
    });
  }

  test('hiç kimlik göndermeyen bağlantı süre dolunca kapanır', async () => {
    const client = connect();
    await client.opened;
    await client.until(() => client.closed() !== null, 7000);
    assert.equal(client.closed(), 4401);
  });

  test('çıkış yapınca yalnızca o telefonun bağlantısı kapanır', async () => {
    const first = await live.call('POST', '/v1/auth/apple', { body: { identity_token: await appleToken('apple-canli') } });
    const second = await live.call('POST', '/v1/auth/apple', { body: { identity_token: await appleToken('apple-canli') } });
    const leaving = await authed(first.json.token);
    const staying = await authed(second.json.token);
    await live.call('POST', '/v1/auth/logout', { token: first.json.token });
    await leaving.until(() => leaving.closed() !== null);
    assert.equal(leaving.closed(), 4401);
    const { json } = await live.call('GET', '/v1/pets/p1/public-code', { token: second.json.token });
    await live.call('POST', `/v1/public/pets/${json.public_code}/sightings`, { body: { message: 'x' } });
    await staying.until(() => staying.messages.some((message) => message.type === 'sighting'));
    assert.equal(staying.closed(), null);
    staying.socket.close();
  });

  test('hesap silinince bağlantılar kapanır', async () => {
    const a = await live.newUser();
    const client = await authed(a.token);
    await live.call('DELETE', '/v1/me', { token: a.token });
    await client.until(() => client.closed() !== null);
    assert.equal(client.closed(), 4401);
  });
});

describe('ayarlar', () => {
  const base = { DATABASE_URL: 'mysql://x', APPLE_AUDIENCES: 'com.patika.app' };

  test('gerçek sunucuda Expo Go kimliği kabul edilmez', () => {
    assert.throws(() => loadConfig({ ...base, APPLE_AUDIENCES: 'host.exp.Exponent' }), /olamaz/);
    assert.equal(loadConfig({ ...base, APPLE_AUDIENCES: 'host.exp.Exponent', ALLOW_DEV_LOGIN: 'true' }).ALLOW_DEV_LOGIN, true);
  });

  test('zorunlu ayar eksikse sunucu açılmaz', () => {
    assert.throws(() => loadConfig({ APPLE_AUDIENCES: 'x' }));
    assert.throws(() => loadConfig({ DATABASE_URL: 'x', APPLE_AUDIENCES: ' , ' }));
  });

  test('varsayılanlar güvenli tarafta', () => {
    const config = loadConfig(base);
    assert.equal(config.ALLOW_DEV_LOGIN, false);
    assert.deepEqual(config.CORS_ORIGINS, []);
    assert.equal(config.TRUST_PROXY, false);
  });
});

describe('sınırlar ve güvenlik', () => {
  test('giriş denemeleri sınırlanır', async () => {
    const limited = await startApp({ rateLimits: { auth: 2 } });
    assert.equal((await limited.call('POST', '/v1/auth/dev')).status, 200);
    assert.equal((await limited.call('POST', '/v1/auth/dev')).status, 200);
    const blocked = await limited.call('POST', '/v1/auth/dev');
    assert.equal(blocked.status, 429);
    assert.equal(blocked.json.error, 'rate_limited');
    await limited.stop();
  });

  test('ihbar gönderme ziyaretçi başına sınırlanır', async () => {
    const limited = await startApp({ rateLimits: { publicWrite: 2 } });
    const { token } = await limited.newUser();
    const { json } = await limited.call('GET', '/v1/pets/p1/public-code', { token });
    const send = () => limited.call('POST', `/v1/public/pets/${json.public_code}/sightings`, { body: { message: 'x' } });
    assert.equal((await send()).status, 201);
    assert.equal((await send()).status, 201);
    assert.equal((await send()).status, 429);
    await limited.stop();
  });

  test('sayfa QR adresinden açılır, güvenlik başlıkları gelir', async () => {
    const page = await t.call('GET', '/p/8718cd6c2425');
    assert.equal(page.status, 200);
    assert.match(String(page.headers['content-type']), /text\/html/);
    assert.match(page.raw.toString(), /<title>Patika<\/title>/);
    assert.match(String(page.headers['content-security-policy']), /default-src 'none'/);
    assert.match(String(page.headers['content-security-policy']), /connect-src 'self'/);
    assert.equal(page.headers['x-robots-tag'], 'noindex');
    assert.equal(page.headers['x-content-type-options'], 'nosniff');
    assert.equal(page.headers['referrer-policy'], 'no-referrer');
  });

  test('sayfanın dosyaları yüklenir', async () => {
    for (const path of ['/app.js', '/style.css', '/favicon.svg', '/fonts/figtree-500.woff2', '/fonts/unbounded-700.woff2']) {
      assert.equal((await t.call('GET', path)).status, 200, path);
    }
  });

  test('sunucunun kendi dosyaları dışarı verilmez', async () => {
    for (const path of ['/.env', '/package.json', '/src/app.ts', '/../package.json', '/..%2F.env', '/fonts/../../.env', '/migrations/0001_init.sql']) {
      assert.equal((await t.call('GET', path)).status, 404, path);
    }
  });

  test('bilinmeyen adres ve bozuk JSON iç bilgi vermez', async () => {
    const missing = await t.call('GET', '/v1/yok');
    assert.equal(missing.status, 404);
    assert.deepEqual(missing.json, { error: 'not_found' });
    const { token } = await t.newUser();
    const broken = await t.app.inject({
      method: 'PUT',
      url: '/v1/items',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: '{bozuk',
    });
    assert.equal(broken.statusCode, 400);
    assert.deepEqual(broken.json(), { error: 'invalid_request' });
  });

  test('başka sitelerden tarayıcı isteği varsayılan olarak kapalı', async () => {
    const response = await t.call('GET', '/v1/public/pets/000000000000', { headers: { origin: 'https://sahte.example.com' } });
    assert.equal(response.headers['access-control-allow-origin'], undefined);
  });

  test('izin verilen adres tarayıcı önizlemesi için açılır', async () => {
    const open = await startApp({ config: { CORS_ORIGINS: ['http://localhost:8081'] } });
    const allowed = await open.call('GET', '/health', { headers: { origin: 'http://localhost:8081' } });
    assert.equal(allowed.headers['access-control-allow-origin'], 'http://localhost:8081');
    const denied = await open.call('GET', '/health', { headers: { origin: 'https://sahte.example.com' } });
    assert.equal(denied.headers['access-control-allow-origin'], undefined);
    await open.stop();
  });

  test('sağlık ucu veritabanını da yoklar', async () => {
    const { status, json } = await t.call('GET', '/health');
    assert.equal(status, 200);
    assert.deepEqual(json, { ok: true });
  });
});
