import fetch from "node-fetch";
import unzipper from "unzipper";
import pg from "pg";
import fs from "fs";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("Set DATABASE_URL environment variable");
  process.exit(1);
}

const client = new pg.Client({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
await client.connect();

async function run() {
  console.log("1/4 — Creating tables (dropping old data)...");
  
  // Drop and recreate for a clean import
  await client.query("DROP TABLE IF EXISTS submissions CASCADE");
  await client.query("DROP TABLE IF EXISTS products CASCADE");
  await client.query("DROP TABLE IF EXISTS applications CASCADE");
  
  const schema = fs.readFileSync("schema.sql", "utf8");
  await client.query(schema);

  console.log("2/4 — Downloading Drugs@FDA bulk data (~40MB)...");
  const url = "https://download.open.fda.gov/drug/drugsfda/drug-drugsfda-0001-of-0001.json.zip";
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);

  const directory = await unzipper.Open.buffer(await res.buffer());
  const file = directory.files[0];
  const content = await file.buffer();
  const data = JSON.parse(content.toString());
  const results = data.results;
  console.log(`   Downloaded ${results.length} applications`);

  console.log("3/4 — Importing into Postgres in batches...");

  // -- Batch insert applications --
  const BATCH = 500;
  let appCount = 0;

  for (let i = 0; i < results.length; i += BATCH) {
    const batch = results.slice(i, i + BATCH);
    const values = [];
    const params = [];
    let p = 1;

    for (const app of batch) {
      const appNum = app.application_number || "";
      const sponsor = app.sponsor_name || "";
      const appType = appNum.startsWith("BLA") ? "BLA" : appNum.startsWith("ANDA") ? "ANDA" : "NDA";
      const brand = app.openfda?.brand_name?.[0] || "";
      const generic = app.openfda?.generic_name?.[0] || "";
      const manufacturer = app.openfda?.manufacturer_name?.[0] || "";
      const substance = (app.openfda?.substance_name || []).join(", ");
      const pharmClass = (app.openfda?.pharm_class_epc || []).join(", ");
      const route = (app.openfda?.route || []).join(", ");

      values.push(`($${p},$${p+1},$${p+2},$${p+3},$${p+4},$${p+5},$${p+6},$${p+7},$${p+8},$${p+9})`);
      params.push(appNum, sponsor, appType, brand, generic, manufacturer, substance, pharmClass, route, JSON.stringify(app));
      p += 10;
    }

    await client.query(
      `INSERT INTO applications (application_number, sponsor_name, application_type,
        brand_name, generic_name, manufacturer_name, substance_name, pharm_class, route, raw_json)
       VALUES ${values.join(",")}
       ON CONFLICT (application_number) DO NOTHING`,
      params
    );

    appCount += batch.length;
    console.log(`   Applications: ${appCount} / ${results.length}`);
  }

  // -- Batch insert products --
  console.log("   Importing products...");
  let prodCount = 0;

  for (let i = 0; i < results.length; i += BATCH) {
    const batch = results.slice(i, i + BATCH);
    const values = [];
    const params = [];
    let p = 1;

    for (const app of batch) {
      const appNum = app.application_number || "";
      for (const prod of (app.products || [])) {
        const ingredients = (prod.active_ingredients || []).map(x => x.name).join(", ");
        values.push(`($${p},$${p+1},$${p+2},$${p+3},$${p+4},$${p+5})`);
        params.push(appNum, prod.product_number || "", prod.marketing_status || "",
                     prod.dosage_form || "", (prod.route || "").toString(), ingredients);
        p += 6;
        prodCount++;
      }
    }

    if (values.length > 0) {
      await client.query(
        `INSERT INTO products (application_number, product_number, marketing_status,
          dosage_form, route, active_ingredients)
         VALUES ${values.join(",")}`,
        params
      );
    }
  }
  console.log(`   ${prodCount} products imported`);

  // -- Batch insert submissions --
  console.log("   Importing submissions...");
  let subCount = 0;

  for (let i = 0; i < results.length; i += BATCH) {
    const batch = results.slice(i, i + BATCH);
    const values = [];
    const params = [];
    let p = 1;

    for (const app of batch) {
      const appNum = app.application_number || "";
      for (const s of (app.submissions || [])) {
        const dateStr = s.submission_status_date;
        const date = dateStr ? `${dateStr.slice(0,4)}-${dateStr.slice(4,6)}-${dateStr.slice(6,8)}` : null;
        values.push(`($${p},$${p+1},$${p+2},$${p+3},$${p+4},$${p+5},$${p+6},$${p+7},$${p+8})`);
        params.push(appNum, s.submission_type || "", s.submission_number || "",
                     s.submission_status || "", date,
                     s.submission_class_code || "", s.submission_class_code_description || "",
                     s.review_priority || "", s.submission_public_notes || "");
        p += 9;
        subCount++;
      }
    }

    if (values.length > 0) {
      await client.query(
        `INSERT INTO submissions (application_number, submission_type, submission_number,
          submission_status, submission_status_date, submission_class_code,
          submission_class_code_description, review_priority, submission_public_notes)
         VALUES ${values.join(",")}`,
        params
      );
    }
  }
  console.log(`   ${subCount} submissions imported`);

  console.log("\n4/4 — Done!");

  const statsRes = await client.query(`
    SELECT marketing_status, COUNT(*) as count
    FROM products GROUP BY marketing_status ORDER BY count DESC
  `);
  console.log("\n   Marketing status distribution:");
  for (const row of statsRes.rows) {
    console.log(`     ${row.marketing_status || "(empty)"}: ${row.count}`);
  }

  const total = await client.query("SELECT COUNT(*) FROM applications");
  console.log(`\n   Total applications: ${total.rows[0].count}`);

  await client.end();
}

run().catch(e => { console.error(e); process.exit(1); });
