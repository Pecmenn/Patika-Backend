import { defineConfig, devices } from '@playwright/test';

const PORT = 4100;

const PANEL = /admin\.spec\.ts/;

// Kayıp sayfası ve yönetim panelinin tarayıcı testleri. Ayrı test sunucusu ve test veritabanıyla çalışır: npm run test:page
// iPhone projeleri Safari motorunu (WebKit) ve iPhone ekran ölçülerini kullanır,
// gerçek iOS simülatörü değildir. Simülatör yalnızca Mac'te çalışıyor.
export default defineConfig({
  testDir: './e2e',
  snapshotPathTemplate: '{testDir}/__screenshots__/{projectName}/{arg}{ext}',
  fullyParallel: true,
  reporter: [['list']],
  expect: {
    // Oran değil piksel sayısı: oran büyük ekranda küçük bir yazı değişikliğini kaçırıyor.
    toHaveScreenshot: { maxDiffPixels: 100, animations: 'disabled' },
  },
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    locale: 'tr-TR',
    timezoneId: 'Europe/Istanbul',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'iphone-safari', testIgnore: PANEL, use: { ...devices['iPhone 15'] } },
    { name: 'kucuk-iphone-safari', testIgnore: PANEL, use: { ...devices['iPhone SE'] } },
    { name: 'android-chrome', testIgnore: PANEL, use: { ...devices['Pixel 7'] } },
    {
      name: 'panel',
      testMatch: PANEL,
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } },
    },
    { name: 'panel-telefon', testMatch: PANEL, use: { ...devices['Pixel 7'] } },
  ],
  webServer: {
    command: 'node --no-warnings --env-file=.env e2e/test-server.ts',
    url: `http://127.0.0.1:${PORT}/health`,
    reuseExistingServer: false,
    stdout: 'ignore',
  },
});
