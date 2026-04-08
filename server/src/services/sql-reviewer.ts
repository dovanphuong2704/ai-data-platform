/**
 * sql-reviewer.ts — AI Reviewer Agent
 *
 * Sau khi Vanna generate SQL, reviewer danh gia:
 * 1. SQL co dung cu phap PostgreSQL?
 * 2. Table/column co ton tai trong schema?
 * 3. JOIN/WHERE/GROUP BY logic co dung voi cau hoi?
 * 4. Vanna co hieu dung y nguoi dung?
 *
 * Neu co van de -> feedback + revised SQL -> Vanna sua lai.
 * Validation columns truc tiep tu schemaJson (khong can LLM) truoc khi goi reviewer LLM.
 */

import { chatWithModel } from './ai';

export interface ReviewResult {
  isValid: boolean;
  issues: string[];
  feedback: string;
  revisedSql?: string;
  confidence: number;
}

// ── Column validation ───────────────────────────────────────────────────────────

/**
 * Parse column references from SQL.
 * Handles: schema.table.column, table.column, alias.column
 */
function extractColumnRefsFromSQL(sql: string): Array<{ schema?: string; table: string; column: string }> {
  const refs: Array<{ schema?: string; table: string; column: string }> = [];
  // Match patterns: schema.table.column, table.column
  const pattern = /\b([a-zA-Z_][a-zA-Z0-9_]*)\.([a-zA-Z_][a-zA-Z0-9_]*)\.([a-zA-Z_][a-zA-Z0-9_]*)\b/g;
  const SKIP_TOKENS = new Set([
    'SELECT', 'FROM', 'WHERE', 'GROUP', 'ORDER', 'HAVING', 'JOIN', 'LEFT', 'RIGHT',
    'INNER', 'OUTER', 'FULL', 'CROSS', 'AND', 'NOT', 'WITH', 'AS', 'ON',
    'IN', 'IS', 'NULL', 'LIMIT', 'OFFSET', 'UNION', 'CASE', 'WHEN',
    'THEN', 'ELSE', 'END', 'EXISTS', 'BETWEEN', 'LIKE', 'ASC', 'DESC',
    'COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'COALESCE', 'NULLIF',
    'CAST', 'ROUND', 'DATE', 'NOW', 'CURRENT', 'TRUE', 'FALSE',
    'ALL', 'DISTINCT', 'ANY', 'TABLE', 'INDEX', 'SCHEMA', 'DATABASE',
  ]);
  let match;
  while ((match = pattern.exec(sql)) !== null) {
    const schema = match[1];
    const table = match[2];
    const column = match[3];
    if (SKIP_TOKENS.has(table.toUpperCase())) continue;
    refs.push({ schema, table, column });
  }
  return refs;
}

/**
 * Validate that all columns referenced in SQL exist in the schema.
 * Runs BEFORE LLM review to catch obvious column errors immediately.
 */
function validateSQLColumns(
  sql: string,
  schemaJson: {
    columns: Array<{ table_schema: string; table_name: string; column_name: string }>;
  },
): string[] {
  const errors: string[] = [];
  const refs = extractColumnRefsFromSQL(sql);

  // Build lookup: "schema.table.column" -> true / "table.column" -> true
  const validColumns = new Set<string>();
  for (const col of schemaJson.columns) {
    validColumns.add(`${col.table_schema}.${col.table_name}.${col.column_name}`);
    validColumns.add(`${col.table_name}.${col.column_name}`);
  }

  for (const ref of refs) {
    const fullKey = ref.schema
      ? `${ref.schema}.${ref.table}.${ref.column}`
      : `${ref.table}.${ref.column}`;
    if (!validColumns.has(fullKey)) {
      // Try without schema
      const shortKey = `${ref.table}.${ref.column}`;
      if (!validColumns.has(shortKey)) {
        errors.push(`Cot '${ref.column}' trong bang '${ref.table}' khong ton tai trong schema.`);
      }
    }
  }

  return errors;
}

// ── Reviewer prompt ──────────────────────────────────────────────────────────────

const REVIEWER_SYSTEM_PROMPT = [
  "Ban la mot chuyen gia SQL PostgreSQL dong vai tro REVIEWER.",
  "",
  "NHIEM VU: Danh gia SQL do Vanna tao ra co DUNG, AN TOAN va HOP LY voi cau hoi nguoi dung hay khong.",
  "",
  "BAN PHAI XEM XET TAT CA cac khia canh sau:",
  "",
  "1. CORRECTNESS (Dung hay sai?):",
  "   - Table va column co ton tai trong DDL duoc cung cap?",
  "   - Data type cua column co phu hop voi phep toan (so sanh, aggregate)?",
  "   - JOIN giua cac bang co chinh xac? Foreign keys co dung?",
  "   - WHERE clause co loc dung du lieu can thiet?",
  "   - GROUP BY co day du cac cot non-aggregate?",
  "   - ORDER BY dung cot can thiet?",
  "",
  "2. LOGIC (Co hieu dung yeu cau nguoi dung?):",
  "   - SQL nay co tra loi dung cau hoi nguoi dung?",
  "   - Neu nguoi dung hoi ve 'diem chay theo thang' ma SQL chi dem tong so -> SAI",
  "   - Neu nguoi dung hoi ve 'huyen nao nhieu diem chay nhat' ma SQL khong GROUP BY district -> SAI",
  "   - Neu nguoi dung hoi ve 'dien tich' ma SQL hoi ve 'so luong' -> SAI",
  "   - Neu cau hoi co filter thoi gian (tuan nay, thang nay) ma SQL khong co -> SAI",
  "",
  "3. SAFETY (Co an toan?):",
  "   - Chi SELECT, khong INSERT/UPDATE/DELETE/DROP/ALTER/TRUNCATE",
  "   - Khong co semicolon chen them",
  "   - LIMIT hop ly (neu co nhieu ket qua)",
  "",
  "4. COMPLETENESS (Day du?):",
  "   - Tat ca cac bang can thiet co duoc JOIN chua?",
  "   - Cac cot _code co duoc JOIN den bang danh muc tuong ung chua?",
  "   - Neu cau hoi yeu cau nhieu cot, SQL co lay day du khong?",
  "",
  "THANG CONFIENCE:",
  "   - 0.0-0.3: Rat yeu - SQL co nhieu van de nghiem trong",
  "   - 0.4-0.6: Trung binh - Co mot so van de nho",
  "   - 0.7-0.8: Tot - Can xem lai mot so chi tiet",
  "   - 0.9-1.0: Xuat sac - SQL dung hoan toan",
  "",
  "TRA VE JSON thuan, khong markdown:",
  '{"isValid": true/false, "issues": ["van de 1", "van de 2"], "feedback": "Mo ta ro rang van de va huong dan Vanna sua", "confidence": 0.0-1.0}',
  "",
  "QUY TAC QUAN TRONG:",
  "- Neu co BAT KY van de nao -> isValid = false",
  "- feedback PHAI ro rang, chi dinh van de CU THE trong SQL",
  "- confidence PHAI phan anh dung muc do tuong minh cua danh gia",
].join("\n");

// ── Main review function ────────────────────────────────────────────────────────

export async function reviewSQL(
  userQuestion: string,
  generatedSql: string,
  selectedTables: Array<{ schema: string; table: string; reason?: string }>,
  ddlText: string,
  ragExamples: string,
  previousIssues: string[],
  apiKey: string,
  provider: string,
  model?: string,
  schemaJson?: {
    columns: Array<{ table_schema: string; table_name: string; column_name: string }>;
  },
): Promise<ReviewResult> {
  // ── Pre-validation: check column existence BEFORE LLM review ──
  if (schemaJson && schemaJson.columns.length > 0) {
    const colErrors = validateSQLColumns(generatedSql, schemaJson);
    if (colErrors.length > 0) {
      return {
        isValid: false,
        issues: colErrors,
        feedback: `SQL chua ${colErrors.length} loi column: "${colErrors[0]}". Hay sua lai SQL.`,
        confidence: 0.2,
      };
    }
  }

  const attempts = previousIssues.length > 0
    ? `Lan sua truoc do:\n${previousIssues.map((i, idx) => `${idx + 1}. ${i}`).join('\n')}`
    : '';

  const userContent = [
    attempts,
    `=== CAU HOI NGUOI DUNG ===\n"${userQuestion}"`,
    "",
    `=== CAC BANG DA DUOC CHON ===\n${selectedTables.map(t => `- ${t.schema}.${t.table}: ${t.reason || ''}`).join('\n')}`,
    "",
    `=== DDL (SCHEMA) ===\n${ddlText}`,
    ragExamples ? `=== VI DU THAM KHAO ===\n${ragExamples}` : '',
    "",
    `=== SQL DO VANNA TAO ===\n${generatedSql}`,
    "",
    "Hay danh gia SQL tren theo 4 khia canh: CORRECTNESS, LOGIC, SAFETY, COMPLETENESS.",
  ].filter(Boolean).join("\n");

  try {
    const response = await chatWithModel({
      provider,
      apiKey,
      model: model || undefined,
      systemMessage: REVIEWER_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userContent }],
      temperature: 0.1,
      maxTokens: 2048,
    });

    const raw = response.content.trim();
    // Extract JSON: find first '{' and count braces to find matching '}'
    const firstBraceIdx = raw.indexOf('{');
    if (firstBraceIdx === -1) {
      return {
        isValid: false,
        issues: ['Reviewer khong tra ve JSON'],
        feedback: 'Co loi khi reviewer danh gia SQL. Hay thu lai.',
        confidence: 0,
      };
    }

    let depth = 0;
    let endIdx = -1;
    for (let i = firstBraceIdx; i < raw.length; i++) {
      const ch = raw[i];
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) { endIdx = i + 1; break; }
      }
    }

    if (endIdx === -1) {
      return {
        isValid: false,
        issues: ['Reviewer tra ve JSON khong day du'],
        feedback: 'Co loi khi reviewer danh gia SQL. Hay thu lai.',
        confidence: 0,
      };
    }

    let parsed: {
      isValid?: boolean;
      issues?: unknown[];
      feedback?: string;
      confidence?: number;
    };
    try {
      parsed = JSON.parse(raw.slice(firstBraceIdx, endIdx));
    } catch {
      return {
        isValid: false,
        issues: ['Reviewer tra ve JSON khong hop le'],
        feedback: 'Reviewer tra ve dinh dang khong dung. Hay thu lai.',
        confidence: 0,
      };
    }

    const issues = Array.isArray(parsed.issues)
      ? (parsed.issues.filter(i => typeof i === 'string') as string[]).map(i => String(i))
      : [];
    const feedback = typeof parsed.feedback === 'string' && parsed.feedback.length > 5
      ? parsed.feedback
      : issues.length > 0 ? `Co ${issues.length} van de can sua.` : 'SQL can duoc xem lai.';

    return {
      isValid: Boolean(parsed.isValid),
      issues,
      feedback,
      confidence: typeof parsed.confidence === 'number'
        ? Math.max(0, Math.min(1, parsed.confidence))
        : 0.5,
    };
  } catch (err) {
    console.error('[sql-reviewer] review failed:', err);
    return {
      isValid: true, // Fallback: cho phep execute neu reviewer fail
      issues: [],
      feedback: '',
      confidence: 0,
    };
  }
}

// ── Feedback builder for retries ─────────────────────────────────────────────────

export function buildReviewerFeedback(
  originalQuestion: string,
  reviewResult: ReviewResult,
  selectedTables: Array<{ schema: string; table: string; reason?: string }>,
  ddlText: string,
  ragExamples?: string,
): string {
  const revisionNumber = (reviewResult.issues?.length ?? 0) + 1;

  return [
    `=== LAN SUA LAN THU ${revisionNumber} ===`,
    `Cau hoi goc: "${originalQuestion}"`,
    "",
    "VAN DE PHAT HIEN:",
    reviewResult.issues.length > 0
      ? reviewResult.issues.map((i, idx) => `${idx + 1}. ${i}`).join('\n')
      : reviewResult.feedback,
    "",
    "FEEDBACK TU REVIEWER:",
    reviewResult.feedback,
    "",
    "YEU CAU:",
    "- Hay SUA SQL dua tren feedback cua reviewer",
    "- Chi sua phan SAI, giu nguyen phan DUNG",
    "- Tra ve SQL moi trong tag [sql]...[sql]",
    "- Sau do viet 1-3 cau phan tich ket qua bang tieng Viet co dau",
    "",
    "DANH SACH BANG:",
    selectedTables.map(t => `- ${t.schema}.${t.table}`).join('\n'),
    ragExamples ? `\n=== VI DU THAM KHAO ===\n${ragExamples}` : '',
  ].filter(Boolean).join('\n');
}
