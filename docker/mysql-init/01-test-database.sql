-- Testler ayrı veritabanında çalışır, her çalıştırmada silinip yeniden kurulur.
CREATE DATABASE IF NOT EXISTS patika_test;
GRANT ALL PRIVILEGES ON patika_test.* TO 'patika'@'%';
