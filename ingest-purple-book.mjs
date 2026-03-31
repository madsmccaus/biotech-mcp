import fetch from "node-fetch";
import pg from "pg";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("Set DATABASE_URL environment variable");
  process.exit(1);
}

const PURPLE_BOOK_URLS = [
  "https://purplebooksearch.fda.gov/files/2026/purplebook-search-march-data-download.csv",
  "https://purplebooksearch.fda.gov/files/2025/purplebook-search-march-data-download.csv",
];

const BATCH_SIZE = 250;

/** @returns {Generator<string[]>} */
function* parseCSVRows(text) {
  let i = 0;
  const row = [];
  let field = "";
  let inQuotes = false;
  const len = text.length;

  const flushRow = function* () {
    row.push(field);
    field = "";
    if (row.length > 1 || (row[0] !== "" && row[0] !== undefined)) {
      yield row.slice();
    }
    row.length = 0;
  };

  while (i < len) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (c === ",") {
      row.push(field);
      field = "";
      i++;
      continue;
    }
    if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      yield* flushRow();
      i++;
      continue;
    }
    field += c;
    i++;
  }
  row.push(field);
  if (row.length > 1 || (row[0] !== "" && row[0] !== undefined)) {
    yield row.slice();
  }
}

function normalizeHeaderCell(s) {
  return s
    .trim()
    .replace(/^"|"$/g, "")
    .replace(/""/g, '"')
    .trim()
    .toLowerCase()
    .replace(/[/\\]+/g, "_")
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_]/g, "");
}

/** Map logical column -> list of normalized header names to match (exact first, then includes) */
const COLUMN_CANDIDATES = {
  bla_number: ["bla_number", "license_number", "blanumber"],
  proprietary_name: ["proprietary_name", "brand_name"],
  proper_name: ["proper_name", "nonproprietary_name"],
  applicant: ["applicant", "applicant_sponsor"],
  dosage_form: ["dosage_form"],
  route: ["route", "route_of_administration"],
  strength: ["strength", "strength_dosage", "strengthdosage"],
  marketing_status: ["marketing_status"],
  license_type: ["license_type", "bla_type", "licensure_status"],
  approval_date: ["approval_date", "date_of_first_licensure"],
  exclusivity_expiration: [
    "exclusivity_expiration",
    "exclusivity_expiration_date",
    "reference_product_exclusivity_expiration_date",
    "first_interchangeable_exclusivity_expiration_date",
  ],
};

function buildColumnIndices(normalizedHeaders) {
  const indices = {};
  const used = new Set();

  function tryExact(candidates) {
    for (const cand of candidates) {
      const idx = normalizedHeaders.indexOf(cand);
      if (idx >= 0 && !used.has(idx)) return idx;
    }
    return -1;
  }

  function tryFuzzy(candidates) {
    for (const cand of candidates) {
      const idx = normalizedHeaders.findIndex(
        (h, i) => !used.has(i) && (h === cand || h.includes(cand) || cand.includes(h))
      );
      if (idx >= 0) return idx;
    }
    return -1;
  }

  for (const key of Object.keys(COLUMN_CANDIDATES)) {
    const cands = COLUMN_CANDIDATES[key];
    let idx = tryExact(cands);
    if (idx < 0) idx = tryFuzzy(cands);
    if (idx >= 0) {
      indices[key] = idx;
      used.add(idx);
    } else {
      indices[key] = -1;
    }
  }

  return indices;
}

function cell(row, idx) {
  if (idx < 0 || idx >= row.length) return "";
  const v = row[idx];
  if (v == null) return "";
  return String(v).trim();
}

async function downloadPurpleBookCsv() {
  for (const url of PURPLE_BOOK_URLS) {
    console.log(`Step 1/4 — Trying download: ${url}`);
    const res = await fetch(url);
    if (!res.ok) {
      console.log(`  HTTP ${res.status} — trying next URL if any...`);
      continue;
    }
    const text = await res.text();
    const start = text.trimStart().slice(0, 20).toLowerCase();
    if (start.startsWith("<!doctype") || start.startsWith("<html")) {
      console.log("  Response body looks like HTML, not CSV — trying next URL if any...");
      continue;
    }
    console.log(`  Downloaded ${(text.length / 1024).toFixed(1)} KB`);
    return { url, text };
  }
  throw new Error(
    "Could not download Purple Book CSV (tried 2026/march then 2025/march). Check FDA URLs or network."
  );
}

async function main() {
  console.log("Purple Book ingestion — starting");
  const { url: usedUrl, text: csvText } = await downloadPurpleBookCsv();
  console.log(`  Using file from: ${usedUrl}`);

  console.log("Step 2/4 — Parsing CSV rows...");
  const rows = Array.from(parseCSVRows(csvText));
  if (rows.length === 0) {
    throw new Error("CSV has no rows");
  }
  const headerRow = rows[0].map((h) => h.trim().replace(/^"|"$/g, "").replace(/""/g, '"'));
  const normalizedHeaders = headerRow.map(normalizeHeaderCell);
  console.log(`  Header columns (${normalizedHeaders.length}): ${normalizedHeaders.join(", ")}`);

  const col = buildColumnIndices(normalizedHeaders);
  console.log("  Column index map:", JSON.stringify(col));

  const dataRows = rows.slice(1).filter((r) => r.some((c) => String(c).trim() !== ""));
  console.log(`  Data rows: ${dataRows.length}`);

  console.log("Step 3/4 — Connecting to Postgres and ensuring table...");
  const client = new pg.Client({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  console.log("  Connected.");

  await client.query(`
    CREATE TABLE IF NOT EXISTS purple_book (
      id SERIAL PRIMARY KEY,
      bla_number TEXT,
      proprietary_name TEXT,
      proper_name TEXT,
      applicant TEXT,
      dosage_form TEXT,
      route TEXT,
      strength TEXT,
      marketing_status TEXT,
      license_type TEXT,
      approval_date TEXT,
      exclusivity_expiration TEXT,
      raw_row TEXT
    )
  `);
  await client.query("TRUNCATE TABLE purple_book RESTART IDENTITY");
  console.log("  Table purple_book ready (truncated for fresh load).");

  await client.query("CREATE INDEX IF NOT EXISTS idx_purple_book_bla ON purple_book(bla_number)");
  await client.query("CREATE INDEX IF NOT EXISTS idx_purple_book_applicant ON purple_book(applicant)");
  await client.query(
    "CREATE INDEX IF NOT EXISTS idx_purple_book_proprietary ON purple_book(proprietary_name)"
  );
  await client.query("CREATE INDEX IF NOT EXISTS idx_purple_book_proper ON purple_book(proper_name)");
  await client.query(
    "CREATE INDEX IF NOT EXISTS idx_purple_book_marketing ON purple_book(marketing_status)"
  );
  await client.query("CREATE INDEX IF NOT EXISTS idx_purple_book_license ON purple_book(license_type)");
  console.log("  Indexes ensured.");

  console.log(`Step 4/4 — Batch inserting (${BATCH_SIZE} rows per batch)...`);
  let inserted = 0;

  for (let start = 0; start < dataRows.length; start += BATCH_SIZE) {
    const slice = dataRows.slice(start, start + BATCH_SIZE);
    const values = [];
    const params = [];
    let p = 1;

    for (const row of slice) {
      const bla_number = cell(row, col.bla_number);
      const proprietary_name = cell(row, col.proprietary_name);
      const proper_name = cell(row, col.proper_name);
      const applicant = cell(row, col.applicant);
      const dosage_form = cell(row, col.dosage_form);
      const route = cell(row, col.route);
      const strength = cell(row, col.strength);
      const marketing_status = cell(row, col.marketing_status);
      const license_type = cell(row, col.license_type);
      const approval_date = cell(row, col.approval_date);
      const exclusivity_expiration = cell(row, col.exclusivity_expiration);
      const raw_row = JSON.stringify(row);

      values.push(
        `($${p},$${p + 1},$${p + 2},$${p + 3},$${p + 4},$${p + 5},$${p + 6},$${p + 7},$${p + 8},$${p + 9},$${p + 10},$${p + 11})`
      );
      params.push(
        bla_number,
        proprietary_name,
        proper_name,
        applicant,
        dosage_form,
        route,
        strength,
        marketing_status,
        license_type,
        approval_date,
        exclusivity_expiration,
        raw_row
      );
      p += 12;
    }

    await client.query(
      `INSERT INTO purple_book (
        bla_number, proprietary_name, proper_name, applicant, dosage_form, route,
        strength, marketing_status, license_type, approval_date, exclusivity_expiration, raw_row
      ) VALUES ${values.join(",")}`,
      params
    );
    inserted += slice.length;
    console.log(`  Inserted ${inserted} / ${dataRows.length} rows...`);
  }

  console.log("\nSummary — Purple Book load complete");
  console.log(`  Source: ${usedUrl}`);
  console.log(`  Total rows inserted: ${inserted}`);

  const total = await client.query("SELECT COUNT(*)::int AS c FROM purple_book");
  console.log(`  Table count: ${total.rows[0].c}`);

  const byLicense = await client.query(`
    SELECT license_type, COUNT(*)::int AS c
    FROM purple_book
    GROUP BY license_type
    ORDER BY c DESC
    LIMIT 10
  `);
  console.log("\n  Top license_type:");
  for (const r of byLicense.rows) {
    console.log(`    ${r.license_type || "(empty)"}: ${r.c}`);
  }

  const byMarketing = await client.query(`
    SELECT marketing_status, COUNT(*)::int AS c
    FROM purple_book
    GROUP BY marketing_status
    ORDER BY c DESC
    LIMIT 10
  `);
  console.log("\n  Top marketing_status:");
  for (const r of byMarketing.rows) {
    console.log(`    ${r.marketing_status || "(empty)"}: ${r.c}`);
  }

  const topApplicants = await client.query(`
    SELECT applicant, COUNT(*)::int AS c
    FROM purple_book
    WHERE applicant IS NOT NULL AND applicant != ''
    GROUP BY applicant
    ORDER BY c DESC
    LIMIT 5
  `);
  console.log("\n  Top 5 applicants by row count:");
  for (const r of topApplicants.rows) {
    console.log(`    ${r.applicant}: ${r.c}`);
  }

  await client.end();
  console.log("\nDone.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
