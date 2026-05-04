/**
 * CSV Ingestion Service
 *
 * Streams a CSV upload, validates each row, and batch-inserts
 * valid rows in chunks of 500. Never loads the entire file into memory.
 * A single bad row never fails the entire upload.
 * Rows already inserted on a partial failure are kept — no rollback.
 */

import { Readable }   from "stream";
import { pipeline }   from "stream/promises";
import { Transform }  from "stream";
import { pool }       from "../config/db";
import { invalidateNamespace } from "./cache.service";

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

interface RawRow {
  name?:                string;
  gender?:              string;
  gender_probability?:  string;
  age?:                 string;
  age_group?:           string;
  country_id?:          string;
  country_name?:        string;
  country_probability?: string;
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

// ── Constants ─────────────────────────────────────────────────────────────────

const CHUNK_SIZE    = 500;
const VALID_GENDERS = new Set(["male", "female"]);
const VALID_GROUPS  = new Set(["child", "teenager", "adult", "senior"]);
const REQUIRED      = ["name", "gender", "age", "country_id", "country_name"] as const;

// ── UUID v7 ───────────────────────────────────────────────────────────────────

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

// ── Row Validation ────────────────────────────────────────────────────────────

type ValidationResult =
  | { ok: true;  row: ValidRow }
  | { ok: false; reason: string };

function validateRow(raw: RawRow): ValidationResult {
  // Check required fields
  for (const field of REQUIRED) {
    if (!raw[field]?.trim()) {
      return { ok: false, reason: "missing_fields" };
    }
  }

  const name       = raw.name!.trim();
  const gender     = raw.gender!.trim().toLowerCase();
  const country_id = raw.country_id!.trim().toUpperCase();
  const country_name = raw.country_name!.trim();

  if (!VALID_GENDERS.has(gender)) {
    return { ok: false, reason: "invalid_gender" };
  }

  const age = parseInt(raw.age ?? "", 10);
  if (isNaN(age) || age < 0 || age > 150) {
    return { ok: false, reason: "invalid_age" };
  }

  const gender_probability  = parseFloat(raw.gender_probability  ?? "0.5");
  const country_probability = parseFloat(raw.country_probability ?? "0.5");

  if (isNaN(gender_probability)  || gender_probability  < 0 || gender_probability  > 1) {
    return { ok: false, reason: "invalid_gender_probability" };
  }
  if (isNaN(country_probability) || country_probability < 0 || country_probability > 1) {
    return { ok: false, reason: "invalid_country_probability" };
  }

  // Derive age_group — use provided value if valid, otherwise compute
  const rawGroup    = raw.age_group?.trim().toLowerCase() ?? "";
  const age_group   = VALID_GROUPS.has(rawGroup) ? rawGroup : getAgeGroup(age);

  return {
    ok: true,
    row: {
      id: uuidv7(),
      name,
      gender,
      gender_probability:  Math.round(gender_probability  * 1000) / 1000,
      age,
      age_group,
      country_id,
      country_name,
      country_probability: Math.round(country_probability * 1000) / 1000,
    },
  };
}

// ── Batch Insert ──────────────────────────────────────────────────────────────

async function insertBatch(
  rows: ValidRow[],
  result: IngestionResult
): Promise<void> {
  if (rows.length === 0) return;

  const cols = [
    "id","name","gender","gender_probability",
    "age","age_group","country_id","country_name","country_probability",
  ];

  const placeholders: string[] = [];
  const values:       unknown[] = [];
  let   p = 1;

  for (const row of rows) {
    placeholders.push(`($${p},$${p+1},$${p+2},$${p+3},$${p+4},$${p+5},$${p+6},$${p+7},$${p+8})`);
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

  try {
    const res = await pool.query(sql, values);
    const inserted  = res.rowCount ?? 0;
    const duplicate = rows.length - inserted;

    result.inserted                += inserted;
    result.skipped                 += duplicate;
    result.reasons.duplicate_name  += duplicate;
  } catch (e) {
    // Batch insert failed — count all rows as skipped rather than crashing
    console.error("Batch insert error:", e);
    result.skipped += rows.length;
  }
}

// ── CSV Line Parser ───────────────────────────────────────────────────────────

function parseCSVLine(line: string): string[] {
  const fields: string[] = [];
  let   current          = "";
  let   inQuotes         = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
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

// ── Main Ingestion Function ───────────────────────────────────────────────────

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

  let headers:    string[]   = [];
  let buffer:     ValidRow[] = [];
  let leftover    = "";
  let headerParsed = false;

  // Process stream line by line without loading entire file into memory
  await new Promise<void>((resolve, reject) => {
    stream.on("data", async (chunk: Buffer | string) => {
      const text  = leftover + chunk.toString("utf8");
      const lines = text.split("\n");
      leftover    = lines.pop() ?? ""; // keep incomplete last line

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;

        // First non-empty line is the header
        if (!headerParsed) {
          headers      = parseCSVLine(line).map(h => h.toLowerCase().trim());
          headerParsed = true;
          continue;
        }

        result.total_rows++;

        const fields = parseCSVLine(line);

        // Malformed row — wrong column count
        if (fields.length !== headers.length) {
          result.skipped++;
          result.reasons.malformed_row++;
          continue;
        }

        const raw: RawRow = {};
        headers.forEach((h, i) => { (raw as Record<string, string>)[h] = fields[i]; });

        const validation = validateRow(raw);
        if (!validation.ok) {
          result.skipped++;
          result.reasons[validation.reason] = (result.reasons[validation.reason] ?? 0) + 1;
          continue;
        }

        buffer.push(validation.row);

        // Flush chunk when buffer is full
        if (buffer.length >= CHUNK_SIZE) {
          stream.pause();
          const chunk = buffer.splice(0, CHUNK_SIZE);
          try {
            await insertBatch(chunk, result);
          } finally {
            stream.resume();
          }
        }
      }
    });

    stream.on("end", async () => {
      // Handle final leftover line
      if (leftover.trim() && headerParsed) {
        const line   = leftover.trim();
        const fields = parseCSVLine(line);
        if (fields.length === headers.length) {
          result.total_rows++;
          const raw: RawRow = {};
          headers.forEach((h, i) => { (raw as Record<string,string>)[h] = fields[i]; });
          const validation = validateRow(raw);
          if (validation.ok) {
            buffer.push(validation.row);
          } else {
            result.skipped++;
            result.reasons[validation.reason] = (result.reasons[validation.reason] ?? 0) + 1;
          }
        }
      }

      // Flush remaining buffer
      try {
        await insertBatch(buffer, result);
      } catch (e) {
        console.error("Final batch insert error:", e);
      }

      // Invalidate cache after ingestion
      await invalidateNamespace();

      resolve();
    });

    stream.on("error", reject);
  });

  return result;
}