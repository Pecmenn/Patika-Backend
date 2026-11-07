// Yönetim paneli. Senaryolar gerçek sunucu ve gerçek veritabanıyla çalışır, görsel karşılaştırmalar sabit veriyle.
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { messagesOf, newOwner, openReport, settle, sightingsOf } from './helpers.ts';
import { ADMIN_EMAIL, ADMIN_PASSWORD } from './test-server.ts';

const WEEK = Array.from({ length: 7 }, () => ({ open: '09:00', close: '17:00' }));
// Testler paralel işlemlerde çalışır: sayaç işlem başına ayrı olduğu için ad rastgele üretilir.
const suffix = () => randomUUID().slice(0, 8);
const unique = (text: string) => `${text} ${suffix()}`;

async function newVet(request: APIRequestContext, name: string, overrides: object = {}) {
  const email = `panel-${suffix()}@example.com`;
  const registered = await request.post('/v1/auth/vet/register', {
    data: { email, password: 'gizli-sifre-1' },
  });
  const { token, user } = (await registered.json()) as { token: string; user: { id: string } };
  const saved = await request.put('/v1/clinic', {
    headers: { authorization: `Bearer ${token}` },
    data: {
      name,
      vet_name: 'Dr. Selin Aydın',
      license_no: 'IST-77123',
      phone: '0216 555 11 22',
      address: 'Moda Cad. No: 10',
      area: 'Moda, Kadıköy',
      lat: 40.98,
      lng: 29.02,
      hours: WEEK,
      slot_minutes: 30,
      species: ['cat', 'dog'],
      services: ['exam'],
      ...overrides,
    },
  });
  expect(saved.ok()).toBe(true);
  const { clinic } = (await saved.json()) as { clinic: { id: string } };
  return { email, token, userId: user.id, clinicId: clinic.id };
}

async function publicClinicIds(request: APIRequestContext) {
  const response = await request.get('/v1/public/clinics');
  const { clinics } = (await response.json()) as { clinics: { id: string }[] };
  return clinics.map((clinic) => clinic.id);
}

async function logIn(page: Page, path = '/admin') {
  await page.goto(path);
  await page.getByLabel('E-posta').fill(ADMIN_EMAIL);
  await page.getByLabel('Şifre').fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Giriş yap' }).click();
  await expect(page.getByRole('button', { name: 'Çıkış yap' })).toBeVisible();
}

const confirmDialog = (page: Page) => page.getByRole('dialog');
const clinicCard = (page: Page, name: string) => page.locator('article', { hasText: name });
const navLink = (page: Page, name: string | RegExp) =>
  page.getByRole('navigation').getByRole('link', { name });
const stampOf = (card: ReturnType<Page['locator']>) => card.locator('.stamp');
const stillLoading = (page: Page) => page.locator('.state', { hasText: 'Yükleniyor' });

test.describe('giriş', () => {
  test('yanlış şifre hata verir, doğru şifre açar, çıkış kapatır', async ({ page }) => {
    await page.goto('/admin');
    await expect(page).toHaveTitle('Giriş | Patika yönetim');
    await page.getByLabel('E-posta').fill('yok@example.com');
    await page.getByLabel('Şifre').fill('yanlis-sifre');
    await page.getByRole('button', { name: 'Giriş yap' }).click();
    await expect(page.getByRole('alert')).toHaveText('E-posta ya da şifre yanlış.');
    await expect(page.getByLabel('Şifre')).toHaveValue('');

    await page.getByLabel('E-posta').fill(ADMIN_EMAIL);
    await page.getByLabel('Şifre').fill(ADMIN_PASSWORD);
    await page.getByRole('button', { name: 'Giriş yap' }).click();
    await expect(navLink(page, /Klinikler/)).toBeVisible();
    await expect(page.getByText(ADMIN_EMAIL)).toBeVisible();

    // Sayfa yenilenince oturum sürer.
    await page.reload();
    await expect(page.getByRole('button', { name: 'Çıkış yap' })).toBeVisible();

    await page.getByRole('button', { name: 'Çıkış yap' }).click();
    await expect(page.getByRole('button', { name: 'Giriş yap' })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('button', { name: 'Giriş yap' })).toBeVisible();
  });

  test('oturumsuz açılan panelde veri görünmez, çerez sayfa kodundan okunamaz', async ({ page, context }) => {
    await page.goto('/admin#/kullanicilar');
    await expect(page.getByRole('button', { name: 'Giriş yap' })).toBeVisible();
    await expect(navLink(page, 'Kullanıcılar')).toHaveCount(0);

    await logIn(page);
    expect(await page.evaluate(() => document.cookie)).toBe('');
    const [cookie] = (await context.cookies()).filter(({ name }) => name === 'patika_admin');
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite).toBe('Strict');
    expect(cookie?.path).toBe('/admin');
  });

  test('oturum düşerse giriş ekranı açıklamayla gelir', async ({ page, context }) => {
    await logIn(page);
    // Özet yüklenmeden çerez silinirse panel daha dokunmadan girişe döner, menü kalmaz.
    await expect(page.locator('.ledger')).toBeVisible();
    await context.clearCookies();
    await navLink(page, /Klinikler/).click();
    await expect(page.getByRole('alert')).toHaveText('Oturumun süresi doldu. Yeniden giriş yap.');
  });

  test('sunucuya ulaşılamazsa söyler, tekrar dene çalışır', async ({ page }) => {
    await logIn(page);
    await page.route('**/admin/api/clinics**', (route) => route.abort());
    await navLink(page, /Klinikler/).click();
    await expect(page.getByText('Sunucuya ulaşılamadı', { exact: false })).toBeVisible();
    await page.unroute('**/admin/api/clinics**');
    await page.getByRole('button', { name: 'Tekrar dene' }).click();
    await expect(page.getByRole('heading', { name: 'Klinikler' })).toBeVisible();
    await expect(page.getByText('Sunucuya ulaşılamadı', { exact: false })).toHaveCount(0);
  });
});

test.describe('klinik onayı', () => {
  test('bekleyen klinik onaylanır, listeye girer, listeden kaldırılınca çıkar', async ({ page, request }) => {
    const name = unique('Onay Kliniği');
    const vet = await newVet(request, name);
    expect(await publicClinicIds(request)).not.toContain(vet.clinicId);

    await logIn(page, '/admin#/klinikler');
    const card = clinicCard(page, name);
    await expect(stampOf(card)).toHaveText('Bekliyor');
    await expect(card.getByText('IST-77123')).toBeVisible();

    await card.getByText('Tüm bilgiler').click();
    await expect(card.getByText('0216 555 11 22')).toBeVisible();
    await expect(card.getByText(vet.email)).toBeVisible();
    await expect(card.getByText('Pazartesi: 09:00 - 17:00', { exact: false })).toBeVisible();

    await card.getByRole('button', { name: 'Onayla' }).click();
    await expect(confirmDialog(page)).toContainText('IST-77123');
    await confirmDialog(page).getByRole('button', { name: 'Onayla' }).click();
    await expect(page.getByRole('status')).toHaveText(`${name} onaylandı.`);
    await expect(card).toHaveCount(0);
    expect(await publicClinicIds(request)).toContain(vet.clinicId);

    await page.getByRole('button', { name: 'Listede', exact: true }).click();
    await expect(stampOf(clinicCard(page, name))).toHaveText('Listede');
    await clinicCard(page, name).getByRole('button', { name: 'Listeden kaldır' }).click();
    await expect(confirmDialog(page)).toContainText('listesinden kalkar');
    await confirmDialog(page).getByRole('button', { name: 'Listeden kaldır' }).click();
    await expect(clinicCard(page, name)).toHaveCount(0);
    expect(await publicClinicIds(request)).not.toContain(vet.clinicId);

    await page.getByRole('button', { name: 'Reddedilen' }).click();
    await expect(stampOf(clinicCard(page, name))).toHaveText('Reddedildi');
  });

  test('Vazgeç ve Esc hiçbir şey yapmaz, yanlışlıkla Enter işlem yapmaz', async ({ page, request }) => {
    const name = unique('Vazgeç Kliniği');
    const vet = await newVet(request, name);
    await logIn(page, '/admin#/klinikler');
    const card = clinicCard(page, name);

    await card.getByRole('button', { name: 'Reddet' }).click();
    await expect(confirmDialog(page).getByRole('button', { name: 'Vazgeç' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(confirmDialog(page)).toBeHidden();

    await card.getByRole('button', { name: 'Onayla' }).click();
    await page.keyboard.press('Escape');
    await expect(confirmDialog(page)).toBeHidden();

    await page.reload();
    await expect(stampOf(clinicCard(page, name))).toHaveText('Bekliyor');
    expect(await publicClinicIds(request)).not.toContain(vet.clinicId);
  });

  test('panel açıkken sicil numarası değişirse onay reddedilir, güncel numara görünür', async ({ page, request }) => {
    const name = unique('Değişen Klinik');
    const vet = await newVet(request, name);
    await logIn(page, '/admin#/klinikler');
    const card = clinicCard(page, name);
    await expect(card.getByText('IST-77123')).toBeVisible();

    const changed = await request.put('/v1/clinic', {
      headers: { authorization: `Bearer ${vet.token}` },
      data: {
        name,
        vet_name: 'Dr. Selin Aydın',
        license_no: 'IST-DEGISTI',
        phone: '0216 555 11 22',
        address: 'Moda Cad. No: 10',
        area: 'Moda, Kadıköy',
        lat: 40.98,
        lng: 29.02,
        hours: WEEK,
        slot_minutes: 30,
        species: ['cat'],
        services: [],
      },
    });
    expect(changed.ok()).toBe(true);

    await card.getByRole('button', { name: 'Onayla' }).click();
    await confirmDialog(page).getByRole('button', { name: 'Onayla' }).click();
    await expect(page.getByRole('status')).toContainText('az önce değişti');
    await expect(card.getByText('IST-DEGISTI')).toBeVisible();
    expect(await publicClinicIds(request)).not.toContain(vet.clinicId);
  });

  test('yaklaşan randevusu olan klinikte kaldırma penceresi sayıyı söyler', async ({ page, request }) => {
    const name = unique('Randevulu Klinik');
    const vet = await newVet(request, name);
    await logIn(page, '/admin#/klinikler');
    await clinicCard(page, name).getByRole('button', { name: 'Onayla' }).click();
    await confirmDialog(page).getByRole('button', { name: 'Onayla' }).click();
    await expect(clinicCard(page, name)).toHaveCount(0);

    const owner = await newOwner(request);
    const date = new Date(Date.now() + 3 * 3600_000 + 3 * 86_400_000).toISOString().slice(0, 10);
    const booked = await request.post('/v1/appointments', {
      headers: { authorization: `Bearer ${owner.token}` },
      data: {
        clinic_id: vet.clinicId,
        pet_id: 'p1',
        pet_name: 'Zeytin',
        species: 'dog',
        owner_name: 'Ayşe Yılmaz',
        owner_phone: '0532 555 00 11',
        reason: 'Aşı',
        date,
        time: '10:00',
      },
    });
    expect(booked.ok()).toBe(true);

    await page.getByRole('button', { name: 'Listede', exact: true }).click();
    await clinicCard(page, name).getByRole('button', { name: 'Listeden kaldır' }).click();
    await expect(confirmDialog(page)).toContainText('1 yaklaşan randevu iptal olur');
    await page.keyboard.press('Escape');
  });
});

test.describe('zararlı yazılar', () => {
  test('klinik, ilan ve ihbar içindeki kod çalışmaz, yazı olarak görünür', async ({ page, request }) => {
    const attack = '<img src=x onerror="window.__xss=1"><script>window.__xss=1</script>';
    const tag = unique('Kod');
    await newVet(request, `${tag} ${attack}`.slice(0, 80), {
      description: attack,
      website: 'https://ornek.example/?a=<script>',
    });
    const owner = await newOwner(request);
    const { code } = await openReport(owner, {
      petId: `kod-${suffix()}`,
      name: '<b>Zeytin</b>',
      description: attack,
    });
    await request.post(`/v1/public/pets/${code}/sightings`, {
      data: { message: attack, place: attack.slice(0, 80), contact: attack.slice(0, 80) },
    });

    const violations: string[] = [];
    page.on('console', (message) => {
      if (message.text().includes('Content Security Policy')) {
        violations.push(message.text());
      }
    });

    await logIn(page, '/admin#/klinikler');
    const clinic = page.locator('article', { hasText: tag });
    await clinic.getByText('Tüm bilgiler').click();
    await expect(clinic.getByText(attack, { exact: false }).first()).toBeVisible();

    await navLink(page, /İlanlar/).click();
    const report = page.locator('article', { hasText: '<b>Zeytin</b>' }).first();
    await expect(report.getByRole('heading', { name: '<b>Zeytin</b>' })).toBeVisible();
    await report.getByText(/İhbarlar/).click();
    await expect(report.getByText(attack, { exact: false }).first()).toBeVisible();

    expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
    await expect(page.locator('#app img[src="x"], #app script, #app b')).toHaveCount(0);
    expect(violations).toEqual([]);
  });

  test('javascript: ile başlayan web adresi bağlantı olmaz', async ({ page, request }) => {
    const name = unique('Bağlantı Kliniği');
    const vet = await newVet(request, name);
    await page.route('**/admin/api/clinics?status=pending*', async (route) => {
      const response = await route.fetch();
      const json = (await response.json()) as { clinics: { id: string; website: string | null }[] };
      for (const clinic of json.clinics) {
        if (clinic.id === vet.clinicId) {
          clinic.website = 'javascript:window.__xss=1';
        }
      }
      await route.fulfill({ response, json });
    });
    await logIn(page, '/admin#/klinikler');
    const card = clinicCard(page, name);
    await card.getByText('Tüm bilgiler').click();
    await expect(card.getByText('javascript:window.__xss=1')).toBeVisible();
    await expect(card.locator('a[href^="javascript"]')).toHaveCount(0);
  });
});

test.describe('kayıp ilanı denetimi', () => {
  test('ihbar silinir, ilan kaldırılınca kayıp sayfası kapanır, ilan Kapanan bölümüne geçer', async ({
    page,
    request,
  }) => {
    const owner = await newOwner(request);
    const name = `İlan${suffix()}`;
    const { id, code } = await openReport(owner, { petId: `denetim-${name}`, name, withPhoto: true });
    await request.post(`/v1/public/pets/${code}/sightings`, {
      data: { message: 'Sahte ihbar mesajı', contact: '05551234567', lat: 41.123456, lng: 29.654321 },
    });
    await request.post(`/v1/public/pets/${code}/sightings`, { data: { message: 'Gerçek ihbar mesajı' } });

    await logIn(page, '/admin#/ilanlar');
    const card = page.locator('article', { hasText: name });
    await expect(stampOf(card)).toHaveText('Açık');
    await expect(card.getByRole('img', { name: `${name} fotoğrafı` })).toBeVisible();
    await expect(card).not.toContainText('41.123');

    await card.getByText('İhbarlar (2)').click();
    await expect(card.getByText('İletişim: 05551234567')).toBeVisible();
    await expect(card.getByText('konum eklendi', { exact: false })).toBeVisible();
    await expect(card).not.toContainText('41.123');

    const fake = card.locator('li', { hasText: 'Sahte ihbar mesajı' });
    await fake.getByRole('button', { name: 'İhbarı sil' }).click();
    await confirmDialog(page).getByRole('button', { name: 'İhbarı sil' }).click();
    await expect(fake).toHaveCount(0);
    await expect(card.getByText('İhbarlar (1)')).toBeVisible();
    expect(await sightingsOf(owner, id)).toHaveLength(1);

    await card.getByRole('button', { name: 'İlanı kaldır' }).click();
    await expect(confirmDialog(page)).toContainText('Kayıp sayfası kapanır');
    await confirmDialog(page).getByRole('button', { name: 'İlanı kaldır' }).click();
    await expect(page.getByRole('status')).toHaveText(`${name} ilanı kaldırıldı.`);
    await expect(card).toHaveCount(0);

    await page.getByRole('button', { name: 'Kapanan' }).click();
    const closed = page.locator('article', { hasText: name });
    await expect(stampOf(closed)).toHaveText('Kaldırıldı');
    await expect(closed.getByRole('button', { name: 'İlanı kaldır' })).toHaveCount(0);

    const visitor = await page.context().newPage();
    await visitor.goto(`/p/${code}`);
    await expect(visitor.getByText(name)).toHaveCount(0);
    await visitor.close();
    expect(await messagesOf(owner)).toEqual([]);
  });
});

test.describe('kullanıcı yönetimi', () => {
  test('hesap aranır, kapatılır, kapalıyken giremez, yeniden açılır', async ({ page, request }) => {
    const name = unique('Kapatılan Klinik');
    const vet = await newVet(request, name);

    await logIn(page, '/admin#/kullanicilar');
    await page.getByRole('searchbox').fill(vet.email);
    await page.getByRole('button', { name: 'Ara' }).click();
    const row = page.locator('tbody tr', { hasText: vet.email });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText(`Klinik: ${name}`);
    await expect(row).toContainText('Veteriner, E-posta ile giriş');
    await expect(page.locator('tbody tr')).toHaveCount(1);

    await row.getByRole('button', { name: 'Hesabı kapat' }).click();
    await expect(confirmDialog(page)).toContainText(`${name} listeden kalkar`);
    await confirmDialog(page).getByRole('button', { name: 'Hesabı kapat' }).click();
    await expect(page.getByRole('status')).toHaveText('Hesap kapatıldı.');
    await expect(row).toContainText('tarihinde kapatıldı');

    const blocked = await request.post('/v1/auth/vet/login', {
      data: { email: vet.email, password: 'gizli-sifre-1' },
    });
    expect(blocked.status()).toBe(403);
    expect((await request.get('/v1/clinic', { headers: { authorization: `Bearer ${vet.token}` } })).status()).toBe(401);

    await page.getByRole('button', { name: 'Kapalı' }).click();
    await expect(page.locator('tbody tr', { hasText: vet.email })).toHaveCount(1);
    await page.locator('tbody tr', { hasText: vet.email }).getByRole('button', { name: 'Hesabı aç' }).click();
    await confirmDialog(page).getByRole('button', { name: 'Hesabı aç' }).click();
    await expect(page.getByRole('status')).toHaveText('Hesap açıldı.');

    const open = await request.post('/v1/auth/vet/login', {
      data: { email: vet.email, password: 'gizli-sifre-1' },
    });
    expect(open.status()).toBe(200);
  });

  test('arama sonuç vermezse söyler', async ({ page }) => {
    await logIn(page, '/admin#/kullanicilar');
    await page.getByRole('searchbox').fill('kimsede-olmayan-arama');
    await page.getByRole('button', { name: 'Ara' }).click();
    await expect(page.getByText('Sonuç yok')).toBeVisible();
  });
});

test.describe('özet', () => {
  test('rakamlar sunucuyla aynı, satırlar ilgili bölüme götürür', async ({ page, request }) => {
    await newVet(request, unique('Özet Kliniği'));
    await logIn(page);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Onay bekleyen');
    await page.getByRole('link', { name: /^Kayıp ilanları/ }).click();
    await expect(page.getByRole('heading', { name: 'Kayıp ilanları' })).toBeVisible();
    await expect(page).toHaveTitle('İlanlar | Patika yönetim');
  });
});

test.describe('ekran düzeni', () => {
  for (const path of ['#/ozet', '#/klinikler', '#/ilanlar', '#/kullanicilar']) {
    test(`${path} yatay kaymaz`, async ({ page, request }) => {
      await newVet(request, unique('Uzun Adlı Çok Çok Çok Çok Çok Uzun Klinik'));
      await logIn(page, `/admin${path}`);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await expect(stillLoading(page)).toHaveCount(0);
      const widths = await page.evaluate(() => ({
        page: document.documentElement.scrollWidth,
        screen: window.innerWidth,
      }));
      expect(widths.page).toBeLessThanOrEqual(widths.screen);
    });
  }
});

// Görsel karşılaştırma: paralel testlerin verisi karışmasın diye sunucu cevapları sabit.
test.describe('görünüş', () => {
  const summary = {
    owners: 128,
    vets: 14,
    suspended: 1,
    pets: 203,
    clinics_pending: 2,
    clinics_approved: 11,
    clinics_rejected: 1,
    reports_open: 3,
    reports_found: 27,
    reports_removed: 2,
    sightings: 94,
    appointments_pending: 6,
    appointments_confirmed: 18,
    appointments_total: 240,
  };
  const clinic = {
    id: '11111111-1111-4111-8111-111111111111',
    status: 'pending',
    name: 'Moda Veteriner Kliniği',
    vet_name: 'Dr. Selin Aydın',
    license_no: 'IST-77123',
    phone: '0216 555 11 22',
    address: 'Moda Cad. No: 10, Kadıköy',
    area: 'Moda, Kadıköy',
    hours: [...WEEK.slice(0, 5), { open: '10:00', close: '14:00' }, null],
    slot_minutes: 30,
    species: ['cat', 'dog'],
    services: ['exam', 'vaccine'],
    description: 'Mahallenin kliniği.',
    website: 'https://moda.example',
    instagram: '@modavet',
    photo_path: 'klinik.jpg',
    created_at: '2026-11-05T08:30:00.000Z',
    owner_email: 'selin@modavet.example',
    owner_suspended_at: null,
    upcoming_appointments: 0,
  };
  const clinics = [
    clinic,
    {
      ...clinic,
      id: '22222222-2222-4222-8222-222222222222',
      name: 'Pati Hayvan Hastanesi',
      vet_name: 'Dr. Can Erdem',
      license_no: 'ANK-4021',
      area: 'Çankaya, Ankara',
      photo_path: null,
    },
  ];
  const report = {
    id: '33333333-3333-4333-8333-333333333333',
    pet_name: 'Zeytin',
    species: 'dog',
    breed: 'Melez',
    description: 'Mavi tasmalı, çekingen. Lütfen kovalamayın.',
    photo_path: 'ilan.jpg',
    last_seen_area: 'Moda, Kadıköy',
    started_at: '2026-11-04T15:40:00.000Z',
    found_at: null,
    removed_at: null,
    owner_email: 'ayse@example.com',
    owner_name: 'Ayşe Demir',
    sightings: 2,
  };
  const users = [
    {
      id: '44444444-4444-4444-8444-444444444444',
      role: 'owner',
      provider: 'apple',
      email: 'ayse@example.com',
      name: 'Ayşe Demir',
      created_at: '2026-10-01T10:00:00.000Z',
      suspended_at: null,
      last_seen_at: '2026-11-05T10:00:00.000Z',
      clinic_name: null,
      clinic_status: null,
      pets: 2,
      open_reports: 1,
      upcoming_appointments: 1,
    },
    {
      id: '55555555-5555-4555-8555-555555555555',
      role: 'vet',
      provider: 'email',
      email: 'selin@modavet.example',
      name: null,
      created_at: '2026-10-12T10:00:00.000Z',
      suspended_at: null,
      last_seen_at: '2026-11-04T10:00:00.000Z',
      clinic_name: 'Moda Veteriner Kliniği',
      clinic_status: 'approved',
      pets: 0,
      open_reports: 0,
      upcoming_appointments: 0,
    },
    {
      id: '66666666-6666-4666-8666-666666666666',
      role: 'owner',
      provider: 'apple',
      email: 'kapali@example.com',
      name: 'Kapalı Hesap',
      created_at: '2026-09-20T10:00:00.000Z',
      suspended_at: '2026-11-02T10:00:00.000Z',
      last_seen_at: null,
      clinic_name: null,
      clinic_status: null,
      pets: 1,
      open_reports: 0,
      upcoming_appointments: 0,
    },
  ];
  const sightings = [
    {
      id: '77777777-7777-4777-8777-777777777777',
      place: 'Yoğurtçu Parkı',
      message: 'Sahilde koşarken gördüm, tasması mavi.',
      contact: '0532 000 00 00',
      created_at: '2026-11-05T09:12:00.000Z',
      has_location: true,
    },
  ];

  async function mockPanel(page: Page) {
    const photo = await readFile(new URL('./fixtures/pet.jpg', import.meta.url));
    await page.route('**/v1/public/**/*.jpg', (route) =>
      route.fulfill({ body: photo, contentType: 'image/jpeg' }),
    );
    await page.route('**/admin/api/**', (route) => {
      const url = new URL(route.request().url());
      const replies: Record<string, unknown> = {
        '/admin/api/me': { email: 'yonetici@patika.example' },
        '/admin/api/summary': summary,
        '/admin/api/clinics': { clinics, has_more: false },
        '/admin/api/lost-reports': { reports: [report], has_more: false },
        [`/admin/api/lost-reports/${report.id}/sightings`]: { sightings },
        '/admin/api/users': { users, has_more: false },
      };
      return route.fulfill({ json: replies[url.pathname] ?? {} });
    });
  }

  const shot = async (page: Page, name: string) => {
    await expect(stillLoading(page)).toHaveCount(0);
    await settle(page);
    await expect(page).toHaveScreenshot(`${name}.png`, { fullPage: true });
  };

  test('giriş ekranı', async ({ page }) => {
    await page.goto('/admin');
    await expect(page.getByRole('button', { name: 'Giriş yap' })).toBeVisible();
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await shot(page, 'giris');
  });

  test('özet', async ({ page }) => {
    await mockPanel(page);
    await page.goto('/admin#/ozet');
    await expect(page.getByRole('heading', { name: 'Onay bekleyen 2 klinik var' })).toBeVisible();
    await shot(page, 'ozet');
  });

  test('klinikler ve ayrıntı', async ({ page }) => {
    await mockPanel(page);
    await page.goto('/admin#/klinikler');
    await expect(page.getByRole('heading', { name: 'Moda Veteriner Kliniği' })).toBeVisible();
    await shot(page, 'klinikler');
    await page.getByText('Tüm bilgiler').first().click();
    await expect(page.getByText('Mahallenin kliniği.').first()).toBeVisible();
    await shot(page, 'klinik-ayrinti');
  });

  test('onay penceresi', async ({ page }) => {
    await mockPanel(page);
    await page.goto('/admin#/klinikler');
    await page.getByRole('button', { name: 'Onayla' }).first().click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await settle(page);
    await expect(page).toHaveScreenshot('onay-penceresi.png');
  });

  test('ilanlar ve ihbarlar', async ({ page }) => {
    await mockPanel(page);
    await page.goto('/admin#/ilanlar');
    await page.getByText('İhbarlar (2)').click();
    await expect(page.getByText('Sahilde koşarken gördüm')).toBeVisible();
    await shot(page, 'ilanlar');
  });

  test('kullanıcılar', async ({ page }) => {
    await mockPanel(page);
    await page.goto('/admin#/kullanicilar');
    await expect(page.getByText('Kapalı Hesap')).toBeVisible();
    await shot(page, 'kullanicilar');
  });
});
