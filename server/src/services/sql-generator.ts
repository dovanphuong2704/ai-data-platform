/**
 * sql-generator.ts - LLM 2: Chef
 * Selected tables + DDL + FK + RAG + Docs -> SQL.
 */

import { chatWithModel } from "./ai";
import { getSimilarSQL, buildRagContext } from "./vanna-rag";
import { getRelevantDocs, buildDocsContext } from "./vanna-docs";
import { buildFocusedDDL, type TableMenuItem } from "./table-menu";
import { type SelectedTable } from "./table-selector";
import { getForeignKeys, getFKsBetweenTables, buildFKContext } from "./foreign-key-retrieval";

export interface SqlGenerationResult {
  sql: string;
  explanation: string;
  selectedTables: SelectedTable[];
  ragExamplesUsed: number;
  docsUsed: number;
}

const SYSTEM_PROMPT = [
  "Ban la chuyen gia SQL PostgreSQL.",
  "",
  "QUY TAC:",
  "0. Neu co lich su -> HIEU cau hoi AM MENH cau truoc",
  "1. Dung ten schema.table.column CHINH XAC nhu trong DDL",
  "2. CHI SELECT - cam INSERT/UPDATE/DELETE/DROP",
  "3. Dung ALIAS rong rao: VD: fire_alert AS fa, district AS d",
  "4. JOIN dung ON, KHONG dung WHERE cho join",
  "5. GROUP BY dung - cot khong phai aggregate phai co trong GROUP BY",
  "6. KHONG LIMIT neu user khong yeu cau",
  "7. PostGIS: ST_Within, ST_Distance, ST_DWithin",
  "8. ROUND(col, 2) cho so thap phan",
  "",
  "TRA VE SQL trong tag [sql]...[sql]:",
  "[sql]SELECT ...[sql]",
  "// Giai thich (1 dong)",
].join("\n");

function parseSqlFromResponse(raw: string): { sql: string; explanation: string } {
  const ts = raw.indexOf("[sql]");
  const te = raw.lastIndexOf("[/sql]");
  if (ts !== -1 && te !== -1 && te > ts) {
    const sql = raw.slice(ts + 5, te).trim();
    const exp = raw.slice(te + 6).trim().slice(0, 200);
    return { sql: sql.replace(/;$/, ""), explanation: exp };
  }
  const si = raw.indexOf("SELECT");
  const ei = raw.lastIndexOf(";");
  if (si !== -1 && ei !== -1 && ei > si) {
    return { sql: raw.slice(si, ei).trim().replace(/;$/, ""), explanation: "" };
  }
  return { sql: raw.trim().slice(0, 1000), explanation: "" };
}

export async function generateSQL(
  userQuestion: string,
  selectedTables: SelectedTable[],
  menuItems: TableMenuItem[],
  schemaJson: {
    columns: Array<{ table_schema: string; table_name: string; column_name: string; data_type: string; description?: string }>;
    foreignKeys: Array<{ table_schema: string; table_name: string; column_name: string; foreign_table_schema: string; foreign_table_name: string; foreign_column_name: string }>;
  },
  connectionId: number,
  apiKey: string,
  provider: string,
  model?: string,
  previousQuestions?: string[],
): Promise<SqlGenerationResult> {
  // 1. DDL for selected tables
  const menuItemsFiltered = menuItems.filter(m =>
    selectedTables.some(s => s.schema === m.schema && s.table === m.table)
  );
  const ddlText = buildFocusedDDL(menuItemsFiltered, schemaJson);

  // 2. RAG examples
  let ragText = "";
  let ragExamplesUsed = 0;
  try {
    const examples = await getSimilarSQL(userQuestion, connectionId, apiKey, 5, 0.55);
    if (examples.length > 0) {
      ragText = buildRagContext(examples);
      ragExamplesUsed = examples.length;
    }
  } catch (e) {
    console.warn("[sql-gen] RAG failed:", e);
  }

  // 3. Business docs
  let docsText = "";
  let docsUsed = 0;
  try {
    const docs = await getRelevantDocs(userQuestion, connectionId, apiKey, 3, 0.5);
    if (docs.length > 0) {
      docsText = buildDocsContext(docs);
      docsUsed = docs.length;
    }
  } catch (e) {
    console.warn("[sql-gen] docs failed:", e);
  }

  // 4. Foreign keys from DB
  let fkSection = "";
  try {
    // Auto-detect FKs between selected tables (no keyword needed)
    const tableFks = await getFKsBetweenTables(selectedTables, connectionId);
    // Also keyword-based FKs from question
    const kwFks = await getForeignKeys(userQuestion, connectionId, 5);

    // Merge + deduplicate
    const seen = new Set<string>();
    const allFks = [...tableFks, ...kwFks].filter(fk => {
      const k = `${fk.sourceSchema}.${fk.sourceTable}.${fk.sourceColumn}->${fk.targetSchema}.${fk.targetTable}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    if (allFks.length > 0) {
      fkSection = buildFKContext(allFks);
    }
  } catch (e) {
    console.warn("[sql-gen] FK failed:", e);
  }

  // 5. History context
  const histSection = previousQuestions && previousQuestions.length > 0
    ? "\n=== LICH SU HOI THOAI GAN DAY ===\n" + previousQuestions.map((q, i) => (i + 1) + ". " + q).join("\n") + "\n"
    : "";

  // 6. Selected tables text
  const tablesText = selectedTables
    .map(t => "  - " + t.schema + "." + t.table + ": " + t.reason)
    .join("\n");

  const userContent = [
    histSection,
    "Cau hoi: " + userQuestion,
    "",
    "Bang duoc chon (" + selectedTables.length + " bang):",
    tablesText,
    "",
    "=== DDL CHI TIET ===",
    ddlText,
    fkSection,
    ragText ? "\n=== VI DU THAM KHAO ===\n" + ragText : "",
    docsText ? "\n=== QUY TAC NGHIEP VU ===\n" + docsText : "",
  ].filter(Boolean).join("\n");

  const modelMap: Record<string, string> = {
    gemini: model ?? "gemini-2.5-pro",
    openai: model ?? "gpt-4o-mini",
    grok: model ?? "grok-2-mini",
    claude: model ?? "claude-3-5-haiku-20241022",
  };

  const modelName = modelMap[provider] ?? "gemini-2.5-pro";

  const response = await chatWithModel({
    provider,
    apiKey,
    model: modelName,
    systemMessage: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userContent }],
    temperature: 0.1,
    maxTokens: 4096,
  });

  const { sql, explanation } = parseSqlFromResponse(response.content);

  return {
    sql,
    explanation: explanation || "SQL da duoc tao dua tren cau hoi va schema.",
    selectedTables,
    ragExamplesUsed,
    docsUsed,
  };
}
