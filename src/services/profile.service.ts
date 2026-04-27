/**
 * Calls external APIs (Genderize, Agify, Nationalize) to enrich a name,
 * then stores and returns the profile — used by POST /api/profiles (admin only).
 */
import axios        from "axios";
import { pool }     from "../config/db";
import type { Profile, AgeGroup } from "../types";

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

function getAgeGroup(age: number): AgeGroup {
  if (age <= 12) return "child";
  if (age <= 19) return "teenager";
  if (age <= 59) return "adult";
  return "senior";
}

interface GenderizeRes  { gender: string; probability: number; }
interface AgifyRes       { age: number; }
interface NationalizeRes { country: { country_id: string; probability: number }[]; }

const COUNTRY_NAMES: Record<string, string> = {
  NG: "Nigeria", KE: "Kenya", GH: "Ghana", ZA: "South Africa",
  AO: "Angola",  ET: "Ethiopia", CM: "Cameroon", SN: "Senegal",
  TZ: "Tanzania", UG: "Uganda",  EG: "Egypt",    MA: "Morocco",
  US: "United States", GB: "United Kingdom", FR: "France",
  DE: "Germany", IN: "India", BR: "Brazil", CA: "Canada", AU: "Australia",
};

export async function createProfileFromName(name: string): Promise<Profile> {
  const firstName = name.trim().split(/\s+/)[0].toLowerCase();

  const [gRes, aRes, nRes] = await Promise.all([
    axios.get<GenderizeRes> (`https://api.genderize.io?name=${firstName}`),
    axios.get<AgifyRes>      (`https://api.agify.io?name=${firstName}`),
    axios.get<NationalizeRes>(`https://api.nationalize.io?name=${firstName}`),
  ]);

  const gender              = gRes.data.gender || "male";
  const gender_probability  = gRes.data.probability || 0.5;
  const age                 = aRes.data.age || 25;
  const age_group           = getAgeGroup(age);
  const topCountry          = nRes.data.country?.[0];
  const country_id          = topCountry?.country_id || "NG";
  const country_probability = topCountry?.probability || 0.5;
  const country_name        = COUNTRY_NAMES[country_id] || country_id;

  const id  = uuidv7();
  const { rows } = await pool.query<Profile>(
    `INSERT INTO profiles
       (id, name, gender, gender_probability, age, age_group,
        country_id, country_name, country_probability)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (name) DO UPDATE SET
       gender             = EXCLUDED.gender,
       gender_probability = EXCLUDED.gender_probability,
       age                = EXCLUDED.age,
       age_group          = EXCLUDED.age_group,
       country_id         = EXCLUDED.country_id,
       country_name       = EXCLUDED.country_name,
       country_probability= EXCLUDED.country_probability
     RETURNING
       id, name, gender, gender_probability, age, age_group,
       country_id, country_name, country_probability,
       to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at`,
    [id, name.trim(), gender, gender_probability, age, age_group,
     country_id, country_name, country_probability]
  );
  return rows[0];
}