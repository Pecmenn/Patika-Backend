import { Kysely, MysqlDialect, type ColumnType, type Generated } from 'kysely';
import { createPool } from 'mysql2';

type Timestamp = ColumnType<Date, Date | undefined, Date>;
type RequiredTimestamp = ColumnType<Date, Date, Date>;

export interface UsersTable {
  id: string;
  apple_sub: string | null;
  email: string | null;
  full_name: string | null;
  given_name: string | null;
  family_name: string | null;
  created_at: Timestamp;
}

export interface SessionsTable {
  token_hash: string;
  user_id: string;
  created_at: Timestamp;
  last_used_at: Timestamp;
  expires_at: RequiredTimestamp;
}

export interface UserItemsTable {
  owner_id: string;
  collection: string;
  id: string;
  data: ColumnType<unknown, string | null, string | null>;
  deleted: ColumnType<number, boolean, boolean>;
  updated_at: RequiredTimestamp;
  synced_at: Timestamp;
}

export interface PetTagsTable {
  owner_id: string;
  pet_id: string;
  public_code: string;
  created_at: Timestamp;
}

export interface LostReportsTable {
  id: string;
  owner_id: string;
  pet_id: string;
  pet_name: string;
  species: string;
  breed: string | null;
  description: string | null;
  photo_path: string | null;
  last_seen_area: string;
  last_seen_lat: number;
  last_seen_lng: number;
  last_seen_at: RequiredTimestamp;
  started_at: Timestamp;
  found_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
  active_pet_id: ColumnType<string | null, never, never>;
}

export interface SightingsTable {
  id: string;
  report_id: string | null;
  owner_id: string;
  pet_id: string;
  place: string | null;
  lat: number | null;
  lng: number | null;
  message: string | null;
  contact: string | null;
  created_at: Timestamp;
}

export interface Database {
  users: UsersTable;
  sessions: SessionsTable;
  user_items: UserItemsTable;
  pet_tags: PetTagsTable;
  lost_reports: LostReportsTable;
  sightings: SightingsTable;
}

export type Db = Kysely<Database>;
export type { Generated };

export function createDb(databaseUrl: string): Db {
  return new Kysely<Database>({
    dialect: new MysqlDialect({
      pool: createPool({ uri: databaseUrl, timezone: 'Z', connectionLimit: 10, charset: 'utf8mb4' }),
    }),
  });
}

export function isDuplicateKey(error: unknown) {
  return (error as { code?: string }).code === 'ER_DUP_ENTRY';
}
