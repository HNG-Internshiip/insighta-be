/**
 * CSV Ingestion Service — Optimized for large files (up to 500k rows)
 *
 * Architecture:
 * - Line-by-line streaming via async generator (no memory spike)
 * - Rows validated as they arrive
 * - Valid rows accumulated into batches of 2,000
 * - Up to 5 batches inserted concurrently (parallel DB round-trips)
 * - Bad rows never abort the upload
 * - No rollback — already-inserted rows are kept on failure
 *
 * Why concurrent inserts:
 * Sequential inserts at 20ms/batch × 250 batches (500k/2000) = 5 seconds minimum.
 * 5 concurrent inserts reduce wall-clock time to ~1 second for the DB portion.
 */

import { Readable }            from "stream";
import { pool }                from "../config/db";
import { invalidateNamespace } from "./cache.service";

// ── Constants ─────────────────────────────────────────────────────────────────

const BATCH_SIZE    = 2000;  // rows per INSERT statement
const CONCURRENCY   = 5;     // parallel INSERT statements in flight

// ── Types ─────────────────────────────────────────────────────────────────────

export interface IngestionResult {
  total_rows: number;
  inserted:   number;
  skipped:    number;
  reasons: {
    duplicate_name:  number;
    invalid_age:     number;
    missing_fields:  number;
    invalid_gender:  number;
    malformed_row:   number;
    [key: string]:   number;
  };
}

interface ValidRow {
  id:                  string;
  name:                string;
  gender:              string;
  gender_probability:  number;
  age:                 number;
  age_group:           string;
  country_id:          string;
  country_name:        string;
  country_probability: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const VALID_GENDERS = new Set(["male", "female"]);
const VALID_GROUPS  = new Set(["child", "teenager", "adult", "senior"]);
const REQUIRED      = ["name", "gender", "age", "country_id", "country_name"] as const;

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

function getAgeGroup(age: number): string {
  if (age <= 12) return "child";
  if (age <= 19) return "teenager";
  if (age <= 59) return "adult";
  return "senior";
}

function parseCSVLine(line: string): string[] {
  const fields: string[] = [];
  let   current = "";
  let   inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === "," && !inQuotes) {
      fields.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current.trim());
  return fields;
}

type ValidationResult =
  | { ok: true;  row: ValidRow }
  | { ok: false; reason: string };

function validateRow(
  headers: string[],
  fields:  string[],
): ValidationResult {
  if (fields.length !== headers.length) {
    return { ok: false, reason: "malformed_row" };
  }

  const cell: Record<string, string> = {};
  headers.forEach((h, i) => { cell[h] = fields[i] ?? ""; });

  for (const f of REQUIRED) {
    if (!cell[f]?.trim()) return { ok: false, reason: "missing_fields" };
  }

  const name        = cell.name.trim();
  const gender      = cell.gender.trim().toLowerCase();
  const country_id  = cell.country_id.trim().toUpperCase();
  const country_name= cell.country_name.trim();

  if (!VALID_GENDERS.has(gender))     return { ok: false, reason: "invalid_gender" };

  const age = parseInt(cell.age ?? "", 10);
  if (isNaN(age) || age < 0 || age > 150) return { ok: false, reason: "invalid_age" };

  const gp = parseFloat(cell.gender_probability  ?? "0.5");
  const cp = parseFloat(cell.country_probability ?? "0.5");
  if (isNaN(gp) || gp < 0 || gp > 1) return { ok: false, reason: "invalid_gender_probability" };
  if (isNaN(cp) || cp < 0 || cp > 1) return { ok: false, reason: "invalid_country_probability" };

  const rawGroup = cell.age_group?.trim().toLowerCase() ?? "";
  const age_group = VALID_GROUPS.has(rawGroup) ? rawGroup : getAgeGroup(age);

  return {
    ok: true,
    row: {
      id:                  uuidv7(),
      name,
      gender,
      gender_probability:  Math.round(gp * 1000) / 1000,
      age,
      age_group,
      country_id,
      country_name,
      country_probability: Math.round(cp * 1000) / 1000,
    },
  };
}

// ── Batch Insert ──────────────────────────────────────────────────────────────

async function insertBatch(rows: ValidRow[]): Promise<{ inserted: number; duplicates: number }> {
  if (rows.length === 0) return { inserted: 0, duplicates: 0 };

  const cols = [
    "id","name","gender","gender_probability",
    "age","age_group","country_id","country_name","country_probability",
  ];

  const placeholders: string[] = [];
  const values:       unknown[] = [];
  let   p = 1;

  for (const row of rows) {
    placeholders.push(
      `($${p},$${p+1},$${p+2},$${p+3},$${p+4},$${p+5},$${p+6},$${p+7},$${p+8})`
    );
    values.push(
      row.id, row.name, row.gender, row.gender_probability,
      row.age, row.age_group, row.country_id, row.country_name, row.country_probability
    );
    p += 9;
  }

  const sql = `
    INSERT INTO profiles (${cols.join(",")})
    VALUES ${placeholders.join(",")}
    ON CONFLICT (name) DO NOTHING
  `;

  const res        = await pool.query(sql, values);
  const inserted   = res.rowCount ?? 0;
  const duplicates = rows.length - inserted;
  return { inserted, duplicates };
}

// ── Async line generator — true streaming, no memory spike ───────────────────

async function* readLines(stream: Readable): AsyncGenerator<string> {
  let leftover = "";

  for await (const chunk of stream) {
    const text  = leftover + (chunk as Buffer).toString("utf8");
    const lines = text.split("\n");
    leftover    = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed) yield trimmed;
    }
  }

  if (leftover.trim()) yield leftover.trim();
}

// ── Concurrent batch processor ────────────────────────────────────────────────
// Maintains up to CONCURRENCY insert promises in flight simultaneously.
// When the pool is full, waits for the oldest one to finish before adding more.

async function flushWithConcurrency(
  batches:    ValidRow[][],
  result:     IngestionResult,
): Promise<void> {
  const inFlight: Promise<void>[] = [];

  for (const batch of batches) {
    const p = insertBatch(batch).then(({ inserted, duplicates }) => {
      result.inserted               += inserted;
      result.skipped                += duplicates;
      result.reasons.duplicate_name += duplicates;
    }).catch((e) => {
      console.error("Batch insert error:", e);
      result.skipped += batch.length;
    });

    inFlight.push(p);

    if (inFlight.length >= CONCURRENCY) {
      // Wait for the oldest batch before queuing more
      await inFlight.shift();
    }
  }

  // Drain remaining in-flight batches
  await Promise.all(inFlight);
}

// ── Main ingestion function ───────────────────────────────────────────────────

export async function ingestCSV(stream: Readable): Promise<IngestionResult> {
  const result: IngestionResult = {
    total_rows: 0,
    inserted:   0,
    skipped:    0,
    reasons: {
      duplicate_name:  0,
      invalid_age:     0,
      missing_fields:  0,
      invalid_gender:  0,
      malformed_row:   0,
    },
  };

  let headers:      string[]    = [];
  let headerParsed              = false;
  let validBuffer:  ValidRow[]  = [];
  const pendingBatches: ValidRow[][] = [];

  for await (const line of readLines(stream)) {
    if (!headerParsed) {
      headers      = parseCSVLine(line).map(h => h.toLowerCase().trim());
      headerParsed = true;
      continue;
    }

    result.total_rows++;

    const fields     = parseCSVLine(line);
    const validation = validateRow(headers, fields);

    if (!validation.ok) {
      result.skipped++;
      result.reasons[validation.reason] = (result.reasons[validation.reason] ?? 0) + 1;
      continue;
    }

    validBuffer.push(validation.row);

    if (validBuffer.length >= BATCH_SIZE) {
      pendingBatches.push(validBuffer.splice(0, BATCH_SIZE));

      // Flush when we have accumulated enough batches to fill the concurrency pool
      if (pendingBatches.length >= CONCURRENCY) {
        await flushWithConcurrency(pendingBatches.splice(0, CONCURRENCY), result);
      }
    }
  }

  // Push any remaining rows as a final batch
  if (validBuffer.length > 0) {
    pendingBatches.push(validBuffer);
  }

  // Flush all remaining batches
  if (pendingBatches.length > 0) {
    await flushWithConcurrency(pendingBatches, result);
  }

  // Invalidate query cache after ingestion
  await invalidateNamespace();

  return result;
}