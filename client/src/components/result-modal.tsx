'use client';

import { useState } from 'react';
import { X, Download, Table, BarChart2, Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { apiClient } from '@/lib/api';
import { exportToCSV, exportToJSON } from '@/lib/utils';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, LineChart, Line, AreaChart, Area
} from 'recharts';

interface ResultModalProps {
  sql: string;
  connectionId?: number;
  queryName: string;
  onClose: () => void;
}

interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  duration_ms: number;
}

const CHART_COLORS = ['#58a6ff', '#3fb950', '#d29922', '#f85149', '#a371f7', '#39d353'];

export default function ResultModal({ sql, connectionId, queryName, onClose }: ResultModalProps) {
  const tc = useTranslations('common');
  const [result, setResult] = useState<QueryResult | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [chartType, setChartType] = useState('table');

  const run = async () => {
    setLoading(true);
    setError('');
    try {
      const { data } = await apiClient.post<QueryResult & { error?: string; details?: string }>('/query', {
        sql,
        connectionId,
      });
      if ('error' in data && data.error) {
        setError(data.details || data.error);
      } else {
        setResult(data as QueryResult);
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : tc('error'));
    } finally {
      setLoading(false);
    }
  };

  const canChart = result && result.columns.length >= 2;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="w-full max-w-4xl max-h-[90vh] glass-card flex flex-col animate-fade-in">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-[#30363d] flex-shrink-0">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-[#e6edf3] truncate">{queryName}</h2>
            <code className="text-[10px] text-[#8b949e] font-mono truncate block max-w-md">{sql}</code>
          </div>
          <div className="flex items-center gap-2 ml-4 flex-shrink-0">
            {result && (
              <div className="flex gap-1 mr-2">
                <button
                  onClick={() => exportToCSV(result.columns, result.rows)}
                  title="Export CSV"
                  className="p-1.5 text-[#8b949e] hover:text-[#58a6ff] transition-colors"
                >
                  <Download size={14} />
                </button>
                {canChart && (
                  <>
                    <button
                      onClick={() => setChartType('table')}
                      className={`p-1.5 transition-colors ${chartType === 'table' ? 'text-[#58a6ff]' : 'text-[#8b949e] hover:text-[#e6edf3]'}`}
                    >
                      <Table size={14} />
                    </button>
                    <button
                      onClick={() => setChartType('bar')}
                      className={`p-1.5 transition-colors ${chartType === 'bar' ? 'text-[#58a6ff]' : 'text-[#8b949e] hover:text-[#e6edf3]'}`}
                    >
                      <BarChart2 size={14} />
                    </button>
                  </>
                )}
              </div>
            )}
            <button onClick={onClose} className="text-[#8b949e] hover:text-[#e6edf3] transition-colors">
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-auto p-5">
          {!result && !error && (
            <div className="flex flex-col items-center justify-center h-full gap-4 text-[#8b949e]">
              {loading ? (
                <>
                  <Loader2 size={24} className="animate-spin" />
                  <p className="text-sm">{tc('loading')}</p>
                </>
              ) : (
                <button
                  onClick={run}
                  className="gradient-btn px-6 py-2.5 text-sm"
                >
                  Run Query
                </button>
              )}
            </div>
          )}

          {error && (
            <div className="flex flex-col items-center justify-center h-full gap-3 text-[#f85149] text-sm">
              <p>Error: {error}</p>
              <button onClick={run} className="gradient-btn px-4 py-2 text-sm">{tc('retry')}</button>
            </div>
          )}

          {result && !loading && (
            <div className="space-y-3">
              <div className="flex items-center gap-3 text-xs text-[#8b949e]">
                <span>{result.rowCount} rows</span>
                <span>·</span>
                <span>{result.duration_ms}ms</span>
              </div>

              {chartType === 'table' ? (
                <div className="overflow-auto max-h-96 border border-[#30363d] rounded-lg">
                  <table className="w-full text-xs">
                    <thead className="bg-[#21262d] sticky top-0">
                      <tr>
                        {result.columns.map(col => (
                          <th key={col} className="px-3 py-2 text-left text-[#8b949e] font-medium whitespace-nowrap border-b border-[#30363d]">
                            {col}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {result.rows.slice(0, 200).map((row, i) => (
                        <tr key={i} className={`border-b border-[#21262d] ${i % 2 === 0 ? 'bg-[#0d1117]' : 'bg-[#161b22]'}`}>
                          {result.columns.map(col => (
                            <td key={col} className="px-3 py-1.5 text-[#e6edf3] whitespace-nowrap">
                              {String(row[col] ?? '')}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {result.rows.length > 200 && (
                    <p className="text-xs text-[#8b949e] px-3 py-2 bg-[#21262d]">+{result.rows.length - 200} more rows</p>
                  )}
                </div>
              ) : (
                <ChartView columns={result.columns} rows={result.rows} chartType={chartType} />
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ChartView({ columns, rows, chartType }: { columns: string[]; rows: Record<string, unknown>[]; chartType: string }) {
  const data = rows.slice(0, 100);
  const xKey = columns[0];
  const yKey = columns[1];
  const chartData = data.map(row => ({ [xKey]: String(row[xKey]), [yKey]: Number(row[yKey]) || 0 }));
  const commonProps = { data: chartData, margin: { top: 5, right: 5, left: -10, bottom: 5 } };

  if (chartType === 'bar') {
    return (
      <ResponsiveContainer width="100%" height={300}>
        <BarChart {...commonProps}>
          <CartesianGrid strokeDasharray="3 3" stroke="#30363d" />
          <XAxis dataKey={xKey} tick={{ fill: '#8b949e', fontSize: 10 }} />
          <YAxis tick={{ fill: '#8b949e', fontSize: 10 }} />
          <Tooltip contentStyle={{ background: '#161b22', border: '1px solid #30363d', borderRadius: 8, fontSize: 12 }} />
          <Bar dataKey={yKey} fill="#58a6ff" radius={[4, 4, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={300}>
      <AreaChart {...commonProps}>
        <CartesianGrid strokeDasharray="3 3" stroke="#30363d" />
        <XAxis dataKey={xKey} tick={{ fill: '#8b949e', fontSize: 10 }} />
        <YAxis tick={{ fill: '#8b949e', fontSize: 10 }} />
        <Tooltip contentStyle={{ background: '#161b22', border: '1px solid #30363d', borderRadius: 8, fontSize: 12 }} />
        <Area type="monotone" dataKey={yKey} stroke="#58a6ff" fill="#58a6ff33" />
      </AreaChart>
    </ResponsiveContainer>
  );
}
