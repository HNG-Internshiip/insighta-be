import { Request, Response } from "express";
import axios  from "axios";
import crypto from "crypto";
import { pool }                                        from "../config/db";
import { issueTokenPair, rotateRefreshToken,
         revokeRefreshToken, revokeAllForUser }        from "../services/token.service";
import type { User } from "../types";

const GH_CLIENT_ID     = process.env.GITHUB_CLIENT_ID!;
const GH_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET!;
const FRONTEND_URL     = process.env.FRONTEND_URL!;
const BACKEND_URL      = process.env.BACKEND_URL!;

// In-memory PKCE state store (short-lived, good enough for single instance)
// For multi-instance deployments, move to Redis/DB
const pkceStore = new Map<string, { code_challenge: string; from: "cli" | "web" }>();

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

// ── GET /auth/github ──────────────────────────────────────────────────────────
export function githubRedirect(req: Request, res: Response): void {
  const code_challenge = (req.query.code_challenge as string) || "";
  const from           = (req.query.from as string) === "cli" ? "cli" : "web";

  // CLI passes its own state so it can verify the callback matches
  // Web gets a backend-generated state
  const state = (req.query.state as string) || crypto.randomBytes(16).toString("hex");

  pkceStore.set(state, { code_challenge, from });
  setTimeout(() => pkceStore.delete(state), 10 * 60 * 1000);

  const params = new URLSearchParams({
    client_id:    GH_CLIENT_ID,
    redirect_uri: `${BACKEND_URL}/auth/github/callback`,
    scope:        "read:user user:email",
    state,
  });
  res.redirect(`https://github.com/login/oauth/authorize?${params}`);
}

// ── GET /auth/github/callback ─────────────────────────────────────────────────
export async function githubCallback(req: Request, res: Response): Promise<void> {
  const { code, state, code_verifier } = req.query as Record<string, string>;

  const stored = pkceStore.get(state);
  if (!stored) {
    res.status(400).json({ status: "error", message: "Invalid or expired state" });
    return;
  }
  pkceStore.delete(state);

  // PKCE verification (CLI flow)
  if (stored.code_challenge) {
    if (!code_verifier) {
      res.status(400).json({ status: "error", message: "code_verifier required" });
      return;
    }
    const derived = crypto
      .createHash("sha256")
      .update(code_verifier)
      .digest("base64url");
    if (derived !== stored.code_challenge) {
      res.status(400).json({ status: "error", message: "PKCE verification failed" });
      return;
    }
  }

  // Exchange code for GitHub access token
  const tokenRes = await axios.post<{ access_token: string }>(
    "https://github.com/login/oauth/access_token",
    { client_id: GH_CLIENT_ID, client_secret: GH_CLIENT_SECRET, code,
      redirect_uri: `${BACKEND_URL}/auth/github/callback` },
    { headers: { Accept: "application/json" } }
  );
  const ghToken = tokenRes.data.access_token;

  // Fetch GitHub user
  const [userRes, emailRes] = await Promise.all([
    axios.get<{ id: number; login: string; avatar_url: string }>(
      "https://api.github.com/user",
      { headers: { Authorization: `Bearer ${ghToken}` } }
    ),
    axios.get<{ email: string; primary: boolean; verified: boolean }[]>(
      "https://api.github.com/user/emails",
      { headers: { Authorization: `Bearer ${ghToken}` } }
    ).catch(() => ({ data: [] })),
  ]);

  const gh        = userRes.data;
  const primary   = emailRes.data.find((e) => e.primary && e.verified);
  const email     = primary?.email ?? null;

  // Upsert user
  const { rows } = await pool.query<User>(
    `INSERT INTO users (id, github_id, username, email, avatar_url)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (github_id) DO UPDATE SET
       username      = EXCLUDED.username,
       email         = COALESCE(EXCLUDED.email, users.email),
       avatar_url    = EXCLUDED.avatar_url,
       last_login_at = NOW()
     RETURNING *`,
    [uuidv7(), String(gh.id), gh.login, email, gh.avatar_url]
  );
  const user = rows[0];

  if (!user.is_active) {
    res.status(403).json({ status: "error", message: "Account disabled" });
    return;
  }

  const { access_token, refresh_token } = await issueTokenPair(user);

  if (stored.from === "cli") {
    // CLI: return tokens as JSON (CLI local server will capture this)
    res.json({ status: "success", access_token, refresh_token,
               username: user.username, role: user.role });
    return;
  }

  // Web: set HTTP-only cookies
  const isProd = process.env.NODE_ENV === "production";
  res.cookie("access_token",  access_token,  {
    httpOnly: true, secure: isProd, sameSite: "lax", maxAge: 3 * 60 * 1000,
  });
  res.cookie("refresh_token", refresh_token, {
    httpOnly: true, secure: isProd, sameSite: "lax", maxAge: 5 * 60 * 1000,
  });
  res.redirect(`${FRONTEND_URL}/dashboard`);
}

// ── POST /auth/refresh ────────────────────────────────────────────────────────
export async function refresh(req: Request, res: Response): Promise<void> {
  // Accept token from body (CLI) or cookie (web)
  const raw = req.body?.refresh_token || req.cookies?.refresh_token;

  if (!raw) {
    res.status(400).json({ status: "error", message: "refresh_token required" });
    return;
  }

  const result = await rotateRefreshToken(raw);
  if (!result) {
    res.status(401).json({ status: "error", message: "Invalid or expired refresh token" });
    return;
  }

  const isProd = process.env.NODE_ENV === "production";
  // Web: update cookies
  res.cookie("access_token",  result.access_token,  {
    httpOnly: true, secure: isProd, sameSite: "lax", maxAge: 3 * 60 * 1000,
  });
  res.cookie("refresh_token", result.refresh_token, {
    httpOnly: true, secure: isProd, sameSite: "lax", maxAge: 5 * 60 * 1000,
  });

  res.json({
    status:        "success",
    access_token:  result.access_token,
    refresh_token: result.refresh_token,
  });
}

// ── POST /auth/logout ─────────────────────────────────────────────────────────
export async function logout(req: Request, res: Response): Promise<void> {
  const raw = req.body?.refresh_token || req.cookies?.refresh_token;
  if (raw) await revokeRefreshToken(raw);

  res.clearCookie("access_token");
  res.clearCookie("refresh_token");
  res.json({ status: "success", message: "Logged out" });
}

// ── GET /auth/me ──────────────────────────────────────────────────────────────
export function me(req: Request, res: Response): void {
  res.json({ status: "success", data: req.user });
}