import type { Config } from './config.ts';
import type { Db } from './db.ts';
import type { AppleKeys } from './auth/apple.ts';
import type { PhotoStore } from './photos/store.ts';
import type { Hub } from './realtime/hub.ts';

export type RateLimits = {
  // Dakikada izin verilen istek sayısı, ziyaretçi adresi başına.
  auth: number;
  publicRead: number;
  publicWrite: number;
};

export type Deps = {
  config: Config;
  db: Db;
  photos: PhotoStore;
  hub: Hub;
  appleKeys: AppleKeys;
  rateLimits: RateLimits;
};
