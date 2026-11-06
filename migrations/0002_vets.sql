-- Veteriner hesapları, klinikler ve randevular. Zamanların hepsi UTC'dir.

-- Bir hesap tek rol taşır: sahip ya da veteriner.
ALTER TABLE users
  ADD COLUMN role VARCHAR(10) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'owner',
  ADD CONSTRAINT users_role_check CHECK (role IN ('owner', 'vet'));

-- Veterinerler e-posta ve şifreyle girer. Şifrenin kendisi değil geri çevrilemez özeti saklanır.
CREATE TABLE vet_logins (
  user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  -- Küçük harfe çevrilmiş hâli: aynı adres iki kez kaydolamasın.
  email VARCHAR(320) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  password_hash VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY vet_logins_email_unique (email),
  CONSTRAINT vet_logins_user_fk FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE TABLE clinics (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  owner_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  -- Yalnızca onaylanan klinik sahiplerin listesinde görünür.
  status VARCHAR(10) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'pending',
  name VARCHAR(80) NOT NULL,
  vet_name VARCHAR(80) NOT NULL,
  -- Oda sicil numarası yalnızca onay içindir: herkese açık uçlardan dönmez.
  license_no VARCHAR(40) NOT NULL,
  phone VARCHAR(24) NOT NULL,
  address VARCHAR(200) NOT NULL,
  area VARCHAR(80) NOT NULL,
  lat DOUBLE NOT NULL,
  lng DOUBLE NOT NULL,
  -- Pazartesiden pazara 7 gün: {open, close} ya da kapalıysa null. Türkiye saatiyle.
  hours JSON NOT NULL,
  slot_minutes SMALLINT NOT NULL DEFAULT 30,
  species JSON NOT NULL,
  services JSON NOT NULL,
  description VARCHAR(600) NULL,
  website VARCHAR(200) NULL,
  instagram VARCHAR(60) NULL,
  photo_path VARCHAR(100) CHARACTER SET ascii COLLATE ascii_bin NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY clinics_owner_unique (owner_id),
  INDEX clinics_status_idx (status, name),
  CONSTRAINT clinics_owner_fk FOREIGN KEY (owner_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT clinics_status_check CHECK (status IN ('pending', 'approved', 'rejected')),
  CONSTRAINT clinics_lat_check CHECK (lat BETWEEN -90 AND 90),
  CONSTRAINT clinics_lng_check CHECK (lng BETWEEN -180 AND 180)
);

CREATE TABLE appointments (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  -- Klinik hesabını silerse randevu sahibin geçmişinde klinik adıyla kalır.
  clinic_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  clinic_name VARCHAR(80) NOT NULL,
  owner_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  pet_id VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  pet_name VARCHAR(30) NOT NULL,
  species VARCHAR(10) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  breed VARCHAR(40) NULL,
  pet_age VARCHAR(30) NULL,
  -- Veterinere giden sahip bilgisi. Sağlık kayıtları paylaşılmaz.
  owner_name VARCHAR(100) NOT NULL,
  owner_phone VARCHAR(24) NOT NULL,
  reason VARCHAR(60) NOT NULL,
  note VARCHAR(500) NULL,
  starts_at DATETIME(3) NOT NULL,
  status VARCHAR(10) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'pending',
  cancelled_by VARCHAR(10) CHARACTER SET ascii COLLATE ascii_bin NULL,
  vet_note VARCHAR(300) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  responded_at DATETIME(3) NULL,
  -- Bir saate tek onaylı randevu olur. Boşlar sayılmaz, bekleyen istekler birbirini engellemez.
  confirmed_slot DATETIME(3) GENERATED ALWAYS AS (IF(status = 'confirmed', starts_at, NULL)) STORED,
  UNIQUE KEY appointments_one_per_slot (clinic_id, confirmed_slot),
  INDEX appointments_clinic_idx (clinic_id, status, starts_at),
  INDEX appointments_owner_idx (owner_id, starts_at),
  INDEX appointments_pet_idx (owner_id, pet_id, status),
  CONSTRAINT appointments_clinic_fk FOREIGN KEY (clinic_id) REFERENCES clinics (id) ON DELETE SET NULL,
  CONSTRAINT appointments_owner_fk FOREIGN KEY (owner_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT appointments_status_check CHECK (status IN ('pending', 'confirmed', 'rejected', 'cancelled')),
  CONSTRAINT appointments_cancelled_by_check CHECK (cancelled_by IS NULL OR cancelled_by IN ('owner', 'vet')),
  CONSTRAINT appointments_species_check CHECK (species IN ('cat', 'dog', 'rabbit', 'bird'))
);
