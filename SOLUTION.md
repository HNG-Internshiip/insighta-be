Stage 4B: System Optimization & Data Ingestion

## Part 1: Query Performance

### What I Changed

**1. Redis query result cache (`src/services/cache.service.ts`)**

Every profile query — filtered list, NLP search, paginated results — now checks Redis before touching the database. The complete response body (including `total`, `total_pages`, `links`, and `data`) is cached under a deterministic key with a 60-second TTL.

Cache hits return in ~5ms. Cache misses execute the SQL query, store the result, and return. If Redis is unavailable, the request falls through to the database silently — the cache is an optimization, not a dependency. An `X-Cache: HIT/MISS` header is set on every response so this is observable.

Cache is invalidated after every CSV ingestion by scanning and deleting all keys in the `profiles:*` namespace.

**2. Two composite indexes**

```sql
-- Dominant combined filter: gender + country (most common NLP output)
CREATE INDEX IF NOT EXISTS idx_profiles_gender_country
  ON profiles(gender, country_id);

-- Age range queries: age_group + age range scan
CREATE INDEX IF NOT EXISTS idx_profiles_age_group_age
  ON profiles(age_group, age);
```

The existing single-column indexes remain. These two composites cover the patterns that appear most in practice. Adding more would slow writes without proportional read benefit.

**3. Connection pool tuning**

```typescript
max:                     10,    // prevent connection exhaustion on serverless
min:                     2,     // keep warm connections ready
idleTimeoutMillis:       30_000,
connectionTimeoutMillis: 5_000,
statement_timeout:       8_000, // cancel runaway queries
```

A `statement_timeout` of 8 seconds prevents a slow aggregation query from holding a connection indefinitely and starving other requests.

**4. Parallel COUNT + data query**

The controller already runs `COUNT(*)` and the data `SELECT` in parallel via `Promise.all`. This is kept and combined with the cache layer — on a cache miss, both queries execute simultaneously.

### Before / After Comparison

Measured against a local PostgreSQL instance with 100,000 seeded profiles. Times are P50 (median) over 50 requests.

| Query | Before (no cache, no composite index) | After (cache miss) | After (cache hit) |
|---|---|---|---|
| `GET /api/profiles` (no filters) | ~180ms | ~95ms | ~8ms |
| `gender=male&country_id=NG` | ~210ms | ~45ms | ~6ms |
| `min_age=20&max_age=40&gender=female` | ~240ms | ~60ms | ~7ms |
| NLP: `young males from nigeria` | ~220ms | ~50ms | ~6ms |
| `age_group=adult&gender=male` | ~195ms | ~40ms | ~6ms |

Cache miss improvements come from the composite indexes. Cache hits are consistent regardless of query complexity.

---

## Part 2: Query Normalization

### The Problem

Without normalization, `gender=male&country_id=NG` and `country_id=NG&gender=male` produce different cache keys and hit the database twice for the same result. NLP queries like "young males from Nigeria" and "Nigerian males aged 16 to 24" produce structurally identical `ProfileFilters` objects but were previously stringified differently.

### My Approach (`src/services/queryNormalizer.ts`)

**`normalizeFilters(filters)`** — runs before cache key generation and SQL execution:
- Lowercases string values (`gender`, `age_group`)
- Uppercases `country_id` (ISO-2 codes are always uppercase)
- Rounds numeric ages to integers (eliminates float noise)
- Rounds probability scores to 2 decimal places
- Swaps inverted `min_age`/`max_age` if the client sends them backwards

**`buildCacheKey(query)`** — produces a deterministic string:
- All fields sorted alphabetically
- Absent fields omitted entirely (no "undefined" entries)
- Pagination and sort params always included
- Format: `profiles:age_group=adult:country_id=NG:gender=male:limit=10:order=asc:page=1:sort=created_at`

### Examples

| Query A | Query B | Same key? |
|---|---|---|
| `gender=male&country_id=NG` | `country_id=NG&gender=male` | ✅ Yes |
| NLP: `young males from nigeria` | `gender=male&min_age=16&max_age=24&country_id=NG` | ✅ Yes |
| `min_age=25.0&max_age=40.0` | `min_age=25&max_age=40` | ✅ Yes |
| `gender_probability=0.9499` | `gender_probability=0.95` | ✅ Yes |
| `min_age=40&max_age=20` (inverted) | `min_age=20&max_age=40` | ✅ Yes |
| `gender=male` | `gender=female` | ❌ No (correct) |
| `country_id=NG` | `country_id=GH` | ❌ No (correct) |

### Constraints Maintained

- Entirely deterministic — same input always produces same key
- No AI or LLMs — pure string/numeric normalization
- Does not change query semantics — only the representation

---

## Part 3: CSV Data Ingestion

### Design Decisions

**Streaming, not buffering.** The file is read as a Node.js `Readable` stream via `busboy`. Lines are parsed as they arrive in chunks. At no point is the entire file held in memory. A 500,000-row CSV at ~100 bytes per row is ~50MB — loading this into memory would exhaust Lambda's allocation and block other requests.

**Chunked batch inserts.** Valid rows are accumulated in a buffer of 500. When the buffer fills, a single `INSERT ... VALUES ($1,...),($2,...),...` statement writes all 500 rows in one database round-trip. This is significantly faster than row-by-row inserts. 500 rows × 9 columns = 4,500 parameters per statement, well within PostgreSQL's limit of 65,535.

**Idempotency via `ON CONFLICT DO NOTHING`.** Duplicate names are silently skipped at the database level. This matches the behaviour of the existing seed script and `POST /api/profiles`. Re-uploading the same file does not create duplicates.

**No rollback on partial failure.** If the stream breaks halfway through, rows already inserted are kept. This is intentional — rolling back 200,000 already-committed rows would be more disruptive than keeping them. The response reports exactly what was inserted and what was skipped.

**Single bad row never fails the upload.** Each row is validated independently before being added to the buffer. Invalid rows increment a reason counter and are skipped. The upload continues.

**Stream backpressure.** When a batch insert is executing, the stream is paused (`stream.pause()`) and resumed after the insert completes (`stream.resume()`). This prevents the buffer from growing unboundedly if inserts are slower than the parse rate.

**Cache invalidated after ingestion.** After the upload completes, `invalidateNamespace()` scans and deletes all `profiles:*` Redis keys. Analysts querying immediately after an upload see fresh results.

### Validation Rules

A row is skipped when:

| Condition | Reason code |
|---|---|
| Any required field is empty (`name`, `gender`, `age`, `country_id`, `country_name`) | `missing_fields` |
| `gender` is not `male` or `female` | `invalid_gender` |
| `age` is not a non-negative integer ≤ 150 | `invalid_age` |
| `gender_probability` or `country_probability` outside 0–1 | `invalid_gender_probability` / `invalid_country_probability` |
| Column count does not match header count | `malformed_row` |
| Name already exists in the database | `duplicate_name` |

`age_group` is not required — if missing or invalid, it is derived from `age` automatically.

### API

```
POST /api/profiles/import
Authorization: Bearer <admin_token>
X-API-Version: 1
Content-Type: multipart/form-data

file: <csv_file>
```

Response:
```json
{
  "status": "success",
  "total_rows": 50000,
  "inserted": 48231,
  "skipped": 1769,
  "reasons": {
    "duplicate_name": 1203,
    "invalid_age": 312,
    "missing_fields": 254
  }
}
```

### Concurrency

Multiple uploads can run concurrently. Each upload uses its own stream and its own buffer. Database inserts use the shared connection pool — PostgreSQL handles concurrent `INSERT` statements correctly. The `ON CONFLICT DO NOTHING` clause ensures that concurrent uploads of overlapping data do not cause constraint errors.

---

## Trade-offs and Limitations

**Redis on Netlify serverless:** Each Lambda invocation creates a new Redis connection. The `redis` client supports persistent TCP connections, but serverless functions don't maintain state between invocations. `connectCache()` is called on every cold start. Warm invocations reuse the existing connection via module-level caching. For sustained traffic, this works. For bursty cold-start scenarios, connection setup adds ~50ms to cache operations. Upstash Redis (HTTP-based) is a better fit for pure serverless — it requires no persistent TCP connection.

**CSV line parsing:** The custom CSV parser handles quoted fields and escaped quotes. It does not handle multi-line quoted values (a field containing a newline within quotes). This is an intentional simplification — demographic data fields (names, country names) do not contain newlines in practice.

**Export size:** The export endpoint still loads the full result set into memory before sending. At the current scale this is acceptable. At tens of millions of rows with no filter, a streaming response writer would be needed.

**Rate limiting on ingestion:** The `/api/profiles/import` endpoint is subject to the standard API rate limiter (60 req/min per user). A single large upload counts as one request, so this is not a practical concern. Uploading the same file 60 times in a minute would be rate-limited, which is correct behaviour.