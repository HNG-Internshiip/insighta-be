import { Request, Response, NextFunction } from "express";
import { verifyAccessToken } from "../services/token.service";
import { pool }              from "../config/db";
import type { User }         from "../types";

export async function requireAuth(
  req: Request, res: Response, next: NextFunction
): Promise<void> {
  try {
    // Support both Bearer token (CLI) and HTTP-only cookie (web)
    let token: string | undefined;

    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith("Bearer ")) {
      token = authHeader.slice(7);
    } else if (req.cookies?.access_token) {
      token = req.cookies.access_token;
    }

    if (!token) {
      res.status(401).json({ status: "error", message: "Authentication required" });
      return;
    }

    const payload = verifyAccessToken(token);
    if (payload.type !== "access") {
      res.status(401).json({ status: "error", message: "Invalid token type" });
      return;
    }

    const { rows } = await pool.query<User>(
      `SELECT * FROM users WHERE id = $1`, [payload.sub]
    );

    if (!rows.length) {
      res.status(401).json({ status: "error", message: "User not found" });
      return;
    }

    if (!rows[0].is_active) {
      res.status(403).json({ status: "error", message: "Account disabled" });
      return;
    }

    req.user = rows[0];
    next();
  } catch {
    res.status(401).json({ status: "error", message: "Invalid or expired token" });
  }
}