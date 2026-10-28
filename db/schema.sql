-- Arzoom Avto lizinq müraciətləri
CREATE TABLE IF NOT EXISTS applications (
  id            TEXT PRIMARY KEY,                 -- AA-2026-1234
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  fin           CHAR(7)     NOT NULL,
  id_series     TEXT        NOT NULL CHECK (id_series IN ('AZE','AA','AB')),
  id_number     TEXT        NOT NULL,
  phone         TEXT        NOT NULL,
  income_sources TEXT[]     NOT NULL,
  voen          CHAR(10),
  brand         TEXT        NOT NULL,
  model         TEXT        NOT NULL,
  consent_text  TEXT        NOT NULL,
  consent_at    TIMESTAMPTZ NOT NULL,
  client_ip     TEXT,
  status        TEXT        NOT NULL DEFAULT 'review'
                CHECK (status IN ('review','offer','accepted','declined','cancelled')),
  offer         JSONB
);
CREATE INDEX IF NOT EXISTS applications_fin_idx ON applications (fin);
CREATE INDEX IF NOT EXISTS applications_created_idx ON applications (created_at DESC);

CREATE TABLE IF NOT EXISTS application_files (
  id             BIGSERIAL PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  income_source  TEXT NOT NULL,
  original_name  TEXT NOT NULL,
  stored_name    TEXT NOT NULL,
  mime           TEXT,
  size_bytes     INTEGER,
  uploaded_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS otp_codes (
  phone       TEXT PRIMARY KEY,
  code_hash   TEXT NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0
);

-- Qiymətləndirmə (əməkdaş paneli)
ALTER TABLE applications ADD COLUMN IF NOT EXISTS assessment    JSONB;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS reject_reason TEXT;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS decided_by    TEXT;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS updated_at    TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE applications DROP CONSTRAINT IF EXISTS applications_status_check;
ALTER TABLE applications ADD CONSTRAINT applications_status_check
  CHECK (status IN ('review','offer','rejected','accepted','declined','cancelled'));
CREATE INDEX IF NOT EXISTS applications_status_idx ON applications (status);

CREATE TABLE IF NOT EXISTS application_events (
  id             BIGSERIAL PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor          TEXT NOT NULL,          -- əməkdaşın adı və ya "Müştəri"
  kind           TEXT NOT NULL,          -- created, assessed, offer, rejected, note, accepted, declined, cancelled, sms
  details        JSONB
);
CREATE INDEX IF NOT EXISTS application_events_app_idx ON application_events (application_id, at);

-- Müştəri girişi: SMS ilə təsdiqdən sonra brauzerə verilən açar (yalnız hash saxlanılır)
CREATE TABLE IF NOT EXISTS app_tokens (
  token_hash     TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at     TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS app_tokens_app_idx ON app_tokens (application_id);

-- Əməkdaş hesabları (parollar scrypt ilə saxlanılır) və giriş sessiyaları
CREATE TABLE IF NOT EXISTS staff_users (
  id            BIGSERIAL PRIMARY KEY,
  username      TEXT UNIQUE NOT NULL,
  name          TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'expert' CHECK (role IN ('admin','expert')),
  active        BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login    TIMESTAMPTZ
);
-- AKB hesabatı: xam XML (audit üçün) və oxunmuş göstəricilər
ALTER TABLE applications ADD COLUMN IF NOT EXISTS bureau     JSONB;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS bureau_xml TEXT;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS bureau_at  TIMESTAMPTZ;
-- Fərdi icazələr: NULL olduqda rolun standart icazələri işləyir
ALTER TABLE staff_users ADD COLUMN IF NOT EXISTS permissions JSONB;
-- Silinmiş müraciətlərin izi: kim, nə vaxt, niyə
CREATE TABLE IF NOT EXISTS deletion_log (
  application_id TEXT NOT NULL,
  deleted_by     TEXT NOT NULL,
  reason         TEXT NOT NULL,
  summary        JSONB,
  at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Satış mütəxəssisi rolu və bildiriş SMS-i üçün telefon
ALTER TABLE staff_users ADD COLUMN IF NOT EXISTS phone TEXT;
ALTER TABLE staff_users DROP CONSTRAINT IF EXISTS staff_users_role_check;
ALTER TABLE staff_users ADD CONSTRAINT staff_users_role_check CHECK (role IN ('admin','expert','sales'));
CREATE TABLE IF NOT EXISTS staff_sessions (
  token_hash  TEXT PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES staff_users(id) ON DELETE CASCADE,
  expires_at  TIMESTAMPTZ NOT NULL
);
