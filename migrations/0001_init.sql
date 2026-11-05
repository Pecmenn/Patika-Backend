-- Patika veritabanı. Zamanların hepsi UTC'dir.
-- Kimlik sütunları büyük-küçük harf ayrımı yapar (ascii_bin, utf8mb4_bin): iki kayıt karışmasın.

CREATE TABLE users (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  -- Apple'ın kullanıcıya verdiği değişmez kimlik. Deneme hesaplarında boştur.
  apple_sub VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL UNIQUE,
  email VARCHAR(320) NULL,
  full_name VARCHAR(200) NULL,
  given_name VARCHAR(100) NULL,
  family_name VARCHAR(100) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
);

-- Oturumlar. Anahtarın kendisi değil özeti saklanır: veritabanı sızsa da oturum çalınamaz.
CREATE TABLE sessions (
  token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_used_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  expires_at DATETIME(3) NOT NULL,
  INDEX sessions_user_idx (user_id),
  CONSTRAINT sessions_user_fk FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);

-- Telefondaki kayıtların yedeği. Her satır bir kayıt: hayvan, aşı, görev...
CREATE TABLE user_items (
  owner_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  collection VARCHAR(30) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  id VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  data JSON NULL,
  deleted BOOLEAN NOT NULL DEFAULT FALSE,
  -- Kaydın telefonda değiştiği an. Çakışmada son değişiklik kazanır.
  updated_at DATETIME(3) NOT NULL,
  -- Satırın sunucuya ulaştığı an. Telefonların saatine güvenmemek için sunucu belirler.
  synced_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (owner_id, collection, id),
  INDEX user_items_sync_idx (owner_id, synced_at, collection, id),
  CONSTRAINT user_items_owner_fk FOREIGN KEY (owner_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT user_items_collection_check CHECK (
    collection IN ('pets', 'health_records', 'visits', 'tasks', 'weights', 'weight_ranges')
  )
);

-- Her hayvanın değişmeyen kodu. QR ve ilan bağlantısı bunu kullanır, tahmin edilemez.
CREATE TABLE pet_tags (
  owner_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  pet_id VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  public_code CHAR(12) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (owner_id, pet_id),
  UNIQUE KEY pet_tags_code_unique (public_code),
  CONSTRAINT pet_tags_owner_fk FOREIGN KEY (owner_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE TABLE lost_reports (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  owner_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  pet_id VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  pet_name VARCHAR(30) NOT NULL,
  species VARCHAR(10) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  breed VARCHAR(40) NULL,
  description VARCHAR(300) NULL,
  photo_path VARCHAR(100) CHARACTER SET ascii COLLATE ascii_bin NULL,
  -- Herkese görünen semt yazısı.
  last_seen_area VARCHAR(80) NOT NULL,
  -- Tam nokta: yalnızca hayvanın sahibi görür, evin yakını olabilir.
  last_seen_lat DOUBLE NOT NULL,
  last_seen_lng DOUBLE NOT NULL,
  last_seen_at DATETIME(3) NOT NULL,
  started_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  found_at DATETIME(3) NULL,
  -- Bir hayvanın aynı anda tek açık ilanı olur. Kapanınca boşalır, MySQL boşları tekrar sayar.
  active_pet_id VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin
    GENERATED ALWAYS AS (IF(found_at IS NULL, pet_id, NULL)) STORED,
  UNIQUE KEY lost_reports_one_active (owner_id, active_pet_id),
  INDEX lost_reports_pet_idx (owner_id, pet_id, started_at),
  CONSTRAINT lost_reports_owner_fk FOREIGN KEY (owner_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT lost_reports_species_check CHECK (species IN ('cat', 'dog', 'rabbit', 'bird')),
  CONSTRAINT lost_reports_lat_check CHECK (last_seen_lat BETWEEN -90 AND 90),
  CONSTRAINT lost_reports_lng_check CHECK (last_seen_lng BETWEEN -180 AND 180)
);

-- İhbarlar. Açık ilan yoksa report_id boştur: sahibine haber olarak düşer.
CREATE TABLE sightings (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  report_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  owner_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  pet_id VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  place VARCHAR(80) NULL,
  lat DOUBLE NULL,
  lng DOUBLE NULL,
  message VARCHAR(500) NULL,
  contact VARCHAR(80) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX sightings_report_idx (report_id, created_at),
  INDEX sightings_pet_idx (owner_id, pet_id, report_id, created_at),
  CONSTRAINT sightings_report_fk FOREIGN KEY (report_id) REFERENCES lost_reports (id) ON DELETE CASCADE,
  CONSTRAINT sightings_owner_fk FOREIGN KEY (owner_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT sightings_lat_check CHECK (lat IS NULL OR lat BETWEEN -90 AND 90),
  CONSTRAINT sightings_lng_check CHECK (lng IS NULL OR lng BETWEEN -180 AND 180),
  CONSTRAINT sightings_location_check CHECK ((lat IS NULL) = (lng IS NULL))
);
