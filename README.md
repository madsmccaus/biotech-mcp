# Biotech MCP

FDA and related regulatory data exposed via an MCP server (`server.mjs`) and ingest scripts.

## Signal — federal crypto policy

**Signal** tracks U.S. federal government activity on cryptocurrency as two separate **0–100** readings:

| Track | Source (this repo) | Status |
|-------|-------------------|--------|
| **Agency** | Federal Register (SEC, CFTC, Treasury, OCC, FDIC, Fed, FinCEN, IRS) | Implemented |
| **Legislative** | Congress.gov + prediction-market odds (planned) | Not wired |

The **gap** between agency and legislative scores is the product headline. Scores are **never** blended.

### Database schema

```bash
psql "$DATABASE_URL" -f signal-schema.sql
```

Tables:

- `signal_events` — one row per Federal Register document (`document_number` unique), with rule-based `classification`, `score_delta`, and `rationale`.
- `signal_readings` — daily `value` per `track` (`agency` | `legislative`).

### Ingest Federal Register (agency track)

```bash
export DATABASE_URL='postgres://...'
node ingest-signal-fr.mjs 2026-01-01
```

Dry-run (no database, hits the public API):

```bash
DRY_RUN=1 node ingest-signal-fr.mjs 2026-01-01
# or: node ingest-signal-fr.mjs 2026-01-01 --dry-run
```

Searches terms such as cryptocurrency, digital asset, stablecoin, crypto asset, blockchain, and virtual currency, across the listed agencies. Results are paginated, deduped on `document_number`, and upserted (safe to rerun).

### Score agency readings

```bash
node score-signal.mjs
```

**Scoring rules:**

1. Start from **50** (neutral).
2. Each classified event contributes `score_delta × decay(days_since_publication)`.
3. **Half-life:** 60 days — weight = `0.5^(days/60)`.
4. **Clamp** the daily sum to **0–100**.
5. **Bill text** and **purely procedural** notices get **delta 0** (not +1).
6. Supportive/restrictive keyword rules apply small integer deltas (capped at +3 / −3). See `signal-lib.mjs` for the full rule list.

Legislative readings will use `track = 'legislative'` once the Congress.gov ingest exists.

### MCP tools

- `get_signal_reading` — latest agency score and 30-day trend; legislative marked unavailable until implemented.
- `search_signal_events` — filter events by query, agency, dates, classification.

### Tests

```bash
npm test
```
