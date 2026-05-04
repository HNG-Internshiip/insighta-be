import { Request, Response }           from "express";
import { pool }                         from "../config/db";
import { parseQuery }                   from "../services/nlp.service";
import { createProfileFromName }        from "../services/profile.service";
import { normalizeFilters, buildCacheKey } from "../services/queryNormalizer";
import { getCache, setCache }           from "../services/cache.service";
import type {
  ProfileFilters, SortField, SortOrder, Pagination, Profile
} from "../types";

// ── Query builder ─────────────────────────────────────────────────────────────

interface QueryBundle {
  countSQL:    string;
  countParams: unknown[];
  dataSQL:     string;
  dataParams:  unknown[];
}

function buildQuery(
  filters:    ProfileFilters,
  sortBy:     SortField,
  sortOrder:  SortOrder,
  pagination: Pagination,
): QueryBundle {
  const conds:  string[]  = [];
  const params: unknown[] = [];
  let   idx = 1;

  const add = (col: string, op: string, val: unknown) => {
    conds.push(`${col} ${op} $${idx++}`);
    params.push(val);
  };

  if (filters.gender                  != null) add("gender",              "=",  filters.gender);
  if (filters.age_group               != null) add("age_group",           "=",  filters.age_group);
  if (filters.country_id              != null) add("country_id",          "=",  filters.country_id);
  if (filters.min_age                 != null) add("age",                 ">=", filters.min_age);
  if (filters.max_age                 != null) add("age",                 "<=", filters.max_age);
  if (filters.min_gender_probability  != null) add("gender_probability",  ">=", filters.min_gender_probability);
  if (filters.min_country_probability != null) add("country_probability", ">=", filters.min_country_probability);

  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  const col   = sortBy === "age" ? "age"
              : sortBy === "gender_probability" ? "gender_probability"
              : "created_at";

  const countSQL  = `SELECT COUNT(*)::INT AS total FROM profiles ${where}`;
  const dataSQL   = `
    SELECT
      id, name, gender, gender_probability,
      age, age_group, country_id, country_name, country_probability,
      to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at
    FROM profiles
    ${where}
    ORDER BY ${col} ${sortOrder}
    LIMIT $${idx++} OFFSET $${idx}
  `;

  return {
    countSQL,
    countParams: [...params],
    dataSQL,
    dataParams:  [...params, pagination.limit, pagination.offset],
  };
}

// ── Pagination links ──────────────────────────────────────────────────────────

function buildLinks(url: string, page: number, limit: number, total: number) {
  const totalPages = Math.ceil(total / limit);
  const qs = (p: number) => {
    const u = new URL(url, "http://x");
    u.searchParams.set("page",  String(p));
    u.searchParams.set("limit", String(limit));
    return u.pathname + "?" + u.searchParams.toString();
  };
  return {
    self: qs(page),
    next: page < totalPages ? qs(page + 1) : null,
    prev: page > 1          ? qs(page - 1) : null,
  };
}

// ── Shared execute + cache handler ────────────────────────────────────────────

async function executeQuery(
  filters:    ProfileFilters,
  sortBy:     SortField,
  sortOrder:  SortOrder,
  pagination: Pagination,
  req:        Request,
  res:        Response,
): Promise<void> {
  // 1. Normalize filters for consistent cache keys
  const normalized = normalizeFilters(filters);

  // 2. Build cache key
  const cacheKey = buildCacheKey({ filters: normalized, sortBy, sortOrder, ...pagination });

  // 3. Check cache
  const cached = await getCache(cacheKey);
  if (cached) {
    res.setHeader("X-Cache", "HIT");
    res.json(JSON.parse(cached));
    return;
  }

  // 4. Execute SQL
  const { countSQL, countParams, dataSQL, dataParams } =
    buildQuery(normalized, sortBy, sortOrder, pagination);

  const [cr, dr] = await Promise.all([
    pool.query<{ total: number }>(countSQL, countParams),
    pool.query<Profile>(dataSQL, dataParams),
  ]);

  const total      = cr.rows[0].total;
  const totalPages = Math.ceil(total / pagination.limit);

  const body = {
    status:      "success",
    page:        pagination.page,
    limit:       pagination.limit,
    total,
    total_pages: totalPages,
    links:       buildLinks(req.originalUrl, pagination.page, pagination.limit, total),
    data:        dr.rows,
  };

  // 5. Store in cache
  await setCache(cacheKey, JSON.stringify(body));

  res.setHeader("X-Cache", "MISS");
  res.json(body);
}

// ── GET /api/profiles ─────────────────────────────────────────────────────────

export async function getProfiles(req: Request, res: Response): Promise<void> {
  try {
    await executeQuery(
      req.filters!,
      req.sortBy!,
      req.sortOrder!,
      req.pagination!,
      req, res,
    );
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
    await executeQuery(filters, "created_at", "ASC", req.pagination!, req, res);
  } catch (e) {
    console.error(e);
    res.status(500).json({ status: "error", message: "Internal server error" });
  }
}

// ── GET /api/profiles/export ──────────────────────────────────────────────────

export async function exportProfiles(req: Request, res: Response): Promise<void> {
  try {
    // Exports always bypass cache — analysts expect fresh data
    const normalized = normalizeFilters(req.filters!);
    const { dataSQL, dataParams } = buildQuery(
      normalized, req.sortBy!, req.sortOrder!,
      { page: 1, limit: 100_000, offset: 0 }
    );

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

// ── POST /api/profiles ────────────────────────────────────────────────────────

export async function createProfile(req: Request, res: Response): Promise<void> {
  try {
    const { name } = req.body as { name?: string };
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

// ── DELETE /api/profiles/:id ──────────────────────────────────────────────────

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