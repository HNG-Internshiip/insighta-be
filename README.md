# Insighta Labs+ — Backend API

A secure, multi-interface demographic intelligence platform built with Node.js, Express, TypeScript, and PostgreSQL.

---

## System Architecture

```
┌─────────────────────────────────────────────────────┐
│                    Clients                          │
│  ┌──────────────┐  ┌──────────┐  ┌──────────────┐  │
│  │  Web Portal  │  │   CLI    │  │  Direct API  │  │
│  │  (React/     │  │ (Node.js │  │   (curl /    │  │
│  │   Netlify)   │  │  global) │  │  any client) │  │
│  └──────┬───────┘  └────┬─────┘  └──────┬───────┘  │
└─────────┼───────────────┼───────────────┼───────────┘
          │               │               │
          └───────────────┴───────────────┘
                          │ HTTPS
                          ▼
          ┌───────────────────────────────┐
          │     Backend API (Netlify      │
          │     Serverless Functions)     │
          │                               │
          │  /auth/*   → auth.routes      │
          │  /api/profiles → profiles     │
          │  /api/users    → users        │
          │                               │
          │  Middleware stack:            │
          │  cors → cookieParser →        │
          │  logger → requireAuth →       │
          │  requireRole → apiVersion →   │
          │  rateLimiter → controller     │
          └──────────────┬────────────────┘
                         │
                         ▼
          ┌───────────────────────────────┐
          │     PostgreSQL (Neon)         │
          │                               │
          │  profiles       (Stage 2)     │
          │  users          (Stage 3)     │
          │  refresh_tokens (Stage 3)     │
          │  rate_limit_hits(Stage 3)     │
          └───────────────────────────────┘
```

Three separate repositories, one shared backend, one database.

---

## Authentication Flow

### GitHub OAuth with PKCE (CLI)

```
1. insighta login
2. CLI generates:
   - state          (random hex, CSRF protection)
   - code_verifier  (random bytes, base64url)
   - code_challenge (SHA-256 of verifier, base64url)
3. CLI starts local HTTP server on random port
4. CLI opens browser:
   GET /auth/github?code_challenge=<ch>&from=cli&state=<state>
5. Backend stores { code_challenge, from:"cli" } in pkceStore[state]
6. Backend redirects to GitHub OAuth with same state
7. User authorizes on GitHub
8. GitHub redirects to:
   GET /auth/github/callback?code=<code>&state=<state>
9. CLI's local server receives the redirect
10. CLI sends code + code_verifier to backend callback
11. Backend:
    a. Looks up pkceStore[state]
    b. Verifies: SHA-256(code_verifier) === code_challenge
    c. Exchanges code with GitHub for access token
    d. Fetches GitHub user profile
    e. Upserts user in DB
    f. Issues access_token (JWT, 3min) + refresh_token (random, 5min, hashed in DB)
    g. Returns tokens as JSON (CLI flow)
12. CLI stores tokens in ~/.insighta/credentials.json
13. Prints: Logged in as @username
```

### GitHub OAuth (Web)

```
1. User clicks "Continue with GitHub"
2. Browser navigates to GET /auth/github?from=web
3. Backend generates state, stores in pkceStore, redirects to GitHub
4. User authorizes
5. GitHub redirects to GET /auth/github/callback?code=&state=
6. Backend processes callback, issues tokens
7. Tokens set as HTTP-only cookies (access_token, refresh_token)
8. Browser redirected to FRONTEND_URL/dashboard
```

---

## Token Handling

| Token | Type | Expiry | Storage (CLI) | Storage (Web) |
|---|---|---|---|---|
| Access token | JWT (signed) | 3 minutes | `~/.insighta/credentials.json` | HTTP-only cookie |
| Refresh token | Random hex (hashed in DB) | 5 minutes | `~/.insighta/credentials.json` | HTTP-only cookie |

**Rotation:** Every refresh call invalidates the old refresh token immediately and issues a new pair. Tokens are never reused.

**Hashing:** Refresh tokens are stored as SHA-256 hashes in the `refresh_tokens` table. The raw token is only ever held by the client.

**Auto-refresh:**
- CLI: axios interceptor catches 401, calls `POST /auth/refresh`, retries original request
- Web: same pattern via axios interceptor, updates cookies silently

**Revocation:** Logout deletes the refresh token from the DB. All tokens for a user can be revoked by deleting all rows for their `user_id`.

---

## Role Enforcement

Two roles: `admin` and `analyst`. Default on signup: `analyst`.

```
Request
  │
  ▼
requireAuth          ← verifies JWT, attaches req.user
  │
  ▼
requireApiVersion    ← checks X-API-Version: 1 header
  │
  ▼
requireRole(...)     ← checks req.user.role
  │
  ├── admin  → always passes
  └── analyst → passes only on read routes
```

### Permissions matrix

| Endpoint | Analyst | Admin |
|---|---|---|
| `GET /api/profiles` | ✅ | ✅ |
| `GET /api/profiles/search` | ✅ | ✅ |
| `GET /api/profiles/export` | ✅ | ✅ |
| `GET /api/profiles/:id` | ✅ | ✅ |
| `POST /api/profiles` | ❌ 403 | ✅ |
| `DELETE /api/profiles/:id` | ❌ 403 | ✅ |
| `GET /api/users/me` | ✅ | ✅ |

**Disabled accounts:** `is_active = false` → 403 on all authenticated routes regardless of role.

---

## CLI Usage

### Installation

```bash
npm install -g insighta-cli
```

### Auth Commands

```bash
insighta login          # GitHub OAuth via browser
insighta logout         # Revoke tokens and clear credentials
insighta whoami         # Show current logged-in user
```

### Profile Commands

```bash
# List with filters
insighta profiles list
insighta profiles list --gender male
insighta profiles list --country NG --age-group adult
insighta profiles list --min-age 25 --max-age 40
insighta profiles list --sort-by age --order desc
insighta profiles list --page 2 --limit 20

# Get single profile
insighta profiles get <uuid>

# Natural language search
insighta profiles search "young males from nigeria"
insighta profiles search "adult females above 30"

# Create profile (admin only)
insighta profiles create --name "Harriet Tubman"

# Export to CSV (saved to current directory)
insighta profiles export --format csv
insighta profiles export --format csv --gender male --country NG
```

### Credentials

Stored at `~/.insighta/credentials.json` after login. Never stored in environment variables or shell history.

---

## Natural Language Parsing

The `/api/profiles/search` endpoint uses a fully rule-based parser — no AI, no external APIs.

### Four-pass architecture

**Pass 1 — Gender:** scans tokens for male/female keywords.
**Pass 2 — Age keywords:** maps `young` (16–24), `child`, `teenager`, `adult`, `senior` to filters.
**Pass 3 — Numeric thresholds:** parses `above N`, `over N`, `below N`, `under N`, `between N and M`.
**Pass 4 — Country:** longest-match lookup against a table of ~50 African nations and demonyms.

### Examples

| Query | Filters |
|---|---|
| `young males from nigeria` | `gender=male, min_age=16, max_age=24, country_id=NG` |
| `adult females above 30` | `gender=female, age_group=adult, min_age=30` |
| `senior men from ghana` | `gender=male, age_group=senior, country_id=GH` |
| `teenagers between 13 and 17` | `age_group=teenager, min_age=13, max_age=17` |

Queries that cannot be interpreted return `{ "status": "error", "message": "Unable to interpret query" }`.

---

## API Reference

### Headers required on all `/api/*` requests

```
Authorization: Bearer <access_token>
X-API-Version: 1
```

### Endpoints

| Method | Path | Role | Description |
|---|---|---|---|
| GET | `/auth/github` | public | Initiate GitHub OAuth |
| GET | `/auth/github/callback` | public | OAuth callback |
| POST | `/auth/refresh` | public | Rotate token pair |
| POST | `/auth/logout` | auth | Revoke refresh token |
| GET | `/auth/me` | auth | Current user |
| GET | `/api/users/me` | auth | Current user (alias) |
| GET | `/api/profiles` | analyst+ | List + filter + sort + paginate |
| GET | `/api/profiles/search` | analyst+ | NLP search |
| GET | `/api/profiles/export` | analyst+ | CSV export |
| GET | `/api/profiles/:id` | analyst+ | Single profile |
| POST | `/api/profiles` | admin | Create profile |
| DELETE | `/api/profiles/:id` | admin | Delete profile |

### Pagination shape

```json
{
  "status": "success",
  "page": 1,
  "limit": 10,
  "total": 2026,
  "total_pages": 203,
  "links": {
    "self": "/api/profiles?page=1&limit=10",
    "next": "/api/profiles?page=2&limit=10",
    "prev": null
  },
  "data": [...]
}
```

---

## Setup

```bash
npm install
cp .env.example .env   # fill in all variables
node scripts/seed.js   # seed 2026 profiles
npm run dev
```

### Required environment variables

```bash
DATABASE_URL          # PostgreSQL connection string
NODE_ENV              # production or development
GITHUB_CLIENT_ID      # GitHub OAuth App client ID
GITHUB_CLIENT_SECRET  # GitHub OAuth App client secret
BACKEND_URL           # This server's public URL (no trailing slash)
FRONTEND_URL          # Web portal URL (no trailing slash)
ALLOWED_ORIGINS       # Comma-separated CORS origins
JWT_ACCESS_SECRET     # Random 64-byte hex string
JWT_REFRESH_SECRET    # Random 64-byte hex string
TEST_SECRET           # Enables POST /auth/test-token for grading
```