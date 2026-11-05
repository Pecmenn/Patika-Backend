import { z } from 'zod';

const flag = z.enum(['true', 'false']).transform((value) => value === 'true');
const list = z
  .string()
  .transform((value) => value.split(',').map((item) => item.trim()).filter(Boolean));

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  PORT: z.coerce.number().int().min(0).max(65535).default(4000),
  HOST: z.string().default('0.0.0.0'),
  PHOTO_DIR: z.string().default('./data/photos'),
  APPLE_AUDIENCES: list.refine((items) => items.length > 0),
  ALLOW_DEV_LOGIN: flag.default(false),
  // Yalnızca tarayıcı önizlemesi için: uygulamanın web sürümü başka adresten istek atar.
  CORS_ORIGINS: list.default([]),
  // Önünde başka bir sunucu varsa gerçek ziyaretçi adresini ondan öğrenir.
  TRUST_PROXY: flag.default(false),
});

export type Config = z.infer<typeof schema>;

const EXPO_GO_AUDIENCE = 'host.exp.Exponent';

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const config = schema.parse(env);
  // Expo Go'nun kimliği herkesin projesi için aynıdır. Gerçek sunucuda kabul edilirse Expo Go'da
  // açılan herhangi bir proje, kullanıcının Apple belgesiyle Patika'ya girebilir.
  if (!config.ALLOW_DEV_LOGIN && config.APPLE_AUDIENCES.includes(EXPO_GO_AUDIENCE)) {
    throw new Error(`Gerçek sunucuda APPLE_AUDIENCES içinde ${EXPO_GO_AUDIENCE} olamaz`);
  }
  return config;
}
