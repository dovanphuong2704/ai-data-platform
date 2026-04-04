'use client';

import { useState, useEffect, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import {
  RefreshCw, Database, List, Brain, Link2, BookOpen,
  FileText, Loader2, ChevronDown, ChevronRight,
  Plus, Trash2, Copy, CheckCircle2, XCircle, Eye, EyeOff,
} from 'lucide-react';
import { trainingApi, type TrainingConnectionStatus, type TrainingMenu, type TrainingSummary, type TrainingFK, type TrainingExample } from '@/lib/api';

const TABS = [
  { key: 'overview', icon: Brain, labelKey: 'overview' },
  { key: 'menu', icon: List, labelKey: 'tableMenu' },
  { key: 'embeddings', icon: Database, labelKey: 'embeddings' },
  { key: 'fks', icon: Link2, labelKey: 'foreignKeys' },
  { key: 'examples', icon: BookOpen, labelKey: 'sqlExamples' },
  { key: 'snapshot', icon: FileText, labelKey: 'schemaSnapshot' },
] as const;

type TabKey = typeof TABS[number]['key'];

export default function AiTrainingPage() {
  const t = useTranslations('aiTraining');
  const tc = useTranslations('common');

  const [connections, setConnections] = useState<TrainingConnectionStatus[]>([]);
  const [selectedConnId, setSelectedConnId] = useState<number | null>(null);
  const [activeTab, setActiveTab] = useState<TabKey>('overview');
  const [loading, setLoading] = useState(false);
  const [seeding, setSeeding] = useState(false);

  // Tab data
  const [menu, setMenu] = useState<TrainingMenu | null>(null);
  const [summaries, setSummaries] = useState<TrainingSummary[]>([]);
  const [summaryPage, setSummaryPage] = useState(1);
  const [summaryTotal, setSummaryTotal] = useState(0);
  const [fks, setFks] = useState<TrainingFK[]>([]);
  const [fkPage, setFkPage] = useState(1);
  const [fkTotal, setFkTotal] = useState(0);
  const [examples, setExamples] = useState<TrainingExample[]>([]);
  const [examplePage, setExamplePage] = useState(1);
  const [exampleTotal, setExampleTotal] = useState(0);
  const [snapshot, setSnapshot] = useState<{ table_count: number; column_count: number; version_hash: string; updated_at: string; preview_text: string } | null>(null);
  const [showSql, setShowSql] = useState<Record<number, boolean>>({});

  // Example editor
  const [showEditor, setShowEditor] = useState(false);
  const [editQuestion, setEditQuestion] = useState('');
  const [editSql, setEditSql] = useState('');
  const [editSaving, setEditSaving] = useState(false);

  const selectedConn = connections.find(c => c.id === selectedConnId);

  // Load connections on mount
  useEffect(() => {
    trainingApi.listConnections().then(r => {
      setConnections(r.data.data);
      if (r.data.data.length && !selectedConnId) {
        setSelectedConnId(r.data.data[0].id);
      }
    }).catch(console.error);
  }, []);

  // Load tab data when connection or tab changes
  useEffect(() => {
    if (!selectedConnId) return;
    loadTabData(activeTab);
  }, [selectedConnId, activeTab, summaryPage, fkPage, examplePage]);

  async function loadTabData(tab: TabKey) {
    setLoading(true);
    try {
      switch (tab) {
        case 'overview':
        case 'menu': {
          const r = await trainingApi.getMenu(selectedConnId!);
          setMenu(r.data.data ?? null);
          break;
        }
        case 'embeddings': {
          const r = await trainingApi.getSummaries(selectedConnId!, summaryPage, 50);
          setSummaries(r.data.entries);
          setSummaryTotal(r.data.pagination.total);
          break;
        }
        case 'fks': {
          const r = await trainingApi.getForeignKeys(selectedConnId!, fkPage, 100);
          setFks(r.data.entries);
          setFkTotal(r.data.totalCount);
          break;
        }
        case 'examples': {
          const r = await trainingApi.getExamples(selectedConnId!, examplePage, 20);
          setExamples(r.data.entries);
          setExampleTotal(r.data.pagination.total);
          break;
        }
        case 'snapshot': {
          const r = await trainingApi.getSnapshot(selectedConnId!);
          setSnapshot(r.data.data ?? null);
          break;
        }
      }
    } catch (e) {
      console.error('[ai-training] load error:', e);
    } finally {
      setLoading(false);
    }
  }

  async function handleSeed(sections: string[]) {
    if (!selectedConnId) return;
    setSeeding(true);
    try {
      await trainingApi.seed({ connectionId: selectedConnId, sections });
      await loadTabData(activeTab);
    } catch (e) {
      console.error('[ai-training] seed error:', e);
    } finally {
      setSeeding(false);
    }
  }

  async function handleAddExample() {
    if (!selectedConnId || !editQuestion.trim() || !editSql.trim()) return;
    setEditSaving(true);
    try {
      await trainingApi.addExample({ connectionId: selectedConnId, question: editQuestion, sql: editSql });
      setShowEditor(false);
      setEditQuestion('');
      setEditSql('');
      await loadTabData('examples');
    } catch (e) {
      console.error('[ai-training] add example error:', e);
    } finally {
      setEditSaving(false);
    }
  }

  async function handleDeleteExample(id: number) {
    if (!confirm('Delete this example?')) return;
    try {
      await trainingApi.deleteExample(id);
      await loadTabData('examples');
    } catch (e) {
      console.error('[ai-training] delete error:', e);
    }
  }

  function copyToClipboard(text: string) {
    navigator.clipboard.writeText(text).catch(console.error);
  }

  const conn = selectedConn;
  const pages = Math.ceil(summaryTotal / 50);
  const exPages = Math.ceil(exampleTotal / 20);

  return (
    <div className="flex flex-col h-full">
      {/* Header bar */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-[#30363d]">
        <div className="flex items-center gap-4">
          {/* Connection selector */}
          <div className="relative">
            <select
              value={selectedConnId ?? ''}
              onChange={e => setSelectedConnId(Number(e.target.value))}
              className="appearance-none pl-3 pr-8 py-2 bg-[#0d1117] border border-[#30363d] rounded-lg text-sm text-[#e6edf3] focus:border-[#58a6ff] focus:outline-none cursor-pointer min-w-[200px]"
            >
              <option value="">-- Select Connection --</option>
              {connections.map(c => (
                <option key={c.id} value={c.id}>
                  {c.profile_name || c.db_name} ({c.db_host}/{c.db_name})
                </option>
              ))}
            </select>
            <ChevronDown size={14} className="absolute right-2 top-1/2 -translate-y-1/2 text-[#8b949e] pointer-events-none" />
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => handleSeed(['all'])}
            disabled={!selectedConnId || seeding}
            className="flex items-center gap-2 px-3 py-1.5 bg-[#238636] hover:bg-[#2ea043] text-white text-sm rounded-lg disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {seeding ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
            {t('refreshAll')}
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-[#30363d] px-6">
        {TABS.map(({ key, icon: Icon, labelKey }) => (
          <button
            key={key}
            onClick={() => setActiveTab(key)}
            className={`flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
              activeTab === key
                ? 'border-[#58a6ff] text-[#58a6ff]'
                : 'border-transparent text-[#8b949e] hover:text-[#e6edf3]'
            }`}
          >
            <Icon size={14} />
            {t(labelKey)}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto p-6">
        {!selectedConnId && (
          <div className="flex items-center justify-center h-full text-[#8b949e]">
            <p>{t('selectConnection')}</p>
          </div>
        )}

        {selectedConnId && loading && (
          <div className="flex items-center justify-center h-32">
            <Loader2 size={24} className="animate-spin text-[#58a6ff]" />
          </div>
        )}

        {selectedConnId && !loading && activeTab === 'overview' && (
          <OverviewTab conn={conn} onRefresh={(sec) => handleSeed(sec)} seeding={seeding} />
        )}

        {selectedConnId && !loading && activeTab === 'menu' && (
          <TableMenuTab menu={menu} onRefresh={() => handleSeed(['menu'])} seeding={seeding} />
        )}

        {selectedConnId && !loading && activeTab === 'embeddings' && (
          <EmbeddingsTab
            summaries={summaries}
            page={summaryPage}
            total={summaryTotal}
            pages={pages}
            onPageChange={setSummaryPage}
            onRefresh={() => handleSeed(['summaries'])}
            seeding={seeding}
          />
        )}

        {selectedConnId && !loading && activeTab === 'fks' && (
          <FkTab
            fks={fks}
            totalCount={fkTotal}
            onRefresh={() => handleSeed(['fks'])}
            seeding={seeding}
          />
        )}

        {selectedConnId && !loading && activeTab === 'examples' && (
          <ExamplesTab
            examples={examples}
            page={examplePage}
            total={exampleTotal}
            pages={exPages}
            onPageChange={setExamplePage}
            showSql={showSql}
            onToggleSql={id => setShowSql(p => ({ ...p, [id]: !p[id] }))}
            onAdd={() => setShowEditor(true)}
            onDelete={handleDeleteExample}
            editing={showEditor}
            editQuestion={editQuestion}
            editSql={editSql}
            onQuestionChange={setEditQuestion}
            onSqlChange={setEditSql}
            onSave={handleAddExample}
            onCancel={() => { setShowEditor(false); setEditQuestion(''); setEditSql(''); }}
            saving={editSaving}
            onRefreshExamples={() => handleSeed(['examples'])}
            seeding={seeding}
          />
        )}

        {selectedConnId && !loading && activeTab === 'snapshot' && (
          <SnapshotTab
            snapshot={snapshot}
            onRefresh={() => handleSeed(['snapshot'])}
            seeding={seeding}
          />
        )}
      </div>
    </div>
  );
}

// ─── Tab Components ─────────────────────────────────────────────────────────────

function OverviewTab({
  conn, onRefresh, seeding,
}: {
  conn: TrainingConnectionStatus | undefined;
  onRefresh: (s: string[]) => void;
  seeding: boolean;
}) {
  const t = useTranslations('aiTraining');
  const stats = [
    { label: t('stats.tables'), value: conn?.total_tables ?? 0, icon: Database, color: 'text-blue-400' },
    { label: t('stats.summaries'), value: conn?.summary_count ?? 0, icon: Brain, color: 'text-purple-400' },
    { label: t('stats.fkHard'), value: conn?.fk_count ?? 0, icon: Link2, color: 'text-green-400' },
    { label: t('stats.fkSoft'), value: conn?.soft_fk_count ?? 0, icon: Link2, color: 'text-yellow-400' },
    { label: t('stats.examples'), value: conn?.example_count ?? 0, icon: BookOpen, color: 'text-orange-400' },
  ];

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        {stats.map(s => (
          <div key={s.label} className="bg-[#161b22] border border-[#30363d] rounded-xl p-4">
            <div className="flex items-center gap-2 mb-2">
              <s.icon size={16} className={s.color} />
              <span className="text-xs text-[#8b949e]">{s.label}</span>
            </div>
            <p className="text-2xl font-bold text-[#e6edf3]">{Number(s.value) || 0}</p>
          </div>
        ))}
      </div>

      {conn?.snapshot_updated_at && (
        <div className="bg-[#161b22] border border-[#30363d] rounded-xl p-4">
          <p className="text-sm text-[#8b949e]">
            {t('stats.snapshotAge')}: <span className="text-[#e6edf3]">
              {new Date(conn.snapshot_updated_at).toLocaleString()}
            </span>
            {' '}({t('stats.snapshotInfo', { tables: conn.table_count ?? 0, cols: conn.column_count ?? 0 })})
          </p>
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {[
          { label: t('refreshMenu'), sections: ['menu'] },
          { label: t('refreshEmbeddings'), sections: ['summaries'] },
          { label: t('refreshFKs'), sections: ['fks'] },
          { label: t('refreshExamples'), sections: ['examples'] },
          { label: t('refreshSnapshot'), sections: ['snapshot'] },
        ].map(action => (
          <button
            key={action.label}
            onClick={() => onRefresh(action.sections)}
            disabled={seeding}
            className="flex items-center gap-2 px-3 py-1.5 bg-[#21262d] hover:bg-[#30363d] border border-[#30363d] text-sm text-[#e6edf3] rounded-lg disabled:opacity-50 transition-colors"
          >
            {seeding ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
            {action.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function TableMenuTab({ menu, onRefresh, seeding }: { menu: TrainingMenu | null; onRefresh: () => void; seeding: boolean }) {
  const t = useTranslations('aiTraining');
  const items = (menu?.menu_json ?? []) as Array<{ schema: string; table: string; topic: string; columns: string; fkHint: string }>;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-[#8b949e]">
          {menu ? `${items.length} tables · ${t('generatedAt')}: ${new Date(menu.generated_at).toLocaleString()}` : t('noMenu')}
        </p>
        <button onClick={onRefresh} disabled={seeding} className="flex items-center gap-1.5 px-3 py-1.5 bg-[#238636] hover:bg-[#2ea043] text-white text-sm rounded-lg disabled:opacity-50 transition-colors">
          {seeding ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
          {t('refresh')}
        </button>
      </div>

      <div className="space-y-1 font-mono text-xs max-h-[600px] overflow-auto">
        {items.slice(0, 100).map((item, i) => (
          <div key={i} className="flex items-start gap-2 px-3 py-1.5 bg-[#0d1117] rounded hover:bg-[#161b22]">
            <span className="text-[#58a6ff] min-w-[4px]">•</span>
            <span className="text-[#e6edf3]">{item.schema}.{item.table}:</span>
            <span className="text-[#7ee787]">[{item.topic}]</span>
            <span className="text-[#8b949e] flex-1 truncate">{item.columns}</span>
            {item.fkHint && <span className="text-[#d29922] flex-shrink-0">{item.fkHint}</span>}
          </div>
        ))}
        {items.length > 100 && (
          <p className="text-xs text-[#8b949e] px-3 py-2">...and {items.length - 100} more</p>
        )}
      </div>
    </div>
  );
}

function EmbeddingsTab({
  summaries, page, total, pages, onPageChange, onRefresh, seeding,
}: {
  summaries: TrainingSummary[];
  page: number; total: number; pages: number;
  onPageChange: (p: number) => void;
  onRefresh: () => void; seeding: boolean;
}) {
  const t = useTranslations('aiTraining');

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-[#8b949e]">{total} tables with embeddings</p>
        <button onClick={onRefresh} disabled={seeding} className="flex items-center gap-1.5 px-3 py-1.5 bg-[#238636] hover:bg-[#2ea043] text-white text-sm rounded-lg disabled:opacity-50 transition-colors">
          {seeding ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
          {t('refresh')}
        </button>
      </div>

      <div className="space-y-1">
        {summaries.map((s, i) => (
          <div key={i} className="bg-[#161b22] border border-[#30363d] rounded-lg p-3">
            <div className="flex items-center gap-2 mb-1">
              <Database size={12} className="text-[#58a6ff]" />
              <span className="text-sm font-medium text-[#e6edf3]">{s.table_schema}.{s.table_name}</span>
              <span className="text-xs text-[#8b949e]">({s.summary_text})</span>
            </div>
            <p className="text-xs text-[#8b949e]">{s.column_list}</p>
            {s.fk_hint && <p className="text-xs text-[#d29922] mt-1">FK: {s.fk_hint}</p>}
          </div>
        ))}
      </div>

      {pages > 1 && (
        <div className="flex items-center gap-2">
          <button onClick={() => onPageChange(page - 1)} disabled={page <= 1} className="px-2 py-1 text-xs bg-[#21262d] border border-[#30363d] rounded disabled:opacity-50">←</button>
          <span className="text-xs text-[#8b949e]">Page {page}/{pages}</span>
          <button onClick={() => onPageChange(page + 1)} disabled={page >= pages} className="px-2 py-1 text-xs bg-[#21262d] border border-[#30363d] rounded disabled:opacity-50">→</button>
        </div>
      )}
    </div>
  );
}

function FkTab({
  fks, totalCount, onRefresh, seeding,
}: {
  fks: TrainingFK[];
  totalCount: number;
  onRefresh: () => void; seeding: boolean;
}) {
  const t = useTranslations('aiTraining');

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-[#8b949e]">{totalCount} foreign keys</p>
        <button onClick={onRefresh} disabled={seeding} className="flex items-center gap-1.5 px-3 py-1.5 bg-[#238636] hover:bg-[#2ea043] text-white text-sm rounded-lg disabled:opacity-50 transition-colors">
          {seeding ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
          {t('refresh')}
        </button>
      </div>

      <div className="font-mono text-xs space-y-0.5 max-h-[500px] overflow-auto">
        {fks.map((fk, i) => (
          <div key={fk.id ?? i} className="flex items-start gap-2 px-3 py-1.5 rounded bg-[#0d1117]">
            <span className={`w-2 h-2 rounded-full flex-shrink-0 mt-0.5 ${fk.direction === 'inbound' ? 'bg-purple-500' : 'bg-green-500'}`} />
            <span className="text-[#e6edf3]">{fk.source_schema}.{fk.source_table}.{fk.source_column}</span>
            <span className="text-[#8b949e]">→</span>
            <span className="text-[#7ee787]">{fk.target_schema}.{fk.target_table}.{fk.target_column}</span>
            {fk.hint_text && <span className="text-[#d29922]">[{fk.direction}] {fk.hint_text}</span>}
          </div>
        ))}
        {fks.length === 0 && <p className="text-xs text-[#8b949e] py-4 text-center">No FKs found</p>}
      </div>
    </div>
  );
}

function ExamplesTab({
  examples, page, total, pages, onPageChange, showSql, onToggleSql,
  onAdd, onDelete, editing, editQuestion, editSql, onQuestionChange, onSqlChange, onSave, onCancel, saving,
  onRefreshExamples, seeding,
}: {
  examples: TrainingExample[];
  page: number; total: number; pages: number;
  onPageChange: (p: number) => void;
  showSql: Record<number, boolean>;
  onToggleSql: (id: number) => void;
  onAdd: () => void;
  onDelete: (id: number) => void;
  editing: boolean;
  editQuestion: string; editSql: string;
  onQuestionChange: (v: string) => void;
  onSqlChange: (v: string) => void;
  onSave: () => void;
  onCancel: () => void;
  saving: boolean;
  onRefreshExamples: () => void; seeding: boolean;
}) {
  const t = useTranslations('aiTraining');

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-[#8b949e]">{total} training examples</p>
        <div className="flex items-center gap-2">
          <button onClick={onRefreshExamples} disabled={seeding} className="flex items-center gap-1.5 px-3 py-1.5 bg-[#21262d] hover:bg-[#30363d] border border-[#30363d] text-sm text-[#e6edf3] rounded-lg disabled:opacity-50 transition-colors">
            {seeding ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
            {t('refresh')}
          </button>
          <button onClick={onAdd} className="flex items-center gap-1.5 px-3 py-1.5 bg-[#238636] hover:bg-[#2ea043] text-white text-sm rounded-lg transition-colors">
            <Plus size={14} />
            {t('addExample')}
          </button>
        </div>
      </div>

      {editing && (
        <div className="bg-[#161b22] border border-[#30363d] rounded-xl p-4 space-y-3">
          <h3 className="text-sm font-medium text-[#e6edf3]">{t('addExample')}</h3>
          <input
            value={editQuestion}
            onChange={e => onQuestionChange(e.target.value)}
            placeholder="Câu hỏi tiếng Việt (ví dụ: đếm điểm cháy theo camera)"
            className="w-full px-3 py-2 bg-[#0d1117] border border-[#30363d] rounded-lg text-sm text-[#e6edf3] placeholder:text-[#484f58] focus:border-[#58a6ff] focus:outline-none"
          />
          <textarea
            value={editSql}
            onChange={e => onSqlChange(e.target.value)}
            placeholder="SELECT ... FROM ..."
            rows={5}
            className="w-full px-3 py-2 bg-[#0d1117] border border-[#30363d] rounded-lg text-sm text-[#e6edf3] placeholder:text-[#484f58] font-mono focus:border-[#58a6ff] focus:outline-none resize-y"
          />
          <div className="flex items-center gap-2 justify-end">
            <button onClick={onCancel} className="px-3 py-1.5 text-sm text-[#8b949e] hover:text-[#e6edf3] transition-colors">Cancel</button>
            <button
              onClick={onSave}
              disabled={saving || !editQuestion.trim() || !editSql.trim()}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-[#238636] hover:bg-[#2ea043] text-white text-sm rounded-lg disabled:opacity-50 transition-colors"
            >
              {saving ? <Loader2 size={12} className="animate-spin" /> : <CheckCircle2 size={12} />}
              Save
            </button>
          </div>
        </div>
      )}

      <div className="space-y-2">
        {examples.map(ex => (
          <div key={ex.id} className="bg-[#161b22] border border-[#30363d] rounded-lg p-3">
            <div className="flex items-start gap-2">
              <div className="flex-1 min-w-0">
                <p className="text-sm text-[#e6edf3] mb-1">{ex.question_vi}</p>
                {showSql[ex.id] ? (
                  <pre className="text-xs text-[#7ee787] bg-[#0d1117] rounded p-2 overflow-auto whitespace-pre-wrap font-mono">
                    {ex.sql}
                  </pre>
                ) : (
                  <p className="text-xs text-[#484f58] font-mono">{ex.sql.slice(0, 80)}...</p>
                )}
                <div className="flex items-center gap-3 mt-1.5">
                  <span className="text-[10px] text-[#484f58]">{ex.source}</span>
                  <span className="text-[10px] text-[#484f58]">{new Date(ex.created_at).toLocaleDateString()}</span>
                </div>
              </div>
              <div className="flex items-center gap-1 flex-shrink-0">
                <button onClick={() => onToggleSql(ex.id)} title={showSql[ex.id] ? 'Hide SQL' : 'Show SQL'} className="p-1 text-[#8b949e] hover:text-[#e6edf3] transition-colors">
                  {showSql[ex.id] ? <EyeOff size={12} /> : <Eye size={12} />}
                </button>
                <button onClick={() => copyToClipboard(ex.sql)} title="Copy SQL" className="p-1 text-[#8b949e] hover:text-[#e6edf3] transition-colors">
                  <Copy size={12} />
                </button>
                <button onClick={() => onDelete(ex.id)} title="Delete" className="p-1 text-[#8b949e] hover:text-[#f85149] transition-colors">
                  <Trash2 size={12} />
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>

      {pages > 1 && (
        <div className="flex items-center gap-2">
          <button onClick={() => onPageChange(page - 1)} disabled={page <= 1} className="px-2 py-1 text-xs bg-[#21262d] border border-[#30363d] rounded disabled:opacity-50">←</button>
          <span className="text-xs text-[#8b949e]">Page {page}/{pages}</span>
          <button onClick={() => onPageChange(page + 1)} disabled={page >= pages} className="px-2 py-1 text-xs bg-[#21262d] border border-[#30363d] rounded disabled:opacity-50">→</button>
        </div>
      )}
    </div>
  );
}

function SnapshotTab({ snapshot, onRefresh, seeding }: { snapshot: { table_count: number; column_count: number; version_hash: string; updated_at: string; preview_text: string } | null; onRefresh: () => void; seeding: boolean }) {
  const t = useTranslations('aiTraining');

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          {snapshot ? (
            <p className="text-sm text-[#8b949e]">
              {snapshot.table_count} tables, {snapshot.column_count} columns · {new Date(snapshot.updated_at).toLocaleString()}
            </p>
          ) : (
            <p className="text-sm text-[#8b949e]">{t('noSnapshot')}</p>
          )}
        </div>
        <button onClick={onRefresh} disabled={seeding} className="flex items-center gap-1.5 px-3 py-1.5 bg-[#238636] hover:bg-[#2ea043] text-white text-sm rounded-lg disabled:opacity-50 transition-colors">
          {seeding ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
          {t('refresh')}
        </button>
      </div>

      {snapshot?.version_hash && (
        <div className="bg-[#161b22] border border-[#30363d] rounded-lg p-3">
          <p className="text-xs text-[#8b949e]">
            Hash: <span className="text-[#e6edf3] font-mono">{snapshot.version_hash}</span>
          </p>
        </div>
      )}

      {snapshot?.preview_text && (
        <pre className="text-xs text-[#8b949e] bg-[#0d1117] border border-[#30363d] rounded-lg p-4 overflow-auto whitespace-pre-wrap font-mono max-h-[400px]">
          {snapshot.preview_text}
        </pre>
      )}
    </div>
  );
}

function copyToClipboard(text: string) {
  navigator.clipboard.writeText(text).catch(console.error);
}
