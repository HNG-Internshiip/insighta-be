import { Request, Response } from "express";
import { pool }                    from "../config/db";
import { parseQuery }              from "../services/nlp.service";
import { createProfileFromName }   from "../services/profile.service";
import type { ProfileFilters, SortField, SortOrder, Pagination, Profile } from "../types";

// ── Query builder (shared) ────────────────────────────────────────────────────
interface QueryBundle {
  countSQL: string; countParams: unknown[];
  dataSQL:  string; dataParams:  unknown[];
}

function buildQuery(
  filters: ProfileFilters, sortBy: SortField,
  sortOrder: SortOrder, pagination: Pagination
): QueryBundle {
  const conds: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  const add = (col: string, op: string, val: unknown) => {
    conds.push(`${col} ${op} $${idx++}`); params.push(val);
  };

  if (filters.gender                  != null) add("gender",              "=",  filters.gender);
  if (filters.age_group               != null) add("age_group",           "=",  filters.age_group);
  if (filters.country_id              != null) add("country_id",          "=",  filters.country_id);
  if (filters.min_age                 != null) add("age",                 ">=", filters.min_age);
  if (filters.max_age                 != null) add("age",                 "<=", filters.max_age);
  if (filters.min_gender_probability  != null) add("gender_probability",  ">=", filters.min_gender_probability);
  if (filters.min_country_probability != null) add("country_probability", ">=", filters.min_country_probability);

  const where      = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  const col        = sortBy === "age" ? "age" : sortBy === "gender_probability" ? "gender_probability" : "created_at";
  const countSQL   = `SELECT COUNT(*)::INT AS total FROM profiles ${where}`;
  const dataSQL    = `
    SELECT id, name, gender, gender_probability, age, age_group,
           country_id, country_name, country_probability,
           to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at
    FROM profiles ${where}
    ORDER BY ${col} ${sortOrder}
    LIMIT $${idx++} OFFSET $${idx}
  `;
  return { countSQL, countParams: [...params],
           dataSQL,  dataParams:  [...params, pagination.limit, pagination.offset] };
}

// ── Pagination links helper ───────────────────────────────────────────────────
function buildLinks(baseUrl: string, page: number, limit: number, total: number) {
  const totalPages = Math.ceil(total / limit);
  const qs = (p: number) => {
    const url = new URL(baseUrl, "http://x");
    url.searchParams.set("page",  String(p));
    url.searchParams.set("limit", String(limit));
    return url.pathname + "?" + url.searchParams.toString();
  };
  return {
    self: qs(page),
    next: page < totalPages ? qs(page + 1) : null,
    prev: page > 1          ? qs(page - 1) : null,
  };
}

function paginatedResponse(
  res: Response, data: Profile[], total: number,
  pagination: Pagination, req: Request
) {
  const totalPages = Math.ceil(total / pagination.limit);
  res.json({
    status:      "success",
    page:        pagination.page,
    limit:       pagination.limit,
    total,
    total_pages: totalPages,
    links:       buildLinks(req.originalUrl, pagination.page, pagination.limit, total),
    data,
  });
}

// ── GET /api/profiles ─────────────────────────────────────────────────────────
export async function getProfiles(req: Request, res: Response): Promise<void> {
  try {
    const { countSQL, countParams, dataSQL, dataParams } =
      buildQuery(req.filters!, req.sortBy!, req.sortOrder!, req.pagination!);

    const [cr, dr] = await Promise.all([
      pool.query<{ total: number }>(countSQL, countParams),
      pool.query<Profile>(dataSQL, dataParams),
    ]);
    paginatedResponse(res, dr.rows, cr.rows[0].total, req.pagination!, req);
  } catch (e) {
    console.error(e);
    res.status(500).json({ status: "error", message: "Internal server error" });
  }
}

// ── GET /api/profiles/search ──────────────────────────────────────────────────
export async function searchProfiles(req: Request, res: Response): Promise<void> {
  try {
    const filters = parseQuery(req.rawQuery!);
    if (!filters) {
      res.status(400).json({ status: "error", message: "Unable to interpret query" });
      return;
    }
    const { countSQL, countParams, dataSQL, dataParams } =
      buildQuery(filters, "created_at", "ASC", req.pagination!);

    const [cr, dr] = await Promise.all([
      pool.query<{ total: number }>(countSQL, countParams),
      pool.query<Profile>(dataSQL, dataParams),
    ]);
    paginatedResponse(res, dr.rows, cr.rows[0].total, req.pagination!, req);
  } catch (e) {
    console.error(e);
    res.status(500).json({ status: "error", message: "Internal server error" });
  }
}

// ── GET /api/profiles/export ──────────────────────────────────────────────────
export async function exportProfiles(req: Request, res: Response): Promise<void> {
  try {
    const { dataSQL, dataParams } =
      buildQuery(req.filters!, req.sortBy!, req.sortOrder!, { page: 1, limit: 100_000, offset: 0 });

    const { rows } = await pool.query<Profile>(dataSQL, dataParams);

    const header = "id,name,gender,gender_probability,age,age_group,country_id,country_name,country_probability,created_at";
    const lines  = rows.map(r =>
      [r.id, r.name, r.gender, r.gender_probability, r.age, r.age_group,
       r.country_id, r.country_name, r.country_probability, r.created_at].join(",")
    );
    const csv = [header, ...lines].join("\n");
    const ts  = new Date().toISOString().replace(/[:.]/g, "-");

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="profiles_${ts}.csv"`);
    res.send(csv);
  } catch (e) {
    console.error(e);
    res.status(500).json({ status: "error", message: "Internal server error" });
  }
}

// ── GET /api/profiles/:id ─────────────────────────────────────────────────────
export async function getProfileById(req: Request, res: Response): Promise<void> {
  try {
    const { rows } = await pool.query<Profile>(
      `SELECT id, name, gender, gender_probability, age, age_group,
              country_id, country_name, country_probability,
              to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at
       FROM profiles WHERE id = $1`,
      [req.params.id]
    );
    if (!rows.length) {
      res.status(404).json({ status: "error", message: "Profile not found" });
      return;
    }
    res.json({ status: "success", data: rows[0] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ status: "error", message: "Internal server error" });
  }
}

// ── POST /api/profiles (admin only) ──────────────────────────────────────────
export async function createProfile(req: Request, res: Response): Promise<void> {
  try {
    const { name } = req.body;
    if (!name?.trim()) {
      res.status(400).json({ status: "error", message: "name is required" });
      return;
    }
    const profile = await createProfileFromName(name);
    res.status(201).json({ status: "success", data: profile });
  } catch (e) {
    console.error(e);
    res.status(500).json({ status: "error", message: "Failed to create profile" });
  }
}

// ── DELETE /api/profiles/:id (admin only) ─────────────────────────────────────
export async function deleteProfile(req: Request, res: Response): Promise<void> {
  try {
    const { rowCount } = await pool.query(
      `DELETE FROM profiles WHERE id = $1`, [req.params.id]
    );
    if (!rowCount) {
      res.status(404).json({ status: "error", message: "Profile not found" });
      return;
    }
    res.json({ status: "success", message: "Profile deleted" });
  } catch (e) {
    console.error(e);
    res.status(500).json({ status: "error", message: "Internal server error" });
  }
}