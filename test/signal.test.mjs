import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  classifyDocument,
  decayWeight,
  computeAgencyReadingForDate,
  computeAllAgencyReadings,
  clampScore,
  dedupeDocumentsByNumber,
  BASE_SCORE,
  HALF_LIFE_DAYS,
} from "../signal-lib.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe("signal classifier", () => {
  it("scores bill text as 0", () => {
    const doc = {
      title: "Publication of House Bill Text on Digital Assets",
      type: "Notice",
      abstract: "Attached is the bill text for H.R. 999.",
    };
    const r = classifyDocument(doc);
    assert.equal(r.scoreDelta, 0);
    assert.equal(r.classification, "neutral");
    assert.match(r.rationale, /bill text/i);
  });

  it("scores procedural notices as 0", () => {
    const doc = {
      title: "Sunshine Act Meeting",
      type: "Notice",
      abstract: "Notice of public meeting and agenda for the commission.",
    };
    const r = classifyDocument(doc);
    assert.equal(r.scoreDelta, 0);
  });

  it("tags enforcement as restrictive", () => {
    const doc = {
      title: "Enforcement Release",
      type: "Notice",
      abstract: "The Commission announced an enforcement action for crypto fraud.",
    };
    const r = classifyDocument(doc);
    assert.equal(r.classification, "restrictive");
    assert.ok(r.scoreDelta < 0);
  });

  it("tags safe harbor as supportive", () => {
    const doc = {
      title: "Guidance on Digital Assets",
      type: "Notice",
      abstract: "Provides a safe harbor for token offerings that clarify disclosure.",
    };
    const r = classifyDocument(doc);
    assert.equal(r.classification, "supportive");
    assert.ok(r.scoreDelta > 0);
  });
});

describe("decay and scoring", () => {
  it("decay halves at half-life", () => {
    assert.equal(decayWeight(0), 1);
    assert.ok(Math.abs(decayWeight(HALF_LIFE_DAYS) - 0.5) < 0.001);
  });

  it("clamps readings to 0-100", () => {
    assert.equal(clampScore(-5), 0);
    assert.equal(clampScore(150), 100);
    assert.equal(clampScore(55), 55);
  });

  it("applies decayed deltas from publication date", () => {
    const events = [{ publication_date: "2026-01-01", score_delta: 10 }];
    const onDay = computeAgencyReadingForDate(events, new Date("2026-01-01T12:00:00Z"));
    assert.equal(onDay, clampScore(BASE_SCORE + 10));

    const later = computeAgencyReadingForDate(events, new Date("2026-02-01T12:00:00Z"));
    assert.ok(later > BASE_SCORE);
    assert.ok(later < onDay);
  });

  it("produces daily agency readings", () => {
    const events = [
      { publication_date: "2026-01-01", score_delta: 2 },
      { publication_date: "2026-01-03", score_delta: -1 },
    ];
    const readings = computeAllAgencyReadings(events, new Date("2026-01-05T12:00:00Z"));
    assert.equal(readings.length, 5);
    assert.equal(readings[0].track, "agency");
    assert.ok(readings[4].value >= 0 && readings[4].value <= 100);
  });
});

describe("ingest dedupe", () => {
  it("dedupes fixture by document_number", () => {
    const raw = JSON.parse(
      fs.readFileSync(path.join(__dirname, "fixtures/fr-dedupe.json"), "utf8")
    );
    const deduped = dedupeDocumentsByNumber(raw);
    assert.equal(deduped.length, 2);
    const one = deduped.find((d) => d.document_number === "2026-00001");
    assert.equal(one.title, "Duplicate should be replaced");
  });
});
