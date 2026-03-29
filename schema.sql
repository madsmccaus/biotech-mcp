-- Applications (one row per NDA/ANDA/BLA)
CREATE TABLE IF NOT EXISTS applications (
  application_number TEXT PRIMARY KEY,
  sponsor_name TEXT,
  application_type TEXT,  -- 'NDA', 'ANDA', 'BLA'
  brand_name TEXT,
  generic_name TEXT,
  manufacturer_name TEXT,
  substance_name TEXT,
  pharm_class TEXT,
  route TEXT,
  raw_json JSONB
);

-- Products (one row per product within an application)
CREATE TABLE IF NOT EXISTS products (
  id SERIAL PRIMARY KEY,
  application_number TEXT REFERENCES applications(application_number),
  product_number TEXT,
  marketing_status TEXT,  -- 'Prescription', 'Discontinued', 'Withdrawn', etc.
  dosage_form TEXT,
  route TEXT,
  active_ingredients TEXT
);

-- Submissions (one row per submission event)
CREATE TABLE IF NOT EXISTS submissions (
  id SERIAL PRIMARY KEY,
  application_number TEXT REFERENCES applications(application_number),
  submission_type TEXT,
  submission_number TEXT,
  submission_status TEXT,
  submission_status_date DATE,
  submission_class_code TEXT,
  submission_class_code_description TEXT,
  review_priority TEXT,
  submission_public_notes TEXT
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_apps_sponsor ON applications(sponsor_name);
CREATE INDEX IF NOT EXISTS idx_apps_type ON applications(application_type);
CREATE INDEX IF NOT EXISTS idx_apps_brand ON applications(brand_name);
CREATE INDEX IF NOT EXISTS idx_apps_substance ON applications(substance_name);
CREATE INDEX IF NOT EXISTS idx_products_status ON products(marketing_status);
CREATE INDEX IF NOT EXISTS idx_submissions_date ON submissions(submission_status_date);
CREATE INDEX IF NOT EXISTS idx_submissions_status ON submissions(submission_status);