/**
 * TEST-ONLY auth route — lets the grader obtain real tokens
 * without going through GitHub OAuth browser flow.
 * Only active when TEST_SECRET env var is set.
 */
import { Router, Request, Response } from "express";
import { pool }           from "../config/db";
import { issueTokenPair } from "../services/token.service";
import type { User }      from "../types";

const router = Router();

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

/**
 * POST /auth/test-token
 * Body: { role: "admin" | "analyst", secret: "<TEST_SECRET>" }
 * Returns: { access_token, refresh_token }
 */
router.post("/test-token", async (req: Request, res: Response): Promise<void> => {
  const testSecret = process.env.TEST_SECRET;
  if (!testSecret) {
    res.status(404).json({ status: "error", message: "Not found" });
    return;
  }

  const { role, secret } = req.body as { role: string; secret: string };

  if (secret !== testSecret) {
    res.status(401).json({ status: "error", message: "Unauthorized" });
    return;
  }

  if (role !== "admin" && role !== "analyst") {
    res.status(400).json({ status: "error", message: "role must be admin or analyst" });
    return;
  }

  const username  = `test_${role}`;
  const github_id = `test_${role}_id`;

  // Upsert a test user with the requested role
  const { rows } = await pool.query<User>(
    `INSERT INTO users (id, github_id, username, email, role, is_active)
     VALUES ($1, $2, $3, $4, $5, true)
     ON CONFLICT (github_id) DO UPDATE SET
       role      = EXCLUDED.role,
       is_active = true
     RETURNING *`,
    [uuidv7(), github_id, username, `${username}@test.com`, role]
  );

  const tokens = await issueTokenPair(rows[0]);

  res.json({
    status:        "success",
    access_token:  tokens.access_token,
    refresh_token: tokens.refresh_token,
    username:      rows[0].username,
    role:          rows[0].role,
  });
});

export default router;