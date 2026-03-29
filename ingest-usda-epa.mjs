import fetch from "node-fetch";
import pg from "pg";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("Set DATABASE_URL environment variable");
  process.exit(1);
}

console.log("Starting USDA + EPA ingestion...");
console.log("Connecting to database...");

async function main() {
  const client = new pg.Client({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await client.connect();
  console.log("Connected.");

  console.log("Creating tables...");
  await client.query(`
    CREATE TABLE IF NOT EXISTS usda_permits (
      id SERIAL PRIMARY KEY,
      permit_number TEXT,
      status TEXT,
      organism TEXT,
      phenotype TEXT,
      developer TEXT,
      event_or_line TEXT,
      permit_type TEXT,
      release_type TEXT,
      effective_date TEXT,
      expiration_date TEXT,
      state TEXT,
      raw_row TEXT
    )
  `);
  await client.query("CREATE INDEX IF NOT EXISTS idx_usda_status ON usda_permits(status)");
  await client.query("CREATE INDEX IF NOT EXISTS idx_usda_developer ON usda_permits(developer)");
  await client.query("CREATE INDEX IF NOT EXISTS idx_usda_organism ON usda_permits(organism)");
  console.log("Tables ready.");

  // ── 1. USDA BRS Permits CSV ──
  console.log("\n--- Downloading USDA BRS Permits CSV ---");
  const csvUrl = "https://www.aphis.usda.gov/sites/default/files/brs-public-apps.csv";
  console.log("  Fetching from aphis.usda.gov...");

  let csvText;
  try {
    const res = await fetch(csvUrl);
    if (!res.ok) throw new Error("HTTP " + res.status);
    csvText = await res.text();
    console.log("  Downloaded " + (csvText.length / 1024 / 1024).toFixed(1) + " MB");
  } catch (e) {
    console.error("  Failed to download CSV: " + e.message);
    console.log("  Skipping USDA permits.");
    csvText = null;
  }

  if (csvText) {
    await client.query("DELETE FROM usda_permits");
    const lines = csvText.split("\n");
    const cols = lines[0].split(",").map(function(c) { return c.trim().replace(/"/g, "").toLowerCase(); });
    console.log("  CSV columns: " + cols.join(", "));

    function colIdx(name) {
      return cols.findIndex(function(c) { return c.includes(name); });
    }

    const iPermit = colIdx("permit");
    const iStatus = colIdx("status");
    const iOrganism = colIdx("article");
    const iPhenotype = colIdx("phenotype");
    const iDeveloper = colIdx("institution");
    const iEvent = colIdx("genotype");
    const iType = colIdx("type");
    const iRelease = colIdx("action");
    const iEffective = colIdx("effective");
    const iExpiration = colIdx("expire");
    const iState = colIdx("location");

    console.log("  Column mapping: permit=" + iPermit + " status=" + iStatus + " organism=" + iOrganism + " developer=" + iDeveloper);

    function parseCSVLine(line) {
      var fields = [];
      var current = "";
      var inQuotes = false;
      for (var i = 0; i < line.length; i++) {
        var ch = line[i];
        if (ch === '"') { inQuotes = !inQuotes; }
        else if (ch === "," && !inQuotes) { fields.push(current.trim()); current = ""; }
        else { current += ch; }
      }
      fields.push(current.trim());
      return fields;
    }

    var imported = 0;
    var BATCH = 200;
    var values = [];
    var params = [];
    var p = 1;

    for (var i = 1; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line) continue;
      var fields = parseCSVLine(line);

      var permit = (iPermit >= 0 ? fields[iPermit] : "") || "";
      var status = (iStatus >= 0 ? fields[iStatus] : "") || "";
      var organism = (iOrganism >= 0 ? fields[iOrganism] : "") || "";
      var phenotype = (iPhenotype >= 0 ? fields[iPhenotype] : "") || "";
      var developer = (iDeveloper >= 0 ? fields[iDeveloper] : "") || "";
      var evt = (iEvent >= 0 ? fields[iEvent] : "") || "";
      var permitType = (iType >= 0 ? fields[iType] : "") || "";
      var release = (iRelease >= 0 ? fields[iRelease] : "") || "";
      var effective = (iEffective >= 0 ? fields[iEffective] : "") || "";
      var expiration = (iExpiration >= 0 ? fields[iExpiration] : "") || "";
      var state = (iState >= 0 ? fields[iState] : "") || "";

      values.push("($" + p + ",$" + (p+1) + ",$" + (p+2) + ",$" + (p+3) + ",$" + (p+4) + ",$" + (p+5) + ",$" + (p+6) + ",$" + (p+7) + ",$" + (p+8) + ",$" + (p+9) + ",$" + (p+10) + ",$" + (p+11) + ")");
      params.push(permit, status, organism, phenotype, developer, evt, permitType, release, effective, expiration, state, line.slice(0, 2000));
      p += 12;
      imported++;

      if (values.length >= BATCH) {
        await client.query("INSERT INTO usda_permits (permit_number, status, organism, phenotype, developer, event_or_line, permit_type, release_type, effective_date, expiration_date, state, raw_row) VALUES " + values.join(","), params);
        values = []; params = []; p = 1;
        if (imported % 5000 === 0) console.log("  " + imported + " permits imported...");
      }
    }
    if (values.length > 0) {
      await client.query("INSERT INTO usda_permits (permit_number, status, organism, phenotype, developer, event_or_line, permit_type, release_type, effective_date, expiration_date, state, raw_row) VALUES " + values.join(","), params);
    }
    console.log("  USDA permits imported: " + imported);

    var statusStats = await client.query("SELECT status, COUNT(*) as count FROM usda_permits GROUP BY status ORDER BY count DESC LIMIT 10");
    console.log("\n  Status distribution:");
    for (var row of statusStats.rows) { console.log("    " + (row.status || "(empty)") + ": " + row.count); }

    var orgStats = await client.query("SELECT organism, COUNT(*) as count FROM usda_permits WHERE organism != '' GROUP BY organism ORDER BY count DESC LIMIT 10");
    console.log("\n  Top organisms:");
    for (var row of orgStats.rows) { console.log("    " + row.organism + ": " + row.count); }
  }

  // ── 2. Expanded Federal Register notices ──
  console.log("\n--- Adding expanded Federal Register notices ---");

  var searches = [
    { term: "plant incorporated protectant registration", agency: "environmental-protection-agency" },
    { term: "biopesticide registration genetically engineered", agency: "environmental-protection-agency" },
    { term: "TSCA biotechnology microorganism submission", agency: "environmental-protection-agency" },
    { term: "pesticide tolerance exemption biotech", agency: "environmental-protection-agency" },
    { term: "pesticide cancellation order", agency: "environmental-protection-agency" },
    { term: "experimental use permit biopesticide", agency: "environmental-protection-agency" },
    { term: "genetically engineered organism deregulation", agency: "animal-and-plant-health-inspection-service" },
    { term: "biotechnology petition nonregulated status", agency: "animal-and-plant-health-inspection-service" },
    { term: "plant pest risk assessment APHIS", agency: "animal-and-plant-health-inspection-service" },
    { term: "environmental assessment genetically engineered crop", agency: "animal-and-plant-health-inspection-service" },
    { term: "biotech noncompliance APHIS", agency: "animal-and-plant-health-inspection-service" },
    { term: "genetically engineered import permit", agency: "animal-and-plant-health-inspection-service" },
    { term: "drug withdrawal safety FDA", agency: "food-and-drug-administration" },
    { term: "REMS risk evaluation mitigation strategy", agency: "food-and-drug-administration" },
    { term: "advisory committee biologics FDA", agency: "food-and-drug-administration" },
    { term: "citizen petition drug biologic FDA", agency: "food-and-drug-administration" },
  ];

  var frImported = 0;
  for (var search of searches) {
    console.log('  Searching: "' + search.term.slice(0, 50) + '..."');
    var url = "https://www.federalregister.gov/api/v1/documents.json?" + "conditions[term]=" + encodeURIComponent(search.term) + "&conditions[agencies][]=" + search.agency + "&per_page=200&order=newest" + "&fields[]=title&fields[]=publication_date&fields[]=type" + "&fields[]=abstract&fields[]=document_number" + "&fields[]=html_url&fields[]=pdf_url&fields[]=docket_ids";

    try {
      var res = await fetch(url);
      if (!res.ok) { console.error("    API returned " + res.status); continue; }
      var data = await res.json();
      var results = data.results || [];
      console.log("    Got " + results.length + " results");

      for (var doc of results) {
        var docNum = doc.document_number || "";
        if (!docNum) continue;
        var agencies = (doc.agencies || []).map(function(a) { return a.name || a; }).join(", ");
        var dockets = (doc.docket_ids || []).join(", ");
        try {
          await client.query(
            "INSERT INTO federal_register (document_number, title, doc_type, abstract, publication_date, agencies, html_url, pdf_url, docket_ids) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (document_number) DO NOTHING",
            [docNum, doc.title || "", doc.type || "", (doc.abstract || "").slice(0, 10000), doc.publication_date || null, agencies, doc.html_url || "", doc.pdf_url || "", dockets]
          );
          frImported++;
        } catch (e) { /* skip duplicates */ }
      }
    } catch (e) {
      console.error("    Fetch error: " + e.message);
    }
    await new Promise(function(r) { setTimeout(r, 1000); });
  }
  console.log("  Federal Register notices added: " + frImported);

  // ── Summary ──
  var usdaCount = await client.query("SELECT COUNT(*) FROM usda_permits");
  var frCount = await client.query("SELECT COUNT(*) FROM federal_register");
  console.log("\n--- Summary ---");
  console.log("  USDA permits: " + usdaCount.rows[0].count);
  console.log("  Federal Register (total): " + frCount.rows[0].count);
  await client.end();
  console.log("Done!");
}

main().catch(function(e) { console.error("FATAL ERROR:", e); process.exit(1); });
