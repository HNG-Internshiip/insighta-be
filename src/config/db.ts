import { Pool } from "pg";

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,

  // Connection pool tuning
  // max: keep low on serverless — Lambda has limited concurrency per instance
  // On a persistent server, raise to 20-30
  max:             10,
  min:             2,
  idleTimeoutMillis:    30_000,
  connectionTimeoutMillis: 5_000,
  // Allow statements to be cancelled if they exceed 8 seconds
  statement_timeout:    8_000,
});

export async function initDB(): Promise<void> {
  await pool.query(`
    -- ── Core tables ────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS profiles (
      id                  VARCHAR(36)  PRIMARY KEY,
      name                VARCHAR(255) NOT NULL UNIQUE,
      gender              VARCHAR(10)  NOT NULL,
      gender_probability  FLOAT        NOT NULL,
      age                 INT          NOT NULL,
      age_group           VARCHAR(20)  NOT NULL,
      country_id          VARCHAR(2)   NOT NULL,
      country_name        VARCHAR(255) NOT NULL,
      country_probability FLOAT        NOT NULL,
      created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    );

    -- ── Single-column indexes ───────────────────────────────────────────────
    CREATE INDEX IF NOT EXISTS idx_profiles_gender     ON profiles(gender);
    CREATE INDEX IF NOT EXISTS idx_profiles_age        ON profiles(age);
    CREATE INDEX IF NOT EXISTS idx_profiles_age_group  ON profiles(age_group);
    CREATE INDEX IF NOT EXISTS idx_profiles_country_id ON profiles(country_id);
    CREATE INDEX IF NOT EXISTS idx_profiles_created_at ON profiles(created_at);

    -- ── Composite index for dominant combined query pattern ─────────────────
    -- Covers: gender=X AND country_id=Y (most common NLP + explicit filter combo)
    CREATE INDEX IF NOT EXISTS idx_profiles_gender_country
      ON profiles(gender, country_id);

    -- ── Composite for age range queries ────────────────────────────────────
    -- Covers: min_age + max_age range scans efficiently
    CREATE INDEX IF NOT EXISTS idx_profiles_age_group_age
      ON profiles(age_group, age);

    -- ── Auth + session tables ───────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS users (
      id            VARCHAR(36)  PRIMARY KEY,
      github_id     VARCHAR(64)  NOT NULL UNIQUE,
      username      VARCHAR(255) NOT NULL,
      email         VARCHAR(255),
      avatar_url    TEXT,
      role          VARCHAR(20)  NOT NULL DEFAULT 'analyst',
      is_active     BOOLEAN      NOT NULL DEFAULT TRUE,
      last_login_at TIMESTAMPTZ,
      created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS refresh_tokens (
      id         VARCHAR(36)  PRIMARY KEY,
      user_id    VARCHAR(36)  NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash VARCHAR(255) NOT NULL UNIQUE,
      expires_at TIMESTAMPTZ  NOT NULL,
      created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id);
    CREATE INDEX IF NOT EXISTS idx_refresh_tokens_hash ON refresh_tokens(token_hash);

    -- ── PKCE state (DB-backed for serverless) ───────────────────────────────
    CREATE TABLE IF NOT EXISTS pkce_states (
      state          TEXT        PRIMARY KEY,
      code_challenge TEXT        NOT NULL,
      from_client    TEXT        NOT NULL DEFAULT 'web',
      redirect_uri   TEXT        NOT NULL DEFAULT '',
      expires_at     TIMESTAMPTZ NOT NULL
    );

    -- ── Rate limiting counters ──────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS rate_limit_hits (
      key        TEXT        PRIMARY KEY,
      hits       INT         NOT NULL DEFAULT 1,
      window_end TIMESTAMPTZ NOT NULL
    );
  `);

  console.log("Database initialised");
}