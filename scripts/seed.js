"use strict";
require("dotenv").config();
const fs   = require("fs");
const path = require("path");
const { Pool } = require("pg");

// ── UUID v7 ───────────────────────────────────────────────────────────────────
function uuidv7() {
  const ms  = BigInt(Date.now());
  const rnd = BigInt(Math.floor(Math.random() * 0xfff));
  const hi  = ((ms << 16n) | (rnd & 0xfffn)).toString(16).padStart(16, "0");
  const lo  = BigInt(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER))
                .toString(16).padStart(16, "0");
  const hex = hi + lo;
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    "7" + hex.slice(13, 16),
    ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16) + hex.slice(17, 20),
    hex.slice(20, 32),
  ].join("-");
}

function getAgeGroup(age) {
  if (age <= 12) return "child";
  if (age <= 19) return "teenager";
  if (age <= 59) return "adult";
  return "senior";
}

async function seed() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === "production"
      ? { rejectUnauthorized: false }
      : false,
  });

  await pool.query(`
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
    CREATE INDEX IF NOT EXISTS idx_profiles_gender     ON profiles(gender);
    CREATE INDEX IF NOT EXISTS idx_profiles_age        ON profiles(age);
    CREATE INDEX IF NOT EXISTS idx_profiles_age_group  ON profiles(age_group);
    CREATE INDEX IF NOT EXISTS idx_profiles_country_id ON profiles(country_id);
    CREATE INDEX IF NOT EXISTS idx_profiles_created_at ON profiles(created_at);
  `);

  const filePath = process.env.SEED_FILE
    || path.resolve(__dirname, "../data/profiles.json");

  if (!fs.existsSync(filePath)) {
    console.error(`Seed file not found: ${filePath}`);
    process.exit(1);
  }

  const raw      = JSON.parse(fs.readFileSync(filePath, "utf8"));
  // Handle both [{ ... }] and { "profiles": [...] } and { "data": [...] }
  const profiles = Array.isArray(raw)
    ? raw
    : raw.profiles ?? raw.data ?? raw[Object.keys(raw)[0]];

  if (!Array.isArray(profiles) || profiles.length === 0) {
    console.error("Could not find a profiles array in the JSON file.");
    console.error("Top-level keys found:", Object.keys(raw));
    process.exit(1);
  }
  console.log(`Seeding ${profiles.length} profiles...`);

  const CHUNK  = 100;
  let inserted = 0;
  let skipped  = 0;

  for (let i = 0; i < profiles.length; i += CHUNK) {
    const chunk        = profiles.slice(i, i + CHUNK);
    const cols         = ["id","name","gender","gender_probability","age","age_group","country_id","country_name","country_probability"];
    const placeholders = [];
    const values       = [];
    let   p            = 1;

    for (const row of chunk) {
      const age      = typeof row.age === "number" ? row.age : parseInt(row.age, 10);
      const ageGroup = row.age_group || getAgeGroup(age);

      placeholders.push(
        `($${p},$${p+1},$${p+2},$${p+3},$${p+4},$${p+5},$${p+6},$${p+7},$${p+8})`
      );
      values.push(
        row.id || uuidv7(),
        row.name,
        row.gender,
        parseFloat(row.gender_probability),
        age,
        ageGroup,
        row.country_id,
        row.country_name,
        parseFloat(row.country_probability)
      );
      p += 9;
    }

    const sql = `
      INSERT INTO profiles (${cols.join(",")})
      VALUES ${placeholders.join(",")}
      ON CONFLICT (name) DO NOTHING
    `;
    const result = await pool.query(sql, values);
    inserted += result.rowCount || 0;
    skipped  += chunk.length - (result.rowCount || 0);
    process.stdout.write(`\r  ${Math.min(i + CHUNK, profiles.length)}/${profiles.length} processed...`);
  }

  console.log(`\nDone. Inserted: ${inserted}, Skipped (duplicates): ${skipped}`);
  await pool.end();
}

seed().catch((e) => {
  console.error("Seed error:", e.message);
  process.exit(1);
});