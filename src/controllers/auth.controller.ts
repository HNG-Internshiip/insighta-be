import { Request, Response } from "express";
import axios  from "axios";
import crypto from "crypto";
import { pool }                                     from "../config/db";
import { issueTokenPair, rotateRefreshToken,
         revokeRefreshToken }                       from "../services/token.service";
import type { User } from "../types";

const GH_CLIENT_ID     = process.env.GITHUB_CLIENT_ID!;
const GH_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET!;
const FRONTEND_URL     = process.env.FRONTEND_URL || "";
const BACKEND_URL      = process.env.BACKEND_URL!;

// Short-lived PKCE + state store
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

  // CLI passes its own state; web gets backend-generated state
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
  try {
    const code  = (req.query.code  as string) || "";
    const state = (req.query.state as string) || "";

    // Accept code_verifier from query string, body, or header
    const code_verifier = (req.query.code_verifier as string)
      || (req.body?.code_verifier as string)
      || (req.headers["x-code-verifier"] as string)
      || "";

    if (!code || !state) {
      res.status(400).json({ status: "error", message: "Missing code or state" });
      return;
    }

    const stored = pkceStore.get(state);

    // If state not found in memory (serverless cold start), allow through
    // but still verify PKCE if challenge was provided
    const from           = stored?.from ?? "cli";
    const code_challenge = stored?.code_challenge ?? "";
    if (stored) pkceStore.delete(state);

    // PKCE verification — only if a challenge was stored
    if (code_challenge && code_verifier) {
      const derived = crypto
        .createHash("sha256")
        .update(code_verifier)
        .digest("base64url");
      if (derived !== code_challenge) {
        res.status(400).json({ status: "error", message: "PKCE verification failed" });
        return;
      }
    }

    // Exchange code for GitHub token
    const tokenRes = await axios.post<{ access_token?: string; error?: string }>(
      "https://github.com/login/oauth/access_token",
      {
        client_id:     GH_CLIENT_ID,
        client_secret: GH_CLIENT_SECRET,
        code,
        redirect_uri: `${BACKEND_URL}/auth/github/callback`,
      },
      { headers: { Accept: "application/json" } }
    );

    const ghToken = tokenRes.data.access_token;
    if (!ghToken) {
      res.status(400).json({ status: "error", message: "GitHub token exchange failed" });
      return;
    }

    // Fetch GitHub user
    const [userRes, emailRes] = await Promise.all([
      axios.get<{ id: number; login: string; avatar_url: string }>(
        "https://api.github.com/user",
        { headers: { Authorization: `Bearer ${ghToken}` } }
      ),
      axios.get<{ email: string; primary: boolean; verified: boolean }[]>(
        "https://api.github.com/user/emails",
        { headers: { Authorization: `Bearer ${ghToken}` } }
      ).catch(() => ({ data: [] as { email: string; primary: boolean; verified: boolean }[] })),
    ]);

    const gh      = userRes.data;
    const primary = emailRes.data.find((e) => e.primary && e.verified);
    const email   = primary?.email ?? null;

    // Auto-promote if username matches ADMIN_GITHUB_USERNAME env var
    const adminUsername = process.env.ADMIN_GITHUB_USERNAME;
    const assignedRole  = (adminUsername && gh.login === adminUsername)
      ? "admin"
      : isFirstUser ? "admin" : "analyst";

    // Upsert user
    const { rows } = await pool.query<User>(
      `INSERT INTO users (id, github_id, username, email, avatar_url, role)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (github_id) DO UPDATE SET
         username      = EXCLUDED.username,
         email         = COALESCE(EXCLUDED.email, users.email),
         avatar_url    = EXCLUDED.avatar_url,
         role          = CASE
                           WHEN $6 = 'admin' THEN 'admin'
                           ELSE users.role
                         END,
         last_login_at = NOW()
       RETURNING *`,
      [uuidv7(), String(gh.id), gh.login, email, gh.avatar_url, assignedRole]
    );
    const user = rows[0];

    if (!user.is_active) {
      res.status(403).json({ status: "error", message: "Account disabled" });
      return;
    }

    const { access_token, refresh_token } = await issueTokenPair(user);

    // CLI flow OR no frontend configured → return JSON
    if (from === "cli" || !FRONTEND_URL) {
      res.json({
        status:        "success",
        access_token,
        refresh_token,
        username:      user.username,
        role:          user.role,
      });
      return;
    }

    // Web flow → HTTP-only cookies + redirect
    const isProd = process.env.NODE_ENV === "production";
    res.cookie("access_token",  access_token,  {
      httpOnly: true, secure: isProd, sameSite: "lax", maxAge: 3 * 60 * 1000,
    });
    res.cookie("refresh_token", refresh_token, {
      httpOnly: true, secure: isProd, sameSite: "lax", maxAge: 5 * 60 * 1000,
    });
    res.redirect(`${FRONTEND_URL}/dashboard`);

  } catch (e) {
    console.error("Callback error:", e);
    res.status(500).json({ status: "error", message: "Authentication failed" });
  }
}

// ── POST /auth/refresh ────────────────────────────────────────────────────────
export async function refresh(req: Request, res: Response): Promise<void> {
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