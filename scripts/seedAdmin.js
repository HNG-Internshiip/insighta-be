"use strict";
/**
 * Seeds a test admin + analyst user and prints their tokens.
 * Run once before submitting:
 *   DATABASE_URL=... JWT_ACCESS_SECRET=... JWT_REFRESH_SECRET=... node scripts/seedAdmin.js
 */
require("dotenv").config();
const { Pool }  = require("pg");
const jwt       = require("jsonwebtoken");
const crypto    = require("crypto");

function uuidv7() {
  const ms  = BigInt(Date.now());
  const rnd = BigInt(Math.floor(Math.random() * 0xfff));
  const hi  = ((ms << 16n) | (rnd & 0xfffn)).toString(16).padStart(16, "0");
  const lo  = BigInt(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER))
    .toString(16).padStart(16, "0");
  const hex = hi + lo;
  return [
    hex.slice(0, 8), hex.slice(8, 12),
    "7" + hex.slice(13, 16),
    ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16) + hex.slice(17, 20),
    hex.slice(20, 32),
  ].join("-");
}

async function run() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
  });

  // Ensure users + refresh_tokens tables exist
  await pool.query(`
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
  `);

  const users = [
    { github_id: "test_admin_github",   username: "test_admin",   role: "admin"   },
    { github_id: "test_analyst_github", username: "test_analyst", role: "analyst" },
  ];

  for (const u of users) {
    const id = uuidv7();
    const { rows } = await pool.query(
      `INSERT INTO users (id, github_id, username, email, role, is_active)
       VALUES ($1, $2, $3, $4, $5, true)
       ON CONFLICT (github_id) DO UPDATE SET
         role      = EXCLUDED.role,
         is_active = true
       RETURNING *`,
      [id, u.github_id, u.username, `${u.username}@test.com`, u.role]
    );
    const user = rows[0];

    // Issue access token (JWT)
    const access_token = jwt.sign(
      { sub: user.id, username: user.username, role: user.role, type: "access" },
      process.env.JWT_ACCESS_SECRET,
      { expiresIn: "24h" }  // long expiry for grading purposes
    );

    // Issue refresh token
    const raw  = crypto.randomBytes(48).toString("hex");
    const hash = crypto.createHash("sha256").update(raw).digest("hex");
    const exp  = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h

    await pool.query(
      `INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (token_hash) DO NOTHING`,
      [uuidv7(), user.id, hash, exp]
    );

    console.log(`\n--- ${u.role.toUpperCase()} ---`);
    console.log(`username:      ${user.username}`);
    console.log(`access_token:  ${access_token}`);
    if (u.role === "admin") {
      console.log(`refresh_token: ${raw}`);
    }
  }

  await pool.end();
  console.log("\nDone. Paste these tokens into the /submit form.");
}

run().catch(e => { console.error(e); process.exit(1); });