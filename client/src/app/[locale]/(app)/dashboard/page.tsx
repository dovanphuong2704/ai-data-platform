'use client';

import { useState, useEffect } from 'react';
import { LayoutDashboard, Trash2, Table, BarChart2, Download, Share2 } from 'lucide-react';
import { apiClient } from '@/lib/api';
import { exportToCSV, exportToJSON, cn } from '@/lib/utils';
import type { DashboardItem } from '@/types';
import ShareModal from '@/components/share-modal';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, PieChart, Pie, Cell, LineChart, Line, AreaChart, Area } from 'recharts';
import { useTranslations } from 'next-intl';

const CHART_COLORS = ['#58a6ff', '#3fb950', '#d29922', '#f85149', '#a371f7', '#39d353'];

function DashboardCard({ item, onDelete, onShare }: { item: DashboardItem; onDelete: () => void; onShare: () => void }) {
  const t = useTranslations('dashboard');
  const data = item.data;
  const columns = data.columns || [];
  const rows = data.rows || [];
  const chartType = data.chartType;

  return (
    <div className="glass-card p-4 animate-fade-in">
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-2">
          {chartType ? <BarChart2 size={16} className="text-[#58a6ff]" /> : <Table size={16} className="text-[#3fb950]" />}
          <h3 className="text-sm font-medium text-[#e6edf3] truncate max-w-[200px]">{data.title || 'Dashboard Item'}</h3>
        </div>
        <div className="flex items-center gap-1">
          {rows.length > 0 && (
            <>
              <button onClick={() => exportToCSV(columns, rows)} className="p-1.5 text-[#8b949e] hover:text-[#58a6ff] transition-colors" title={t('exportCsv')}>
                <Download size={14} />
              </button>
              <button onClick={() => exportToJSON(rows)} className="p-1.5 text-[#8b949e] hover:text-[#58a6ff] transition-colors" title={t('exportJson')}>
                <span className="text-xs font-mono">JSON</span>
              </button>
            </>
          )}
          <button onClick={onShare} className="p-1.5 text-[#8b949e] hover:text-[#58a6ff] transition-colors" title={t('share')}>
            <Share2 size={14} />
          </button>
          <button onClick={onDelete} className="p-1.5 text-[#8b949e] hover:text-[#f85149] transition-colors" title={t('remove')}>
            <Trash2 size={14} />
          </button>
        </div>
      </div>

      {data.sql && (
        <code className="block text-xs font-mono text-[#8b949e] bg-[#0d1117] px-2 py-1.5 rounded mb-3 truncate">{data.sql}</code>
      )}

      {chartType && rows.length > 0 ? (
        <ChartView chartType={chartType} columns={columns} rows={rows} />
      ) : rows.length > 0 ? (
        <div className="overflow-x-auto max-h-64">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-[#21262d]">
                {columns.map(col => (
                  <th key={col} className="px-2 py-1.5 text-left text-[#8b949e] font-medium whitespace-nowrap">{col}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 20).map((row, i) => (
                <tr key={i} className={cn('border-t border-[#30363d]', i % 2 === 0 ? 'bg-[#0d1117]' : '')}>
                  {columns.map(col => (
                    <td key={col} className="px-2 py-1.5 text-[#e6edf3] whitespace-nowrap">{String(row[col] ?? '')}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length > 20 && <p className="text-xs text-[#8b949e] px-2 py-1.5 bg-[#21262d]">+{rows.length - 20} more rows</p>}
        </div>
      ) : (
        <p className="text-xs text-[#8b949e]">{t('noData')}</p>
      )}
    </div>
  );
}

function ChartView({ chartType, columns, rows }: { chartType: string; columns: string[]; rows: Record<string, unknown>[] }) {
  const data = rows.slice(0, 100);
  if (!data.length || columns.length < 2) return null;
  const xKey = columns[0];
  const yKey = columns[1];
  const chartData = data.map(row => ({ [xKey]: String(row[xKey]), [yKey]: Number(row[yKey]) || 0 }));
  const commonProps = { data: chartData, margin: { top: 5, right: 5, left: -10, bottom: 5 } };

  switch (chartType) {
    case 'bar':
      return <ResponsiveContainer width="100%" height={200}><BarChart {...commonProps}><CartesianGrid strokeDasharray="3 3" stroke="#30363d" /><XAxis dataKey={xKey} tick={{ fill: '#8b949e', fontSize: 10 }} /><YAxis tick={{ fill: '#8b949e', fontSize: 10 }} /><Tooltip contentStyle={{ background: '#161b22', border: '1px solid #30363d', borderRadius: 8 }} /><Bar dataKey={yKey} fill="#58a6ff" radius={[3, 3, 0, 0]} /></BarChart></ResponsiveContainer>;
    case 'line':
      return <ResponsiveContainer width="100%" height={200}><LineChart {...commonProps}><CartesianGrid strokeDasharray="3 3" stroke="#30363d" /><XAxis dataKey={xKey} tick={{ fill: '#8b949e', fontSize: 10 }} /><YAxis tick={{ fill: '#8b949e', fontSize: 10 }} /><Tooltip contentStyle={{ background: '#161b22', border: '1px solid #30363d', borderRadius: 8 }} /><Line type="monotone" dataKey={yKey} stroke="#3fb950" strokeWidth={2} dot={false} /></LineChart></ResponsiveContainer>;
    case 'pie':
      return <ResponsiveContainer width="100%" height={200}><PieChart><Pie data={chartData} dataKey={yKey} nameKey={xKey} cx="50%" cy="50%" outerRadius={80} label={({ name, percent }) => `${((percent ?? 0) * 100).toFixed(0)}%`} labelLine={false}>{chartData.map((_, i) => <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />)}</Pie><Tooltip contentStyle={{ background: '#161b22', border: '1px solid #30363d', borderRadius: 8 }} /></PieChart></ResponsiveContainer>;
    case 'area':
      return <ResponsiveContainer width="100%" height={200}><AreaChart {...commonProps}><CartesianGrid strokeDasharray="3 3" stroke="#30363d" /><XAxis dataKey={xKey} tick={{ fill: '#8b949e', fontSize: 10 }} /><YAxis tick={{ fill: '#8b949e', fontSize: 10 }} /><Tooltip contentStyle={{ background: '#161b22', border: '1px solid #30363d', borderRadius: 8 }} /><Area type="monotone" dataKey={yKey} stroke="#a371f7" fill="#a371f7" fillOpacity={0.2} /></AreaChart></ResponsiveContainer>;
    default:
      return null;
  }
}

export default function DashboardPage() {
  const t = useTranslations('dashboard');
  const tc = useTranslations('common');
  const [items, setItems] = useState<DashboardItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [shareItemId, setShareItemId] = useState<number | null>(null);

  useEffect(() => {
    apiClient.get('/dashboard').then(res => setItems(res.data.items)).catch(() => {}).finally(() => setLoading(false));
  }, []);

  const deleteItem = async (id: number) => {
    try {
      await apiClient.delete(`/dashboard/${id}`);
      setItems(prev => prev.filter(i => i.id !== id));
    } catch {
      alert(tc('error'));
    }
  };

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center gap-3">
        <LayoutDashboard size={20} className="text-[#58a6ff]" />
        <h1 className="text-lg font-semibold text-[#e6edf3]">{t('title')}</h1>
      </div>

      {loading ? (
        <div className="text-sm text-[#8b949e]">{tc('loading')}</div>
      ) : items.length === 0 ? (
        <div className="text-center py-20">
          <LayoutDashboard size={48} className="text-[#30363d] mx-auto mb-4" />
          <p className="text-[#8b949e]">{t('empty')}</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {items.map(item => (
            <DashboardCard key={item.id} item={item} onDelete={() => deleteItem(item.id)} onShare={() => setShareItemId(item.id)} />
          ))}
        </div>
      )}

      {shareItemId !== null && (
        <ShareModal
          dashboardItemId={shareItemId}
          onClose={() => setShareItemId(null)}
        />
      )}
    </div>
  );
}
