-- Signal: U.S. federal crypto policy (agency + legislative tracks; scores kept separate)

CREATE TABLE IF NOT EXISTS signal_events (
  id SERIAL PRIMARY KEY,
  document_number TEXT NOT NULL UNIQUE,
  agency TEXT,
  type TEXT,
  title TEXT,
  abstract TEXT,
  publication_date DATE,
  url TEXT,
  classification TEXT NOT NULL,
  score_delta INTEGER NOT NULL DEFAULT 0,
  rationale TEXT,
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_signal_events_pub_date ON signal_events(publication_date DESC);
CREATE INDEX IF NOT EXISTS idx_signal_events_agency ON signal_events(agency);
CREATE INDEX IF NOT EXISTS idx_signal_events_classification ON signal_events(classification);

-- Daily 0–100 readings per track (never blend agency + legislative)
CREATE TABLE IF NOT EXISTS signal_readings (
  id SERIAL PRIMARY KEY,
  reading_date DATE NOT NULL,
  track TEXT NOT NULL,
  value NUMERIC(5, 2) NOT NULL,
  UNIQUE (reading_date, track)
);

CREATE INDEX IF NOT EXISTS idx_signal_readings_track_date ON signal_readings(track, reading_date DESC);

-- Future legislative track: ingest from Congress.gov + prediction-market odds (not wired yet).
-- Use track = 'legislative' in signal_readings when implemented.
