-- Yönetim paneli. Zamanların hepsi UTC'dir.

-- Yöneticinin kapattığı hesap giriş yapamaz. Boşsa hesap açıktır.
ALTER TABLE users ADD COLUMN suspended_at DATETIME(3) NULL;

-- Yöneticinin kaldırdığı ilan. found_at da dolar: açık ilan sayılmaz, sahibi yenisini açabilir.
ALTER TABLE lost_reports ADD COLUMN removed_at DATETIME(3) NULL;

-- Yöneticiler uygulama hesaplarından ayrıdır: uygulama oturumu panele giremez, panel oturumu uygulamaya.
CREATE TABLE admins (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  -- Küçük harfe çevrilmiş hâli.
  email VARCHAR(320) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  password_hash VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY admins_email_unique (email)
);

CREATE TABLE admin_sessions (
  token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  admin_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  expires_at DATETIME(3) NOT NULL,
  INDEX admin_sessions_admin_idx (admin_id),
  CONSTRAINT admin_sessions_admin_fk FOREIGN KEY (admin_id) REFERENCES admins (id) ON DELETE CASCADE
);
