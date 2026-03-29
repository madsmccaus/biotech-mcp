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

  // Tool 4: Run custom SQL
  mcp.tool(
    "run_query",
    "Run a read-only SQL query against the FDA database. Tables: applications (application_number, sponsor_name, application_type, brand_name, generic_name, manufacturer_name, substance_name, pharm_class, route), products (application_number, marketing_status, dosage_form, active_ingredients), submissions (application_number, submission_type, submission_number, submission_status, submission_status_date, submission_class_code_description, submission_public_notes). Only SELECT queries are allowed.",
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
app.use(express.json());

// Health check
app.get("/health", (req, res) => res.send("ok"));

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

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`MCP server running on port ${port}`);
  console.log(`MCP endpoint: http://localhost:${port}/mcp`);
});
