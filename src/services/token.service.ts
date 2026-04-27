import jwt            from "jsonwebtoken";
import crypto          from "crypto";
import { pool }        from "../config/db";
import type { User, TokenPayload, Role } from "../types";

const ACCESS_SECRET  = process.env.JWT_ACCESS_SECRET!;
const REFRESH_SECRET = process.env.JWT_REFRESH_SECRET!;
const ACCESS_TTL     = "3m";
const REFRESH_TTL    = "5m";
const REFRESH_TTL_MS = 5 * 60 * 1000;

// ── Issue ─────────────────────────────────────────────────────────────────────
export function issueAccessToken(user: User): string {
  const payload: Omit<TokenPayload, "type"> & { type: "access" } = {
    sub: user.id, username: user.username, role: user.role, type: "access",
  };
  return jwt.sign(payload, ACCESS_SECRET, { expiresIn: ACCESS_TTL });
}

export async function issueRefreshToken(user: User): Promise<string> {
  const raw  = crypto.randomBytes(48).toString("hex");
  const hash = crypto.createHash("sha256").update(raw).digest("hex");
  const exp  = new Date(Date.now() + REFRESH_TTL_MS);
  const id   = uuidv7();

  await pool.query(
    `INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [id, user.id, hash, exp]
  );
  return raw;
}

export async function issueTokenPair(user: User) {
  const access  = issueAccessToken(user);
  const refresh = await issueRefreshToken(user);
  return { access_token: access, refresh_token: refresh };
}

// ── Verify ────────────────────────────────────────────────────────────────────
export function verifyAccessToken(token: string): TokenPayload {
  return jwt.verify(token, ACCESS_SECRET) as TokenPayload;
}

// ── Refresh ───────────────────────────────────────────────────────────────────
export async function rotateRefreshToken(
  raw: string
): Promise<{ access_token: string; refresh_token: string; user: User } | null> {
  const hash = crypto.createHash("sha256").update(raw).digest("hex");

  const { rows } = await pool.query<{ user_id: string; expires_at: Date }>(
    `DELETE FROM refresh_tokens
     WHERE token_hash = $1
     RETURNING user_id, expires_at`,
    [hash]
  );

  if (!rows.length) return null;
  if (new Date() > rows[0].expires_at) return null;

  const { rows: users } = await pool.query<User>(
    `SELECT * FROM users WHERE id = $1`, [rows[0].user_id]
  );
  if (!users.length || !users[0].is_active) return null;

  const tokens = await issueTokenPair(users[0]);
  return { ...tokens, user: users[0] };
}

// ── Revoke ────────────────────────────────────────────────────────────────────
export async function revokeRefreshToken(raw: string): Promise<void> {
  const hash = crypto.createHash("sha256").update(raw).digest("hex");
  await pool.query(`DELETE FROM refresh_tokens WHERE token_hash = $1`, [hash]);
}

export async function revokeAllForUser(userId: string): Promise<void> {
  await pool.query(`DELETE FROM refresh_tokens WHERE user_id = $1`, [userId]);
}

// ── UUID v7 ───────────────────────────────────────────────────────────────────
function uuidv7(): string {
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