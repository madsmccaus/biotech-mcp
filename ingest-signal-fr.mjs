import fetch from "node-fetch";
import pg from "pg";
import fs from "fs";
import {
  CRYPTO_SEARCH_TERMS,
  SIGNAL_AGENCY_SLUGS,
  dedupeDocumentsByNumber,
  normalizeFrDocument,
} from "./signal-lib.mjs";

const FR_API = "https://www.federalregister.gov/api/v1/documents.json";
const DRY_RUN = process.env.DRY_RUN === "1" || process.argv.includes("--dry-run");

const startDateArg = process.argv.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));
if (!startDateArg) {
  console.error("Usage: node ingest-signal-fr.mjs <YYYY-MM-DD> [--dry-run]");
  console.error("  Or: DRY_RUN=1 node ingest-signal-fr.mjs <YYYY-MM-DD>");
  process.exit(1);
}

const DATABASE_URL = process.env.DATABASE_URL;

async function fetchSearchPage({ term, agencySlug, startDate, page }) {
  const params = new URLSearchParams();
  params.set("conditions[term]", term);
  params.set("conditions[publication_date][gte]", startDate);
  params.set("per_page", "100");
  params.set("order", "newest");
  params.set("page", String(page));
  params.append("fields[]", "title");
  params.append("fields[]", "publication_date");
  params.append("fields[]", "type");
  params.append("fields[]", "abstract");
  params.append("fields[]", "document_number");
  params.append("fields[]", "html_url");
  params.append("fields[]", "pdf_url");
  params.append("fields[]", "agencies");
  if (agencySlug) {
    params.append("conditions[agencies][]", agencySlug);
  }

  const url = `${FR_API}?${params.toString()}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Federal Register API ${res.status} for term="${term}" page=${page}`);
  }
  return res.json();
}

async function fetchAllForQuery(term, agencySlug, startDate) {
  const collected = [];
  let page = 1;
  let totalPages = 1;

  while (page <= totalPages) {
    const data = await fetchSearchPage({ term, agencySlug, startDate, page });
    const results = data.results || [];
    collected.push(...results);
    totalPages = data.total_pages || 1;
    page += 1;
    if (page <= totalPages) {
      await new Promise((r) => setTimeout(r, 350));
    }
  }
  return collected;
}

export async function fetchSignalFrDocuments(startDate) {
  const all = [];
  for (const term of CRYPTO_SEARCH_TERMS) {
    console.log(`  Term: "${term}" (all listed agencies)...`);
    const docs = await fetchAllForQuery(term, null, startDate);
    console.log(`    fetched ${docs.length} raw rows`);
    all.push(...docs);
    await new Promise((r) => setTimeout(r, 400));
  }

  for (const slug of SIGNAL_AGENCY_SLUGS) {
    console.log(`  Agency slug: ${slug} (crypto terms)...`);
    for (const term of CRYPTO_SEARCH_TERMS.slice(0, 3)) {
      try {
        const docs = await fetchAllForQuery(term, slug, startDate);
        if (docs.length) {
          console.log(`    ${term}: ${docs.length}`);
          all.push(...docs);
        }
      } catch (e) {
        console.error(`    skipped ${term} @ ${slug}: ${e.message}`);
      }
      await new Promise((r) => setTimeout(r, 350));
    }
  }

  return dedupeDocumentsByNumber(all);
}

async function ensureSchema(client) {
  const sql = fs.readFileSync(new URL("./signal-schema.sql", import.meta.url), "utf8");
  await client.query(sql);
}

async function upsertEvent(client, row) {
  await client.query(
    `INSERT INTO signal_events (
      document_number, agency, type, title, abstract, publication_date, url,
      classification, score_delta, rationale
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    ON CONFLICT (document_number) DO UPDATE SET
      agency = EXCLUDED.agency,
      type = EXCLUDED.type,
      title = EXCLUDED.title,
      abstract = EXCLUDED.abstract,
      publication_date = EXCLUDED.publication_date,
      url = EXCLUDED.url,
      classification = EXCLUDED.classification,
      score_delta = EXCLUDED.score_delta,
      rationale = EXCLUDED.rationale`,
    [
      row.document_number,
      row.agency,
      row.type,
      row.title,
      row.abstract,
      row.publication_date,
      row.url,
      row.classification,
      row.score_delta,
      row.rationale,
    ]
  );
}

async function main() {
  console.log(`Signal Federal Register ingest since ${startDateArg}${DRY_RUN ? " (DRY RUN)" : ""}`);

  const rawDocs = await fetchSignalFrDocuments(startDateArg);
  console.log(`Unique documents after dedupe: ${rawDocs.length}`);

  const normalized = rawDocs.map(normalizeFrDocument);

  if (DRY_RUN) {
    const byClass = {};
    for (const n of normalized) {
      byClass[n.classification] = (byClass[n.classification] || 0) + 1;
    }
    console.log("Classification counts:", byClass);
    console.log("\nSample classified documents:");
    for (const s of normalized.slice(0, 8)) {
      console.log(
        `  ${s.publication_date} | ${s.classification} (${s.score_delta}) | ${s.agency}\n    ${s.title}\n    ${s.rationale}`
      );
    }
    return;
  }

  if (!DATABASE_URL) {
    console.error("Set DATABASE_URL or use --dry-run");
    process.exit(1);
  }

  const client = new pg.Client({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  await ensureSchema(client);

  let upserted = 0;
  for (const row of normalized) {
    await upsertEvent(client, row);
    upserted += 1;
  }

  const count = await client.query("SELECT COUNT(*)::int AS n FROM signal_events");
  console.log(`Upserted ${upserted} rows; signal_events total: ${count.rows[0].n}`);
  await client.end();
  console.log("Done. Run: node score-signal.mjs");
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
