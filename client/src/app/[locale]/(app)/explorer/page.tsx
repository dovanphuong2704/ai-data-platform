'use client';

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Database, Table2, Loader2, Plug, X, GitBranch, Search, KeyRound, ArrowRight, ChevronDown, ChevronRight, ChevronUp } from 'lucide-react';
import { apiClient } from '@/lib/api';
import { cn } from '@/lib/utils';
import type { DbConnection, SchemaInfoResponse, QueryResult } from '@/types';
import { useTranslations } from 'next-intl';

// ─── Types ───────────────────────────────────────────────────────────────────

type Tab = 'schema' | 'diagram';

// Schema color palette — distinct, easy to tell apart
const SCHEMA_COLORS = [
  { bg: '#1a3a5c', text: '#58a6ff', border: '#1e4d7b' },  // blue
  { bg: '#1a3d2b', text: '#3fb950', border: '#256b3a' },  // green
  { bg: '#3d2e0a', text: '#d29922', border: '#5a4410' },  // yellow
  { bg: '#3d1a1a', text: '#f85149', border: '#6b2525' },  // red
  { bg: '#2a1a3d', text: '#a371f7', border: '#3d2660' },  // purple
  { bg: '#1a3d3d', text: '#39d353', border: '#256b5a' },  // teal
  { bg: '#3d2e1a', text: '#ffa657', border: '#5a4425' },  // orange
  { bg: '#2a1a2a', text: '#ff7b72', border: '#3d2525' },  // pink
];

function getSchemaColor(schema: string, index: number) {
  return SCHEMA_COLORS[index % SCHEMA_COLORS.length];
}

// ─── SchemaDiagram Component ──────────────────────────────────────────────────
// Layout: grid of table-cards + SVG overlay for FK arrows.
// Each table card = schema badge + table name + columns list + FK indicators.

interface TableCardProps {
  schema: string;
  table: { table_name: string; columns: { column_name: string; data_type: string; is_nullable: boolean }[] };
  schemaColor: { bg: string; text: string; border: string };
  isSelected: boolean;
  onClick: () => void;
  fks: Array<{ direction: 'in' | 'out'; from_schema: string; from_table: string; from_column: string; to_schema: string; to_table: string; to_column: string }>;
  refCallback?: (el: HTMLDivElement | null) => void;
  t: ReturnType<typeof useTranslations>;
}

function TableCard({ schema, table, schemaColor, isSelected, onClick, fks, refCallback, t }: TableCardProps) {
  const [expanded, setExpanded] = useState(false);
  const primaryKey = table.columns.find(c =>
    c.column_name.toLowerCase().includes('id') || c.column_name.toLowerCase() === 'uuid' || c.column_name.toLowerCase() === 'key'
  );

  const shortType = (type: string) =>
    type.replace('character varying', 'varchar').replace('timestamp without time zone', 'timestamp').replace('boolean', 'bool').replace('integer', 'int').replace('character', 'char').slice(0, 12);

  return (
    <div
      ref={refCallback}
      onClick={onClick}
      className={cn(
        'w-56 rounded-xl border cursor-pointer transition-all duration-150 flex flex-col flex-shrink-0',
        isSelected
          ? 'border-[#58a6ff] shadow-[0_0_0_1px_#58a6ff,0_0_16px_rgba(88,166,255,0.15)]'
          : 'border-[#30363d] hover:border-[#8b949e] hover:shadow-[0_0_8px_rgba(0,0,0,0.4)]'
      )}
      style={{ background: '#161b22' }}
    >
      {/* Header */}
      <div
        className="px-3 py-2 rounded-t-xl border-b flex items-center gap-2 flex-shrink-0"
        style={{ borderColor: schemaColor.border, background: schemaColor.bg }}
      >
        <Database size={11} style={{ color: schemaColor.text }} />
        <span className="text-[10px] font-semibold" style={{ color: schemaColor.text }}>{schema}</span>
        <div className="w-px h-3" style={{ background: schemaColor.border }} />
        <span className="text-xs font-semibold text-[#e6edf3] truncate flex-1">{table.table_name}</span>
      </div>

      {/* FK indicators */}
      {fks.length > 0 && (
        <div className="flex items-center gap-1 px-3 py-1 border-b border-[#21262d] flex-wrap flex-shrink-0">
          {fks.filter(f => f.direction === 'out').slice(0, 3).map((fk, i) => (
            <div key={i} className="flex items-center gap-0.5 text-[9px] text-[#d29922] bg-[#d29922]/10 px-1.5 py-0.5 rounded">
              <ArrowRight size={8} />
              <span className="truncate max-w-[60px]">{fk.to_table}.{fk.to_column}</span>
            </div>
          ))}
          {fks.filter(f => f.direction === 'in').slice(0, 2).map((fk, i) => (
            <div key={i} className="flex items-center gap-0.5 text-[9px] text-[#58a6ff] bg-[#58a6ff]/10 px-1.5 py-0.5 rounded">
              <ArrowRight size={8} className="rotate-180" />
              <span className="truncate max-w-[60px]">{fk.from_table}.{fk.from_column}</span>
            </div>
          ))}
        </div>
      )}

      {/* Columns — always scrollable */}
      <div
        className="flex-1 px-2 py-1.5 space-y-0.5 overflow-y-auto"
        style={{ maxHeight: expanded ? '320px' : '140px' }}
      >
        {table.columns.map(col => {
          const isPK = primaryKey?.column_name === col.column_name;
          return (
            <div key={col.column_name} className="flex items-center gap-1.5 py-0.5 flex-shrink-0">
              {isPK ? (
                <span title={t('primaryKey')}><KeyRound size={9} className="text-[#d29922] flex-shrink-0" /></span>
              ) : (
                <div className="w-1.5 h-1.5 rounded-full border border-[#30363d] flex-shrink-0" />
              )}
              <span className={cn(
                'text-[10px] font-mono truncate flex-1',
                isPK ? 'text-[#d29922]' : 'text-[#8b949e]'
              )}>
                {col.column_name}
              </span>
              <span className="text-[9px] text-[#484f58] font-mono truncate max-w-[64px] flex-shrink-0" title={col.data_type}>
                {shortType(col.data_type)}
              </span>
              {col.is_nullable && <span className="text-[8px] text-[#484f58] flex-shrink-0">?</span>}
            </div>
          );
        })}
      </div>

      {/* Footer: column count + expand/collapse */}
      <div className="px-3 py-1.5 border-t border-[#21262d] flex items-center justify-between flex-shrink-0">
        <span className="text-[9px] text-[#484f58]">{table.columns.length} cols · {fks.length} FK</span>
        {table.columns.length > 5 && (
          <button
            onClick={e => { e.stopPropagation(); setExpanded(v => !v); }}
            className="flex items-center gap-0.5 text-[9px] text-[#58a6ff] hover:text-[#79b8ff]"
          >
            {expanded ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
            {expanded ? t('showLess') : t('showMoreColumns', { count: table.columns.length - 5 })}
          </button>
        )}
      </div>
    </div>
  );
}

// ─── FK Arrow SVG Overlay ────────────────────────────────────────────────────

interface Arrow {
  fromEl: HTMLDivElement;
  toEl: HTMLDivElement;
  label: string;
  color: string;
}

function drawArrows(arrows: Arrow[], svgRef: SVGSVGElement | null) {
  if (!svgRef) return;
  const ns = 'http://www.w3.org/2000/svg';
  // Clear previous arrows
  while (svgRef.firstChild) svgRef.removeChild(svgRef.firstChild);

  arrows.forEach(({ fromEl, toEl, label, color }) => {
    const fx = fromEl.offsetLeft + fromEl.offsetWidth / 2;
    const fy = fromEl.offsetTop + fromEl.offsetHeight / 2;
    const tx = toEl.offsetLeft + toEl.offsetWidth / 2;
    const ty = toEl.offsetTop + toEl.offsetHeight / 2;

    // Simple straight line with arrowhead
    const line = document.createElementNS(ns, 'line');
    line.setAttribute('x1', String(fx));
    line.setAttribute('y1', String(fy));
    line.setAttribute('x2', String(tx));
    line.setAttribute('y2', String(ty));
    line.setAttribute('stroke', color);
    line.setAttribute('stroke-width', '1.5');
    line.setAttribute('stroke-dasharray', '4 3');
    line.setAttribute('opacity', '0.7');
    svgRef.appendChild(line);

    // Arrowhead
    const angle = Math.atan2(ty - fy, tx - fx);
    const arrowLen = 8;
    const ax1 = tx - arrowLen * Math.cos(angle - Math.PI / 7);
    const ay1 = ty - arrowLen * Math.sin(angle - Math.PI / 7);
    const ax2 = tx - arrowLen * Math.cos(angle + Math.PI / 7);
    const ay2 = ty - arrowLen * Math.sin(angle + Math.PI / 7);
    const arrowHead = document.createElementNS(ns, 'polygon');
    arrowHead.setAttribute('points', `${tx},${ty} ${ax1},${ay1} ${ax2},${ay2}`);
    arrowHead.setAttribute('fill', color);
    arrowHead.setAttribute('opacity', '0.7');
    svgRef.appendChild(arrowHead);
  });
}

// ─── Main SchemaDiagram ──────────────────────────────────────────────────────

interface SchemaDiagramProps {
  schemaInfo: SchemaInfoResponse;
  onSelectTable: (schema: string, table: string) => void;
  selectedTable?: { schema: string; table: string } | null;
  t: ReturnType<typeof useTranslations>;
}

function SchemaDiagram({ schemaInfo, onSelectTable, selectedTable, t }: SchemaDiagramProps) {
  const [filterSchema, setFilterSchema] = useState<string>('');
  const [search, setSearch] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const cardRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const cardPositionsRef = useRef<Map<string, { schema: string; table: string }>>(new Map());
  const [, forceUpdate] = useState(0);

  // Filter tables
  const filteredSchemas = useMemo(() => {
    const schemas = filterSchema
      ? schemaInfo.schemas.filter(s => s.schema_name === filterSchema)
      : schemaInfo.schemas;

    const filteredTables = search
      ? schemaInfo.tables.filter(t =>
          t.table_name.toLowerCase().includes(search.toLowerCase()) ||
          t.schema_name.toLowerCase().includes(search.toLowerCase())
        )
      : schemaInfo.tables;

    return schemas
      .map(s => ({
        schema: s.schema_name,
        color: getSchemaColor(s.schema_name, schemaInfo.schemas.indexOf(s)),
        tables: filteredTables.filter(t => t.schema_name === s.schema_name),
      }))
      .filter(g => g.tables.length > 0);
  }, [schemaInfo, filterSchema, search]);

  // Gather all FKs per table
  const tableFks = useMemo(() => {
    const map = new Map<string, Array<{ direction: 'in' | 'out'; from_schema: string; from_table: string; from_column: string; to_schema: string; to_table: string; to_column: string }>>();
    for (const fk of schemaInfo.foreignKeys) {
      const outKey = `${fk.from_schema}.${fk.from_table}`;
      const inKey = `${fk.to_schema}.${fk.to_table}`;
      if (!map.has(outKey)) map.set(outKey, []);
      if (!map.has(inKey)) map.set(inKey, []);
      map.get(outKey)!.push({ direction: 'out', ...fk });
      map.get(inKey)!.push({ direction: 'in', ...fk });
    }
    return map;
  }, [schemaInfo]);

  // Build arrows after render
  const redrawArrows = useCallback(() => {
    if (!svgRef.current || !containerRef.current) return;
    const arrows: Arrow[] = [];
    const containerRect = containerRef.current.getBoundingClientRect();
    schemaInfo.foreignKeys.forEach(fk => {
      const fromKey = `${fk.from_schema}.${fk.from_table}`;
      const toKey = `${fk.to_schema}.${fk.to_table}`;
      if (!filterSchema || (filterSchema === fk.from_schema || filterSchema === fk.to_schema)) {
        const fromEl = cardRefs.current.get(fromKey);
        const toEl = cardRefs.current.get(toKey);
        if (fromEl && toEl) {
          arrows.push({
            fromEl,
            toEl,
            label: `${fk.from_column} → ${fk.to_column}`,
            color: '#d29922',
          });
        }
      }
    });
    drawArrows(arrows, svgRef.current);
  }, [schemaInfo, filterSchema]);

  // Redraw arrows on resize or scroll
  useEffect(() => {
    const ro = new ResizeObserver(() => redrawArrows());
    const container = containerRef.current;
    if (container) {
      ro.observe(container);
      container.addEventListener('scroll', redrawArrows);
    }
    return () => {
      ro.disconnect();
      if (container) container.removeEventListener('scroll', redrawArrows);
    };
  }, [redrawArrows]);

  useEffect(() => {
    // Small delay to let cards render with positions
    const timer = setTimeout(redrawArrows, 50);
    return () => clearTimeout(timer);
  }, [filteredSchemas, redrawArrows]);

  const totalTables = filteredSchemas.reduce((acc, g) => acc + g.tables.length, 0);

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center gap-3 px-4 py-2.5 border-b border-[#30363d] bg-[#0d1117]">
        <GitBranch size={14} className="text-[#58a6ff]" />
        <span className="text-xs font-semibold text-[#e6edf3]">{t('erDiagram')}</span>
        <div className="h-4 w-px bg-[#30363d]" />

        {/* Search */}
        <div className="relative">
          <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[#484f58]" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder={t('searchTables')}
            className="pl-7 pr-3 py-1.5 bg-[#0d1117] border border-[#30363d] text-[#e6edf3] rounded-lg text-xs focus:outline-none focus:border-[#58a6ff] w-44 placeholder:text-[#484f58]"
          />
        </div>

        {/* Schema filter */}
        <select
          value={filterSchema}
          onChange={e => setFilterSchema(e.target.value)}
          className="bg-[#161b22] border border-[#30363d] text-[#e6edf3] rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:border-[#58a6ff]"
        >
          <option value="">{t('allSchemas')} ({totalTables} {t('tables').toLowerCase()})</option>
          {schemaInfo.schemas.map(s => (
            <option key={s.schema_name} value={s.schema_name}>
              {s.schema_name} ({s.table_count} {t('tables').toLowerCase()})
            </option>
          ))}
        </select>

        {/* Schema legend chips */}
        <div className="flex items-center gap-1.5 flex-1 overflow-x-auto no-scrollbar">
          {schemaInfo.schemas.slice(0, 8).map((s, i) => {
            const c = getSchemaColor(s.schema_name, i);
            return (
              <button
                key={s.schema_name}
                onClick={() => setFilterSchema(filterSchema === s.schema_name ? '' : s.schema_name)}
                className={cn(
                  'flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium border transition-all whitespace-nowrap',
                  filterSchema === s.schema_name
                    ? 'opacity-100'
                    : 'opacity-60 hover:opacity-100'
                )}
                style={{ background: c.bg, color: c.text, borderColor: c.border }}
              >
                {s.schema_name}
              </button>
            );
          })}
        </div>

        {/* Stats */}
        <div className="flex items-center gap-3 text-[10px] text-[#484f58] border-l border-[#21262d] pl-3 ml-auto">
          <span>{totalTables} {t('tables').toLowerCase()}</span>
          <span>·</span>
          <span>{schemaInfo.foreignKeys.length} {t('foreignKeys').toLowerCase()}</span>
          <span>·</span>
          <span>{schemaInfo.schemas.length} {t('schemas').toLowerCase()}</span>
        </div>
      </div>

      {/* Diagram area: cards grid + SVG overlay */}
      <div ref={containerRef} className="flex-1 overflow-auto relative p-6" style={{ background: '#0d1117' }}>
        {/* SVG overlay for FK arrows */}
        <svg
          ref={svgRef}
          className="absolute inset-0 w-full h-full pointer-events-none"
          style={{ zIndex: 1 }}
        />

        {/* Cards grid — zIndex 2 so cards are above arrows */}
        <div
          className="relative flex flex-wrap content-start gap-4"
          style={{ zIndex: 2 }}
        >
          {filteredSchemas.map(group => (
            <div key={group.schema} className="w-full">
              {/* Schema group header */}
              <div
                className="inline-flex items-center gap-2 px-3 py-1 rounded-lg mb-2 text-xs font-semibold"
                style={{ background: group.color.bg, color: group.color.text, border: `1px solid ${group.color.border}` }}
              >
                <Database size={11} />
                <span>{group.schema}</span>
                <span className="text-[10px] opacity-60 font-normal">{group.tables.length} tables</span>
              </div>

              {/* Table cards grid */}
              <div className="flex flex-wrap gap-3">
                {group.tables.map(table => {
                  const key = `${group.schema}.${table.table_name}`;
                  const fks = tableFks.get(key) ?? [];
                  return (
                    <TableCard
                      key={key}
                      refCallback={el => {
                        if (el) cardRefs.current.set(key, el);
                        else cardRefs.current.delete(key);
                      }}
                      schema={group.schema}
                      table={table}
                      schemaColor={group.color}
                      isSelected={!!(selectedTable && selectedTable.schema === group.schema && selectedTable.table === table.table_name)}
                      onClick={() => onSelectTable(group.schema, table.table_name)}
                      fks={fks}
                      t={t}
                    />
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        {totalTables === 0 && (
          <div className="flex items-center justify-center h-full text-[#8b949e] text-sm">
            {search ? t('noTablesMatch', { query: search }) : t('explorer.noTables')}
          </div>
        )}
      </div>

      {/* Legend */}
      <div className="flex flex-wrap items-center gap-4 px-4 py-2 border-t border-[#30363d] bg-[#0d1117]">
        {schemaInfo.schemas.slice(0, 8).map((s, i) => {
          const c = getSchemaColor(s.schema_name, i);
          return (
            <div key={s.schema_name} className="flex items-center gap-1.5">
              <div className="w-3 h-3 rounded-sm" style={{ background: c.text }} />
              <span className="text-[10px] text-[#8b949e]">{s.schema_name}</span>
            </div>
          );
        })}
        <div className="flex items-center gap-1.5">
          <KeyRound size={10} className="text-[#d29922]" />
          <span className="text-[10px] text-[#8b949e]">{t('primaryKey')}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <ArrowRight size={10} className="text-[#d29922]" />
          <span className="text-[10px] text-[#8b949e]">{t('references')}</span>
        </div>
      </div>
    </div>
  );
}

// ─── Main Explorer Page ───────────────────────────────────────────────────────

export default function ExplorerPage() {
  const t = useTranslations();
  const tc = useTranslations('common');
  const [connections, setConnections] = useState<DbConnection[]>([]);
  const [selectedConnectionId, setSelectedConnectionId] = useState<number | undefined>();
  const [schemaInfo, setSchemaInfo] = useState<SchemaInfoResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [schemaError, setSchemaError] = useState('');
  const [tab, setTab] = useState<Tab>('schema');
  const [selectedTable, setSelectedTable] = useState<{ schema: string; table: string } | null>(null);
  const [previewData, setPreviewData] = useState<QueryResult | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState('');

  useEffect(() => {
    loadConnections();
  }, []);

  const loadConnections = async () => {
    try {
      const { data } = await apiClient.get<{ connections: DbConnection[] }>('/connections?withStatus=true');
      const conns = data.connections ?? [];
      setConnections(conns);
      // Handle is_default as boolean or string "true"/"false" from PostgreSQL
      const isDefault = (c: DbConnection) =>
        c.is_default === true || c.is_default === 'true' || c.is_default === 1;
      const defaultConn = conns.find(isDefault);
      setSelectedConnectionId(defaultConn?.id ?? conns[0]?.id);
    } catch (err: unknown) {
      setConnections([]);
    }
  };

  const loadSchemaInfo = useCallback(async () => {
    setLoading(true);
    setSchemaError('');
    setSchemaInfo(null);
    try {
      const params: Record<string, string> = {};
      if (selectedConnectionId) params.connectionId = String(selectedConnectionId);
      const { data } = await apiClient.get<SchemaInfoResponse>('/explorer/schema-info', { params });
      setSchemaInfo(data);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setSchemaError(msg);
    } finally {
      setLoading(false);
    }
  }, [selectedConnectionId]);

  useEffect(() => {
    loadSchemaInfo();
  }, [loadSchemaInfo]);

  const previewTable = useCallback(async (schema: string, table: string) => {
    setPreviewLoading(true);
    setPreviewError('');
    setPreviewData(null);
    try {
      const payload: { sql: string; connectionId?: number } = {
        sql: `SELECT * FROM "${schema}"."${table}" LIMIT 50`,
      };
      if (selectedConnectionId) payload.connectionId = selectedConnectionId;
      const { data } = await apiClient.post<QueryResult>('/query', payload);
      setPreviewData(data);
    } catch (err: any) {
      setPreviewError(err?.response?.data?.error ?? String(err));
    } finally {
      setPreviewLoading(false);
    }
  }, [selectedConnectionId]);

  // Group tables by schema for tree view
  const groupedTables = useMemo(() => {
    if (!schemaInfo) return [];
    return schemaInfo.schemas.map(s => ({
      schema: s.schema_name,
      tables: schemaInfo.tables.filter(t => t.schema_name === s.schema_name),
    }));
  }, [schemaInfo]);

  const schemaColorMap = useMemo(() => {
    if (!schemaInfo) return new Map<string, { bg: string; text: string; border: string }>();
    const map = new Map<string, { bg: string; text: string; border: string }>();
    schemaInfo.schemas.forEach((s, i) => map.set(s.schema_name, getSchemaColor(s.schema_name, i)));
    return map;
  }, [schemaInfo]);

  const stats = useMemo(() => {
    if (!schemaInfo) return null;
    return {
      schemas: schemaInfo.schemas.length,
      tables: schemaInfo.tables.length,
      columns: schemaInfo.tables.reduce((acc, t) => acc + t.columns.length, 0),
      fks: schemaInfo.foreignKeys.length,
    };
  }, [schemaInfo]);

  return (
    <div className="flex h-full overflow-hidden">
      {/* Left sidebar */}
      <aside className="w-80 border-r border-[#30363d] flex flex-col overflow-hidden bg-[#0d1117]">
        {/* Header */}
        <div className="px-4 py-3 border-b border-[#30363d]">
          <div className="flex items-center gap-2 mb-3">
            <Database size={16} className="text-[#58a6ff]" />
            <h1 className="text-sm font-semibold text-[#e6edf3]">{t('explorer.title')}</h1>
          </div>

          {/* Connection selector */}
          <label className="flex items-center gap-1.5 text-xs text-[#8b949e] mb-1.5">
            <Plug size={12} />
            Database
          </label>
          <select
            value={selectedConnectionId ?? ''}
            onChange={e => setSelectedConnectionId(e.target.value ? Number(e.target.value) : undefined)}
            className="w-full bg-[#161b22] border border-[#30363d] text-[#e6edf3] rounded-lg px-3 py-2 text-xs focus:outline-none focus:border-[#58a6ff]"
          >
            <option value="">— Default connection —</option>
            {connections.map(conn => (
              <option key={conn.id} value={conn.id}>
                {conn.profile_name || `${conn.db_host}/${conn.db_name}`}{conn.is_default ? ' (default)' : ''}
              </option>
            ))}
          </select>
          {connections.length === 0 && (
            <p className="text-xs text-[#d29922] mt-1.5">
              {t('explorer.noConnections')}
            </p>
          )}

          {/* Stats */}
          {stats && (
            <div className="grid grid-cols-4 gap-1 mt-2">
              {[
                { label: t('explorer.schemas'), value: stats.schemas },
                { label: t('explorer.tables'), value: stats.tables },
                { label: t('explorer.columns'), value: stats.columns },
                { label: t('explorer.fks'), value: stats.fks },
              ].map(s => (
                <div key={s.label} className="bg-[#161b22] rounded px-2 py-1 text-center">
                  <div className="text-xs font-semibold text-[#e6edf3]">{s.value}</div>
                  <div className="text-[10px] text-[#8b949e]">{s.label}</div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Tab buttons */}
        <div className="flex border-b border-[#30363d]">
          {[
            { id: 'schema' as Tab, label: t('explorer.schemaTab'), icon: Table2 },
            { id: 'diagram' as Tab, label: t('explorer.diagramTab'), icon: GitBranch },
          ].map(tabItem => (
            <button
              key={tabItem.id}
              onClick={() => setTab(tabItem.id)}
              className={cn(
                'flex-1 flex items-center justify-center gap-1.5 py-2.5 text-xs font-medium transition-colors',
                tab === tabItem.id
                  ? 'text-[#58a6ff] border-b-2 border-[#58a6ff] bg-[#58a6ff]/5'
                  : 'text-[#8b949e] hover:text-[#e6edf3] hover:bg-[#21262d]'
              )}
            >
              <tabItem.icon size={13} />
              {tabItem.label}
            </button>
          ))}
        </div>

        {/* Schema tree (always visible as sidebar) */}
        <div className="flex-1 overflow-y-auto p-3">
          {loading ? (
            <div className="flex items-center gap-2 text-sm text-[#8b949e]">
              <Loader2 size={14} className="animate-spin" />
              {t('explorer.loadingSchema')}
            </div>
          ) : !schemaInfo ? (
            <div />
          ) : tab === 'schema' ? (
            <div className="space-y-3">
              {groupedTables.map(group => (
                <div key={group.schema}>
                  <div
                    className="flex items-center gap-2 px-2 py-1 mb-1 text-xs font-semibold rounded"
                    style={{ color: (schemaColorMap.get(group.schema)?.text ?? '#58a6ff') }}
                  >
                    <Database size={12} />
                    {group.schema}
                    <span className="ml-auto text-[#8b949e]">{group.tables.length}</span>
                  </div>
                  <div className="space-y-0.5">
                    {group.tables.map(table => (
                      <button
                        key={`${group.schema}.${table.table_name}`}
                        onClick={() => previewTable(group.schema, table.table_name)}
                        className={cn(
                          'w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs transition-colors',
                          selectedTable?.schema === group.schema && selectedTable?.table === table.table_name
                            ? 'bg-[#58a6ff]/10 text-[#58a6ff]'
                            : 'text-[#8b949e] hover:bg-[#21262d] hover:text-[#e6edf3]'
                        )}
                      >
                        <Table2 size={11} />
                        <span className="flex-1 text-left truncate">{table.table_name}</span>
                        <span className="text-[10px] text-[#8b949e]">{table.columns.length}</span>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-[#8b949e]">
              {t('explorer.diagramTab')}
            </p>
          )}
        </div>
      </aside>

      {/* Main content area */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {tab === 'diagram' && (
          <div className="flex-1 overflow-hidden">
            {schemaInfo ? (
            <SchemaDiagram
              schemaInfo={schemaInfo}
              onSelectTable={(schema, table) => {
                setSelectedTable({ schema, table });
                previewTable(schema, table);
              }}
              selectedTable={selectedTable}
              t={t}
            />
            ) : schemaError ? (
              <div className="flex items-center justify-center h-full flex-col text-center">
                <X size={24} className="text-[#f85149] mb-2" />
                <p className="text-xs text-[#8b949e] max-w-xs">{schemaError}</p>
              </div>
            ) : (
              <div className="flex items-center justify-center h-full">
                <Loader2 size={20} className="animate-spin text-[#58a6ff]" />
              </div>
            )}
          </div>
        )}

        {tab === 'schema' && (
          <div className="flex-1 overflow-y-auto p-6">
            {/* Loading state */}
            {loading && (
              <div className="flex flex-col items-center justify-center h-full text-center">
                <Loader2 size={32} className="animate-spin text-[#58a6ff] mb-3" />
                <p className="text-sm text-[#8b949e]">{t('explorer.loadingSchema')}</p>
              </div>
            )}

            {/* Error state */}
            {!loading && schemaError && (
              <div className="flex flex-col items-center justify-center h-full text-center">
                <X size={32} className="text-[#f85149] mb-3" />
                <p className="text-sm text-[#f85149] mb-1">{t('explorer.connectionFailed')}</p>
                <p className="text-xs text-[#8b949e] mb-4 max-w-sm">{schemaError}</p>
                <button
                  onClick={loadSchemaInfo}
                  className="px-4 py-2 bg-[#21262d] hover:bg-[#30363d] text-xs text-[#e6edf3] rounded-lg transition-colors"
                >
                  {tc('retry')}
                </button>
              </div>
            )}

            {/* No schema yet — no connection configured */}
            {!loading && !schemaError && !schemaInfo && (
              <div className="flex flex-col items-center justify-center h-full text-center">
                <Database size={48} className="text-[#21262d] mb-4" />
                <h2 className="text-base font-semibold text-[#8b949e] mb-2">{t('explorer.title')}</h2>
                <p className="text-sm text-[#8b949e] max-w-xs">
                  {connections.length === 0 ? t('explorer.noConnections') : t('explorer.selectTable')}
                </p>
              </div>
            )}

            {/* Welcome — schema loaded, no table selected */}
            {!loading && !schemaError && schemaInfo && !selectedTable && !previewLoading && !previewData && (
              <div className="flex flex-col items-center justify-center h-full text-center">
                <Table2 size={48} className="text-[#21262d] mb-4" />
                <h2 className="text-lg font-semibold text-[#8b949e] mb-2">{t('explorer.title')}</h2>
                <p className="text-sm text-[#8b949e] max-w-sm mb-6">{t('explorer.selectTable')}</p>
                <div className="flex gap-3">
                  <div className="text-center px-4 py-2 bg-[#161b22] rounded-lg border border-[#30363d]">
                    <div className="text-lg font-bold text-[#e6edf3]">{stats?.schemas ?? 0}</div>
                    <div className="text-xs text-[#8b949e]">{t('explorer.schemas')}</div>
                  </div>
                  <div className="text-center px-4 py-2 bg-[#161b22] rounded-lg border border-[#30363d]">
                    <div className="text-lg font-bold text-[#e6edf3]">{stats?.tables ?? 0}</div>
                    <div className="text-xs text-[#8b949e]">{t('explorer.tables')}</div>
                  </div>
                  <div className="text-center px-4 py-2 bg-[#161b22] rounded-lg border border-[#30363d]">
                    <div className="text-lg font-bold text-[#e6edf3]">{stats?.fks ?? 0}</div>
                    <div className="text-xs text-[#8b949e]">{t('explorer.fks')}</div>
                  </div>
                </div>
              </div>
            )}

            {/* Table detail panel */}
            {selectedTable && (
              <div>
                {/* Table header */}
                <div className="flex items-center gap-3 mb-6">
                  <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-semibold"
                    style={{ backgroundColor: (schemaColorMap.get(selectedTable.schema)?.bg ?? '#1a3a5c'), color: (schemaColorMap.get(selectedTable.schema)?.text ?? '#58a6ff') }}>
                    <Database size={12} />
                    {selectedTable.schema}
                  </div>
                  <div className="w-1 h-4 bg-[#30363d] rounded" />
                  <h2 className="text-lg font-semibold text-[#e6edf3]">{selectedTable.table}</h2>
                  <button
                    onClick={() => { setSelectedTable(null); setPreviewData(null); setPreviewError(''); }}
                    className="ml-auto p-1.5 text-[#8b949e] hover:text-[#e6edf3] hover:bg-[#21262d] rounded transition-colors"
                  >
                    <X size={16} />
                  </button>
                </div>

                {/* Columns */}
                {schemaInfo && (() => {
                  const tableInfo = schemaInfo.tables.find(
                    t => t.schema_name === selectedTable.schema && t.table_name === selectedTable.table
                  );
                  if (!tableInfo) return null;
                  return (
                    <div className="mb-6">
                      <h3 className="text-xs font-semibold text-[#8b949e] mb-2 uppercase tracking-wider">
                        {t('explorer.columns')} ({tableInfo.columns.length})
                      </h3>
                      <div className="overflow-x-auto rounded-lg border border-[#30363d]">
                        <table className="w-full text-xs">
                          <thead>
                            <tr className="bg-[#21262d]">
                              <th className="px-4 py-2.5 text-left font-medium text-[#8b949e]">Column</th>
                              <th className="px-4 py-2.5 text-left font-medium text-[#8b949e]">Type</th>
                              <th className="px-4 py-2.5 text-center font-medium text-[#8b949e]">{t('explorer.nullable')}</th>
                            </tr>
                          </thead>
                          <tbody>
                            {tableInfo.columns.map((col, i) => (
                              <tr key={col.column_name} className={cn('border-t border-[#30363d]', i % 2 === 0 ? 'bg-[#161b22]' : 'bg-[#0d1117]')}>
                                <td className="px-4 py-2 text-[#e6edf3] font-mono">{col.column_name}</td>
                                <td className="px-4 py-2 text-[#58a6ff] font-mono">{col.data_type}</td>
                                <td className="px-4 py-2 text-center">
                                  {col.is_nullable
                                    ? <span className="text-[#8b949e] text-[10px]">{t('explorer.nullable')}</span>
                                    : <span className="text-[#3fb950] text-[10px]">{t('explorer.notNull')}</span>
                                  }
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  );
                })()}

                {/* FK relations */}
                {schemaInfo && (() => {
                  const fks = schemaInfo.foreignKeys.filter(
                    fk => (fk.from_schema === selectedTable.schema && fk.from_table === selectedTable.table) ||
                          (fk.to_schema === selectedTable.schema && fk.to_table === selectedTable.table)
                  );
                  if (!fks.length) return null;
                  return (
                    <div className="mb-6">
                      <h3 className="text-xs font-semibold text-[#8b949e] mb-2 uppercase tracking-wider">
                        {t('explorer.foreignKeys')} ({fks.length})
                      </h3>
                      <div className="space-y-1.5">
                        {fks.map((fk, i) => (
                          <div key={i} className="flex items-center gap-2 px-3 py-2 bg-[#161b22] border border-[#30363d] rounded-lg text-xs">
                            {fk.from_schema === selectedTable.schema && fk.from_table === selectedTable.table ? (
                              <>
                                <span className="text-[#d29922] font-mono">{fk.from_column}</span>
                                <span className="text-[#8b949e]">→</span>
                                <span
                                  className="text-[#58a6ff] font-mono cursor-pointer hover:underline"
                                  onClick={() => { setSelectedTable({ schema: fk.to_schema, table: fk.to_table }); previewTable(fk.to_schema, fk.to_table); }}
                                >
                                  {fk.to_schema}.{fk.to_table}.{fk.to_column}
                                </span>
                              </>
                            ) : (
                              <>
                                <span
                                  className="text-[#58a6ff] font-mono cursor-pointer hover:underline"
                                  onClick={() => { setSelectedTable({ schema: fk.from_schema, table: fk.from_table }); previewTable(fk.from_schema, fk.from_table); }}
                                >
                                  {fk.from_schema}.{fk.from_table}.{fk.from_column}
                                </span>
                                <span className="text-[#8b949e]">→</span>
                                <span className="text-[#d29922] font-mono">{fk.to_column}</span>
                              </>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })()}

                {/* Data preview */}
                <div>
                  <h3 className="text-xs font-semibold text-[#8b949e] mb-2 uppercase tracking-wider flex items-center gap-2">
                    <Table2 size={12} />
                    {t('explorer.dataPreview')}
                  </h3>
                  {previewLoading ? (
                    <div className="flex items-center gap-2 py-8 text-sm text-[#8b949e]">
                      <Loader2 size={14} className="animate-spin" />
                      {t('explorer.loadingPreview')}
                    </div>
                  ) : previewError ? (
                    <div className="px-4 py-4 bg-[#f85149]/10 border border-[#f85149]/30 rounded-lg text-xs text-[#f85149]">
                      {previewError}
                    </div>
                  ) : previewData ? (
                    <div>
                      <div className="text-xs text-[#8b949e] mb-2">
                        {previewData.rowCount} row(s) · {previewData.columns.length} columns
                      </div>
                      <div className="overflow-x-auto rounded-lg border border-[#30363d]">
                        <table className="w-full text-xs">
                          <thead>
                            <tr className="bg-[#21262d]">
                              {previewData.columns.map(col => (
                                <th key={col} className="px-3 py-2 text-left font-medium text-[#8b949e] whitespace-nowrap">{col}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {previewData.rows.map((row, i) => (
                              <tr key={i} className={cn('border-t border-[#30363d]', i % 2 === 0 ? 'bg-[#161b22]' : 'bg-[#0d1117]')}>
                                {previewData.columns.map(col => (
                                  <td key={col} className="px-3 py-2 text-[#e6edf3] whitespace-nowrap">
                                    {row[col] === null ? (
                                      <span className="text-[#8b949e] italic">NULL</span>
                                    ) : (
                                      String(row[col] ?? '')
                                    )}
                                  </td>
                                ))}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  ) : null}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
