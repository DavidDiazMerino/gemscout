/**
 * GemScout Agent UI — the "money shot" for the hackathon demo.
 * Natural language → MongoDB Atlas Vector Search → Gemini scouting report.
 */

import { useRef, useState } from 'react'
import {
  AlertCircle,
  Bot,
  ChevronRight,
  CircleCheck,
  Loader2,
  Search,
  Sparkles,
  Trophy,
  Zap,
} from 'lucide-react'

// ─── Types ─────────────────────────────────────────────────────────────────

type ReasoningStep = {
  step: number
  action: string
  detail: string
  result_summary: string | null
}

type PlayerTrend = {
  direction: 'up' | 'down' | 'flat' | 'insufficient'
  values_by_season: Record<string, number>
  minutes_by_season: Record<string, number | null>
}

type ScoutPlayer = {
  id: string
  name: string
  age: number
  position: string
  nationality: string
  current_team: string
  league: string
  league_tier: number
  season: string
  stats: Record<string, number | null>
  metrics_normalized: Record<string, number | null>
  market_value_eur: number | null
  vector_score: number | null
  profile_text: string
  trend?: PlayerTrend
}

type DebugInfo = {
  query_intent: Record<string, unknown>
  filters_applied: Record<string, unknown>
  semantic_candidates: Array<{
    name: string
    team: string
    league: string
    age: number
    position: string
    vector_score: number
  }>
  quant_candidates_count: number
  final_ranking: Array<{
    name: string
    team: string
    vector_score: number
    stat_score: number
    combined_score: number
  }>
  timing_ms: Record<string, number>
  vector_index: string
  embedding_model: string
  llm_model: string
}

type ScoutResponse = {
  query: string
  reasoning_steps: ReasoningStep[]
  players: ScoutPlayer[]
  scouting_report: string
  tool_calls: string[]
  debug_info?: DebugInfo
}

// ─── Example queries ────────────────────────────────────────────────────────

type ExampleQuery = { label: string; query: string }

const EXAMPLE_QUERIES: ExampleQuery[] = [
  {
    label: 'Box-to-box MID U24',
    query:
      'Find me a box-to-box midfielder, under 24, high pressing intensity and strong ball progression, World Cup 2026 potential',
  },
  {
    label: 'Elite GK for WC 2026',
    query:
      'Elite goalkeeper for World Cup 2026 — commanding aerial presence, quick distribution, top-tier shot-stopping, under 32',
  },
  {
    label: 'Pressing forward U23',
    query:
      'High-intensity pressing forward, under 23, similar to Gnabry — explosive, goals and assists, Champions League ready',
  },
  {
    label: 'La Liga playmaker',
    query:
      'Creative attacking midfielder in La Liga, under 26, elite chance creation and key passes, potential dark horse for Spain squad',
  },
  {
    label: 'Ball-playing CB U25',
    query:
      'Ball-playing centre-back, under 25, strong in the air and comfortable with long-range passing, ideal for a high defensive line',
  },
  {
    label: 'Undervalued South American',
    query:
      'South American midfielder playing in Europe, under 25, undervalued by Transfermarkt relative to their statistical output, World Cup squad candidate',
  },
]

// ─── Position + League chips config ────────────────────────────────────────

const POSITIONS = [
  { value: '', label: 'All pos.' },
  { value: 'GK', label: 'GK' },
  { value: 'DEF', label: 'DEF' },
  { value: 'MID', label: 'MID' },
  { value: 'FWD', label: 'FWD' },
]

const LEAGUES = [
  { slug: '', label: 'All leagues' },
  { slug: 'premier-league', label: 'Premier League' },
  { slug: 'la-liga', label: 'La Liga' },
  { slug: 'bundesliga', label: 'Bundesliga' },
  { slug: 'serie-a', label: 'Serie A' },
  { slug: 'ligue-1', label: 'Ligue 1' },
]

// ─── Helpers ───────────────────────────────────────────────────────────────

function pct(val: number | null | undefined): string {
  if (val == null) return '—'
  return `${Math.round(val)}th`
}

function formatValue(eur: number | null | undefined): string {
  if (!eur) return 'unknown'
  if (eur >= 1_000_000) return `€${(eur / 1_000_000).toFixed(1)}M`
  return `€${(eur / 1000).toFixed(0)}K`
}

function tierLabel(tier: number): string {
  const labels: Record<number, string> = { 1: 'Big-5', 2: 'Mid Europe', 3: 'Other' }
  return labels[tier] ?? 'Unknown'
}

function tierColor(tier: number): string {
  const colors: Record<number, string> = {
    1: 'text-blue-300 border-blue-300/30 bg-blue-500/10',
    2: 'text-yellow-300 border-yellow-300/30 bg-yellow-500/10',
    3: 'text-[#00d992] border-[#00d992]/30 bg-[#00d992]/10',
  }
  return colors[tier] ?? 'text-[#8b949e] border-[#3d3a39] bg-[#1a1a1a]'
}

const ACTION_ICONS: Record<string, React.ReactNode> = {
  semantic_player_search: <Sparkles size={14} />,
  filter_players: <Search size={14} />,
  rank_candidates: <Trophy size={14} />,
  generate_scouting_report: <Bot size={14} />,
}

const ACTION_LABELS: Record<string, string> = {
  semantic_player_search: 'Atlas Vector Search (Voyage AI)',
  filter_players: 'Quantitative filter',
  rank_candidates: 'Combine + rank',
  generate_scouting_report: 'Gemini scouting report',
}

// ─── Sub-components ────────────────────────────────────────────────────────

function ChipRow<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string }[]
  value: T
  onChange: (v: T) => void
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((opt) => {
        const active = opt.value === value
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(active ? ('' as T) : opt.value)}
            className={`rounded-full border px-3 py-1 text-xs font-medium transition ${
              active
                ? 'border-[#00d992] bg-[#00d992] text-[#101010]'
                : 'border-[#3d3a39] bg-[#101010] text-[#8b949e] hover:border-[#00d992]/40 hover:text-[#bdbdbd]'
            }`}
          >
            {opt.label}
          </button>
        )
      })}
    </div>
  )
}

function ReasoningTrace({ steps, active }: { steps: ReasoningStep[]; active: boolean }) {
  return (
    <div className="mt-4 rounded-lg border border-[#3d3a39] bg-[#1a1a1a] p-4">
      <div className="mb-3 flex items-center gap-2">
        <Zap size={14} className="text-[#00d992]" />
        <span className="text-xs font-semibold uppercase tracking-[2.52px] text-[#8b949e]">
          Agent Reasoning
        </span>
        {active && <Loader2 size={12} className="animate-spin text-[#00d992]" />}
      </div>
      <div className="flex flex-col gap-2">
        {steps.map((step) => (
          <div key={step.step} className="flex items-start gap-3">
            <div className="mt-0.5 flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full border border-[#00d992]/30 bg-[#00d992]/10 text-[#00d992]">
              {step.result_summary ? (
                <CircleCheck size={12} />
              ) : active ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <ChevronRight size={12} />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-[#00d992]">
                  {ACTION_ICONS[step.action] ?? <Zap size={14} />}
                </span>
                <span className="text-xs font-semibold text-[#f2f2f2]">
                  {ACTION_LABELS[step.action] ?? step.action}
                </span>
              </div>
              <p className="mt-0.5 text-[11px] text-[#8b949e]">{step.detail}</p>
              {step.result_summary && (
                <p className="mt-1 text-[11px] text-[#bdbdbd]">{step.result_summary}</p>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

const METRICS_BY_POSITION: Record<string, { key: string; label: string }[]> = {
  GK: [
    { key: 'save_percent', label: 'Save %' },
    { key: 'goals_prevented', label: 'Goals prevented' },
    { key: 'clean_sheets', label: 'Clean sheets' },
    { key: 'rating', label: 'Rating' },
    { key: 'minutes', label: 'Minutes' },
  ],
  FWD: [
    { key: 'xg', label: 'xG' },
    { key: 'goals', label: 'Goals' },
    { key: 'npxg', label: 'npxG' },
    { key: 'xa', label: 'xA' },
    { key: 'xg_chain', label: 'xG chain' },
    { key: 'shots', label: 'Shots' },
  ],
  MID: [
    { key: 'xa', label: 'xA' },
    { key: 'key_passes', label: 'Key passes' },
    { key: 'xg_chain', label: 'xG chain' },
    { key: 'xg_buildup', label: 'xG buildup' },
    { key: 'xg', label: 'xG' },
    { key: 'assists', label: 'Assists' },
  ],
  DEF: [
    { key: 'xg_chain', label: 'xG chain' },
    { key: 'xg_buildup', label: 'xG buildup' },
    { key: 'key_passes', label: 'Key passes' },
    { key: 'xa', label: 'xA' },
    { key: 'minutes', label: 'Minutes' },
    { key: 'assists', label: 'Assists' },
  ],
}

const DEFAULT_METRICS = [
  { key: 'xg', label: 'xG' },
  { key: 'xa', label: 'xA' },
  { key: 'key_passes', label: 'Key passes' },
  { key: 'xg_chain', label: 'xG chain' },
  { key: 'xg_buildup', label: 'xG buildup' },
]

function TrendBadge({ trend }: { trend?: PlayerTrend }) {
  if (!trend || trend.direction === 'insufficient') return null

  const seasons = Object.keys(trend.values_by_season).sort()
  const vals = seasons.map((s) => trend.values_by_season[s])
  const max = Math.max(...vals, 1)

  const icon = trend.direction === 'up' ? '↑' : trend.direction === 'down' ? '↓' : '→'
  const color =
    trend.direction === 'up'
      ? 'text-[#00d992] border-[#00d992]/40 bg-[#00d992]/10'
      : trend.direction === 'down'
        ? 'text-red-400 border-red-400/40 bg-red-400/10'
        : 'text-[#8b949e] border-[#3d3a39] bg-[#101010]'

  return (
    <div className={`flex items-center gap-2 rounded border px-2 py-1 ${color}`}>
      <span className="text-[11px] font-bold">{icon} WC cycle</span>
      {/* mini bar chart */}
      <div className="flex items-end gap-0.5">
        {vals.map((v, i) => (
          <div
            key={i}
            className={`w-2 rounded-sm ${
              trend.direction === 'up'
                ? 'bg-[#00d992]/70'
                : trend.direction === 'down'
                  ? 'bg-red-400/70'
                  : 'bg-[#8b949e]/50'
            }`}
            style={{ height: `${Math.max(4, Math.round((v / max) * 16))}px` }}
            title={`${seasons[i]}: ${v.toFixed(0)}`}
          />
        ))}
      </div>
      <span className="font-mono text-[10px] opacity-70">
        {seasons[0]?.slice(0, 4)}–{seasons[seasons.length - 1]?.slice(-2)}
      </span>
    </div>
  )
}

function PlayerCard({ player, rank }: { player: ScoutPlayer; rank: number }) {
  const norm = player.metrics_normalized
  const stats = player.stats
  const pos = player.position?.toUpperCase()
  const keyMetrics = (METRICS_BY_POSITION[pos] ?? DEFAULT_METRICS).filter(
    (m) => norm[m.key] != null,
  )

  // Extract the first sentence or up to 120 chars of profile_text
  const profileSnippet = (() => {
    if (!player.profile_text) return null
    const dot = player.profile_text.indexOf('. ')
    const cut = dot > 0 && dot < 120 ? dot + 1 : 120
    const snippet = player.profile_text.slice(0, cut)
    return snippet.length < player.profile_text.length ? snippet + '…' : snippet
  })()

  return (
    <div className="rounded-lg border border-[#3d3a39] bg-[#1a1a1a] p-4 transition hover:border-[#00d992]/30">
      {/* Header */}
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-[#00d992]/15 text-base font-black text-[#00d992]">
            {rank}
          </div>
          <div>
            <h3 className="text-base font-bold text-[#f2f2f2]">{player.name}</h3>
            <p className="text-xs text-[#8b949e]">
              {player.current_team} · {player.nationality} · {player.age}y
            </p>
          </div>
        </div>
        <div className="flex flex-col items-end gap-1.5">
          <span className="rounded border border-[#3d3a39] bg-[#101010] px-2 py-0.5 text-xs font-semibold text-[#f2f2f2]">
            {player.position}
          </span>
          <span className={`rounded border px-1.5 py-0.5 text-[10px] font-medium ${tierColor(player.league_tier)}`}>
            {tierLabel(player.league_tier)}
          </span>
        </div>
      </div>

      {/* Tactical profile snippet */}
      {profileSnippet && (
        <p className="mb-3 rounded border border-[#3d3a39] bg-[#101010] px-3 py-2 text-[12px] italic leading-relaxed text-[#8b949e]">
          {profileSnippet}
        </p>
      )}

      {/* Percentile bars */}
      {keyMetrics.length > 0 && (
        <div className="mb-3 grid grid-cols-3 gap-1.5 sm:grid-cols-6">
          {keyMetrics.slice(0, 6).map((m) => {
            const percentile = norm[m.key] as number
            const raw = stats[m.key]
            return (
              <div key={m.key} className="rounded border border-[#3d3a39] bg-[#101010] p-2">
                <div className="mb-1 flex items-baseline justify-between gap-1">
                  <span className="truncate text-[11px] text-[#8b949e]">{m.label}</span>
                  <span className="flex-shrink-0 font-mono text-[11px] font-bold text-[#00d992]">{pct(percentile)}</span>
                </div>
                <div className="h-1 w-full overflow-hidden rounded-full bg-[#3d3a39]">
                  <div
                    className="h-full rounded-full bg-[#00d992]"
                    style={{ width: `${Math.max(2, percentile)}%` }}
                  />
                </div>
                {raw != null && (
                  <span className="mt-0.5 block font-mono text-[10px] text-[#8b949e]">
                    {typeof raw === 'number' ? raw.toFixed(1) : raw}
                  </span>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* Footer */}
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-[#8b949e]">
        <div className="flex items-center gap-2">
          <span>{player.league}</span>
          {player.market_value_eur && (
            <span className="text-[#bdbdbd]">
              · <span className="text-[#8b949e]">TM </span>
              {formatValue(player.market_value_eur)}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <TrendBadge trend={player.trend} />
          {player.vector_score != null && (
            <span className="font-mono text-[10px]" title="Semantic similarity score">
              sim {(player.vector_score * 100).toFixed(1)}%
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

function renderInline(text: string): React.ReactNode {
  const parts = text.split(/(\*\*[^*]+\*\*)/g)
  return (
    <>
      {parts.map((part, j) =>
        part.startsWith('**') && part.endsWith('**') ? (
          <strong key={j} className="font-semibold text-[#f2f2f2]">
            {part.slice(2, -2)}
          </strong>
        ) : (
          <span key={j}>{part}</span>
        ),
      )}
    </>
  )
}

function recoBadgeClass(value: string): string {
  if (value.includes('SIGN NOW')) return 'border-[#00d992]/60 bg-[#00d992]/20 text-[#00d992]'
  if (value.includes('TRACK CLOSELY')) return 'border-blue-400/50 bg-blue-400/15 text-blue-300'
  if (value.includes('MONITOR')) return 'border-yellow-400/50 bg-yellow-400/15 text-yellow-300'
  return 'border-[#3d3a39] bg-[#1a1a1a] text-[#8b949e]'
}

function confidenceTextClass(text: string): string {
  if (text.startsWith('HIGH')) return 'text-[#00d992]'
  if (text.startsWith('MEDIUM')) return 'text-yellow-300'
  return 'text-[#8b949e]'
}

function ScoutingReport({ report }: { report: string }) {
  const lines = report.split('\n')
  return (
    <div className="rounded-lg border border-[#3d3a39] bg-[#1a1a1a] p-5">
      <div className="mb-5 flex items-center gap-2">
        <Bot size={16} className="text-[#00d992]" />
        <span className="text-xs font-semibold uppercase tracking-[2.52px] text-[#8b949e]">
          Gemini Scouting Dossier
        </span>
      </div>
      <div className="space-y-2">
        {lines.map((raw, i) => {
          const line = raw.trimEnd()
          const trimmed = line.trim()

          // Player name header
          if (trimmed.match(/^#{1,3}\s/)) {
            const name = trimmed.replace(/^#+\s/, '')
            return (
              <h3
                key={i}
                className={`text-base font-bold text-[#f2f2f2] ${i > 0 ? 'mt-6 border-t border-[#3d3a39] pt-5' : ''}`}
              >
                {name}
              </h3>
            )
          }

          // --- divider: skipped (handled by the border-t on player headers)
          if (trimmed === '---') return null

          // RECOMMENDATION: VALUE
          if (trimmed.match(/^RECOMMENDATION:/)) {
            const value = trimmed.replace(/^RECOMMENDATION:\s*/, '')
            return (
              <div key={i} className="mt-3 flex items-center gap-2 pt-1">
                <span className="text-[10px] font-semibold uppercase tracking-[1.5px] text-[#8b949e]">
                  Recomendación
                </span>
                <span className={`rounded border px-2.5 py-0.5 text-xs font-bold ${recoBadgeClass(value)}`}>
                  {value}
                </span>
              </div>
            )
          }

          // CONFIDENCE: HIGH — reason
          if (trimmed.match(/^CONFIDENCE:/)) {
            const rest = trimmed.replace(/^CONFIDENCE:\s*/, '')
            const dashIdx = rest.indexOf('—')
            const level = dashIdx >= 0 ? rest.slice(0, dashIdx).trim() : rest
            const reason = dashIdx >= 0 ? rest.slice(dashIdx + 1).trim() : ''
            return (
              <p key={i} className="text-[12px] text-[#8b949e]">
                <span className={`font-semibold ${confidenceTextClass(rest)}`}>{level}</span>
                {reason && <span> — {reason}</span>}
              </p>
            )
          }

          // WORLD CUP CYCLE TREND — mini green callout
          if (trimmed.match(/^WORLD CUP CYCLE TREND/)) {
            return (
              <p key={i} className="mt-3 rounded border border-[#00d992]/25 bg-[#00d992]/5 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[1.5px] text-[#00d992]">
                {trimmed}
              </p>
            )
          }

          // WORLD CUP … VERDICT: — highlighted callout label
          if (trimmed.match(/^WORLD CUP/)) {
            return (
              <p key={i} className="mt-3 text-[10px] font-semibold uppercase tracking-[1.5px] text-[#00d992]">
                {trimmed}
              </p>
            )
          }

          // Other ALLCAPS section labels (TACTICAL VERDICT:, KEY STRENGTHS:, RISK FLAGS:…)
          if (trimmed.match(/^[A-Z][A-Z\s\d]+:/)) {
            return (
              <p key={i} className="mt-3 text-[10px] font-semibold uppercase tracking-[1.5px] text-[#00d992]">
                {trimmed}
              </p>
            )
          }

          // Bullet points
          if (trimmed.match(/^[-•]\s/) || trimmed.match(/^\s+[-•]\s/)) {
            const content = trimmed.replace(/^[-•]\s+/, '')
            return (
              <div key={i} className="flex gap-2.5 pl-1 text-[13px] leading-relaxed text-[#bdbdbd]">
                <span className="mt-[7px] h-1.5 w-1.5 flex-shrink-0 rounded-full bg-[#00d992]/50" />
                <span>{renderInline(content)}</span>
              </div>
            )
          }

          // Warning
          if (trimmed.match(/^⚠/)) {
            return (
              <p key={i} className="rounded border border-yellow-500/20 bg-yellow-500/5 px-3 py-2 text-[12px] text-yellow-300">
                {trimmed}
              </p>
            )
          }

          // Regular paragraph
          return trimmed ? (
            <p key={i} className="text-[13px] leading-relaxed text-[#bdbdbd]">
              {renderInline(trimmed)}
            </p>
          ) : (
            <div key={i} className="h-1" />
          )
        })}
      </div>
    </div>
  )
}

function DebugPanel({ info }: { info: DebugInfo }) {
  const totalMs = Object.values(info.timing_ms).reduce((a, b) => a + b, 0)

  const STEP_EXPLANATIONS: Record<string, string> = {
    semantic_search: 'Query → 1536-dim vector → cosine similarity over all ~2,200 player embeddings',
    quant_filter: 'Hard filter on age, position, league tier, then sort by position-specific stat',
    report_generation: `Prompt with top-3 player profiles + percentile stats → ${info.llm_model} → structured dossier`,
  }

  return (
    <div className="mt-6 rounded-lg border border-yellow-500/30 bg-yellow-500/5 p-5">
      <div className="mb-4 flex items-center gap-2">
        <span className="text-sm font-bold text-yellow-300">⚡ Technical View — Judges Panel</span>
        <span className="rounded border border-yellow-500/20 bg-yellow-500/10 px-2 py-0.5 text-[11px] text-yellow-400">
          {totalMs.toFixed(0)} ms total
        </span>
      </div>

      {/* Architecture pipeline */}
      <div className="mb-4 rounded border border-white/10 bg-black/30 p-4">
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-[1.5px] text-[#8b949e]">Full Pipeline</p>
        <div className="flex flex-wrap items-center gap-1 font-mono text-[12px]">
          {[
            { label: 'NL Query', color: 'text-[#f2f2f2]' },
            { label: `${info.embedding_model}`, color: 'text-blue-300', note: '1536-dim embedding' },
            { label: `Atlas: ${info.vector_index}`, color: 'text-[#00d992]', note: 'cosine similarity' },
            { label: 'Quantitative filter', color: 'text-yellow-300', note: 'age / position / league' },
            { label: '60% vec + 40% stat', color: 'text-orange-300', note: 'combined score' },
            { label: info.llm_model, color: 'text-purple-300', note: 'scouting dossier' },
          ].map((node, i, arr) => (
            <span key={i} className="flex items-center gap-1">
              <span className={`rounded border border-white/10 bg-black/40 px-2 py-0.5 ${node.color}`} title={node.note}>
                {node.label}
              </span>
              {i < arr.length - 1 && <span className="text-[#3d3a39]">→</span>}
            </span>
          ))}
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        {/* Query intent + filters */}
        <div className="rounded border border-white/10 bg-black/25 p-3">
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-[1.5px] text-[#8b949e]">
            Query Intent Parsing
          </p>
          <p className="mb-2 text-[11px] text-[#8b949e]">
            Regex patterns extract structured hints from the natural language query.
          </p>
          {Object.entries(info.query_intent).map(([k, v]) => {
            const detected = k.startsWith('detected_') || k === 'americas_league_flag'
            return (
              <div key={k} className="flex justify-between gap-2 py-0.5 text-[12px]">
                <span className="text-[#8b949e]">{k.replace(/_/g, ' ')}</span>
                <span className={`font-mono ${detected ? 'text-[#f2f2f2]' : 'text-[#00d992]'}`}>
                  {v != null ? String(v) : '—'}
                </span>
              </div>
            )
          })}
          <div className="mt-2 border-t border-white/10 pt-2">
            <p className="mb-1 text-[11px] text-[#8b949e]">Active MongoDB filters:</p>
            {Object.entries(info.filters_applied).map(([k, v]) => (
              <div key={k} className="flex justify-between gap-2 py-0.5 text-[12px]">
                <span className="text-[#8b949e]">{k.replace(/_/g, ' ')}</span>
                <span className="font-mono text-[#00d992]">{v != null ? String(v) : '—'}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Timing breakdown */}
        <div className="rounded border border-white/10 bg-black/25 p-3">
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-[1.5px] text-[#8b949e]">Step Timing</p>
          {Object.entries(info.timing_ms).map(([step, ms]) => {
            const pct = Math.round((ms / totalMs) * 100)
            const explanation = STEP_EXPLANATIONS[step]
            return (
              <div key={step} className="mb-2.5">
                <div className="flex justify-between text-[12px]">
                  <span className="text-[#bdbdbd]">{step.replace(/_/g, ' ')}</span>
                  <span className="font-mono text-[#00d992]">{ms} ms</span>
                </div>
                {explanation && (
                  <p className="mb-0.5 text-[11px] leading-tight text-[#8b949e]">{explanation}</p>
                )}
                <div className="h-1 w-full overflow-hidden rounded-full bg-[#3d3a39]">
                  <div className="h-full rounded-full bg-[#00d992]/60" style={{ width: `${pct}%` }} />
                </div>
              </div>
            )
          })}
          <p className="mt-2 border-t border-white/10 pt-2 text-[11px] text-[#8b949e]">
            Embedding model: <span className="text-[#f2f2f2]">{info.embedding_model}</span> (dim 1536) ·
            {' '}LLM: <span className="text-[#f2f2f2]">{info.llm_model}</span> · Vertex AI us-central1
          </p>
        </div>
      </div>

      {/* Atlas Vector Search candidates */}
      <div className="mt-3 rounded border border-white/10 bg-black/25 p-3">
        <div className="mb-2 flex items-baseline gap-2">
          <p className="text-[11px] font-semibold uppercase tracking-[1.5px] text-[#8b949e]">
            Step 1 — Atlas Vector Search ({info.semantic_candidates.length} semantic candidates)
          </p>
          <span className="text-[11px] text-[#8b949e]">
            numCandidates: {info.semantic_candidates.length * 20}+ · cosine similarity · post-filtered
          </span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[500px] text-left text-[12px]">
            <thead>
              <tr className="border-b border-white/10 text-[#8b949e]">
                <th className="pb-1 pr-4">#</th>
                <th className="pb-1 pr-4">Player</th>
                <th className="pb-1 pr-4">Club · League</th>
                <th className="pb-1 pr-4">Pos · Age</th>
                <th className="pb-1 text-right">Cosine sim.</th>
              </tr>
            </thead>
            <tbody>
              {info.semantic_candidates.map((c, i) => (
                <tr key={c.name} className="border-b border-white/[0.04]">
                  <td className="py-1 pr-4 text-[#8b949e]">{i + 1}</td>
                  <td className="py-1 pr-4 font-medium text-[#f2f2f2]">{c.name}</td>
                  <td className="py-1 pr-4 text-[#8b949e]">{c.team} · {c.league}</td>
                  <td className="py-1 pr-4 text-[#8b949e]">{c.position} · {c.age}y</td>
                  <td className="py-1 text-right">
                    <span className="font-mono text-[#00d992]">{c.vector_score.toFixed(4)}</span>
                    <div className="mt-0.5 h-1 w-full overflow-hidden rounded-full bg-[#3d3a39]">
                      <div
                        className="h-full rounded-full bg-[#00d992]"
                        style={{ width: `${Math.round(c.vector_score * 100)}%` }}
                      />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Final ranking */}
      <div className="mt-3 rounded border border-white/10 bg-black/25 p-3">
        <div className="mb-2 flex items-baseline gap-2">
          <p className="text-[11px] font-semibold uppercase tracking-[1.5px] text-[#8b949e]">
            Step 3 — Combined Ranking
          </p>
          <span className="text-[11px] text-[#8b949e]">
            score = <span className="text-[#00d992]">0.6</span> × cosine_sim×100 + <span className="text-[#00d992]">0.4</span> × position_stat_percentile_avg
          </span>
        </div>
        <div className="mb-1.5 grid grid-cols-[24px_minmax(0,1fr)_80px_80px_88px] gap-2 text-[11px] text-[#8b949e]">
          <span>#</span><span>Player · Club</span>
          <span className="text-right">vec score</span>
          <span className="text-right">stat p̄</span>
          <span className="text-right font-semibold text-[#00d992]">combined</span>
        </div>
        <div className="space-y-1">
          {info.final_ranking.map((p, i) => (
            <div key={p.name} className="grid grid-cols-[24px_minmax(0,1fr)_80px_80px_88px] items-center gap-2 text-[12px]">
              <span className="text-[#8b949e]">{i + 1}</span>
              <span className="font-medium text-[#f2f2f2]">
                {p.name}
                <span className="ml-1 font-normal text-[#8b949e]">· {p.team}</span>
              </span>
              <span className="text-right font-mono text-[#8b949e]" title="semantic similarity × 100">
                {(p.vector_score * 100).toFixed(1)}
              </span>
              <span className="text-right font-mono text-[#8b949e]" title="position stat percentile avg">
                {p.stat_score?.toFixed(1) ?? '—'}
              </span>
              <span className="text-right font-mono font-bold text-[#00d992]">
                {p.combined_score.toFixed(1)}
              </span>
            </div>
          ))}
        </div>
        <p className="mt-2 text-[11px] text-[#8b949e]">
          Quant-filter added {info.quant_candidates_count > 0 ? `${info.quant_candidates_count}` : '0'} extra candidates
          {info.quant_candidates_count > 0 ? ' (sorted by position stat, merged into semantic pool)' : ' (all candidates came from vector search)'}
        </p>
      </div>
    </div>
  )
}

// ─── Main ScoutMode component ───────────────────────────────────────────────

export default function ScoutMode() {
  const [query, setQuery] = useState('')
  const [position, setPosition] = useState<string>('')
  const [leagueSlug, setLeagueSlug] = useState<string>('')
  const [maxAge, setMaxAge] = useState<string>('')
  const [loading, setLoading] = useState(false)
  const [streamingSteps, setStreamingSteps] = useState<ReasoningStep[]>([])
  const [result, setResult] = useState<ScoutResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [judgesMode, setJudgesMode] = useState(false)
  const abortRef = useRef<AbortController | null>(null)

  const handleSubmit = async (q = query) => {
    if (!q.trim() || loading) return
    abortRef.current?.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl

    setLoading(true)
    setError(null)
    setResult(null)
    setStreamingSteps([])

    const simulatedSteps: ReasoningStep[] = [
      {
        step: 1,
        action: 'semantic_player_search',
        detail: `Translating '${q}' to a tactical embedding via Voyage AI, querying MongoDB Atlas Vector Search`,
        result_summary: null,
      },
    ]
    setStreamingSteps([...simulatedSteps])

    const timers: ReturnType<typeof setTimeout>[] = []
    timers.push(
      setTimeout(() => {
        setStreamingSteps((prev) => [
          ...prev,
          {
            step: 2,
            action: 'filter_players',
            detail: 'Cross-referencing with quantitative filters to validate candidates',
            result_summary: null,
          },
        ])
      }, 800),
    )
    timers.push(
      setTimeout(() => {
        setStreamingSteps((prev) => [
          ...prev,
          {
            step: 3,
            action: 'rank_candidates',
            detail: 'Scoring candidates by combined semantic similarity + statistical percentile',
            result_summary: null,
          },
        ])
      }, 1600),
    )
    timers.push(
      setTimeout(() => {
        setStreamingSteps((prev) => [
          ...prev,
          {
            step: 4,
            action: 'generate_scouting_report',
            detail: 'Calling Gemini 2.5 Flash to generate detailed scouting dossier…',
            result_summary: null,
          },
        ])
      }, 2400),
    )

    try {
      const body: Record<string, unknown> = {
        query: q,
        season: '2025-26',
        world_cup_context: true,
        limit: 5,
        debug_mode: judgesMode,
      }
      if (position) body.position = position
      if (maxAge) body.max_age = parseInt(maxAge, 10)
      if (leagueSlug) body.league_slug = leagueSlug

      const resp = await fetch('/api/agent/scout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      })

      timers.forEach(clearTimeout)

      if (!resp.ok) {
        const text = await resp.text()
        throw new Error(`${resp.status}: ${text}`)
      }

      const data: ScoutResponse = await resp.json()
      setResult(data)
      setStreamingSteps(data.reasoning_steps)
    } catch (err: unknown) {
      timers.forEach(clearTimeout)
      if ((err as Error).name !== 'AbortError') {
        setError((err as Error).message)
      }
    } finally {
      setLoading(false)
    }
  }

  const handleExampleClick = (q: string) => {
    setQuery(q)
    handleSubmit(q)
  }

  return (
    <div className="mx-auto max-w-4xl px-4 pb-16 pt-6">
      {/* Hero */}
      <div className="mb-8 text-center">
        <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-[#00d992]/30 bg-[#00d992]/10 px-3 py-1">
          <Sparkles size={12} className="text-[#00d992]" />
          <span className="text-xs font-semibold uppercase tracking-[2.52px] text-[#00d992]">
            Agent Builder · Atlas · Voyage AI · Gemini 2.5
          </span>
        </div>
        <h1 className="text-3xl font-black tracking-[-0.65px] text-[#f2f2f2] sm:text-4xl">
          Find them{' '}
          <span className="text-[#00d992]">before anyone else</span>
        </h1>
        <p className="mt-2 text-sm text-[#8b949e]">
          2,200+ players · Semantic + statistical scouting · World Cup 2026 ready
        </p>
        {/* Data coverage disclaimer */}
        <div className="mx-auto mt-3 flex max-w-lg items-start gap-2 rounded-lg border border-[#3d3a39] bg-[#1a1a1a] px-3 py-2 text-left">
          <AlertCircle size={13} className="mt-0.5 flex-shrink-0 text-[#8b949e]" />
          <p className="text-[11px] leading-relaxed text-[#8b949e]">
            <span className="font-semibold text-[#bdbdbd]">Coverage: </span>
            Big-5 + Mid-European leagues (2025-26). No Americas/CONMEBOL league data — South American players are indexed based on their current European club.
          </p>
        </div>
      </div>

      {/* Query input */}
      <div className="rounded-lg border border-[#3d3a39] bg-[#1a1a1a] p-4">
        <textarea
          className="w-full resize-none rounded border border-[#3d3a39] bg-[#101010] px-4 py-3 text-sm text-[#f2f2f2] placeholder-[#8b949e] outline-none transition focus:border-[#00d992]/50 focus:ring-1 focus:ring-[#00d992]/20"
          rows={3}
          placeholder="e.g. Box-to-box midfielder, under 24, high pressing intensity and ball progression, World Cup 2026 potential…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleSubmit()
          }}
        />

        {/* Position chips */}
        <div className="mt-3 flex items-center gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-[1.5px] text-[#8b949e]">
            Pos
          </span>
          <ChipRow
            options={POSITIONS}
            value={position}
            onChange={setPosition}
          />
        </div>

        {/* League chips */}
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-[1.5px] text-[#8b949e]">
            Liga
          </span>
          <ChipRow
            options={LEAGUES.map((l) => ({ value: l.slug, label: l.label }))}
            value={leagueSlug}
            onChange={setLeagueSlug}
          />
        </div>

        {/* Age + Scout button */}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <input
            type="number"
            className="w-28 rounded border border-[#3d3a39] bg-[#101010] px-3 py-1.5 text-xs text-[#f2f2f2] placeholder-[#8b949e] outline-none transition focus:border-[#00d992]/50"
            placeholder="Edad máx."
            min={15}
            max={40}
            value={maxAge}
            onChange={(e) => setMaxAge(e.target.value)}
          />
          <button
            type="button"
            onClick={() => {
              const next = !judgesMode
              setJudgesMode(next)
              if (next && result && query.trim()) handleSubmit(query)
            }}
            title="Toggle technical detail for judges"
            className={`flex items-center gap-1.5 rounded border px-3 py-1.5 text-[11px] font-semibold transition ${
              judgesMode
                ? 'border-yellow-500/50 bg-yellow-500/15 text-yellow-300'
                : 'border-[#3d3a39] bg-[#101010] text-[#8b949e] hover:text-[#bdbdbd]'
            }`}
          >
            ⚡ Judges
          </button>
          <span className="text-[11px] text-[#8b949e]">Cmd+Enter</span>
          <button
            type="button"
            onClick={() => handleSubmit()}
            disabled={loading || !query.trim()}
            className="ml-auto flex items-center gap-2 rounded bg-[#00d992] px-5 py-2 text-sm font-bold text-[#101010] transition hover:bg-[#2fd6a1] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading ? (
              <Loader2 size={15} className="animate-spin" />
            ) : (
              <Search size={15} />
            )}
            Scout
          </button>
        </div>
      </div>

      {/* Example queries */}
      {!result && !loading && (
        <div className="mt-5">
          <p className="mb-2.5 text-[11px] font-semibold uppercase tracking-[2.52px] text-[#8b949e]">
            Prueba un ejemplo
          </p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {EXAMPLE_QUERIES.map((ex) => (
              <button
                key={ex.label}
                type="button"
                onClick={() => handleExampleClick(ex.query)}
                className="rounded-lg border border-[#3d3a39] bg-[#1a1a1a] p-3 text-left transition hover:border-[#00d992]/30 hover:bg-[#00d992]/5"
              >
                <span className="block text-[11px] font-semibold text-[#00d992]">{ex.label}</span>
                <span className="mt-1 block text-[11px] leading-relaxed text-[#8b949e] line-clamp-2">
                  {ex.query}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="mt-4 rounded border border-red-400/30 bg-red-500/10 p-4 text-sm text-red-300">
          <strong>Error:</strong> {error}
        </div>
      )}

      {/* Reasoning trace */}
      {(loading || streamingSteps.length > 0) && (
        <ReasoningTrace steps={streamingSteps} active={loading} />
      )}

      {/* Results */}
      {result && (
        <div className="mt-6 flex flex-col gap-6">
          {result.players.length > 0 && (
            <div>
              <h2 className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-[2.52px] text-[#8b949e]">
                <Trophy size={14} className="text-[#00d992]" />
                Top Candidates
              </h2>
              <div className="grid gap-3">
                {result.players.slice(0, 3).map((player, i) => (
                  <PlayerCard key={player.id} player={player} rank={i + 1} />
                ))}
              </div>
            </div>
          )}

          {result.scouting_report && (
            <ScoutingReport report={result.scouting_report} />
          )}

          {judgesMode && result.debug_info && (
            <DebugPanel info={result.debug_info} />
          )}
        </div>
      )}
    </div>
  )
}
