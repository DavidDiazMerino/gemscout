/**
 * GemScout Agent UI — streaming edition.
 * Natural language → ADK Agent (Gemini 3 Pro) → MCP → MongoDB Atlas → live scouting report.
 *
 * The frontend consumes a Server-Sent Events stream from /api/agent/scout/stream:
 *   step_start  → push reasoning step
 *   step_done   → close reasoning step with result_summary
 *   player      → push player card (one at a time as MCP returns them)
 *   text        → append chunk to scouting dossier
 *   done        → finalise
 *   error       → surface error
 */

import { useRef, useState } from 'react'
import {
  AlertCircle,
  Bot,
  ChevronRight,
  CircleCheck,
  Database,
  ExternalLink,
  Loader2,
  Search,
  Sparkles,
  Trophy,
  Zap,
} from 'lucide-react'

// ─── Config ─────────────────────────────────────────────────────────────────

const ADK_AGENT_UI = 'https://gemscout-agent-377689698254.europe-west3.run.app'

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

function actionIcon(action: string): React.ReactNode {
  if (action.startsWith('mcp:aggregate')) return <Database size={14} />
  if (action.startsWith('mcp:find')) return <Search size={14} />
  if (action.startsWith('mcp:count')) return <Zap size={14} />
  if (action === 'connecting') return <Bot size={14} />
  return <Zap size={14} />
}

function actionLabel(action: string): string {
  if (action === 'mcp:aggregate') return 'MongoDB aggregate — Atlas Search ($search pipeline)'
  if (action === 'mcp:find') return 'MongoDB find — player profile lookup'
  if (action === 'mcp:count') return 'MongoDB count'
  if (action === 'connecting') return 'Connecting to GemScout agent (Gemini 3 Pro)'
  return action
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

function ReasoningTrace({
  steps,
  active,
  done,
}: {
  steps: ReasoningStep[]
  active: boolean
  done: boolean
}) {
  return (
    <div className="mt-4 rounded-lg border border-[#3d3a39] bg-[#1a1a1a] p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Zap size={14} className="text-[#00d992]" />
          <span className="text-xs font-semibold uppercase tracking-[2.52px] text-[#8b949e]">
            Agent Reasoning {active && '· Live'}
          </span>
          {active && <Loader2 size={12} className="animate-spin text-[#00d992]" />}
        </div>
        {done && steps.length > 0 && (
          <a
            href={ADK_AGENT_UI}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 text-[11px] text-[#8b949e] transition hover:text-[#00d992]"
          >
            Agent UI
            <ExternalLink size={10} />
          </a>
        )}
      </div>

      {steps.length === 0 && active && (
        <div className="flex items-center gap-2 text-[12px] text-[#8b949e]">
          <Loader2 size={12} className="animate-spin text-[#00d992]" />
          <span>Creating ADK session and dispatching to Gemini 3 Pro…</span>
        </div>
      )}

      <div className="flex flex-col gap-2">
        {steps.map((step, idx) => {
          const isLast = idx === steps.length - 1
          const isRunning = active && isLast && !step.result_summary
          return (
            <div key={step.step} className="flex items-start gap-3">
              <div className="mt-0.5 flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full border border-[#00d992]/30 bg-[#00d992]/10 text-[#00d992]">
                {step.result_summary ? (
                  <CircleCheck size={12} />
                ) : isRunning ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : (
                  <ChevronRight size={12} />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-[#00d992]">{actionIcon(step.action)}</span>
                  <span className="text-xs font-semibold text-[#f2f2f2]">
                    {actionLabel(step.action)}
                  </span>
                </div>
                <p className="mt-0.5 break-all text-[11px] text-[#8b949e]">{step.detail}</p>
                {step.result_summary && (
                  <p className="mt-1 text-[11px] text-[#bdbdbd]">{step.result_summary}</p>
                )}
              </div>
            </div>
          )
        })}
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

function PlayerCard({
  player,
  rank,
  onFindSimilar,
}: {
  player: ScoutPlayer
  rank: number
  onFindSimilar?: (p: ScoutPlayer) => void
}) {
  const norm = player.metrics_normalized
  const stats = player.stats
  const pos = player.position?.toUpperCase()
  const keyMetrics = (METRICS_BY_POSITION[pos] ?? DEFAULT_METRICS).filter(
    (m) => norm[m.key] != null,
  )

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
          <span
            className={`rounded border px-1.5 py-0.5 text-[10px] font-medium ${tierColor(player.league_tier)}`}
          >
            {tierLabel(player.league_tier)}
          </span>
        </div>
      </div>

      {profileSnippet && (
        <p className="mb-3 rounded border border-[#3d3a39] bg-[#101010] px-3 py-2 text-[12px] italic leading-relaxed text-[#8b949e]">
          {profileSnippet}
        </p>
      )}

      {keyMetrics.length === 0 && (
        <div className="mb-3 flex items-center gap-2 rounded border border-[#3d3a39] bg-[#101010] px-3 py-2 text-[11px] text-[#8b949e]">
          <span className="h-2 w-2 rounded-full bg-[#3d3a39]" />
          Stats not included in this query — click the card to scout further
        </div>
      )}

      {keyMetrics.length > 0 && (
        <div className="mb-3 grid grid-cols-3 gap-1.5 sm:grid-cols-6">
          {keyMetrics.slice(0, 6).map((m) => {
            const percentile = norm[m.key] as number
            const raw = stats[m.key]
            return (
              <div key={m.key} className="rounded border border-[#3d3a39] bg-[#101010] p-2">
                <div className="mb-1 flex items-baseline justify-between gap-1">
                  <span className="truncate text-[11px] text-[#8b949e]">{m.label}</span>
                  <span className="flex-shrink-0 font-mono text-[11px] font-bold text-[#00d992]">
                    {pct(percentile)}
                  </span>
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
          {onFindSimilar && (
            <button
              type="button"
              onClick={() => onFindSimilar(player)}
              title="Find tactically similar players via Atlas Vector Search (MCP)"
              className="flex items-center gap-1 rounded border border-[#00d992]/40 bg-[#00d992]/10 px-2 py-1 text-[10px] font-semibold text-[#00d992] transition hover:bg-[#00d992]/20"
            >
              <Sparkles size={10} />
              Find similar
            </button>
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

function ScoutingReport({ report, streaming }: { report: string; streaming: boolean }) {
  const lines = report.split('\n')
  return (
    <div className="rounded-lg border border-[#3d3a39] bg-[#1a1a1a] p-5">
      <div className="mb-5 flex items-center gap-2">
        <Bot size={16} className="text-[#00d992]" />
        <span className="text-xs font-semibold uppercase tracking-[2.52px] text-[#8b949e]">
          Gemini 3 Pro — Scouting Dossier {streaming && '· Writing…'}
        </span>
        {streaming && <Loader2 size={12} className="animate-spin text-[#00d992]" />}
      </div>
      <div className="space-y-2">
        {lines.map((raw, i) => {
          const line = raw.trimEnd()
          const trimmed = line.trim()

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

          if (trimmed === '---') return null

          if (trimmed.match(/^RECOMMENDATION:/)) {
            const value = trimmed.replace(/^RECOMMENDATION:\s*/, '')
            return (
              <div key={i} className="mt-3 flex items-center gap-2 pt-1">
                <span className="text-[10px] font-semibold uppercase tracking-[1.5px] text-[#8b949e]">
                  Recomendación
                </span>
                <span
                  className={`rounded border px-2.5 py-0.5 text-xs font-bold ${recoBadgeClass(value)}`}
                >
                  {value}
                </span>
              </div>
            )
          }

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

          if (trimmed.match(/^WORLD CUP CYCLE TREND/)) {
            return (
              <p
                key={i}
                className="mt-3 rounded border border-[#00d992]/25 bg-[#00d992]/5 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[1.5px] text-[#00d992]"
              >
                {trimmed}
              </p>
            )
          }

          if (trimmed.match(/^WORLD CUP/)) {
            return (
              <p
                key={i}
                className="mt-3 text-[10px] font-semibold uppercase tracking-[1.5px] text-[#00d992]"
              >
                {trimmed}
              </p>
            )
          }

          if (trimmed.match(/^[A-Z][A-Z\s\d]+:/)) {
            return (
              <p
                key={i}
                className="mt-3 text-[10px] font-semibold uppercase tracking-[1.5px] text-[#00d992]"
              >
                {trimmed}
              </p>
            )
          }

          if (trimmed.match(/^[-•]\s/) || trimmed.match(/^\s+[-•]\s/)) {
            const content = trimmed.replace(/^[-•]\s+/, '')
            return (
              <div
                key={i}
                className="flex gap-2.5 pl-1 text-[13px] leading-relaxed text-[#bdbdbd]"
              >
                <span className="mt-[7px] h-1.5 w-1.5 flex-shrink-0 rounded-full bg-[#00d992]/50" />
                <span>{renderInline(content)}</span>
              </div>
            )
          }

          if (trimmed.match(/^⚠/)) {
            return (
              <p
                key={i}
                className="rounded border border-yellow-500/20 bg-yellow-500/5 px-3 py-2 text-[12px] text-yellow-300"
              >
                {trimmed}
              </p>
            )
          }

          return trimmed ? (
            <p key={i} className="text-[13px] leading-relaxed text-[#bdbdbd]">
              {renderInline(trimmed)}
              {streaming && i === lines.length - 1 && (
                <span className="ml-0.5 inline-block h-3 w-1 animate-pulse bg-[#00d992]/70" />
              )}
            </p>
          ) : (
            <div key={i} className="h-1" />
          )
        })}
      </div>
    </div>
  )
}

// ─── Judges / Technical Panel ──────────────────────────────────────────────

function AgentPanel({
  steps,
  players,
  toolCalls,
}: {
  steps: ReasoningStep[]
  players: ScoutPlayer[]
  toolCalls: string[]
}) {
  const mcpCalls = steps.filter((s) => s.action.startsWith('mcp:'))

  return (
    <div className="mt-6 rounded-lg border border-yellow-500/30 bg-yellow-500/5 p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="text-sm font-bold text-yellow-300">⚡ Technical View — Judges Panel</span>
          <span className="rounded border border-yellow-500/20 bg-yellow-500/10 px-2 py-0.5 text-[11px] text-yellow-400">
            ADK + MCP · Gemini 3 Pro
          </span>
          <span className="rounded border border-yellow-500/20 bg-yellow-500/10 px-2 py-0.5 text-[11px] text-yellow-400">
            {toolCalls.length} MCP calls
          </span>
        </div>
        <a
          href={ADK_AGENT_UI}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1.5 rounded border border-yellow-500/30 bg-yellow-500/10 px-3 py-1.5 text-[11px] font-semibold text-yellow-300 transition hover:bg-yellow-500/20"
        >
          <ExternalLink size={12} />
          Open ADK Agent UI
        </a>
      </div>

      <div className="mb-4 rounded border border-white/10 bg-black/30 p-4">
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-[1.5px] text-[#8b949e]">
          Streaming Pipeline (Server-Sent Events end-to-end)
        </p>
        <div className="flex flex-wrap items-center gap-1 font-mono text-[12px]">
          {[
            { label: 'NL Query', color: 'text-[#f2f2f2]' },
            { label: 'FastAPI /scout/stream', color: 'text-blue-300' },
            { label: 'ADK /run_sse', color: 'text-purple-300' },
            { label: 'Gemini 3 Pro', color: 'text-orange-300' },
            { label: 'MongoDB MCP (partner)', color: 'text-[#00d992]' },
            { label: 'Atlas Search + Vector', color: 'text-yellow-300' },
          ].map((node, i, arr) => (
            <span key={i} className="flex items-center gap-1">
              <span className={`rounded border border-white/10 bg-black/40 px-2 py-0.5 ${node.color}`}>
                {node.label}
              </span>
              {i < arr.length - 1 && <span className="text-[#3d3a39]">→</span>}
            </span>
          ))}
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <div className="rounded border border-white/10 bg-black/25 p-3">
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-[1.5px] text-[#8b949e]">
            MCP Tool Calls ({mcpCalls.length})
          </p>
          {mcpCalls.length === 0 ? (
            <p className="text-[12px] text-[#8b949e]">No MCP calls recorded yet</p>
          ) : (
            <div className="space-y-3">
              {mcpCalls.map((step, i) => {
                const toolName = step.action.replace('mcp:', '')
                const rawDetail = step.detail
                  .replace(`MCP tool call → ${toolName}(`, '')
                  .replace(/\)$/, '')
                return (
                  <div key={i} className="rounded border border-white/[0.06] bg-black/20 p-2">
                    <div className="mb-1 flex items-center gap-2">
                      <span className="text-[#00d992]">{actionIcon(step.action)}</span>
                      <span className="text-[12px] font-semibold text-[#f2f2f2]">{toolName}</span>
                      {step.result_summary && (
                        <span className="ml-auto rounded bg-[#00d992]/15 px-1.5 py-0.5 text-[10px] font-medium text-[#00d992]">
                          {step.result_summary}
                        </span>
                      )}
                    </div>
                    <pre className="overflow-x-auto whitespace-pre-wrap break-all font-mono text-[10px] leading-relaxed text-[#8b949e]">
                      {rawDetail.slice(0, 400)}
                      {rawDetail.length > 400 ? '…' : ''}
                    </pre>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        <div className="rounded border border-white/10 bg-black/25 p-3">
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-[1.5px] text-[#8b949e]">
            Players via MCP ({players.length})
          </p>
          {players.length === 0 ? (
            <p className="text-[12px] text-[#8b949e]">No players returned yet</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-[12px]">
                <thead>
                  <tr className="border-b border-white/10 text-[#8b949e]">
                    <th className="pb-1 pr-3">#</th>
                    <th className="pb-1 pr-3">Player</th>
                    <th className="pb-1 pr-3">Club</th>
                    <th className="pb-1 pr-3">Pos · Age</th>
                    <th className="pb-1 text-right">TM Value</th>
                  </tr>
                </thead>
                <tbody>
                  {players.map((p, i) => (
                    <tr key={p.id} className="border-b border-white/[0.04]">
                      <td className="py-1 pr-3 text-[#8b949e]">{i + 1}</td>
                      <td className="py-1 pr-3 font-medium text-[#f2f2f2]">{p.name}</td>
                      <td className="py-1 pr-3 text-[#8b949e]">{p.current_team}</td>
                      <td className="py-1 pr-3 text-[#8b949e]">
                        {p.position} · {p.age}y
                      </td>
                      <td className="py-1 text-right font-mono text-[#00d992]">
                        {formatValue(p.market_value_eur)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      <div className="mt-4 rounded border border-yellow-500/20 bg-yellow-500/5 p-3">
        <p className="text-[12px] text-yellow-200/80">
          <span className="font-semibold">💡 Deeper inspection:</span> The ADK Agent UI exposes
          each Gemini turn, the exact MCP tool requests/responses, and the full reasoning trace.
        </p>
        <a
          href={ADK_AGENT_UI}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-2 flex items-center gap-1.5 text-[12px] font-semibold text-yellow-300 transition hover:text-yellow-200"
        >
          <ExternalLink size={12} />
          {ADK_AGENT_UI}
        </a>
      </div>
    </div>
  )
}

// ─── Main component ────────────────────────────────────────────────────────

type StreamMode = 'scout' | 'similar'

export default function ScoutMode() {
  const [query, setQuery] = useState('')
  const [position, setPosition] = useState<string>('')
  const [leagueSlug, setLeagueSlug] = useState<string>('')
  const [maxAge, setMaxAge] = useState<string>('')

  const [loading, setLoading] = useState(false)
  const [done, setDone] = useState(false)
  const [steps, setSteps] = useState<ReasoningStep[]>([])
  const [players, setPlayers] = useState<ScoutPlayer[]>([])
  const [report, setReport] = useState<string>('')
  const [toolCalls, setToolCalls] = useState<string[]>([])
  const [activeMode, setActiveMode] = useState<{ mode: StreamMode; refName?: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [judgesMode, setJudgesMode] = useState(false)

  const abortRef = useRef<AbortController | null>(null)

  const resetForNewRun = (mode: StreamMode, refName?: string) => {
    abortRef.current?.abort()
    setLoading(true)
    setDone(false)
    setError(null)
    setSteps([])
    setPlayers([])
    setReport('')
    setToolCalls([])
    setActiveMode({ mode, refName })
  }

  // Process one SSE event from the backend stream
  const handleEvent = (ev: any) => {
    switch (ev.type) {
      case 'step_start':
        setSteps((prev) => [
          ...prev,
          {
            step: ev.step,
            action: ev.action,
            detail: ev.detail,
            result_summary: null,
          },
        ])
        if (ev.action?.startsWith('mcp:')) {
          setToolCalls((prev) => [...prev, ev.action.replace('mcp:', '')])
        }
        break

      case 'step_done':
        setSteps((prev) => {
          if (prev.length === 0) return prev
          const next = [...prev]
          const last = next[next.length - 1]
          next[next.length - 1] = { ...last, result_summary: ev.result_summary || 'done' }
          return next
        })
        break

      case 'player':
        setPlayers((prev) => {
          if (prev.find((p) => p.id === ev.player.id)) return prev
          return [...prev, ev.player as ScoutPlayer]
        })
        break

      case 'text':
        setReport((prev) => prev + (ev.chunk || ''))
        break

      case 'done':
        setLoading(false)
        setDone(true)
        break

      case 'error':
        setError(ev.message || 'Unknown stream error')
        setLoading(false)
        break
    }
  }

  const streamRun = async (
    url: string,
    body: Record<string, unknown>,
    mode: StreamMode,
    refName?: string,
  ) => {
    resetForNewRun(mode, refName)

    const ctrl = new AbortController()
    abortRef.current = ctrl

    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      })

      if (!resp.ok || !resp.body) {
        const text = await resp.text().catch(() => '')
        throw new Error(`${resp.status}: ${text || resp.statusText}`)
      }

      const reader = resp.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done: readerDone, value } = await reader.read()
        if (readerDone) break
        buffer += decoder.decode(value, { stream: true })

        const segments = buffer.split('\n\n')
        buffer = segments.pop() || ''

        for (const seg of segments) {
          for (const line of seg.split('\n')) {
            if (line.startsWith('data: ')) {
              try {
                const ev = JSON.parse(line.slice(6))
                handleEvent(ev)
              } catch {
                /* ignore malformed events */
              }
            }
          }
        }
      }
      // ensure final state if backend forgot to emit `done`
      setLoading(false)
      setDone(true)
    } catch (err: unknown) {
      if ((err as Error).name !== 'AbortError') {
        setError((err as Error).message)
      }
      setLoading(false)
    }
  }

  const handleScoutSubmit = async (q = query) => {
    if (!q.trim() || loading) return

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

    await streamRun('/api/agent/scout/stream', body, 'scout')
  }

  const handleFindSimilar = async (player: ScoutPlayer) => {
    if (loading) return
    setQuery(`Players tactically similar to ${player.name}`)
    await streamRun(
      '/api/agent/scout/similar/stream',
      { qid: player.id, debug_mode: judgesMode },
      'similar',
      player.name,
    )
  }

  const handleExampleClick = (q: string) => {
    setQuery(q)
    handleScoutSubmit(q)
  }

  const showResults = steps.length > 0 || players.length > 0 || report.length > 0

  return (
    <div className="mx-auto max-w-4xl px-4 pb-16 pt-6">
      {/* Hero */}
      <div className="mb-8 text-center">
        <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-[#00d992]/30 bg-[#00d992]/10 px-3 py-1">
          <Sparkles size={12} className="text-[#00d992]" />
          <span className="text-xs font-semibold uppercase tracking-[2.52px] text-[#00d992]">
            ADK · MCP · Atlas Search + Vector · Gemini 3 Pro
          </span>
        </div>
        <h1 className="text-3xl font-black tracking-[-0.65px] text-[#f2f2f2] sm:text-4xl">
          Find them <span className="text-[#00d992]">before anyone else</span>
        </h1>
        <p className="mt-2 text-sm text-[#8b949e]">
          2,200+ players · Streaming AI agent via MCP · World Cup 2026 ready
        </p>
        <div className="mx-auto mt-3 flex max-w-lg items-start gap-2 rounded-lg border border-[#3d3a39] bg-[#1a1a1a] px-3 py-2 text-left">
          <AlertCircle size={13} className="mt-0.5 flex-shrink-0 text-[#8b949e]" />
          <p className="text-[11px] leading-relaxed text-[#8b949e]">
            <span className="font-semibold text-[#bdbdbd]">Coverage: </span>
            Big-5 + Mid-European leagues (2025-26). No Americas/CONMEBOL league data — South
            American players are indexed based on their current European club.
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
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleScoutSubmit()
          }}
        />

        <div className="mt-3 flex items-center gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-[1.5px] text-[#8b949e]">
            Pos
          </span>
          <ChipRow options={POSITIONS} value={position} onChange={setPosition} />
        </div>

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
            onClick={() => setJudgesMode((v) => !v)}
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
            onClick={() => handleScoutSubmit()}
            disabled={loading || !query.trim()}
            className="ml-auto flex items-center gap-2 rounded bg-[#00d992] px-5 py-2 text-sm font-bold text-[#101010] transition hover:bg-[#2fd6a1] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading ? <Loader2 size={15} className="animate-spin" /> : <Search size={15} />}
            Scout
          </button>
        </div>
      </div>

      {/* Mode badge — "Searching similar to X" */}
      {activeMode?.mode === 'similar' && activeMode.refName && (
        <div className="mt-4 flex items-center gap-2 rounded-lg border border-[#00d992]/30 bg-[#00d992]/5 px-3 py-2 text-[12px] text-[#bdbdbd]">
          <Sparkles size={14} className="text-[#00d992]" />
          <span>
            <span className="font-semibold text-[#00d992]">Vector Search mode:</span> Atlas
            <span className="font-mono"> $vectorSearch </span>via MCP — finding players tactically
            similar to <span className="font-semibold text-[#f2f2f2]">{activeMode.refName}</span>
          </span>
        </div>
      )}

      {/* Example queries — only when nothing has streamed yet */}
      {!showResults && !loading && (
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

      {error && (
        <div className="mt-4 rounded border border-red-400/30 bg-red-500/10 p-4 text-sm text-red-300">
          <strong>Error:</strong> {error}
        </div>
      )}

      {(loading || steps.length > 0) && (
        <ReasoningTrace steps={steps} active={loading} done={done} />
      )}

      {showResults && (
        <div className="mt-6 flex flex-col gap-6">
          {players.length > 0 && (
            <div>
              <h2 className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-[2.52px] text-[#8b949e]">
                <Trophy size={14} className="text-[#00d992]" />
                Top Candidates {loading && players.length > 0 && (
                  <span className="text-[#bdbdbd] normal-case tracking-normal">
                    · streaming ({players.length} so far)
                  </span>
                )}
              </h2>
              <div className="grid gap-3">
                {players.slice(0, 5).map((player, i) => (
                  <PlayerCard
                    key={player.id}
                    player={player}
                    rank={i + 1}
                    onFindSimilar={done && !loading ? handleFindSimilar : undefined}
                  />
                ))}
              </div>
            </div>
          )}

          {report && <ScoutingReport report={report} streaming={loading} />}

          {judgesMode && (steps.length > 0 || players.length > 0) && (
            <AgentPanel steps={steps} players={players} toolCalls={toolCalls} />
          )}
        </div>
      )}
    </div>
  )
}
