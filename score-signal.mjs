import pg from "pg";
import fs from "fs";
import {
  TRACK_AGENCY,
  TRACK_LEGISLATIVE,
  computeAllAgencyReadings,
} from "./signal-lib.mjs";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("Set DATABASE_URL environment variable");
  process.exit(1);
}

async function ensureSchema(client) {
  const sql = fs.readFileSync(new URL("./signal-schema.sql", import.meta.url), "utf8");
  await client.query(sql);
}

async function main() {
  const client = new pg.Client({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  await ensureSchema(client);

  const evRes = await client.query(
    `SELECT publication_date, score_delta
     FROM signal_events
     WHERE publication_date IS NOT NULL
     ORDER BY publication_date ASC`
  );

  const events = evRes.rows;
  if (!events.length) {
    console.log("No signal_events with publication_date; nothing to score.");
    await client.end();
    return;
  }

  const today = new Date();
  const readings = computeAllAgencyReadings(events, today);

  await client.query("DELETE FROM signal_readings WHERE track = $1", [TRACK_AGENCY]);

  for (const r of readings) {
    await client.query(
      `INSERT INTO signal_readings (reading_date, track, value)
       VALUES ($1, $2, $3)
       ON CONFLICT (reading_date, track) DO UPDATE SET value = EXCLUDED.value`,
      [r.reading_date, r.track, r.value]
    );
  }

  const latest = await client.query(
    `SELECT reading_date, value FROM signal_readings
     WHERE track = $1 ORDER BY reading_date DESC LIMIT 1`,
    [TRACK_AGENCY]
  );

  console.log(
    `Wrote ${readings.length} agency readings (half-life ${60}d, base 50, clamped 0–100).`
  );
  if (latest.rows[0]) {
    console.log(`Latest agency reading: ${latest.rows[0].reading_date} → ${latest.rows[0].value}`);
  }

  // Legislative track hook: populate signal_readings with track = TRACK_LEGISLATIVE
  // after Congress.gov ingest + prediction-market odds pipeline exists.
  void TRACK_LEGISLATIVE;

  await client.end();
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
