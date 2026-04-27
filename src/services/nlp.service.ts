import type { ProfileFilters, AgeGroup } from "../types";

// ── Country lookup ────────────────────────────────────────────────────────────
const COUNTRY_MAP: Record<string, string> = {
  nigeria: "NG",          nigerian: "NG",
  benin: "BJ",            beninese: "BJ",
  ghana: "GH",            ghanaian: "GH",
  kenya: "KE",            kenyan: "KE",
  angola: "AO",           angolan: "AO",
  ethiopia: "ET",         ethiopian: "ET",
  cameroon: "CM",         cameroonian: "CM",
  senegal: "SN",          senegalese: "SN",
  tanzania: "TZ",         tanzanian: "TZ",
  uganda: "UG",           ugandan: "UG",
  "south africa": "ZA",   "south african": "ZA",
  egypt: "EG",            egyptian: "EG",
  morocco: "MA",          moroccan: "MA",
  zimbabwe: "ZW",         zimbabwean: "ZW",
  zambia: "ZM",           zambian: "ZM",
  rwanda: "RW",           rwandan: "RW",
  togo: "TG",             togolese: "TG",
  mali: "ML",             malian: "ML",
  niger: "NE",            nigerien: "NE",
  "ivory coast": "CI",    "cote d'ivoire": "CI", ivorian: "CI",
  mozambique: "MZ",       mozambican: "MZ",
  madagascar: "MG",       malagasy: "MG",
  malawi: "MW",           malawian: "MW",
  "burkina faso": "BF",   burkina: "BF",         burkinabe: "BF",
  chad: "TD",             chadian: "TD",
  liberia: "LR",          liberian: "LR",
  "sierra leone": "SL",   sierra: "SL",
  guinea: "GN",           guinean: "GN",
  "equatorial guinea": "GQ",
  "guinea-bissau": "GW",
  gambia: "GM",           gambian: "GM",
  gabon: "GA",            gabonese: "GA",
  congo: "CG",            congolese: "CG",
  "democratic republic of congo": "CD", "dr congo": "CD", drc: "CD",
  sudan: "SD",            sudanese: "SD",
  somalia: "SO",          somali: "SO",
  eritrea: "ER",          eritrean: "ER",
  djibouti: "DJ",         djiboutian: "DJ",
  burundi: "BI",          burundian: "BI",
  comoros: "KM",          comorian: "KM",
  namibia: "NA",          namibian: "NA",
  botswana: "BW",         batswana: "BW",
  lesotho: "LS",          basotho: "LS",
  eswatini: "SZ",         swaziland: "SZ",       swazi: "SZ",
  mauritius: "MU",        mauritian: "MU",
  seychelles: "SC",       seychellois: "SC",
  "cape verde": "CV",     "cabo verde": "CV",    cape: "CV",
  "central african republic": "CF", "central african": "CF",
  "sao tome": "ST",       "são tomé": "ST",
};

const GENDER_MALE   = new Set(["male","man","men","boy","boys","males"]);
const GENDER_FEMALE = new Set(["female","woman","women","girl","girls","females"]);

const AGE_GROUP_KEYWORDS: Record<string, AgeGroup> = {
  child: "child",    children: "child",
  teenager: "teenager", teenagers: "teenager", teen: "teenager", teens: "teenager",
  adult: "adult",    adults: "adult",
  senior: "senior",  seniors: "senior",  elderly: "senior",  old: "senior",
};

const YOUNG_MIN = 16;
const YOUNG_MAX = 24;

export function parseQuery(q: string): ProfileFilters | null {
  if (!q?.trim()) return null;

  const lower   = q.trim().toLowerCase();
  const filters: ProfileFilters = {};

  // ── Pass 1: Gender ──────────────────────────────────────────────────────
  const tokens = lower.split(/\s+/);
  for (const t of tokens) {
    if (GENDER_MALE.has(t))   { filters.gender = "male";   break; }
    if (GENDER_FEMALE.has(t)) { filters.gender = "female"; break; }
  }

  if (/\b(male\s+and\s+female|female\s+and\s+male|both\s+genders?)\b/.test(lower)) {
    delete filters.gender;
  }

  // ── Pass 2: Age keywords ────────────────────────────────────────────────
  if (/\byoung\b/.test(lower)) {
    filters.min_age = YOUNG_MIN;
    filters.max_age = YOUNG_MAX;
  }

  for (const [kw, group] of Object.entries(AGE_GROUP_KEYWORDS)) {
    if (new RegExp(`\\b${kw}\\b`).test(lower)) {
      filters.age_group = group;
      if (filters.min_age == null && filters.max_age == null) {
        switch (group) {
          case "child":    filters.max_age = 12; break;
          case "teenager": filters.min_age = 13; filters.max_age = 19; break;
          case "adult":    filters.min_age = 18; filters.max_age = 59; break;
          case "senior":   filters.min_age = 60; break;
        }
      }
      break;
    }
  }

  // ── Pass 3: Numeric thresholds ──────────────────────────────────────────
  const between = lower.match(/\bbetween\s+(\d+)\s+and\s+(\d+)\b/);
  if (between) {
    filters.min_age = parseInt(between[1], 10);
    filters.max_age = parseInt(between[2], 10);
  }

  const above = lower.match(/\b(?:above|older\s+than)\s+(\d+)\b/);
  if (above) filters.min_age = parseInt(above[1], 10);

  const over = lower.match(/\bover\s+(\d+)\b/);
  if (over) filters.min_age = parseInt(over[1], 10) + 1;

  const below = lower.match(/\b(?:below|younger\s+than)\s+(\d+)\b/);
  if (below) filters.max_age = parseInt(below[1], 10);

  const under = lower.match(/\bunder\s+(\d+)\b/);
  if (under) filters.max_age = parseInt(under[1], 10) - 1;

  const aged = lower.match(/\b(?:aged?)\s+(\d+)\b/);
  if (aged) {
    const n = parseInt(aged[1], 10);
    filters.min_age = n;
    filters.max_age = n;
  }

  // ── Pass 4: Country (longest-match first) ──────────────────────────────
  const words = lower.split(/\s+/);
  outer: for (let len = 4; len >= 1; len--) {
    for (let i = 0; i <= words.length - len; i++) {
      const phrase = words.slice(i, i + len).join(" ");
      if (COUNTRY_MAP[phrase]) {
        filters.country_id = COUNTRY_MAP[phrase];
        break outer;
      }
    }
  }

  return Object.keys(filters).length > 0 ? filters : null;
}