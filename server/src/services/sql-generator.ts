/**
 * sql-generator.ts - LLM 2: Chef
 * Selected tables + DDL + FK + RAG + Docs -> SQL.
 * Sau generate, goi AI Reviewer de danh gia SQL.
 * Neu co van de -> feedback + generate lai (max 2 retry).
 */

import { chatWithModel } from "./ai";
import { getSimilarSQL, buildRagContext } from "./vanna-rag";
import { getRelevantDocs, buildDocsContext } from "./vanna-docs";
import { buildFocusedDDL, type TableMenuItem } from "./table-menu";
import { type SelectedTable } from "./table-selector";
import { getForeignKeys, getFKsBetweenTables, buildFKContext } from "./foreign-key-retrieval";
import { reviewSQL, buildReviewerFeedback, type ReviewResult } from "./sql-reviewer";

export interface SqlGenerationResult {
  sql: string;
  explanation: string;
  rawResponse: string; // full raw text from LLM (for narrative extraction in chat.ts)
  selectedTables: SelectedTable[];
  ragExamplesUsed: number;
  docsUsed: number;
  reviewResult?: ReviewResult; // review info for logging/debugging
  reviewAttempts: number;       // so lan reviewer duoc goi
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
  "SAU KHI VIET SQL XONG, HAY VIET 1-3 CAU phan tich ket qua bang tieng Viet co dau, nhu mot tro ly that su.",
  "Vi du: 'Day la danh sach cac camera. Tong cong co X camera, phan bo tai cac huyen...',",
  "'Duoi day la dien tich cac huyen. Huyenn co dien tich lon nhat la...',",
  "'Cong ty nao co doanh thu cao nhat? Tim thay roi...',",
  "",
  "TRA VE:",
  "[sql]SELECT ...[sql]",
  "(Viet 1-3 cau phan tich ket qua ngay sau day, bang tieng Viet co dau, khong can JSON)",
].join("\n");

function parseSqlFromResponse(raw: string): { sql: string; explanation: string } {
  const ts = raw.indexOf("[sql]");
  const te = raw.lastIndexOf("[/sql]");
  if (ts !== -1 && te !== -1 && te > ts) {
    const sql = raw.slice(ts + 5, te).trim();
    const after = raw.slice(te + 6).trim();
    // Only use as explanation if it's non-trivial text (not more SQL/JSON)
    const isNonTrivial = after.length > 0
      && !after.toUpperCase().startsWith('SELECT')
      && !after.startsWith('{')
      && !after.startsWith('[');
    return { sql: sql.replace(/;$/, ""), explanation: isNonTrivial ? after : "" };
  }
  const si = raw.indexOf("SELECT");
  const ei = raw.lastIndexOf(";");
  if (si !== -1 && ei !== -1 && ei > si) {
    return { sql: raw.slice(si, ei).trim().replace(/;$/, ""), explanation: "" };
  }
  return { sql: raw.trim().slice(0, 1000), explanation: "" };
}

async function callVannaModel(
  provider: string,
  apiKey: string,
  modelName: string,
  systemMessage: string,
  userContent: string,
): Promise<{ sql: string; explanation: string; rawResponse: string }> {
  const response = await chatWithModel({
    provider,
    apiKey,
    model: modelName,
    systemMessage,
    messages: [{ role: "user", content: userContent }],
    temperature: 0.1,
    maxTokens: 4096,
  });
  const { sql, explanation } = parseSqlFromResponse(response.content);
  return { sql, explanation, rawResponse: response.content };
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
  const MAX_REVIEW_ATTEMPTS = 2;

  // ── Build shared context ──────────────────────────────────────────────────────
  const menuItemsFiltered = menuItems.filter(m =>
    selectedTables.some(s => s.schema === m.schema && s.table === m.table)
  );
  const ddlText = buildFocusedDDL(menuItemsFiltered, schemaJson);

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

  let fkSection = "";
  try {
    const tableFks = await getFKsBetweenTables(selectedTables, connectionId);
    const kwFks = await getForeignKeys(userQuestion, connectionId, 5);
    const seen = new Set<string>();
    const allFks = [...tableFks, ...kwFks].filter(fk => {
      const k = `${fk.sourceSchema}.${fk.sourceTable}.${fk.sourceColumn}->${fk.targetSchema}.${fk.targetTable}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    if (allFks.length > 0) fkSection = buildFKContext(allFks);
  } catch (e) {
    console.warn("[sql-gen] FK failed:", e);
  }

  const modelMap: Record<string, string> = {
    gemini: model ?? "gemini-2.5-pro",
    openai: model ?? "gpt-4o-mini",
    grok: model ?? "grok-2-mini",
    claude: model ?? "claude-3-5-haiku-20241022",
  };
  const modelName = modelMap[provider] ?? "gemini-2.5-pro";

  // ── Generate SQL + Review loop ────────────────────────────────────────────────
  let currentSql = "";
  let currentRawResponse = "";
  let currentExplanation = "";
  let lastReviewResult: ReviewResult | undefined;
  let reviewAttempts = 0;
  let previousIssues: string[] = [];

  // Build base context (without feedback)
  const buildBaseContext = (feedback?: string) => {
    const histSection = previousQuestions && previousQuestions.length > 0
      ? "\n=== LICH SU HOI THOAI GAN DAY ===\n" + previousQuestions.map((q, i) => (i + 1) + ". " + q).join("\n") + "\n"
      : "";
    const tablesText = selectedTables
      .map(t => "  - " + t.schema + "." + t.table + ": " + t.reason)
      .join("\n");
    const parts = [
      feedback || "",
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
    ].filter(Boolean);
    return parts.join("\n");
  };

  // ── Attempt 1: Generate initial SQL ────────────────────────────────────────────
  console.log(`[sql-gen] Generate #${reviewAttempts + 1}...`);
  let attempt1 = await callVannaModel(provider, apiKey, modelName, SYSTEM_PROMPT, buildBaseContext());
  currentSql = attempt1.sql;
  currentRawResponse = attempt1.rawResponse;
  currentExplanation = attempt1.explanation;
  reviewAttempts++;

  // ── Review attempt 1 ────────────────────────────────────────────────────────────
  console.log(`[sql-gen] Review #${reviewAttempts}...`);
  let reviewResult = await reviewSQL(
    userQuestion,
    currentSql,
    selectedTables,
    ddlText,
    ragText,
    previousIssues,
    apiKey,
    provider,
    model,
    schemaJson,
  );
  lastReviewResult = reviewResult;
  console.log(`[sql-gen] Review #${reviewAttempts}: isValid=${reviewResult.isValid}, confidence=${reviewResult.confidence}, issues=${reviewResult.issues.length}`);
  if (reviewResult.issues.length > 0) {
    console.log(`[sql-gen] Issues:`, reviewResult.issues);
  }

  // ── Retry loop: max 2 retries if invalid ─────────────────────────────────────
  while (!reviewResult.isValid && reviewAttempts <= MAX_REVIEW_ATTEMPTS) {
    // Build feedback prompt
    const feedback = buildReviewerFeedback(
      userQuestion,
      reviewResult,
      selectedTables,
      ddlText,
      ragText,
    );
    const userContent = [
      feedback,
      "",
      "Hay viet lai SQL moi phu hop voi feedback.",
    ].join("\n");

    reviewAttempts++;
    console.log(`[sql-gen] Generate #${reviewAttempts} (retry after review)...`);
    const attempt = await callVannaModel(provider, apiKey, modelName, SYSTEM_PROMPT, userContent);
    currentSql = attempt.sql;
    currentRawResponse = attempt.rawResponse;
    currentExplanation = attempt.explanation;
    previousIssues = [...previousIssues, ...reviewResult.issues];

    // Review again
    console.log(`[sql-gen] Review #${reviewAttempts}...`);
    reviewResult = await reviewSQL(
      userQuestion,
      currentSql,
      selectedTables,
      ddlText,
      ragText,
      previousIssues,
      apiKey,
      provider,
      model,
      schemaJson,
    );
    lastReviewResult = reviewResult;
    console.log(`[sql-gen] Review #${reviewAttempts}: isValid=${reviewResult.isValid}, confidence=${reviewResult.confidence}`);
  }

  return {
    sql: currentSql,
    explanation: currentExplanation || "SQL da duoc tao dua tren cau hoi va schema.",
    rawResponse: currentRawResponse,
    selectedTables,
    ragExamplesUsed,
    docsUsed,
    reviewResult: lastReviewResult,
    reviewAttempts,
  };
}
