/**
 * Signal agency track — transparent rule-based classification and decay scoring.
 */

export const TRACK_AGENCY = "agency";
export const TRACK_LEGISLATIVE = "legislative"; // hook for Congress.gov + prediction markets

export const BASE_SCORE = 50;
export const HALF_LIFE_DAYS = 60;

export const CRYPTO_SEARCH_TERMS = [
  "cryptocurrency",
  "digital asset",
  "stablecoin",
  "crypto asset",
  "blockchain",
  "virtual currency",
];

/** Federal Register agency slugs */
export const SIGNAL_AGENCY_SLUGS = [
  "securities-and-exchange-commission",
  "commodity-futures-trading-commission",
  "treasury-department",
  "comptroller-of-the-currency",
  "federal-deposit-insurance-corporation",
  "federal-reserve-system",
  "financial-crimes-enforcement-network",
  "internal-revenue-service",
];

const BILL_TEXT_PATTERNS = [
  /\bbill\s+text\b/i,
  /\benrolled\s+bill\b/i,
  /\bslip\s+law\b/i,
  /\btext\s+of\s+(the\s+)?bill\b/i,
  /\bhouse\s+bill\s+\d+/i,
  /\bsenate\s+bill\s+\d+/i,
];

const PROCEDURAL_PATTERNS = [
  /\bnotice\s+of\s+(public\s+)?meeting\b/i,
  /\bmeeting\s+notice\b/i,
  /\bagenda\b/i,
  /\bextension\s+of\s+comment\s+period\b/i,
  /\brequest\s+for\s+comments?\b/i,
  /\bsunshine\s+act\b/i,
  /\binformation\s+collection\b/i,
  /\bpaperwork\s+reduction\s+act\b/i,
  /\bnotice\s+of\s+filing\b/i,
  /\bself-regulatory\s+organization\b.*\bnotice\b/i,
  /\bprocedural\s+notice\b/i,
  /\broutine\s+notice\b/i,
];

const SUPPORTIVE_RULES = [
  { re: /\bsafe\s+harbor\b/i, delta: 2, note: "safe harbor" },
  { re: /\bno-action\s+letter\b/i, delta: 2, note: "no-action relief" },
  { re: /\bapproval\s+order\b/i, delta: 2, note: "approval order" },
  { re: /\bgranted\s+exemptive\b/i, delta: 2, note: "exemptive relief" },
  { re: /\bclarif(y|ies|ication)\b/i, delta: 1, note: "clarification" },
  { re: /\bguidance\b/i, delta: 1, note: "guidance" },
  { re: /\bpermit(s|ted)?\b/i, delta: 1, note: "permitting language" },
  { re: /\bexempt(ion|s)?\b/i, delta: 1, note: "exemption" },
  { re: /\bfacilitat(e|es|ing)\b/i, delta: 1, note: "facilitation" },
  { re: /\binteroperab(le|ility)\b/i, delta: 1, note: "interoperability" },
];

const RESTRICTIVE_RULES = [
  { re: /\benforcement\s+action\b/i, delta: -3, note: "enforcement action" },
  { re: /\bcease[- ]and[- ]desist\b/i, delta: -3, note: "cease-and-desist" },
  { re: /\bcivil\s+penalty\b/i, delta: -2, note: "civil penalty" },
  { re: /\bfraud\b/i, delta: -2, note: "fraud allegation" },
  { re: /\bprohibit(s|ed|ion)?\b/i, delta: -2, note: "prohibition" },
  { re: /\bban(s|ned|ning)?\b/i, delta: -2, note: "ban" },
  { re: /\bsanction(s)?\b/i, delta: -2, note: "sanctions" },
  { re: /\bviolation\b/i, delta: -1, note: "violation" },
  { re: /\bpenalt(y|ies)\b/i, delta: -1, note: "penalty" },
  { re: /\brestrict(s|ed|ion)?\b/i, delta: -1, note: "restriction" },
  { re: /\bnew\s+reporting\s+requirement\b/i, delta: -1, note: "new reporting burden" },
];

export function formatAgencies(doc) {
  const agencies = doc.agencies || [];
  return agencies
    .map((a) => (typeof a === "string" ? a : a.name || a.raw_name || ""))
    .filter(Boolean)
    .join("; ");
}

export function primaryAgency(doc) {
  const names = formatAgencies(doc);
  if (!names) return "Unknown";
  return names.split(";")[0].trim();
}

export function documentTextBlob(doc) {
  const parts = [doc.title, doc.type, doc.abstract].filter(Boolean);
  return parts.join("\n");
}

export function isBillText(blob) {
  return BILL_TEXT_PATTERNS.some((re) => re.test(blob));
}

export function isPurelyProcedural(blob, docType) {
  const type = (docType || "").toLowerCase();
  if (type === "notice" && PROCEDURAL_PATTERNS.some((re) => re.test(blob))) {
    return true;
  }
  return PROCEDURAL_PATTERNS.some((re) => re.test(blob));
}

/**
 * Rule-based classifier. Returns classification, score_delta, rationale.
 */
export function classifyDocument(doc) {
  const blob = documentTextBlob(doc);
  const docType = doc.type || "";

  if (isBillText(blob)) {
    return {
      classification: "neutral",
      scoreDelta: 0,
      rationale: "Bill text in Federal Register; scored 0 (legislative track handles statutes).",
    };
  }

  if (isPurelyProcedural(blob, docType)) {
    return {
      classification: "neutral",
      scoreDelta: 0,
      rationale: "Purely procedural notice (meeting, comment period, filing, etc.); delta 0.",
    };
  }

  let delta = 0;
  const hits = [];

  for (const rule of SUPPORTIVE_RULES) {
    if (rule.re.test(blob)) {
      delta += rule.delta;
      hits.push(`+${rule.delta} (${rule.note})`);
    }
  }
  for (const rule of RESTRICTIVE_RULES) {
    if (rule.re.test(blob)) {
      delta += rule.delta;
      hits.push(`${rule.delta} (${rule.note})`);
    }
  }

  if (delta > 0) {
    const capped = Math.min(delta, 3);
    return {
      classification: "supportive",
      scoreDelta: capped,
      rationale: hits.length
        ? `Supportive: ${hits.join("; ")} (capped at +3).`
        : "Supportive cues; default +1.",
    };
  }
  if (delta < 0) {
    const capped = Math.max(delta, -3);
    return {
      classification: "restrictive",
      scoreDelta: capped,
      rationale: hits.length
        ? `Restrictive: ${hits.join("; ")} (capped at -3).`
        : "Restrictive cues; default -1.",
    };
  }

  const cryptoMention = /\b(cryptocurrency|digital asset|stablecoin|blockchain|virtual currency)\b/i.test(
    blob
  );
  if (cryptoMention && /\b(rule|proposed rule)\b/i.test(docType)) {
    return {
      classification: "neutral",
      scoreDelta: 0,
      rationale: "Substantive rule text without clear supportive/restrictive keywords; neutral 0.",
    };
  }

  return {
    classification: "neutral",
    scoreDelta: 0,
    rationale: "No supportive/restrictive rule matched; neutral 0.",
  };
}

export function decayWeight(daysAgo, halfLifeDays = HALF_LIFE_DAYS) {
  if (daysAgo < 0) return 0;
  if (daysAgo === 0) return 1;
  return Math.pow(0.5, daysAgo / halfLifeDays);
}

export function clampScore(value) {
  return Math.max(0, Math.min(100, value));
}

function parseDateOnly(iso) {
  if (!iso) return null;
  const d = new Date(`${iso}T12:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function daysBetween(fromDate, toDate) {
  const ms = toDate.getTime() - fromDate.getTime();
  return Math.floor(ms / (24 * 60 * 60 * 1000));
}

/**
 * Agency reading for a single calendar day from decayed event deltas.
 */
export function computeAgencyReadingForDate(events, readingDate, opts = {}) {
  const halfLife = opts.halfLifeDays ?? HALF_LIFE_DAYS;
  const base = opts.baseScore ?? BASE_SCORE;
  let weightedSum = 0;

  for (const ev of events) {
    const pub = parseDateOnly(ev.publication_date);
    if (!pub || pub > readingDate) continue;
    const daysAgo = daysBetween(pub, readingDate);
    weightedSum += (ev.score_delta || 0) * decayWeight(daysAgo, halfLife);
  }

  return clampScore(base + weightedSum);
}

/**
 * Recompute daily agency readings from first event through endDate (inclusive).
 */
export function computeAllAgencyReadings(events, endDate, opts = {}) {
  if (!events.length) return [];

  const pubs = events
    .map((e) => parseDateOnly(e.publication_date))
    .filter(Boolean)
    .sort((a, b) => a - b);
  if (!pubs.length) return [];

  const start = pubs[0];
  const end = endDate instanceof Date ? endDate : parseDateOnly(endDate) || new Date();

  const readings = [];
  const cursor = new Date(start);
  while (cursor <= end) {
    const iso = cursor.toISOString().slice(0, 10);
    readings.push({
      reading_date: iso,
      track: TRACK_AGENCY,
      value: computeAgencyReadingForDate(events, cursor, opts),
    });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return readings;
}

/**
 * Dedupe Federal Register API results by document_number (last wins).
 */
export function dedupeDocumentsByNumber(docs) {
  const map = new Map();
  for (const doc of docs) {
    const num = doc.document_number;
    if (num) map.set(num, doc);
  }
  return [...map.values()];
}

export function normalizeFrDocument(doc) {
  const { classification, scoreDelta, rationale } = classifyDocument(doc);
  return {
    document_number: doc.document_number,
    agency: primaryAgency(doc),
    type: doc.type || "",
    title: doc.title || "",
    abstract: (doc.abstract || "").slice(0, 10000),
    publication_date: doc.publication_date || null,
    url: doc.html_url || doc.pdf_url || "",
    classification,
    score_delta: scoreDelta,
    rationale,
  };
}
