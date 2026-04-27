"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.issueAccessToken = issueAccessToken;
exports.issueRefreshToken = issueRefreshToken;
exports.issueTokenPair = issueTokenPair;
exports.verifyAccessToken = verifyAccessToken;
exports.rotateRefreshToken = rotateRefreshToken;
exports.revokeRefreshToken = revokeRefreshToken;
exports.revokeAllForUser = revokeAllForUser;
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const crypto_1 = __importDefault(require("crypto"));
const db_1 = require("../config/db");
const ACCESS_SECRET = process.env.JWT_ACCESS_SECRET;
const REFRESH_SECRET = process.env.JWT_REFRESH_SECRET;
const ACCESS_TTL = "3m";
const REFRESH_TTL = "5m";
const REFRESH_TTL_MS = 5 * 60 * 1000;
// ── Issue ─────────────────────────────────────────────────────────────────────
function issueAccessToken(user) {
    const payload = {
        sub: user.id, username: user.username, role: user.role, type: "access",
    };
    return jsonwebtoken_1.default.sign(payload, ACCESS_SECRET, { expiresIn: ACCESS_TTL });
}
async function issueRefreshToken(user) {
    const raw = crypto_1.default.randomBytes(48).toString("hex");
    const hash = crypto_1.default.createHash("sha256").update(raw).digest("hex");
    const exp = new Date(Date.now() + REFRESH_TTL_MS);
    const id = uuidv7();
    await db_1.pool.query(`INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at)
     VALUES ($1, $2, $3, $4)`, [id, user.id, hash, exp]);
    return raw;
}
async function issueTokenPair(user) {
    const access = issueAccessToken(user);
    const refresh = await issueRefreshToken(user);
    return { access_token: access, refresh_token: refresh };
}
// ── Verify ────────────────────────────────────────────────────────────────────
function verifyAccessToken(token) {
    return jsonwebtoken_1.default.verify(token, ACCESS_SECRET);
}
// ── Refresh ───────────────────────────────────────────────────────────────────
async function rotateRefreshToken(raw) {
    const hash = crypto_1.default.createHash("sha256").update(raw).digest("hex");
    const { rows } = await db_1.pool.query(`DELETE FROM refresh_tokens
     WHERE token_hash = $1
     RETURNING user_id, expires_at`, [hash]);
    if (!rows.length)
        return null;
    if (new Date() > rows[0].expires_at)
        return null;
    const { rows: users } = await db_1.pool.query(`SELECT * FROM users WHERE id = $1`, [rows[0].user_id]);
    if (!users.length || !users[0].is_active)
        return null;
    const tokens = await issueTokenPair(users[0]);
    return { ...tokens, user: users[0] };
}
// ── Revoke ────────────────────────────────────────────────────────────────────
async function revokeRefreshToken(raw) {
    const hash = crypto_1.default.createHash("sha256").update(raw).digest("hex");
    await db_1.pool.query(`DELETE FROM refresh_tokens WHERE token_hash = $1`, [hash]);
}
async function revokeAllForUser(userId) {
    await db_1.pool.query(`DELETE FROM refresh_tokens WHERE user_id = $1`, [userId]);
}
// ── UUID v7 ───────────────────────────────────────────────────────────────────
function uuidv7() {
    const ms = BigInt(Date.now());
    const rnd = BigInt(Math.floor(Math.random() * 0xfff));
    const hi = ((ms << 16n) | (rnd & 0xfffn)).toString(16).padStart(16, "0");
    const lo = BigInt(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER))
        .toString(16).padStart(16, "0");
    const hex = hi + lo;
    return [
        hex.slice(0, 8), hex.slice(8, 12),
        "7" + hex.slice(13, 16),
        ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16) + hex.slice(17, 20),
        hex.slice(20, 32),
    ].join("-");
}
