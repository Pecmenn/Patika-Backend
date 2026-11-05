// QR'ı okutan kişinin gördüğü sayfa. Tüm senaryolar gerçek sunucu ve gerçek veritabanıyla çalışır.
import { expect, test, type Page } from '@playwright/test';

import {
  failGeolocation,
  fakeGeolocation,
  freezeClock,
  markFound,
  messagesOf,
  newOwner,
  openReport,
  publicCode,
  settle,
  sightingsOf,
} from './helpers.ts';

const addLocation = (page: Page) => page.getByRole('button', { name: 'Şu an buradaysa konumumu ekle' }).click();
const place = (page: Page) => page.getByLabel('Nerede gördün?');
const message = (page: Page) => page.getByLabel('Mesajın');
const contact = (page: Page) => page.getByLabel('Sana nasıl ulaşsınlar?');
const send = (page: Page, label = 'Aileme gönder') => page.getByRole('button', { name: label }).click();
const thanks = (page: Page) => page.getByRole('heading', { name: 'Teşekkürler!' });

test.describe('sayfa durumları', () => {
  test('kayıp ilanı: ad, semt, tarih, tür ve açıklama görünür', async ({ page, request }) => {
    const owner = await newOwner(request);
    const { code } = await openReport(owner, { withPhoto: true });
    await page.goto(`/p/${code}`);
    await expect(page.getByRole('heading', { name: 'Merhaba, ben Zeytin' })).toBeVisible();
    await expect(page.getByText('kayıp bildirildi')).toBeVisible();
    await expect(page.getByText('Moda, Kadıköy')).toBeVisible();
    await expect(page.getByText('1 Kasım, 18.40')).toBeVisible();
    await expect(page.getByText('Köpek, Melez')).toBeVisible();
    await expect(page.getByText('Mavi tasmalı, çekingen')).toBeVisible();
    await expect(page.getByRole('img', { name: 'Zeytin fotoğrafı' })).toBeVisible();
    await expect(page).toHaveTitle('Zeytin kayıp | Patika');
  });

  test('tam konum, sahip ve telefon sayfada hiç geçmez', async ({ page, request }) => {
    const owner = await newOwner(request);
    const { code, id } = await openReport(owner);
    await request.post(`/v1/public/pets/${code}/sightings`, {
      data: { message: 'Gizli ihbar', contact: '05551234567' },
    });
    const bodies: Promise<string>[] = [];
    page.on('response', (response) => {
      if (response.url().includes('/v1/')) {
        bodies.push(response.text());
      }
    });
    await page.goto(`/p/${code}`);
    await expect(page.getByRole('heading', { name: 'Merhaba, ben Zeytin' })).toBeVisible();
    const serverText = (await Promise.all(bodies)).join('');
    expect(serverText).toContain('Zeytin');
    const visible = (await page.content()) + serverText;
    for (const secret of ['40.98', '29.12', '05551234567', 'Gizli ihbar', 'owner', id]) {
      expect(visible, secret).not.toContain(secret);
    }
  });

  test('fotoğrafsız ilanda yer tutucu görünür', async ({ page, request }) => {
    const { code } = await openReport(await newOwner(request));
    await page.goto(`/p/${code}`);
    await expect(page.locator('.photo-empty')).toBeVisible();
    await expect(page.getByRole('img')).toHaveCount(0);
  });

  test('fotoğraf yüklenemezse yer tutucuya döner', async ({ page, request }) => {
    const { code } = await openReport(await newOwner(request), { withPhoto: true });
    await page.route('**/v1/public/photos/**', (route) => route.abort());
    await page.goto(`/p/${code}`);
    await expect(page.locator('.photo-empty')).toBeVisible();
  });

  for (const [species, label] of [
    ['cat', 'Kedi'],
    ['rabbit', 'Tavşan'],
    ['bird', 'Kuş'],
  ] as const) {
    test(`tür yazısı: ${label}`, async ({ page, request }) => {
      const { code } = await openReport(await newOwner(request), { species, breed: null });
      await page.goto(`/p/${code}`);
      await expect(page.locator('.facts')).toContainText(label);
    });
  }

  test('ırk ve açıklama boşsa boş satır çıkmaz', async ({ page, request }) => {
    const { code } = await openReport(await newOwner(request), { breed: null, description: null, species: 'dog' });
    await page.goto(`/p/${code}`);
    await expect(page.locator('.lead')).toHaveCount(1);
    await expect(page.locator('.facts')).toContainText('Köpek');
    await expect(page.locator('.facts')).not.toContainText('Köpek,');
  });

  test('bulundu: yalnızca ad kalır, fotoğraf ve ayrıntı kaybolur', async ({ page, request }) => {
    const owner = await newOwner(request);
    const { code, id } = await openReport(owner, { withPhoto: true });
    await markFound(owner, id);
    await page.goto(`/p/${code}`);
    await expect(page.getByText('Zeytin evine döndü')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Teşekkürler' })).toBeVisible();
    await expect(page.locator('body')).not.toContainText('Moda');
    await expect(page.locator('body')).not.toContainText('Mavi tasma');
    await expect(page.locator('img')).toHaveCount(0);
    await expect(page).toHaveTitle('Zeytin bulundu | Patika');
    await expect(page.getByRole('button', { name: 'Ailesine gönder' })).toHaveCount(0);
  });

  test('bulundu: "şu an yanında mı?" formu açar, haber sahibine düşer', async ({ page, request }) => {
    const owner = await newOwner(request);
    const { code, id } = await openReport(owner);
    await markFound(owner, id);
    await page.goto(`/p/${code}`);
    await page.getByRole('button', { name: /şu an yanında mı/ }).click();
    await message(page).fill('Yine sokakta gördüm');
    await send(page, 'Ailesine gönder');
    await expect(thanks(page)).toBeVisible();
    const messages = await messagesOf(owner);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.message).toBe('Yine sokakta gördüm');
  });

  test('ilan hiç açılmamış: ad görünmez, haber bırakılır', async ({ page, request }) => {
    const owner = await newOwner(request);
    const code = await publicCode(owner, 'boncuk');
    await page.goto(`/p/${code}`);
    await expect(page.getByRole('heading', { name: 'Bu hayvanın bir ailesi var' })).toBeVisible();
    await expect(page.getByText('Hayvan künyesi')).toBeVisible();
    await place(page).fill('Parkın girişi');
    await send(page, 'Ailesine gönder');
    await expect(thanks(page)).toBeVisible();
    expect((await messagesOf(owner))[0]!.place).toBe('Parkın girişi');
  });

  for (const path of ['/p/000000000000', '/p/ABCDEF123456', '/p/kisa', '/p/8718cd6c2425/fazla', '/']) {
    test(`geçersiz adres açılır ve "bulunamadı" der: ${path}`, async ({ page }) => {
      await page.goto(path);
      await expect(page.getByRole('heading', { name: 'Bu ilan bulunamadı' })).toBeVisible();
    });
  }

  test('adresin sonunda eğik çizgi olsa da ilan açılır', async ({ page, request }) => {
    const { code } = await openReport(await newOwner(request));
    await page.goto(`/p/${code}/`);
    await expect(page.getByRole('heading', { name: 'Merhaba, ben Zeytin' })).toBeVisible();
  });

  test('form ilk ekranda görünmese de düğme oraya götürür', async ({ page, request }) => {
    const { code } = await openReport(await newOwner(request), { withPhoto: true });
    await page.goto(`/p/${code}`);
    const jump = page.getByRole('button', { name: 'Beni gördüysen haber ver' });
    await expect(jump).toBeInViewport();
    await jump.click();
    await expect(page.getByRole('heading', { name: 'Beni gördün mü?' })).toBeInViewport();
  });

  test('yanındaysa numara bırakması gerektiği söylenir', async ({ page, request }) => {
    const { code } = await openReport(await newOwner(request));
    await page.goto(`/p/${code}`);
    await expect(page.getByText('ailem seni arayabilsin')).toBeVisible();
  });

  test('sunucuya ulaşılamazsa uyarır, "Tekrar dene" çalışır', async ({ page, request }) => {
    const { code } = await openReport(await newOwner(request));
    await page.route('**/v1/public/pets/**', (route) => route.abort());
    await page.goto(`/p/${code}`);
    await expect(page.getByRole('heading', { name: 'Sayfa açılamadı' })).toBeVisible();
    await page.unroute('**/v1/public/pets/**');
    await page.getByRole('button', { name: 'Tekrar dene' }).click();
    await expect(page.getByRole('heading', { name: 'Merhaba, ben Zeytin' })).toBeVisible();
  });

  test('sunucu hata dönerse (500) de uyarır', async ({ page, request }) => {
    const { code } = await openReport(await newOwner(request));
    await page.route('**/v1/public/pets/**', (route) => route.fulfill({ status: 500, json: { error: 'server_error' } }));
    await page.goto(`/p/${code}`);
    await expect(page.getByRole('heading', { name: 'Sayfa açılamadı' })).toBeVisible();
  });
});

test.describe('ihbar formu', () => {
  test('boş form gönderilmez, uyarı çıkar, sunucuya istek gitmez', async ({ page, request }) => {
    const owner = await newOwner(request);
    const { code, id } = await openReport(owner);
    await page.goto(`/p/${code}`);
    await send(page);
    await expect(page.getByText('Konumunu ekle ya da nerede gördüğünü yaz.')).toBeVisible();
    expect(await sightingsOf(owner, id)).toHaveLength(0);
  });

  test('yalnızca boşluk ya da yalnızca iletişim yetmez', async ({ page, request }) => {
    const owner = await newOwner(request);
    const { code, id } = await openReport(owner);
    await page.goto(`/p/${code}`);
    await place(page).fill('    ');
    await contact(page).fill('0555');
    await send(page);
    await expect(page.getByText('Konumunu ekle ya da nerede gördüğünü yaz.')).toBeVisible();
    expect(await sightingsOf(owner, id)).toHaveLength(0);
  });

  test('uyarı, kişi formu düzeltip gönderince kaybolur', async ({ page, request }) => {
    const { code } = await openReport(await newOwner(request));
    await page.goto(`/p/${code}`);
    await send(page);
    await message(page).fill('Gördüm');
    await send(page);
    await expect(thanks(page)).toBeVisible();
    await expect(page.getByText('Konumunu ekle ya da')).toHaveCount(0);
  });

  test('yer adıyla gönderilir, Türkçe karakterler bozulmaz', async ({ page, request }) => {
    const owner = await newOwner(request);
    const { code, id } = await openReport(owner);
    await page.goto(`/p/${code}`);
    await place(page).fill('Şişli, Çağlayan İğdır Üsküdar');
    await send(page);
    await expect(thanks(page)).toBeVisible();
    const [row] = await sightingsOf(owner, id);
    expect(row!.place).toBe('Şişli, Çağlayan İğdır Üsküdar');
    expect(row!.lat).toBeNull();
  });

  test('tüm alanlar sahibine ulaşır', async ({ page, request }) => {
    const owner = await newOwner(request);
    const { code, id } = await openReport(owner);
    await fakeGeolocation(page, 41.0123, 29.0456);
    await page.goto(`/p/${code}`);
    await addLocation(page);
    await expect(page.getByText('Şu anki konumun eklendi')).toBeVisible();
    await place(page).fill('Bahariye');
    await message(page).fill('Parka doğru gitti');
    await contact(page).fill('0555 123 45 67');
    await send(page);
    await expect(thanks(page)).toBeVisible();
    const [row] = await sightingsOf(owner, id);
    expect(row).toMatchObject({
      place: 'Bahariye',
      message: 'Parka doğru gitti',
      contact: '0555 123 45 67',
      lat: 41.0123,
      lng: 29.0456,
    });
  });

  test('yalnızca konumla gönderilebilir', async ({ page, request }) => {
    const owner = await newOwner(request);
    const { code, id } = await openReport(owner);
    await fakeGeolocation(page, 41.5, 29.5);
    await page.goto(`/p/${code}`);
    await addLocation(page);
    await send(page);
    await expect(thanks(page)).toBeVisible();
    expect((await sightingsOf(owner, id))[0]).toMatchObject({ lat: 41.5, lng: 29.5, place: null });
  });

  test('tarayıcının gerçek konum izniyle çalışır', async ({ page, context, request, browserName }) => {
    test.skip(browserName === 'webkit', 'Windows WebKit sürümünde konum servisi yok');
    await context.grantPermissions(['geolocation']);
    await context.setGeolocation({ latitude: 40.1, longitude: 28.2 });
    const owner = await newOwner(request);
    const { code, id } = await openReport(owner);
    await page.goto(`/p/${code}`);
    await addLocation(page);
    await expect(page.getByText('Şu anki konumun eklendi')).toBeVisible();
    await send(page);
    await expect(thanks(page)).toBeVisible();
    expect((await sightingsOf(owner, id))[0]).toMatchObject({ lat: 40.1, lng: 28.2 });
  });

  test('eklenen konum kaldırılabilir, gönderilmez', async ({ page, request }) => {
    const owner = await newOwner(request);
    const { code, id } = await openReport(owner);
    await fakeGeolocation(page, 41.5, 29.5);
    await page.goto(`/p/${code}`);
    await addLocation(page);
    await page.getByRole('button', { name: 'Kaldır' }).click();
    await expect(page.getByRole('button', { name: 'Şu an buradaysa konumumu ekle' })).toBeVisible();
    await place(page).fill('Moda');
    await send(page);
    await expect(thanks(page)).toBeVisible();
    expect((await sightingsOf(owner, id))[0]!.lat).toBeNull();
  });

  test('konum izni verilmezse yazıyla devam edilir', async ({ page, request }) => {
    const owner = await newOwner(request);
    const { code, id } = await openReport(owner);
    await failGeolocation(page, 1);
    await page.goto(`/p/${code}`);
    await addLocation(page);
    await expect(page.getByText('Konum izni verilmedi. Yer adını yazman yeterli.')).toBeVisible();
    await place(page).fill('Moda');
    await send(page);
    await expect(thanks(page)).toBeVisible();
    expect(await sightingsOf(owner, id)).toHaveLength(1);
  });

  test('konum alınamazsa uyarır, yeniden denenebilir', async ({ page, request }) => {
    const { code } = await openReport(await newOwner(request));
    await failGeolocation(page, 2);
    await page.goto(`/p/${code}`);
    await addLocation(page);
    await expect(page.getByText('Konum alınamadı. Yer adını yazman yeterli.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Şu an buradaysa konumumu ekle' })).toBeEnabled();
  });

  test('gönderim hata alırsa yazılanlar kaybolmaz, yeniden gönderilir', async ({ page, request }) => {
    const owner = await newOwner(request);
    const { code, id } = await openReport(owner);
    await page.goto(`/p/${code}`);
    await page.route('**/sightings', (route) => route.abort());
    await message(page).fill('Önemli mesaj');
    await send(page);
    await expect(page.getByText('Gönderilemedi. İnternet bağlantını kontrol edip tekrar dene.')).toBeVisible();
    await expect(message(page)).toHaveValue('Önemli mesaj');
    await page.unroute('**/sightings');
    await send(page);
    await expect(thanks(page)).toBeVisible();
    expect(await sightingsOf(owner, id)).toHaveLength(1);
  });

  for (const [error, text] of [
    ['too_many_sightings', 'Şu anda çok fazla mesaj geldi'],
    ['rate_limited', 'Şu anda çok fazla mesaj geldi'],
    ['unknown_code', 'Bu kayıt artık yok'],
    ['server_error', 'Gönderilemedi'],
  ] as const) {
    test(`sunucu hatası anlaşılır gösterilir: ${error}`, async ({ page, request }) => {
      const { code } = await openReport(await newOwner(request));
      await page.goto(`/p/${code}`);
      await page.route('**/sightings', (route) => route.fulfill({ status: 429, json: { error } }));
      await message(page).fill('x');
      await send(page);
      await expect(page.getByText(text)).toBeVisible();
    });
  }

  test('düğmeye art arda basılsa da tek ihbar gider', async ({ page, request }) => {
    const owner = await newOwner(request);
    const { code, id } = await openReport(owner);
    await page.goto(`/p/${code}`);
    await message(page).fill('Bir kez');
    let releaseResponse = () => {};
    const held = new Promise<void>((resolve) => (releaseResponse = resolve));
    await page.route('**/sightings', async (route) => {
      await held;
      await route.continue();
    });
    const button = page.getByRole('button', { name: 'Aileme gönder' });
    await button.click();
    await expect(page.getByRole('button', { name: 'Gönderiliyor...' })).toBeDisabled();
    await page.locator('form').dispatchEvent('submit');
    await page.locator('form').dispatchEvent('submit');
    releaseResponse();
    await expect(thanks(page)).toBeVisible();
    expect(await sightingsOf(owner, id)).toHaveLength(1);
  });

  test('Enter tuşu yer adı alanından gönderir', async ({ page, request }) => {
    const owner = await newOwner(request);
    const { code, id } = await openReport(owner);
    await page.goto(`/p/${code}`);
    await place(page).fill('Moda');
    await place(page).press('Enter');
    await expect(thanks(page)).toBeVisible();
    expect(await sightingsOf(owner, id)).toHaveLength(1);
  });

  test('gönderdikten sonra yeni mesaj eklenebilir, form boş açılır', async ({ page, request }) => {
    const owner = await newOwner(request);
    const { code, id } = await openReport(owner);
    await page.goto(`/p/${code}`);
    await message(page).fill('İlk mesaj');
    await send(page);
    await page.getByRole('button', { name: 'Bir şey daha eklemek istiyorum' }).click();
    await expect(message(page)).toHaveValue('');
    await message(page).fill('İkinci mesaj');
    await send(page);
    await expect(thanks(page)).toBeVisible();
    expect(await sightingsOf(owner, id)).toHaveLength(2);
  });

  test('alanlar sınırdan uzun yazıya izin vermez', async ({ page, request }) => {
    const { code } = await openReport(await newOwner(request));
    await page.goto(`/p/${code}`);
    await expect(place(page)).toHaveAttribute('maxlength', '80');
    await expect(message(page)).toHaveAttribute('maxlength', '500');
    await expect(contact(page)).toHaveAttribute('maxlength', '80');
  });

  test('sayfa açıkken ilan kapanırsa mesaj sahibine haber olarak gider', async ({ page, request }) => {
    const owner = await newOwner(request);
    const { code, id } = await openReport(owner);
    await page.goto(`/p/${code}`);
    await markFound(owner, id);
    await message(page).fill('Geç kaldım');
    await send(page);
    await expect(thanks(page)).toBeVisible();
    expect(await sightingsOf(owner, id)).toHaveLength(0);
    expect(await messagesOf(owner)).toHaveLength(1);
  });

  test('sayfa açıkken hayvan silinirse anlaşılır uyarı çıkar', async ({ page, request }) => {
    const owner = await newOwner(request);
    const { code } = await openReport(owner);
    await page.goto(`/p/${code}`);
    await request.delete('/v1/pets/zeytin/lost-data', { headers: { authorization: `Bearer ${owner.token}` } });
    await message(page).fill('x');
    await send(page);
    await expect(page.getByText('Bu kayıt artık yok')).toBeVisible();
  });
});

test.describe('güvenlik', () => {
  const XSS = '<img src=x onerror="window.hacked=1">';

  test('kötü niyetli ad ve açıklama kod olarak çalışmaz', async ({ page, request }) => {
    const { code } = await openReport(await newOwner(request), {
      name: '<b>Kedi</b><script>1</script>',
      description: XSS,
      area: '<svg onload=alert(1)>',
      breed: '<i>x</i>',
    });
    page.on('dialog', () => {
      throw new Error('Sayfada kod çalıştı');
    });
    await page.goto(`/p/${code}`);
    await expect(page.getByRole('heading', { name: /<b>Kedi<\/b>/ })).toBeVisible();
    await expect(page.getByText(XSS)).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { hacked?: number }).hacked)).toBeUndefined();
    await expect(page.locator('main img, main script, main b:has-text("Kedi"), main i')).toHaveCount(0);
  });

  test('sayfa yalnızca kendi sunucusuna istek atar, dış servis yok', async ({ page, request }) => {
    const { code } = await openReport(await newOwner(request), { withPhoto: true });
    const hosts = new Set<string>();
    page.on('request', (item) => hosts.add(new URL(item.url()).host));
    await page.goto(`/p/${code}`);
    await settle(page);
    expect([...hosts]).toEqual(['127.0.0.1:4100']);
  });

  test('güvenlik kuralı ihlali ya da sayfa hatası yok', async ({ page, request }) => {
    const { code } = await openReport(await newOwner(request), { withPhoto: true });
    const problems: string[] = [];
    page.on('console', (item) => {
      if (item.type() === 'error') {
        problems.push(item.text());
      }
    });
    page.on('pageerror', (error) => problems.push(error.message));
    await page.goto(`/p/${code}`);
    await settle(page);
    expect(problems).toEqual([]);
  });

  test('sayfanın kodu dış betik yükleyemez', async ({ page, request }) => {
    const { code } = await openReport(await newOwner(request));
    await page.goto(`/p/${code}`);
    const blocked = await page.evaluate(
      () =>
        new Promise<boolean>((resolve) => {
          const script = document.createElement('script');
          script.src = 'https://example.com/x.js';
          script.onerror = () => resolve(true);
          script.onload = () => resolve(false);
          document.head.append(script);
        }),
    );
    expect(blocked).toBe(true);
  });
});

test.describe('kullanılabilirlik', () => {
  test('hiçbir durumda yatay taşma yok: 30 harfli ad, 300 harfli açıklama', async ({ page, request }) => {
    const { code } = await openReport(await newOwner(request), {
      name: 'Çokuzunadlıbirkedibenimkedimki',
      description: 'Uzunbirsözcük'.repeat(23),
      area: 'Mahallesininçokuzunadı'.repeat(3),
      breed: 'Ç'.repeat(40),
    });
    await page.goto(`/p/${code}`);
    await settle(page);
    const { scrollWidth, innerWidth } = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    }));
    expect(scrollWidth).toBeLessThanOrEqual(innerWidth);
  });

  test('düğmeler parmakla rahat basılacak boyutta', async ({ page, request }) => {
    const { code } = await openReport(await newOwner(request));
    await page.goto(`/p/${code}`);
    for (const name of ['Beni gördüysen haber ver', 'Şu an buradaysa konumumu ekle', 'Aileme gönder']) {
      const box = await page.getByRole('button', { name }).boundingBox();
      expect(box!.height, name).toBeGreaterThanOrEqual(44);
    }
    await message(page).fill('x');
    await send(page);
    const more = await page.getByRole('button', { name: 'Bir şey daha eklemek istiyorum' }).boundingBox();
    expect(more!.height).toBeGreaterThanOrEqual(44);
  });

  test('alanlar iPhone yakınlaştırmasını tetiklemeyecek boyutta', async ({ page, request }) => {
    const { code } = await openReport(await newOwner(request));
    await page.goto(`/p/${code}`);
    for (const field of [place(page), message(page), contact(page)]) {
      const size = await field.evaluate((element) => parseFloat(getComputedStyle(element).fontSize));
      expect(size).toBeGreaterThanOrEqual(16);
    }
  });

  test('tasarımın yazı tipleri yüklenir', async ({ page, request }) => {
    const { code } = await openReport(await newOwner(request));
    await page.goto(`/p/${code}`);
    await settle(page);
    const loaded = await page.evaluate(() => ({
      display: document.fonts.check('700 30px Unbounded'),
      ui: document.fonts.check('500 16px Figtree'),
      heading: getComputedStyle(document.querySelector('h1')!).fontFamily,
    }));
    expect(loaded.display).toBe(true);
    expect(loaded.ui).toBe(true);
    expect(loaded.heading).toContain('Unbounded');
  });

  test('sayfa hafif: fotoğraf hariç 150 KB altında', async ({ page, request }) => {
    const { code } = await openReport(await newOwner(request));
    const bodies: Promise<Buffer>[] = [];
    page.on('response', (response) => {
      if (!response.url().includes('/photos/')) {
        bodies.push(response.body());
      }
    });
    await page.goto(`/p/${code}`);
    await settle(page);
    const total = (await Promise.all(bodies)).reduce((sum, body) => sum + body.length, 0);
    expect(total).toBeGreaterThan(10 * 1024);
    expect(total).toBeLessThan(150 * 1024);
  });

  test('form klavyeyle ve ekran okuyucuyla kullanılabilir: etiketler bağlı', async ({ page, request }) => {
    const { code } = await openReport(await newOwner(request));
    await page.goto(`/p/${code}`);
    await expect(page.getByRole('textbox')).toHaveCount(3);
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    await expect(page.getByRole('heading', { level: 2, name: 'Beni gördün mü?' })).toBeVisible();
  });

  test('gönderim sonrası teşekkür yazısı görünür alanda', async ({ page, request }) => {
    const { code } = await openReport(await newOwner(request));
    await page.goto(`/p/${code}`);
    await message(page).fill('x');
    await send(page);
    await expect(thanks(page)).toBeInViewport();
  });
});

// Piksel testleri: ekran görüntüsü onaylanmış görselle karşılaştırılır.
// Bilerek yapılan tasarım değişikliğinde: npx playwright test --update-snapshots
test.describe('piksel', () => {
  test.beforeEach(({ page }) => freezeClock(page));

  async function snap(page: Page, name: string) {
    await settle(page);
    await expect(page).toHaveScreenshot(`${name}.png`, { fullPage: true });
  }

  test('kayıp ilanı, fotoğraflı', async ({ page, request }) => {
    const { code } = await openReport(await newOwner(request), { withPhoto: true });
    await page.goto(`/p/${code}`);
    await snap(page, 'kayip-fotografli');
  });

  test('kayıp ilanı, fotoğrafsız', async ({ page, request }) => {
    const { code } = await openReport(await newOwner(request), { name: 'Şanslı', species: 'cat', breed: 'Tekir' });
    await page.goto(`/p/${code}`);
    await snap(page, 'kayip-fotografsiz');
  });

  test('kayıp ilanı, en uzun yazılar', async ({ page, request }) => {
    const { code } = await openReport(await newOwner(request), {
      name: 'Çokuzunadlıbirkedibenimkedimki',
      description: 'Uzun bir açıklama cümlesi burada. '.repeat(8).slice(0, 300),
      area: 'Çok uzun bir mahalle adı, Çok uzun bir ilçe adı, İstanbul',
    });
    await page.goto(`/p/${code}`);
    await snap(page, 'kayip-uzun-yazilar');
  });

  test('konum eklendi', async ({ page, request }) => {
    const { code } = await openReport(await newOwner(request));
    await fakeGeolocation(page, 41, 29);
    await page.goto(`/p/${code}`);
    await addLocation(page);
    await expect(page.getByText('Şu anki konumun eklendi')).toBeVisible();
    await snap(page, 'konum-eklendi');
  });

  test('konum izni yok', async ({ page, request }) => {
    const { code } = await openReport(await newOwner(request));
    await failGeolocation(page, 1);
    await page.goto(`/p/${code}`);
    await addLocation(page);
    await expect(page.getByText('Konum izni verilmedi')).toBeVisible();
    await snap(page, 'konum-izni-yok');
  });

  test('boş form uyarısı', async ({ page, request }) => {
    const { code } = await openReport(await newOwner(request));
    await page.goto(`/p/${code}`);
    await send(page);
    await expect(page.getByText('Konumunu ekle ya da')).toBeVisible();
    await snap(page, 'bos-form-uyarisi');
  });

  test('form dolu', async ({ page, request }) => {
    const { code } = await openReport(await newOwner(request));
    await page.goto(`/p/${code}`);
    await place(page).fill('Bahariye Caddesi, fırının önü');
    await message(page).fill('Parka doğru koşuyordu, kırmızı tasmalı bir köpekle birlikteydi.');
    await contact(page).fill('0555 123 45 67');
    await page.locator(':focus').blur();
    await snap(page, 'form-dolu');
  });

  test('teşekkür', async ({ page, request }) => {
    const { code } = await openReport(await newOwner(request));
    await page.goto(`/p/${code}`);
    await message(page).fill('x');
    await send(page);
    await expect(thanks(page)).toBeVisible();
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await snap(page, 'tesekkur');
  });

  test('bulundu', async ({ page, request }) => {
    const owner = await newOwner(request);
    const { code, id } = await openReport(owner);
    await markFound(owner, id);
    await page.goto(`/p/${code}`);
    await snap(page, 'bulundu');
  });

  test('bulundu, form açık', async ({ page, request }) => {
    const owner = await newOwner(request);
    const { code, id } = await openReport(owner);
    await markFound(owner, id);
    await page.goto(`/p/${code}`);
    await page.getByRole('button', { name: /şu an yanında mı/ }).click();
    await snap(page, 'bulundu-form');
  });

  test('ilan yok', async ({ page, request }) => {
    const code = await publicCode(await newOwner(request), 'p');
    await page.goto(`/p/${code}`);
    await snap(page, 'ilan-yok');
  });

  test('bulunamadı', async ({ page }) => {
    await page.goto('/p/000000000000');
    await expect(page.getByRole('heading', { name: 'Bu ilan bulunamadı' })).toBeVisible();
    await snap(page, 'bulunamadi');
  });

  test('sayfa açılamadı', async ({ page }) => {
    await page.route('**/v1/public/pets/**', (route) => route.abort());
    await page.goto('/p/000000000000');
    await expect(page.getByRole('heading', { name: 'Sayfa açılamadı' })).toBeVisible();
    await snap(page, 'sayfa-acilamadi');
  });
});
