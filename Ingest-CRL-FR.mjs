import fetch from "node-fetch";
import pg from "pg";
import fs from "fs";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("Set DATABASE_URL environment variable");
  process.exit(1);
}

console.log("Starting CRL + Federal Register ingestion...");
console.log("Connecting to database...");

async function main() {
  const client = new pg.Client({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await client.connect();
  console.log("Connected to database.");

  // ── Create tables ──
  console.log("Creating tables...");
  
  await client.query(`
    CREATE TABLE IF NOT EXISTS complete_response_letters (
      id SERIAL PRIMARY KEY,
      application_number TEXT,
      letter_date TEXT,
      letter_type TEXT,
      company_name TEXT,
      approver_name TEXT,
      approver_title TEXT,
      approver_center TEXT,
      file_name TEXT,
      letter_text TEXT
    )
  `);
  await client.query("CREATE INDEX IF NOT EXISTS idx_crl_app_num ON complete_response_letters(application_number)");
  await client.query("CREATE INDEX IF NOT EXISTS idx_crl_company ON complete_response_letters(company_name)");

  await client.query(`
    CREATE TABLE IF NOT EXISTS federal_register (
      id SERIAL PRIMARY KEY,
      document_number TEXT UNIQUE,
      title TEXT,
      doc_type TEXT,
      abstract TEXT,
      publication_date DATE,
      agencies TEXT,
      html_url TEXT,
      pdf_url TEXT,
      docket_ids TEXT
    )
  `);
  await client.query("CREATE INDEX IF NOT EXISTS idx_fr_date ON federal_register(publication_date)");
  console.log("Tables ready.");

  // ── 1. Complete Response Letters ──
  console.log("\n--- Ingesting Complete Response Letters ---");

  // Clear old data
  await client.query("DELETE FROM complete_response_letters");

  const countRes = await fetch("https://api.fda.gov/transparency/crl.json?limit=1");
  const countData = await countRes.json();
  const total = countData.meta?.results?.total || 0;
  console.log("Found " + total + " CRLs in openFDA");

  let imported = 0;
  for (let skip = 0; skip < total; skip += 100) {
    const batchSize = Math.min(100, total - skip);
    console.log("  Fetching CRLs " + (skip + 1) + "–" + (skip + batchSize) + "...");

    const url = "https://api.fda.gov/transparency/crl.json?limit=100&skip=" + skip;
    const res = await fetch(url);
    if (!res.ok) {
      console.error("  API returned " + res.status + ", stopping CRL fetch.");
      break;
    }

    const data = await res.json();
    const results = data.results || [];

    for (const crl of results) {
      let appNum = "";

      // Try to extract application number from the text
      if (crl.text) {
        const textMatch = crl.text.match(/(NDA|BLA|ANDA)\s*(\d+)/i);
        if (textMatch) {
          appNum = textMatch[1].toUpperCase() + textMatch[2];
        }
      }

      // Fallback: extract from file_name
      if (!appNum && crl.file_name) {
        const match = crl.file_name.match(/^(\d+)/);
        if (match) appNum = match[1];
      }

      // Extract from application_number array if present
      if (!appNum && Array.isArray(crl.application_number) && crl.application_number.length > 0) {
        appNum = crl.application_number[0].replace(/\s+/g, "");
      }

      const centers = Array.isArray(crl.approver_center)
        ? crl.approver_center.join(", ")
        : (crl.approver_center || "");

      const letterText = (crl.text || "").slice(0, 50000);

      await client.query(
        "INSERT INTO complete_response_letters (application_number, letter_date, letter_type, company_name, approver_name, approver_title, approver_center, file_name, letter_text) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
        [appNum, crl.letter_date || "", crl.letter_type || "",
         crl.company_name || "", crl.approver_name || "",
         crl.approver_title || "", centers, crl.file_name || "", letterText]
      );
      imported++;
    }

    // Small delay between pages
    await new Promise(r => setTimeout(r, 500));
  }

  console.log("CRLs imported: " + imported);

  // ── 2. Federal Register Notices ──
  console.log("\n--- Ingesting Federal Register notices ---");

  await client.query("DELETE FROM federal_register");

  const searches = [
    "withdrawn drug application FDA",
    "biologic license application FDA",
    "complete response letter FDA",
    "biotechnology FDA approval",
    "gene therapy FDA",
    "drug safety withdrawal FDA",
  ];

  let frImported = 0;

  for (const term of searches) {
    console.log('  Searching: "' + term + '"...');

    const url = "https://www.federalregister.gov/api/v1/documents.json?"
      + "conditions[term]=" + encodeURIComponent(term)
      + "&conditions[agencies][]=food-and-drug-administration"
      + "&per_page=200&order=newest"
      + "&fields[]=title&fields[]=publication_date&fields[]=type"
      + "&fields[]=abstract&fields[]=document_number"
      + "&fields[]=html_url&fields[]=pdf_url&fields[]=docket_ids";

    try {
      const res = await fetch(url);
      if (!res.ok) {
        console.error("    API returned " + res.status);
        continue;
      }

      const data = await res.json();
      const results = data.results || [];
      console.log("    Got " + results.length + " results");

      for (const doc of results) {
        const docNum = doc.document_number || "";
        if (!docNum) continue;

        const agencies = (doc.agencies || []).map(function(a) { return a.name || a; }).join(", ");
        const dockets = (doc.docket_ids || []).join(", ");

        try {
          await client.query(
            "INSERT INTO federal_register (document_number, title, doc_type, abstract, publication_date, agencies, html_url, pdf_url, docket_ids) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (document_number) DO NOTHING",
            [docNum, doc.title || "", doc.type || "",
             (doc.abstract || "").slice(0, 10000), doc.publication_date || null,
             agencies, doc.html_url || "", doc.pdf_url || "", dockets]
          );
          frImported++;
        } catch (e) {
          // skip duplicates
        }
      }
    } catch (e) {
      console.error("    Fetch error: " + e.message);
    }

    await new Promise(r => setTimeout(r, 1000));
  }

  console.log("Federal Register notices imported: " + frImported);

  // ── Stats ──
  const crlCount = await client.query("SELECT COUNT(*) FROM complete_response_letters");
  const frCount = await client.query("SELECT COUNT(*) FROM federal_register");
  console.log("\n--- Summary ---");
  console.log("  CRLs: " + crlCount.rows[0].count);
  console.log("  Federal Register: " + frCount.rows[0].count);

  await client.end();
  console.log("Done!");
}

main().catch(function(e) {
  console.error("FATAL ERROR:", e);
  process.exit(1);
});
