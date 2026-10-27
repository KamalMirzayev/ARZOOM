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
