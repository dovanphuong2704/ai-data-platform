// table-reranker.ts — LLM-assisted table selection from Top-K candidates
//
// Instead of blindly using top-5 from vector search, calls GPT-4o-mini once
// to choose the most relevant 5-7 tables from a candidate pool of 20.

import { chatWithModel } from './ai';
import type { TableSummary } from './table-retrieval';

export interface RerankResult {
  selectedTables: string[];
  reasoning: string;
}

/**
 * Use a lightweight LLM (GPT-4o-mini) to select the most relevant tables
 * from a list of candidates. Reduces false positives from vector search
 * when table names overlap semantically.
 */
export async function rerankTablesWithLLM(
  candidates: TableSummary[],
  question: string,
  provider: string,
  apiKey: string,
  model?: string,
): Promise<RerankResult> {
  const tableList = candidates
    .map(t =>
      `• ${t.table_schema}.${t.table_name}\n  Mo ta: ${t.summary_text}\n  Cot: ${t.column_list}`
    )
    .join('\n\n');

  const prompt = `Ban la chuyen gia phan tich database. Cau hoi nguoi dung: "${question}"

Danh sach cac bang (theo thu tu relevance tu vector search):

${tableList}

Hay chon ra 5-7 bang THUC SU can thiet de tra loi cau hoi tren.
QUY TAC:
- Chi chon bang co THONG TIN PHU HOP voi cau hoi
- Khong chon bang chi vi ten giong nhau (false positive cua vector search)
- Luon bao gom bang CHINH (main entity) chua du lieu can thiet
- Neu cau hoi lien quan den ma/danh muc → them bang danh muc (reference table)
- Neu cau hoi yeu cau chi tiet → chi chon bang chua cot can thiet
- Tra ve JSON: {"tables": ["schema.tenbang1", "schema.tenbang2", ...], "reasoning": "..."}`;

  try {
    const response = await chatWithModel({
      provider,
      apiKey,
      model: model ?? 'gpt-4o-mini',
      systemMessage: 'Tra loi CHI JSON, khong giai thich them. Dung tieng Viet.',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0,
      maxTokens: 512,
    });

    const parsed = JSON.parse(response.content.trim());
    return {
      selectedTables: parsed.tables ?? [],
      reasoning: parsed.reasoning ?? '',
    };
  } catch (err) {
    console.warn('[table-reranker] LLM call failed, fallback to top-5:', err);
    return {
      selectedTables: candidates.slice(0, 5).map(t => `${t.table_schema}.${t.table_name}`),
      reasoning: 'LLM fallback: use top-5 from vector search',
    };
  }
}
