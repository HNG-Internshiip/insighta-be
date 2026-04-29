import { Request, Response, NextFunction } from "express";
import { pool } from "../config/db";

const errorBody = { status: "error", message: "Too many requests, please slow down" };

async function checkRateLimit(
  key: string, max: number, windowMs: number
): Promise<{ limited: boolean; hits: number }> {
  const now        = new Date();
  const windowEnd  = new Date(now.getTime() + windowMs);

  const { rows } = await pool.query<{ hits: number; window_end: Date }>(
    `INSERT INTO rate_limit_hits (key, hits, window_end)
     VALUES ($1, 1, $2)
     ON CONFLICT (key) DO UPDATE SET
       hits       = CASE
                      WHEN rate_limit_hits.window_end < NOW()
                      THEN 1
                      ELSE rate_limit_hits.hits + 1
                    END,
       window_end = CASE
                      WHEN rate_limit_hits.window_end < NOW()
                      THEN $2
                      ELSE rate_limit_hits.window_end
                    END
     RETURNING hits, window_end`,
    [key, windowEnd]
  );

  return { limited: rows[0].hits > max, hits: rows[0].hits };
}

import { Request, Response, NextFunction } from "express";

// ── Auth limiter: 10 req/min per IP ──────────────────────────────────────────
export function authLimiter(req: Request, res: Response, next: NextFunction): void {
  const key = `auth:${req.ip}`;
  checkRateLimit(key, 10, 60_000)
    .then(({ limited }) => {
      if (limited) {
        res.status(429).json(errorBody);
        return;
      }
      next();
    })
    .catch(() => next()); // fail open on DB error
}

// ── API limiter: 60 req/min per user or IP ───────────────────────────────────
export function apiLimiter(req: Request, res: Response, next: NextFunction): void {
  const id  = req.user?.id ?? req.ip ?? "anon";
  const key = `api:${id}`;
  checkRateLimit(key, 60, 60_000)
    .then(({ limited }) => {
      if (limited) {
        res.status(429).json(errorBody);
        return;
      }
      next();
    })
    .catch(() => next());
}