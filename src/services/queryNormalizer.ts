/**
 * Query Normalizer
 *
 * Converts a ProfileFilters object into a canonical, deterministic cache key.
 * Two queries expressing the same intent must always produce the same key,
 * regardless of parameter order, casing, or phrasing.
 *
 * Rules:
 * - All keys sorted alphabetically
 * - String values lowercased
 * - Numeric values rounded to integers where appropriate
 * - Undefined/null fields omitted entirely
 * - Pagination (page, limit) and sort params included in key
 * - Output is a stable colon-separated string
 */

import type { ProfileFilters, SortField, SortOrder } from "../types";

export interface NormalizedQuery {
  filters:   ProfileFilters;
  sortBy:    SortField;
  sortOrder: SortOrder;
  page:      number;
  limit:     number;
}

/**
 * Clamps and normalizes numeric filter values.
 * Prevents cache fragmentation from floating point noise (e.g. min_age=25.0 vs 25).
 */
function normalizeNumeric(val: number | undefined): number | undefined {
  if (val == null) return undefined;
  return Math.round(val);
}

/**
 * Normalizes a probability score to 2 decimal places.
 * 0.9499 and 0.95 should not produce different cache keys.
 */
function normalizeProbability(val: number | undefined): number | undefined {
  if (val == null) return undefined;
  return Math.round(val * 100) / 100;
}

/**
 * Builds a canonical cache key from a normalized query object.
 * Format: "profiles:field1=val1:field2=val2:..."
 *
 * Fields are always emitted in alphabetical order.
 * Absent fields are never emitted (no "undefined" in key).
 */
export function buildCacheKey(q: NormalizedQuery): string {
  const f = q.filters;

  // Build ordered field map — always alphabetical
  const fields: Record<string, string | number> = {};

  if (f.age_group               != null) fields["age_group"]               = f.age_group.toLowerCase();
  if (f.country_id              != null) fields["country_id"]               = f.country_id.toUpperCase();
  if (f.gender                  != null) fields["gender"]                   = f.gender.toLowerCase();
  if (f.max_age                 != null) fields["max_age"]                  = normalizeNumeric(f.max_age)!;
  if (f.min_age                 != null) fields["min_age"]                  = normalizeNumeric(f.min_age)!;
  if (f.min_country_probability != null) fields["min_country_probability"]  = normalizeProbability(f.min_country_probability)!;
  if (f.min_gender_probability  != null) fields["min_gender_probability"]   = normalizeProbability(f.min_gender_probability)!;

  // Always include sort and pagination — they affect the result set
  fields["limit"]  = q.limit;
  fields["order"]  = q.sortOrder.toLowerCase();
  fields["page"]   = q.page;
  fields["sort"]   = q.sortBy.toLowerCase();

  const parts = Object.keys(fields)
    .sort()
    .map(k => `${k}=${fields[k]}`);

  return "profiles:" + parts.join(":");
}

/**
 * Normalizes raw filter inputs before cache key generation and SQL execution.
 * Ensures consistent representation regardless of how the user expressed the query.
 */
export function normalizeFilters(filters: ProfileFilters): ProfileFilters {
  const out: ProfileFilters = {};

  if (filters.gender     != null) out.gender     = filters.gender.toLowerCase() as ProfileFilters["gender"];
  if (filters.age_group  != null) out.age_group  = filters.age_group.toLowerCase() as ProfileFilters["age_group"];
  if (filters.country_id != null) out.country_id = filters.country_id.toUpperCase();
  if (filters.min_age    != null) out.min_age    = normalizeNumeric(filters.min_age);
  if (filters.max_age    != null) out.max_age    = normalizeNumeric(filters.max_age);

  // Swap min/max if inverted — user may send min_age=40&max_age=20
  if (out.min_age != null && out.max_age != null && out.min_age > out.max_age) {
    [out.min_age, out.max_age] = [out.max_age, out.min_age];
  }

  if (filters.min_gender_probability  != null) out.min_gender_probability  = normalizeProbability(filters.min_gender_probability);
  if (filters.min_country_probability != null) out.min_country_probability = normalizeProbability(filters.min_country_probability);

  return out;
}