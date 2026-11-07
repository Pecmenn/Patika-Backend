# Patika Backend

Patika telefon uygulamasının sunucusu: giriş, kayıt yedekleme, fotoğraflar, kayıp ilanları, canlı ihbar, QR kodunun açtığı kayıp sayfası ve yönetim paneli.

**Teknoloji:** Node.js 24, TypeScript, Fastify, MySQL 8.4, Docker.

## Çalıştırma

Gerekenler: Docker Desktop (Mac'te OrbStack de olur) ve Node.js 24.

```bash
npm install
cp .env.example .env
```

`.env` içindeki `degistir` yazan parolaları değiştir, `DATABASE_URL` içindeki parola da `MYSQL_PASSWORD` ile aynı olsun. Parolada yalnızca harf ve rakam kullan, adresin içine yazıldığı için özel karakter bozar.

```bash
docker compose up -d --build
```

Bu komut MySQL'i ve sunucuyu başlatır, tabloları otomatik kurar. Sunucu `http://localhost:4000` adresinde çalışır. Kontrol: `http://localhost:4000/health` adresi `{"ok":true}` döner.

**Bilinmesi gerekenler:**

- 4000 numaralı kapı aynı ağdaki herkese açık ve şifresiz `http` kullanıyor, deneme girişi de açık. Bu yüzden bilgisayar açılınca kendiliğinden başlamaz. İşin bitince durdur: `docker compose stop`.
- `docker compose down -v` tüm verileri siler, yedeği yoktur. Yalnızca verilerin gitmesini istiyorsan kullan.
- Test veritabanı (`patika_test`) yalnızca MySQL ilk kurulurken oluşur. Daha sonra eklemek gerekirse `docker/mysql-init` içindeki komutu elle çalıştır.
- Kayıp sayfası Docker görüntüsünün içindedir. `public/` değişince `docker compose up -d --build` çalıştırmazsan eski sayfa görünür.

| Komut | Ne yapar |
|---|---|
| `docker compose ps` | Çalışıyor mu? |
| `docker compose logs -f api` | Sunucu kayıtları |
| `docker compose stop` | Durdurur, veriler kalır |
| `docker compose up -d --build` | Kod değişince yeniden başlatır |
| `npm test` | Sunucu senaryoları (ayrı test veritabanında) |
| `npm run test:page` | Kayıp sayfası ve yönetim panelinin tarayıcı testleri ve piksel testleri |
| `npm run admin -- create <e-posta>` | Yönetici hesabı açar, şifreyi sorar |
| `npx playwright test --update-snapshots` | Bilerek yapılan tasarım değişikliğinden sonra karşılaştırma görsellerini yeniler |
| `npm run typecheck` | Tip kontrolü |

Testlerden önce MySQL çalışıyor olmalı. Tarayıcı motorları ilk seferde `npx playwright install chromium webkit` ile kurulur.

## Mimari

```
src/
  server.ts        Başlangıç: tabloları kurar, sunucuyu açar
  app.ts           Uçları ve güvenlik başlıklarını birleştirir
  config.ts        Ayarlar (.env)
  db.ts            Veritabanı bağlantısı ve tablo tipleri
  migrate.ts       migrations/ klasörünü sırayla çalıştırır
  auth/            Apple belgesi doğrulama, oturumlar, hesap
  sync/            Telefondaki kayıtların yedeklenmesi
  photos/          Hayvan fotoğrafları (diskte)
  lost/            Kayıp ilanı, ihbar, herkese açık uçlar
  realtime/        Yeni ihbarın telefona anında gitmesi (WebSocket)
  admin/           Yönetim panelinin uçları ve yönetici oturumları
public/            QR kodunun açtığı kayıp sayfası (HTML, CSS, JS)
public/admin/      Yönetim panelinin sayfası
scripts/admin.ts   Yönetici hesabı komutu
migrations/        Veritabanı değişiklikleri (SQL)
tests/             Sunucu senaryoları
e2e/               Kayıp sayfası ve panelin tarayıcı ve piksel testleri
```

**Kurallar:**

- Bir kullanıcı yalnızca kendi verisine ulaşır. Her sorgu `owner_id` ile sınırlıdır. Veritabanı bunu kendi başına zorlamaz, bu yüzden `tests/api.test.ts` sınar. Yeni uç eklenince test de eklenir.
- Giriş gerektiren uçlar `app.ts` içindeki korumalı bloğa eklenir. Blok dışına yalnızca gerçekten herkese açık olanlar girer.
- Herkese açık uçlardan tam konum, sahip bilgisi ve ihbarlar asla dönmez (`src/lost/public-routes.ts`).
- Veritabanı değişikliği yeni bir `migrations/000N_ad.sql` dosyasıdır, eski dosyalar değiştirilmez.
- Oturum anahtarının kendisi saklanmaz, özeti saklanır.
- Yöneticiler uygulama hesaplarından ayrıdır. Uygulama oturumu panele, panel oturumu uygulamaya giremez. Panel uçları `src/admin/routes.ts` içindeki korumalı bloğa eklenir, `tests/admin.test.ts` içindeki uç listesine de yazılır.
- Panelde sağlık kaydı, tam konum, şifre özeti ve Apple kimliği hiçbir uçtan dönmez. Panel sayfası kullanıcı metnini yalnızca yazı olarak basar (`public/admin/admin.js` içindeki `h`).

## Uçlar

Kısaca: `POST /v1/auth/apple`, `POST /v1/auth/dev` (yalnızca geliştirirken), `POST /v1/auth/logout`, `GET/DELETE /v1/me`, `GET/PUT /v1/items`, `PUT/GET/DELETE /v1/photos/:ad`, `GET/POST /v1/lost-reports`, `GET /v1/lost-reports/:id`, `PUT /v1/lost-reports/:id/photo`, `POST /v1/lost-reports/:id/found`, `GET /v1/pets/:id/public-code`, `DELETE /v1/pets/:id/lost-data`, `GET /v1/pet-messages`, `DELETE /v1/pets/:id/messages`, `GET /v1/public/pets/:kod`, `POST /v1/public/pets/:kod/sightings`, `GET /v1/public/photos/:dosya`, `WS /v1/events`, `GET /p/:kod`, `GET /admin`, `/admin/api/*` (panel), `GET /health`.

## Gerçek sunucuya geçmeden önce

- `ALLOW_DEV_LOGIN=false`, `CORS_ORIGINS` boş. Deneme girişi kapalıyken `APPLE_AUDIENCES` içinde `host.exp.Exponent` varsa sunucu açılmaz, bu bilinçli bir korumadır.
- HTTPS ve kendi alan adı. Tarayıcılar konum iznini yalnızca HTTPS sayfalarda verir.
- Parolaları yenile, veritabanı yedeği kur.
- Önünde başka bir sunucu varsa `TRUST_PROXY=true`, yoksa ziyaretçi sınırları hepsini tek kişi sayar (Docker'da şu an da öyle: dakikada 10 ihbar sınırı herkes için ortak). Sunucunun zaman dilimi UTC olmalı.
- `APPLE_AUDIENCES` listesine uygulamanın kendi kimliğini ekle, `host.exp.Exponent` değerini çıkar.
- Panel internete HTTPS arkasında açılır ve `TRUST_PROXY=true` olur: panel çerezi ancak o zaman yalnızca HTTPS üzerinden gider. Açmadan önce iki aşamalı girişi ve yapılan işlemlerin kaydını değerlendir.

## Yönetim paneli

Klinik onayı, özet rakamlar, kayıp ilanı denetimi ve kullanıcı yönetimi. Bu bilgisayardan `http://localhost:4000/admin` adresinden açılır. Şifre şimdilik şifresiz `http` üzerinden gittiği için panele başka bir cihazdan girme.

Yönetici hesabı uygulamadan ya da panelden açılmaz, yalnızca komutla:

```bash
npm run admin -- create <e-posta>
npm run admin -- password <e-posta>
npm run admin -- list
npm run admin -- remove <e-posta>
```

Şifre komuta yazılmaz, sorulur ve yazarken ekranda görünmez. En az 12 karakter olmalı. Unutulursa `password` komutuyla yenilenir, açık oturumlar kapanır. Oturum 8 saat sürer. Gerçek sunucuda aynı komut `docker compose exec api node --no-warnings scripts/admin.ts create <e-posta>` ile çalışır.

Aynı e-postayla 5 yanlış denemede giriş 15 dakika kapanır. Beklemeden açmak için: `docker compose restart api`.

**Yapılan işlerin sonuçları:**

- **Klinik onayı:** Kayıt olan klinik onaylanmadan sahiplerin listesinde görünmez. Onaylamadan önce oda sicil numarası kontrol edilmeli. Panel açıkken bilgiler değiştiyse onay reddedilir, güncel hâli gösterilir. Onaydan sonra klinik adı, hekim adı ya da sicil numarası değişirse klinik yeniden onaya düşer. Reddedilen ya da listeden kaldırılan kliniğin yaklaşan randevuları iptal olur.
- **İlan kaldırma:** Kayıp sayfası kapanır, herkese açık fotoğraf silinir, sahibinin açık uygulamasına haber gider. Geri alınamaz, sahibi yeni ilan açabilir. İhbar silme de geri alınamaz.
- **Hesap kapatma:** Oturum düşer, giriş yapılamaz, QR sayfası kapanır, açık ilan kalkar, klinik reddedilir, yaklaşan randevular iptal olur. Kayıtlar silinmez. Yeniden açılınca giriş yapılır ve QR çalışır, ama ilan ve klinik onayı kendiliğinden geri gelmez. Kapatma hata verirse hesabı açıp yeniden kapatmak kalan adımları tamamlar.
