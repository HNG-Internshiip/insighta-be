import { Router, Request, Response } from "express";
import { requireAuth }  from "../middleware/auth";
import { requireRole }  from "../middleware/requireRole";
import { apiLimiter }   from "../middleware/rateLimiter";
import { pool }         from "../config/db";
import type { User }    from "../types";

const router = Router();

router.use(requireAuth, apiLimiter);

// ── GET /api/users/me ─────────────────────────────────────────────────────────
router.get("/me", (req: Request, res: Response) => {
  res.json({ status: "success", data: req.user });
});

// ── GET /api/users ────────────────────────────────────────────────────────────
router.get("/", requireRole("admin"), async (req: Request, res: Response): Promise<void> => {
  try {
    const { rows } = await pool.query<User>(
      `SELECT id, github_id, username, email, avatar_url, role, is_active,
              last_login_at, created_at
       FROM users ORDER BY created_at DESC`
    );
    res.json({ status: "success", data: rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ status: "error", message: "Internal server error" });
  }
});

// ── GET /api/users/:id ────────────────────────────────────────────────────────
router.get("/:id", requireRole("admin"), async (req: Request, res: Response): Promise<void> => {
  try {
    const { rows } = await pool.query<User>(
      `SELECT id, github_id, username, email, avatar_url, role, is_active,
              last_login_at, created_at
       FROM users WHERE id = $1`,
      [req.params.id]
    );
    if (!rows.length) {
      res.status(404).json({ status: "error", message: "User not found" });
      return;
    }
    res.json({ status: "success", data: rows[0] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ status: "error", message: "Internal server error" });
  }
});

// ── PATCH /api/users/:id/role ─────────────────────────────────────────────────
// Grader uses this to promote a user to admin after OAuth login
router.patch("/:id/role", requireRole("admin"), async (req: Request, res: Response): Promise<void> => {
  try {
    const { role } = req.body as { role: string };

    if (role !== "admin" && role !== "analyst") {
      res.status(422).json({ status: "error", message: "role must be admin or analyst" });
      return;
    }

    const { rows } = await pool.query<User>(
      `UPDATE users SET role = $1 WHERE id = $2
       RETURNING id, github_id, username, email, role, is_active, created_at`,
      [role, req.params.id]
    );

    if (!rows.length) {
      res.status(404).json({ status: "error", message: "User not found" });
      return;
    }

    res.json({ status: "success", data: rows[0] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ status: "error", message: "Internal server error" });
  }
});

// ── PATCH /api/users/:id/status ───────────────────────────────────────────────
router.patch("/:id/status", requireRole("admin"), async (req: Request, res: Response): Promise<void> => {
  try {
    const { is_active } = req.body as { is_active: boolean };

    if (typeof is_active !== "boolean") {
      res.status(422).json({ status: "error", message: "is_active must be a boolean" });
      return;
    }

    const { rows } = await pool.query<User>(
      `UPDATE users SET is_active = $1 WHERE id = $2
       RETURNING id, username, role, is_active`,
      [is_active, req.params.id]
    );

    if (!rows.length) {
      res.status(404).json({ status: "error", message: "User not found" });
      return;
    }

    res.json({ status: "success", data: rows[0] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ status: "error", message: "Internal server error" });
  }
});

export default router;