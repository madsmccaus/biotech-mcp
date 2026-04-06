import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import pg from "pg";
import { z } from "zod";

// ── Database ──

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ── Helper: create a fresh MCP server with all tools registered ──

function createMcpServer() {
  const mcp = new McpServer({
    name: "biotech-tracker",
    version: "1.0.0",
  });

  // Tool 1: Search applications
  mcp.tool(
    "search_applications",
    "Search FDA drug and biologic applications. Use this for broad queries about drugs, sponsors, therapeutic areas, or application types.",
    {
      query: z.string().optional().describe("Free text search across brand name, generic name, sponsor, substance, and pharmacologic class"),
      application_type: z.enum(["BLA", "NDA", "ANDA", "any"]).optional().default("any").describe("Filter by application type. BLA = biologics, NDA = new drugs, ANDA = generics"),
      marketing_status: z.string().optional().describe("Filter by product marketing status: Prescription, Discontinued, Withdrawn, Over-the-counter"),
      year: z.number().optional().describe("Filter to applications with submission activity in this year"),
      sponsor: z.string().optional().describe("Filter by sponsor/manufacturer name (partial match)"),
      limit: z.number().optional().default(20).describe("Max results to return (default 20, max 100)"),
    },
    async ({ query, application_type, marketing_status, year, sponsor, limit }) => {
      const conditions = [];
      const params = [];
      let paramIdx = 1;

      if (query) {
        conditions.push(`(
          a.brand_name ILIKE $${paramIdx}
          OR a.generic_name ILIKE $${paramIdx}
          OR a.sponsor_name ILIKE $${paramIdx}
          OR a.substance_name ILIKE $${paramIdx}
          OR a.pharm_class ILIKE $${paramIdx}
          OR a.application_number ILIKE $${paramIdx}
        )`);
        params.push(`%${query}%`);
        paramIdx++;
      }

      if (application_type && application_type !== "any") {
        conditions.push(`a.application_type = $${paramIdx}`);
        params.push(application_type);
        paramIdx++;
      }

      if (marketing_status) {
        conditions.push(`EXISTS (SELECT 1 FROM products p WHERE p.application_number = a.application_number AND p.marketing_status ILIKE $${paramIdx})`);
        params.push(marketing_status);
        paramIdx++;
      }

      if (year) {
        conditions.push(`EXISTS (SELECT 1 FROM submissions s WHERE s.application_number = a.application_number AND EXTRACT(YEAR FROM s.submission_status_date) = $${paramIdx})`);
        params.push(year);
        paramIdx++;
      }

      if (sponsor) {
        conditions.push(`(a.sponsor_name ILIKE $${paramIdx} OR a.manufacturer_name ILIKE $${paramIdx})`);
        params.push(`%${sponsor}%`);
        paramIdx++;
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      const safeLimit = Math.min(Math.max(limit || 20, 1), 100);

      const res = await pool.query(`
        SELECT a.application_number, a.application_type, a.sponsor_name,
               a.brand_name, a.generic_name, a.substance_name,
               a.pharm_class, a.route, a.manufacturer_name,
               (SELECT string_agg(DISTINCT p.marketing_status, ', ')
                FROM products p WHERE p.application_number = a.application_number) as marketing_statuses,
               (SELECT MAX(s.submission_status_date)
                FROM submissions s WHERE s.application_number = a.application_number) as latest_submission
        FROM applications a
        ${where}
        ORDER BY latest_submission DESC NULLS LAST
        LIMIT ${safeLimit}
      `, params);

      if (res.rows.length === 0) {
        return { content: [{ type: "text", text: "No applications found matching your criteria." }] };
      }

      const summary = res.rows.map(r =>
        `${r.application_number} | ${r.brand_name || r.generic_name || "unnamed"} | ${r.sponsor_name || r.manufacturer_name || "unknown sponsor"} | ${r.marketing_statuses || "?"} | Latest: ${r.latest_submission || "?"} | Class: ${r.pharm_class || "—"}`
      ).join("\n");

      return {
        content: [{ type: "text", text: `Found ${res.rows.length} applications:\n\n${summary}` }],
      };
    }
  );

  // Tool 2: Get application details
  mcp.tool(
    "get_application_details",
    "Get full details for a specific FDA application by its number (e.g., BLA125057, NDA021436). Returns products, submission history, and all metadata.",
    {
      application_number: z.string().describe("The application number (e.g., BLA125057, NDA021436)"),
    },
    async ({ application_number }) => {
      const appRes = await pool.query(
        "SELECT * FROM applications WHERE application_number ILIKE $1",
        [application_number]
      );
      if (appRes.rows.length === 0) {
        return { content: [{ type: "text", text: `No application found with number "${application_number}".` }] };
      }
      const app = appRes.rows[0];

      const prodRes = await pool.query(
        "SELECT * FROM products WHERE application_number = $1 ORDER BY product_number",
        [app.application_number]
      );

      const subRes = await pool.query(
        "SELECT * FROM submissions WHERE application_number = $1 ORDER BY submission_status_date DESC",
        [app.application_number]
      );

      let text = `APPLICATION: ${app.application_number} (${app.application_type})\n`;
      text += `Brand: ${app.brand_name || "—"}\n`;
      text += `Generic: ${app.generic_name || "—"}\n`;
      text += `Sponsor: ${app.sponsor_name || "—"}\n`;
      text += `Manufacturer: ${app.manufacturer_name || "—"}\n`;
      text += `Substances: ${app.substance_name || "—"}\n`;
      text += `Pharm Class: ${app.pharm_class || "—"}\n`;
      text += `Route: ${app.route || "—"}\n`;

      text += `\nPRODUCTS (${prodRes.rows.length}):\n`;
      for (const p of prodRes.rows) {
        text += `  - ${p.active_ingredients || "?"} | ${p.dosage_form} | ${p.marketing_status} | Route: ${p.route}\n`;
      }

      text += `\nSUBMISSION HISTORY (${subRes.rows.length}):\n`;
      for (const s of subRes.rows) {
        const date = s.submission_status_date ? new Date(s.submission_status_date).toISOString().slice(0, 10) : "?";
        text += `  ${date} | ${s.submission_type}${s.submission_number} | Status: ${s.submission_status} | ${s.submission_class_code_description || ""}\n`;
        if (s.submission_public_notes) {
          text += `    Note: ${s.submission_public_notes}\n`;
        }
      }

      return { content: [{ type: "text", text }] };
    }
  );

  // Tool 3: Aggregate statistics
  mcp.tool(
    "get_statistics",
    "Get aggregate statistics about FDA applications. Use for questions like 'how many BLAs were approved in 2023' or 'which sponsors have the most withdrawn products'.",
    {
      group_by: z.enum(["sponsor", "year", "pharm_class", "marketing_status", "application_type"]).describe("What to group results by"),
      application_type: z.enum(["BLA", "NDA", "ANDA", "any"]).optional().default("any").describe("Filter by application type"),
      marketing_status: z.string().optional().describe("Filter by marketing status"),
      year_from: z.number().optional().describe("Start year for date range"),
      year_to: z.number().optional().describe("End year for date range"),
      limit: z.number().optional().default(25).describe("Max groups to return"),
    },
    async ({ group_by, application_type, marketing_status, year_from, year_to, limit }) => {
      const conditions = [];
      const params = [];
      let paramIdx = 1;

      if (application_type && application_type !== "any") {
        conditions.push(`a.application_type = $${paramIdx}`);
        params.push(application_type);
        paramIdx++;
      }

      if (marketing_status) {
        conditions.push(`EXISTS (SELECT 1 FROM products p2 WHERE p2.application_number = a.application_number AND p2.marketing_status ILIKE $${paramIdx})`);
        params.push(marketing_status);
        paramIdx++;
      }

      if (year_from) {
        conditions.push(`EXISTS (SELECT 1 FROM submissions s2 WHERE s2.application_number = a.application_number AND EXTRACT(YEAR FROM s2.submission_status_date) >= $${paramIdx})`);
        params.push(year_from);
        paramIdx++;
      }

      if (year_to) {
        conditions.push(`EXISTS (SELECT 1 FROM submissions s3 WHERE s3.application_number = a.application_number AND EXTRACT(YEAR FROM s3.submission_status_date) <= $${paramIdx})`);
        params.push(year_to);
        paramIdx++;
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      const safeLimit = Math.min(Math.max(limit || 25, 1), 100);

      let query;
      if (group_by === "marketing_status") {
        query = `
          SELECT p.marketing_status as group_key, COUNT(DISTINCT a.application_number) as count
          FROM applications a
          JOIN products p ON p.application_number = a.application_number
          ${where}
          GROUP BY p.marketing_status
          ORDER BY count DESC
          LIMIT ${safeLimit}`;
      } else if (group_by === "year") {
        query = `
          SELECT EXTRACT(YEAR FROM s.submission_status_date)::int as group_key,
                 COUNT(DISTINCT a.application_number) as count
          FROM applications a
          JOIN submissions s ON s.application_number = a.application_number
          ${where} ${where ? "AND" : "WHERE"} s.submission_status_date IS NOT NULL
          GROUP BY group_key
          ORDER BY group_key DESC
          LIMIT ${safeLimit}`;
      } else {
        const col = group_by === "sponsor" ? "a.sponsor_name"
          : group_by === "pharm_class" ? "a.pharm_class"
          : "a.application_type";
        query = `
          SELECT ${col} as group_key, COUNT(*) as count
          FROM applications a
          ${where} ${where ? "AND" : "WHERE"} ${col} IS NOT NULL AND ${col} != ''
          GROUP BY group_key
          ORDER BY count DESC
          LIMIT ${safeLimit}`;
      }

      const res = await pool.query(query, params);
      const text = res.rows.map(r => `${r.group_key || "(empty)"}: ${r.count}`).join("\n");
      return { content: [{ type: "text", text: `Results grouped by ${group_by}:\n\n${text}` }] };
    }
  );

  // Tool 4: Search Complete Response Letters
  mcp.tool(
    "search_crls",
    "Search FDA Complete Response Letters — these are rejection/deficiency letters explaining why an application was not approved. Contains the full letter text with reasons. Use for questions about why drugs were rejected, common deficiencies, or specific company rejections.",
    {
      query: z.string().optional().describe("Free text search across company name, letter text, and application number"),
      company: z.string().optional().describe("Filter by company name (partial match)"),
      application_number: z.string().optional().describe("Filter by application number"),
      limit: z.number().optional().default(10).describe("Max results (default 10, max 50)"),
    },
    async ({ query, company, application_number, limit }) => {
      const conditions = [];
      const params = [];
      let paramIdx = 1;

      if (query) {
        conditions.push(`(c.company_name ILIKE $${paramIdx} OR c.letter_text ILIKE $${paramIdx} OR c.application_number ILIKE $${paramIdx})`);
        params.push(`%${query}%`);
        paramIdx++;
      }
      if (company) {
        conditions.push(`c.company_name ILIKE $${paramIdx}`);
        params.push(`%${company}%`);
        paramIdx++;
      }
      if (application_number) {
        conditions.push(`c.application_number ILIKE $${paramIdx}`);
        params.push(`%${application_number}%`);
        paramIdx++;
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      const safeLimit = Math.min(Math.max(limit || 10, 1), 50);

      const res = await pool.query(`
        SELECT c.application_number, c.company_name, c.letter_date,
               c.letter_type, c.approver_name, c.approver_title,
               LEFT(c.letter_text, 2000) as letter_excerpt
        FROM complete_response_letters c
        ${where}
        ORDER BY c.letter_date DESC
        LIMIT ${safeLimit}
      `, params);

      if (res.rows.length === 0) {
        return { content: [{ type: "text", text: "No Complete Response Letters found matching your criteria." }] };
      }

      const summary = res.rows.map(r => {
        let entry = `${r.application_number || "?"} | ${r.company_name} | Date: ${r.letter_date}\n`;
        if (r.letter_excerpt) {
          const clean = r.letter_excerpt.replace(/\n{3,}/g, "\n\n").trim().slice(0, 500);
          entry += `  Excerpt: ${clean}...\n`;
        }
        return entry;
      }).join("\n");

      return { content: [{ type: "text", text: `Found ${res.rows.length} CRLs:\n\n${summary}` }] };
    }
  );

  // Tool 5: Get full CRL text
  mcp.tool(
    "get_crl_full_text",
    "Get the full text of a specific Complete Response Letter by its application number. Use after search_crls to read the detailed rejection reasons.",
    {
      application_number: z.string().describe("The application number (e.g., 209510 or BLA125057)"),
    },
    async ({ application_number }) => {
      const res = await pool.query(
        `SELECT * FROM complete_response_letters WHERE application_number ILIKE $1 ORDER BY letter_date DESC LIMIT 5`,
        [`%${application_number}%`]
      );
      if (res.rows.length === 0) {
        return { content: [{ type: "text", text: `No CRL found for application "${application_number}".` }] };
      }

      const texts = res.rows.map(r => {
        const clean = (r.letter_text || "").replace(/\n{3,}/g, "\n\n").trim();
        return `--- CRL for ${r.application_number} (${r.letter_date}) ---\nCompany: ${r.company_name}\nApprover: ${r.approver_name}, ${r.approver_title}\n\n${clean}`;
      }).join("\n\n");

      return { content: [{ type: "text", text: texts }] };
    }
  );

  // Tool 6: Search Federal Register notices
  mcp.tool(
    "search_federal_register",
    "Search FDA-related Federal Register notices — includes withdrawal notices, proposed rules, drug approvals, safety alerts, and regulatory actions. Use for questions about regulatory history, policy changes, or official FDA announcements.",
    {
      query: z.string().optional().describe("Free text search across title, abstract, and document type"),
      doc_type: z.string().optional().describe("Filter by document type: Notice, Rule, Proposed Rule, Presidential Document"),
      year: z.number().optional().describe("Filter by publication year"),
      limit: z.number().optional().default(20).describe("Max results (default 20, max 100)"),
    },
    async ({ query, doc_type, year, limit }) => {
      const conditions = [];
      const params = [];
      let paramIdx = 1;

      if (query) {
        conditions.push(`(f.title ILIKE $${paramIdx} OR f.abstract ILIKE $${paramIdx})`);
        params.push(`%${query}%`);
        paramIdx++;
      }
      if (doc_type) {
        conditions.push(`f.doc_type ILIKE $${paramIdx}`);
        params.push(`%${doc_type}%`);
        paramIdx++;
      }
      if (year) {
        conditions.push(`EXTRACT(YEAR FROM f.publication_date) = $${paramIdx}`);
        params.push(year);
        paramIdx++;
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      const safeLimit = Math.min(Math.max(limit || 20, 1), 100);

      const res = await pool.query(`
        SELECT f.document_number, f.title, f.doc_type, f.publication_date,
               LEFT(f.abstract, 500) as abstract_excerpt, f.html_url
        FROM federal_register f
        ${where}
        ORDER BY f.publication_date DESC
        LIMIT ${safeLimit}
      `, params);

      if (res.rows.length === 0) {
        return { content: [{ type: "text", text: "No Federal Register notices found matching your criteria." }] };
      }

      const summary = res.rows.map(r => {
        const date = r.publication_date ? new Date(r.publication_date).toISOString().slice(0, 10) : "?";
        let entry = `${date} | ${r.doc_type} | ${r.title}`;
        if (r.abstract_excerpt) entry += `\n  ${r.abstract_excerpt.trim().slice(0, 200)}...`;
        if (r.html_url) entry += `\n  ${r.html_url}`;
        return entry;
      }).join("\n\n");

      return { content: [{ type: "text", text: `Found ${res.rows.length} Federal Register notices:\n\n${summary}` }] };
    }
  );

  // Tool 7: Search USDA biotech permits
  mcp.tool(
    "search_usda_permits",
    "Search USDA/APHIS biotech permits and notifications. This covers genetically engineered organisms — field trials, releases, imports, and interstate movement. Includes crops like corn, soy, cotton, and newer organisms. Use for questions about who is doing GE field trials, what organisms are being tested, or permit status.",
    {
      query: z.string().optional().describe("Free text search across organism, developer, phenotype, and permit number"),
      organism: z.string().optional().describe("Filter by organism name (e.g., corn, soybean, cotton)"),
      developer: z.string().optional().describe("Filter by developer/applicant company name"),
      status: z.string().optional().describe("Filter by permit status (e.g., Issued, Denied, Withdrawn, Acknowledged)"),
      state: z.string().optional().describe("Filter by US state"),
      limit: z.number().optional().default(20).describe("Max results (default 20, max 100)"),
    },
    async ({ query, organism, developer, status, state, limit }) => {
      const conditions = [];
      const params = [];
      let paramIdx = 1;

      if (query) {
        conditions.push(`(u.organism ILIKE $${paramIdx} OR u.developer ILIKE $${paramIdx} OR u.phenotype ILIKE $${paramIdx} OR u.permit_number ILIKE $${paramIdx})`);
        params.push(`%${query}%`);
        paramIdx++;
      }
      if (organism) {
        conditions.push(`u.organism ILIKE $${paramIdx}`);
        params.push(`%${organism}%`);
        paramIdx++;
      }
      if (developer) {
        conditions.push(`u.developer ILIKE $${paramIdx}`);
        params.push(`%${developer}%`);
        paramIdx++;
      }
      if (status) {
        conditions.push(`u.status ILIKE $${paramIdx}`);
        params.push(`%${status}%`);
        paramIdx++;
      }
      if (state) {
        conditions.push(`u.state ILIKE $${paramIdx}`);
        params.push(`%${state}%`);
        paramIdx++;
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      const safeLimit = Math.min(Math.max(limit || 20, 1), 100);

      const res = await pool.query(`
        SELECT u.permit_number, u.status, u.organism, u.phenotype,
               u.developer, u.permit_type, u.release_type,
               u.effective_date, u.state
        FROM usda_permits u
        ${where}
        ORDER BY u.effective_date DESC NULLS LAST
        LIMIT ${safeLimit}
      `, params);

      if (res.rows.length === 0) {
        return { content: [{ type: "text", text: "No USDA biotech permits found matching your criteria." }] };
      }

      const summary = res.rows.map(r =>
        `${r.permit_number || "?"} | ${r.organism || "?"} | ${r.developer || "?"} | ${r.phenotype || "?"} | Status: ${r.status || "?"} | ${r.state || "?"} | ${r.effective_date || "?"}`
      ).join("\n");

      return { content: [{ type: "text", text: `Found ${res.rows.length} USDA permits:\n\n${summary}` }] };
    }
  );

  // Tool 8: USDA permit statistics
  mcp.tool(
    "get_usda_statistics",
    "Get aggregate statistics about USDA biotech permits. Use for questions like 'which companies have the most field trial permits' or 'what organisms are most commonly tested'.",
    {
      group_by: z.enum(["developer", "organism", "status", "state", "phenotype"]).describe("What to group results by"),
      organism: z.string().optional().describe("Filter by organism"),
      developer: z.string().optional().describe("Filter by developer"),
      limit: z.number().optional().default(25).describe("Max groups to return"),
    },
    async ({ group_by, organism, developer, limit }) => {
      const conditions = [];
      const params = [];
      let paramIdx = 1;

      if (organism) {
        conditions.push(`u.organism ILIKE $${paramIdx}`);
        params.push(`%${organism}%`);
        paramIdx++;
      }
      if (developer) {
        conditions.push(`u.developer ILIKE $${paramIdx}`);
        params.push(`%${developer}%`);
        paramIdx++;
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      const safeLimit = Math.min(Math.max(limit || 25, 1), 100);
      const col = `u.${group_by}`;

      const res = await pool.query(`
        SELECT ${col} as group_key, COUNT(*) as count
        FROM usda_permits u
        ${where} ${where ? "AND" : "WHERE"} ${col} IS NOT NULL AND ${col} != ''
        GROUP BY group_key
        ORDER BY count DESC
        LIMIT ${safeLimit}
      `, params);

      const text = res.rows.map(r => `${r.group_key}: ${r.count}`).join("\n");
      return { content: [{ type: "text", text: `USDA permits grouped by ${group_by}:\n\n${text}` }] };
    }
  );

  // Tool 9: Search FDA Purple Book (licensed biological products)
  mcp.tool(
    "search_biologics",
    "Search the FDA Purple Book — licensed biological products (BLAs), including proprietary name, proper name, applicant, BLA number, dosage form, route, strength, license type, and marketing status. Use for biosimilars, interchangeable products, vaccines, and other licensed biologics.",
    {
      query: z.string().optional().describe("Search across proprietary name, proper name, applicant, BLA number, and route (partial match)"),
      license_type: z.string().optional().describe("Filter by license type (e.g., 351(a), 351(k) biosimilar, 351(k) interchangeable)"),
      marketing_status: z.string().optional().describe("Filter by marketing status"),
      limit: z.number().optional().default(20).describe("Max results (default 20, max 100)"),
    },
    async ({ query, license_type, marketing_status, limit }) => {
      const conditions = [];
      const params = [];
      let paramIdx = 1;

      if (query) {
        const q = `%${query}%`;
        conditions.push(`(
          pb.proprietary_name ILIKE $${paramIdx}
          OR pb.proper_name ILIKE $${paramIdx}
          OR pb.applicant ILIKE $${paramIdx}
          OR pb.bla_number ILIKE $${paramIdx}
          OR pb.route ILIKE $${paramIdx}
        )`);
        params.push(q);
        paramIdx++;
      }
      if (license_type) {
        conditions.push(`pb.license_type ILIKE $${paramIdx}`);
        params.push(`%${license_type}%`);
        paramIdx++;
      }
      if (marketing_status) {
        conditions.push(`pb.marketing_status ILIKE $${paramIdx}`);
        params.push(`%${marketing_status}%`);
        paramIdx++;
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      const safeLimit = Math.min(Math.max(limit || 20, 1), 100);

      const res = await pool.query(
        `
        SELECT pb.bla_number, pb.proprietary_name, pb.proper_name, pb.applicant,
               pb.dosage_form, pb.route, pb.strength, pb.marketing_status,
               pb.license_type, pb.approval_date, pb.exclusivity_expiration
        FROM purple_book pb
        ${where}
        ORDER BY pb.proprietary_name NULLS LAST, pb.bla_number
        LIMIT ${safeLimit}
        `,
        params
      );

      if (res.rows.length === 0) {
        return { content: [{ type: "text", text: "No Purple Book biologics found matching your criteria." }] };
      }

      const summary = res.rows
        .map(
          (r) =>
            `${r.bla_number || "?"} | ${r.proprietary_name || "?"} | ${r.proper_name || "?"} | ${r.applicant || "?"} | ${r.route || "—"} | ${r.marketing_status || "?"} | ${r.license_type || "—"}`
        )
        .join("\n");

      return {
        content: [{ type: "text", text: `Found ${res.rows.length} Purple Book rows:\n\n${summary}` }],
      };
    }
  );

  // Tool 10: Purple Book aggregate statistics
  mcp.tool(
    "get_biologics_statistics",
    "Aggregate FDA Purple Book data by applicant, license type, route of administration, or marketing status. Use for questions like which applicants have the most licensed biologics or how products split by license type.",
    {
      group_by: z.enum(["applicant", "license_type", "route", "marketing_status"]).describe("Dimension to group by"),
      limit: z.number().optional().default(25).describe("Max groups to return (default 25, max 100)"),
    },
    async ({ group_by, limit }) => {
      const safeLimit = Math.min(Math.max(limit || 25, 1), 100);
      const col =
        group_by === "applicant"
          ? "pb.applicant"
          : group_by === "license_type"
            ? "pb.license_type"
            : group_by === "route"
              ? "pb.route"
              : "pb.marketing_status";

      const res = await pool.query(
        `
        SELECT ${col} AS group_key, COUNT(*)::int AS count
        FROM purple_book pb
        WHERE ${col} IS NOT NULL AND TRIM(${col}) != ''
        GROUP BY group_key
        ORDER BY count DESC
        LIMIT ${safeLimit}
        `
      );

      if (res.rows.length === 0) {
        return { content: [{ type: "text", text: "No Purple Book data to aggregate (table may be empty)." }] };
      }

      const text = res.rows.map((r) => `${r.group_key}: ${r.count}`).join("\n");
      return {
        content: [{ type: "text", text: `Purple Book grouped by ${group_by}:\n\n${text}` }],
      };
    }
  );

  // Tool 11: Search EPA biotech submissions (MCANs, TERAs, TMEAs)
  mcp.tool(
    "search_epa_biotech",
    "Search EPA OCSPP biotechnology submissions including Microbial Commercial Activity Notices (MCANs), TSCA Environmental Release Applications (TERAs), Test Market Exemption Applications (TMEAs), and related biotech regulatory actions. Covers TSCA biotech notifications and FIFRA biopesticide activity.",
    {
      query: z.string().optional().describe("Free text search across case number, organism, submitter, disposition, and page content"),
      submission_type: z.enum(["MCAN", "TERA", "TMEA", "any"]).optional().default("any").describe("Filter by submission type"),
      status: z.string().optional().describe("Filter by status/disposition, e.g. 'not likely to present unreasonable risk', 'consent order', 'pending'"),
      limit: z.number().optional().default(25).describe("Max results to return"),
    },
    async ({ query, submission_type, status, limit }) => {
      let where = [];
      let params = [];
      let p = 1;

      if (submission_type && submission_type !== "any") {
        where.push(`submission_type = $${p++}`);
        params.push(submission_type);
      }
      if (status) {
        where.push(`disposition ILIKE $${p++}`);
        params.push(`%${status}%`);
      }
      if (query) {
        where.push(`(
          case_number ILIKE $${p} OR
          organism ILIKE $${p} OR
          submitter ILIKE $${p} OR
          disposition ILIKE $${p} OR
          page_text ILIKE $${p}
        )`);
        params.push(`%${query}%`);
        p++;
      }

      const whereClause = where.length > 0 ? "WHERE " + where.join(" AND ") : "";
      const sql = `SELECT case_number, submission_type, received_date, organism, submitter,
                          interim_status, disposition, effective_date, source_url
                   FROM epa_biotech_submissions
                   ${whereClause}
                   ORDER BY received_date DESC NULLS LAST
                   LIMIT $${p}`;
      params.push(Math.min(Math.max(limit || 25, 1), 100));

      try {
        const res = await pool.query(sql, params);
        if (res.rows.length === 0) {
          return { content: [{ type: "text", text: "No EPA biotech submissions found matching those criteria." }] };
        }

        const summary = res.rows.map(r => {
          let entry = `${r.case_number} (${r.submission_type})`;
          if (r.received_date) entry += ` | Received: ${r.received_date}`;
          if (r.organism) entry += ` | Organism: ${r.organism}`;
          if (r.submitter) entry += ` | Submitter: ${r.submitter}`;
          if (r.disposition) entry += `\n  Disposition: ${r.disposition}`;
          if (r.effective_date) entry += ` (${r.effective_date})`;
          if (r.source_url) entry += `\n  ${r.source_url}`;
          return entry;
        }).join("\n\n");

        return { content: [{ type: "text", text: `Found ${res.rows.length} EPA biotech submissions:\n\n${summary}` }] };
      } catch (e) {
        return { content: [{ type: "text", text: `Query error: ${e.message}` }] };
      }
    }
  );

  // Tool 12: EPA biotech statistics
  mcp.tool(
    "get_epa_biotech_statistics",
    "Get aggregate statistics on EPA OCSPP biotech submissions — counts by type, disposition, year, etc.",
    {
      group_by: z.enum(["submission_type", "disposition", "year", "submitter"]).optional().default("submission_type"),
    },
    async ({ group_by }) => {
      let sql;
      switch (group_by) {
        case "year":
          sql = `SELECT EXTRACT(YEAR FROM received_date::date) as year, COUNT(*) as count
                 FROM epa_biotech_submissions
                 WHERE received_date IS NOT NULL
                 GROUP BY year ORDER BY year DESC`;
          break;
        case "submitter":
          sql = `SELECT submitter, COUNT(*) as count
                 FROM epa_biotech_submissions
                 WHERE submitter IS NOT NULL AND submitter != ''
                 GROUP BY submitter ORDER BY count DESC LIMIT 20`;
          break;
        default:
          sql = `SELECT ${group_by}, COUNT(*) as count
                 FROM epa_biotech_submissions
                 GROUP BY ${group_by} ORDER BY count DESC`;
      }

      try {
        const res = await pool.query(sql);
        const total = await pool.query("SELECT COUNT(*) FROM epa_biotech_submissions");
        const lines = res.rows.map(r => {
          const key = r[group_by] || r.year || "(unknown)";
          return `  ${key}: ${r.count}`;
        }).join("\n");
        return { content: [{ type: "text", text: `EPA Biotech Submissions — ${total.rows[0].count} total\n\nBy ${group_by}:\n${lines}` }] };
      } catch (e) {
        return { content: [{ type: "text", text: `Query error: ${e.message}` }] };
      }
    }
  );

  // Tool 13: Run custom SQL
  mcp.tool(
    "run_query",
    "Run a read-only SQL query against the regulatory database. Tables: applications (application_number, sponsor_name, application_type, brand_name, generic_name, manufacturer_name, substance_name, pharm_class, route), products (application_number, marketing_status, dosage_form, active_ingredients), submissions (application_number, submission_type, submission_number, submission_status, submission_status_date, submission_class_code_description, submission_public_notes), complete_response_letters (application_number, letter_date, company_name, letter_type, letter_text, approver_name), federal_register (document_number, title, doc_type, abstract, publication_date, html_url, agencies), usda_permits (permit_number, status, organism, phenotype, developer, permit_type, release_type, effective_date, state), purple_book (bla_number, proprietary_name, proper_name, applicant, dosage_form, route, strength, marketing_status, license_type, approval_date, exclusivity_expiration, raw_row), epa_biotech_submissions (case_number, submission_type, received_date, organism, submitter, interim_status, disposition, effective_date, source_url). Only SELECT queries are allowed.",
    {
      sql: z.string().describe("A SELECT SQL query"),
    },
    async ({ sql }) => {
      const trimmed = sql.trim().toLowerCase();
      if (!trimmed.startsWith("select")) {
        return { content: [{ type: "text", text: "Only SELECT queries are allowed." }] };
      }
      if (/\b(drop|delete|insert|update|alter|create|truncate|grant|revoke)\b/i.test(sql)) {
        return { content: [{ type: "text", text: "Write operations are not allowed." }] };
      }

      try {
        const res = await pool.query(sql + (sql.toLowerCase().includes("limit") ? "" : " LIMIT 50"));
        if (res.rows.length === 0) {
          return { content: [{ type: "text", text: "Query returned no results." }] };
        }

        const cols = Object.keys(res.rows[0]);
        const header = cols.join(" | ");
        const rows = res.rows.map(r => cols.map(c => String(r[c] ?? "")).join(" | "));
        const text = `${header}\n${"—".repeat(header.length)}\n${rows.join("\n")}`;

        return { content: [{ type: "text", text: `${res.rows.length} rows:\n\n${text}` }] };
      } catch (e) {
        return { content: [{ type: "text", text: `Query error: ${e.message}` }] };
      }
    }
  );

  return mcp;
}

// ── Express App ──

const app = express();
app.use(express.json({ limit: "10mb" }));

// Health check
app.get("/health", (req, res) => res.send("ok"));

app.post("/api/apify/ingest", async (req, res) => {
  const incomingSecret = req.headers["x-ingest-secret"];
  const expectedSecret = process.env.APIFY_INGEST_SECRET;

  if (!expectedSecret || incomingSecret !== expectedSecret) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  console.log("Apify webhook received");
  console.log(req.body);

  return res.json({ ok: true });
});

// MCP endpoint — stateless: new transport + server per request
app.post("/mcp", async (req, res) => {
  try {
    const server = createMcpServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
    });

    res.on("close", () => {
      transport.close();
      server.close();
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("Error handling MCP request:", error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

// Handle GET and DELETE on /mcp per spec
app.get("/mcp", (req, res) => {
  res.writeHead(405, { Allow: "POST" }).end(JSON.stringify({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed. Use POST." },
    id: null,
  }));
});

app.delete("/mcp", (req, res) => {
  res.writeHead(405, { Allow: "POST" }).end(JSON.stringify({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed." },
    id: null,
  }));
});

// ── Apify Webhook: receive crawled EPA data ──

app.post("/api/apify/ingest", async (req, res) => {
  const secret = req.headers["x-ingest-secret"];
  if (!secret || secret !== process.env.APIFY_INGEST_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const body = req.body;

    // Apify webhook sends run metadata with a dataset ID
    const datasetId = body?.resource?.defaultDatasetId;
    if (!datasetId) {
      return res.status(400).json({ error: "No dataset ID found in webhook payload. Make sure the payload template is set to {{resource}}" });
    }

    // Fetch the crawled pages from the Apify dataset
    const apifyToken = process.env.APIFY_API_TOKEN;
    if (!apifyToken) {
      return res.status(500).json({ error: "APIFY_API_TOKEN not configured on server" });
    }

    const apifyRes = await fetch(
      `https://api.apify.com/v2/datasets/${datasetId}/items?format=json`,
      { headers: { "Authorization": `Bearer ${apifyToken}` } }
    );

    if (!apifyRes.ok) {
      console.error("Failed to fetch Apify dataset:", apifyRes.status);
      return res.status(502).json({ error: "Failed to fetch Apify dataset" });
    }

    const items = await apifyRes.json();
    const count = await processApifyItems(items);
    console.log(`Apify ingest complete: ${items.length} pages, ${count} records inserted/updated`);
    return res.json({ ok: true, pages: items.length, inserted: count });

  } catch (e) {
    console.error("Ingest error:", e);
    return res.status(500).json({ error: e.message });
  }
});

async function processApifyItems(items) {
  let inserted = 0;

  for (const item of items) {
    const url = item.url || "";
    const text = item.text || item.markdown || "";
    if (!text) continue;

    // Look for MCAN/TERA case numbers in markdown table rows: | J-17-0007 | ... |
    const tableRowRegex = /^\|?\s*([JR]-\d{2}-\d{4})\s*\|/gm;
    let match;

    while ((match = tableRowRegex.exec(text)) !== null) {
      const lineStart = text.lastIndexOf("\n", match.index) + 1;
      const lineEnd = text.indexOf("\n", match.index);
      const line = text.slice(lineStart, lineEnd === -1 ? undefined : lineEnd).trim();

      const cells = line.split("|").map(c => c.trim()).filter(c => c);
      if (cells.length < 3) continue;

      const caseNumber = cells[0] || "";
      const submissionType = caseNumber.startsWith("J") ? "MCAN"
                           : caseNumber.startsWith("R") ? "TERA" : "OTHER";
      const receivedDate = cells[1] || null;
      const interimStatus = cells[2] || "";
      const disposition = cells.length >= 5 ? cells[4] || cells[3] || "" : cells[3] || "";
      const effectiveDate = cells[cells.length - 1] || null;

      try {
        await pool.query(
          `INSERT INTO epa_biotech_submissions
           (case_number, submission_type, received_date, interim_status, disposition, effective_date, source_url, page_text)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (case_number) DO UPDATE SET
             disposition = EXCLUDED.disposition,
             effective_date = EXCLUDED.effective_date,
             interim_status = EXCLUDED.interim_status`,
          [caseNumber, submissionType, receivedDate, interimStatus,
           disposition, effectiveDate, url, text.slice(0, 5000)]
        );
        inserted++;
      } catch (e) {
        console.error("Insert error for", caseNumber, ":", e.message);
      }
    }

    // If no table rows found but the page has biotech content, store it as a document
    const isBiotechPage = /\b(MCAN|TERA|TMEA|biotech|microbial|biopesticide|experimental use permit)\b/i.test(text);
    if (isBiotechPage && inserted === 0) {
      try {
        const docKey = `PAGE-${Buffer.from(url).toString("base64").slice(0, 40)}`;
        await pool.query(
          `INSERT INTO epa_biotech_submissions
           (case_number, submission_type, source_url, page_text)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (case_number) DO UPDATE SET page_text = EXCLUDED.page_text`,
          [docKey, "DOCUMENT", url, text.slice(0, 50000)]
        );
        inserted++;
      } catch (e) {
        console.error("Page insert error:", e.message);
      }
    }
  }

  return inserted;
}

// ── Start server ──

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`MCP server running on port ${port}`);
  console.log(`MCP endpoint: http://localhost:${port}/mcp`);
});
