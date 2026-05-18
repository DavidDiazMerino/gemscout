/**
 * GemScout Agent UI — the "money shot" for the hackathon demo.
 * Natural language → MongoDB Atlas Vector Search → Gemini scouting report.
 */

import { useEffect, useRef, useState } from 'react'
import {
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
}

type ScoutResponse = {
  query: string
  reasoning_steps: ReasoningStep[]
  players: ScoutPlayer[]
  scouting_report: string
  tool_calls: string[]
}

// ─── Example queries shown on load ─────────────────────────────────────────

const EXAMPLE_QUERIES = [
  'Find me a box-to-box midfielder, under 24, from Americas leagues, high pressing, World Cup potential',
  'Striker from Brasileirão or Liga MX, strong xG, under 25, flying under the radar',
  'Attacking fullback with creativity, under 26, non-European league',
  'Defensive midfielder, strong in build-up, under 23, South American league',
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
  const labels: Record<number, string> = { 1: 'Big-5 Europe', 2: 'Mid Europe', 3: 'Americas / Other' }
  return labels[tier] ?? 'Unknown'
}

function tierColor(tier: number): string {
  const colors: Record<number, string> = {
    1: 'text-blue-300 border-blue-300/30 bg-blue-500/10',
    2: 'text-yellow-300 border-yellow-300/30 bg-yellow-500/10',
    3: 'text-lime-300 border-lime-300/30 bg-lime-500/10',
  }
  return colors[tier] ?? 'text-slate-300 border-white/10 bg-white/5'
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

function ReasoningTrace({ steps, active }: { steps: ReasoningStep[]; active: boolean }) {
  return (
    <div className="mt-4 rounded-xl border border-white/10 bg-black/20 p-4">
      <div className="mb-3 flex items-center gap-2">
        <Zap size={14} className="text-lime-300" />
        <span className="text-xs font-semibold uppercase tracking-widest text-slate-400">
          Agent Reasoning
        </span>
        {active && <Loader2 size={12} className="animate-spin text-lime-300" />}
      </div>
      <div className="flex flex-col gap-2">
        {steps.map((step) => (
          <div key={step.step} className="flex items-start gap-3">
            <div className="mt-0.5 flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full border border-lime-400/30 bg-lime-500/10 text-lime-300">
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
                <span className="text-lime-300">
                  {ACTION_ICONS[step.action] ?? <Zap size={14} />}
                </span>
                <span className="text-xs font-semibold text-white">
                  {ACTION_LABELS[step.action] ?? step.action}
                </span>
              </div>
              <p className="mt-0.5 text-[11px] text-slate-500">{step.detail}</p>
              {step.result_summary && (
                <p className="mt-1 text-[11px] text-slate-400">{step.result_summary}</p>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function PlayerCard({ player, rank }: { player: ScoutPlayer; rank: number }) {
  const norm = player.metrics_normalized
  const stats = player.stats
  const keyMetrics = [
    { key: 'xg', label: 'xG' },
    { key: 'xa', label: 'xA' },
    { key: 'key_passes', label: 'Key passes' },
    { key: 'xg_chain', label: 'xG chain' },
    { key: 'xg_buildup', label: 'xG buildup' },
  ].filter((m) => norm[m.key] != null)

  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4 transition hover:border-lime-400/30 hover:bg-white/[0.05]">
      {/* Header */}
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-lime-500/20 text-sm font-black text-lime-300">
            {rank}
          </div>
          <div>
            <h3 className="text-base font-bold text-white">{player.name}</h3>
            <p className="text-xs text-slate-400">
              {player.current_team} · {player.nationality} · {player.age}y
            </p>
          </div>
        </div>
        <div className="flex flex-col items-end gap-1.5">
          <span className="rounded-md bg-white/10 px-2 py-0.5 text-xs font-semibold text-white">
            {player.position}
          </span>
          <span
            className={`rounded border px-1.5 py-0.5 text-[10px] font-medium ${tierColor(player.league_tier)}`}
          >
            {tierLabel(player.league_tier)}
          </span>
        </div>
      </div>

      {/* Percentile bars */}
      {keyMetrics.length > 0 && (
        <div className="mb-3 grid grid-cols-2 gap-1.5 sm:grid-cols-3">
          {keyMetrics.slice(0, 6).map((m) => {
            const percentile = norm[m.key] as number
            const raw = stats[m.key]
            return (
              <div key={m.key} className="rounded-lg border border-white/10 bg-black/20 p-2">
                <div className="mb-1 flex items-baseline justify-between">
                  <span className="text-[11px] text-slate-500">{m.label}</span>
                  <span className="text-[11px] font-bold text-lime-300">{pct(percentile)}</span>
                </div>
                <div className="h-1 w-full overflow-hidden rounded-full bg-white/10">
                  <div
                    className="h-full rounded-full bg-lime-400"
                    style={{ width: `${Math.max(2, percentile)}%` }}
                  />
                </div>
                {raw != null && (
                  <span className="mt-0.5 block text-[10px] text-slate-600">
                    {typeof raw === 'number' ? raw.toFixed(1) : raw}
                  </span>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* Footer */}
      <div className="flex items-center justify-between text-xs text-slate-500">
        <span>{player.league}</span>
        <div className="flex items-center gap-3">
          {player.market_value_eur && (
            <span className="text-slate-400">
              <span className="text-slate-500">TM </span>
              {formatValue(player.market_value_eur)}
            </span>
          )}
          {player.vector_score != null && (
            <span title="Semantic similarity score">
              score {(player.vector_score * 100).toFixed(1)}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

function ScoutingReport({ report }: { report: string }) {
  // Split by player headers for better rendering
  const sections = report.split(/(?=^#{1,3}\s|^[A-Z]{2,}.*:)/m).filter(Boolean)

  return (
    <div className="rounded-xl border border-white/10 bg-black/20 p-5">
      <div className="mb-4 flex items-center gap-2">
        <Bot size={16} className="text-lime-300" />
        <span className="text-sm font-semibold uppercase tracking-widest text-slate-400">
          Gemini Scouting Dossier
        </span>
      </div>
      <div className="prose prose-invert prose-sm max-w-none">
        {sections.length > 1 ? (
          sections.map((section, i) => (
            <div key={i} className="mb-4">
              {section.split('\n').map((line, j) => {
                if (line.match(/^#{1,3}\s/) || line.match(/^[A-Z][A-Z ]+:/)) {
                  return (
                    <h4 key={j} className="mb-1 text-sm font-bold text-white">
                      {line.replace(/^#+\s/, '')}
                    </h4>
                  )
                }
                if (line.trim().startsWith('- ') || line.trim().startsWith('• ')) {
                  return (
                    <p key={j} className="mb-0.5 pl-3 text-[13px] text-slate-300">
                      {line}
                    </p>
                  )
                }
                return line.trim() ? (
                  <p key={j} className="mb-1 text-[13px] text-slate-300">
                    {line}
                  </p>
                ) : (
                  <div key={j} className="h-2" />
                )
              })}
            </div>
          ))
        ) : (
          <pre className="whitespace-pre-wrap text-[13px] text-slate-300">{report}</pre>
        )}
      </div>
    </div>
  )
}

// ─── Main ScoutMode component ───────────────────────────────────────────────

export default function ScoutMode() {
  const [query, setQuery] = useState('')
  const [position, setPosition] = useState<string>('ALL')
  const [maxAge, setMaxAge] = useState<string>('')
  const [leagueTierMax, setLeagueTierMax] = useState<string>('3')
  const [loading, setLoading] = useState(false)
  const [streamingSteps, setStreamingSteps] = useState<ReasoningStep[]>([])
  const [result, setResult] = useState<ScoutResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
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

    // Simulate streaming reasoning steps while waiting for response
    const simulatedSteps: ReasoningStep[] = [
      {
        step: 1,
        action: 'semantic_player_search',
        detail: `Translating '${q}' to a tactical embedding via Voyage AI, querying MongoDB Atlas Vector Search`,
        result_summary: null,
      },
    ]
    setStreamingSteps([...simulatedSteps])

    // Add steps progressively for better UX
    const timers: NodeJS.Timeout[] = []
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
            detail: 'Calling Gemini 2.0 Flash to generate detailed scouting dossier…',
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
      }
      if (position !== 'ALL') body.position = position
      if (maxAge) body.max_age = parseInt(maxAge, 10)
      if (leagueTierMax) body.league_tier_max = parseInt(leagueTierMax, 10)

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

  const handleExampleClick = (example: string) => {
    setQuery(example)
    handleSubmit(example)
  }

  return (
    <div className="mx-auto max-w-4xl px-4 pb-16 pt-6">
      {/* Hero */}
      <div className="mb-8 text-center">
        <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-lime-400/30 bg-lime-500/10 px-3 py-1 text-xs font-semibold text-lime-300">
          <Sparkles size={12} />
          Google Cloud Agent Builder · MongoDB Atlas · Voyage AI · Gemini 2.0
        </div>
        <h1 className="text-3xl font-black tracking-tight text-white sm:text-4xl">
          Find them <span className="text-lime-300">before anyone else</span>
        </h1>
        <p className="mt-2 text-sm text-slate-400">
          2,200+ players · Semantic + statistical scouting · World Cup 2026 ready
        </p>
      </div>

      {/* Query input */}
      <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-4">
        <textarea
          className="w-full resize-none rounded-xl border border-white/10 bg-black/30 px-4 py-3 text-sm text-white placeholder-slate-500 outline-none transition focus:border-lime-400/50 focus:ring-1 focus:ring-lime-400/30"
          rows={3}
          placeholder="e.g. Find me a box-to-box midfielder, under 24, from Americas leagues, high pressing, World Cup potential"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleSubmit()
          }}
        />

        {/* Filters row */}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <select
            className="rounded-lg border border-white/10 bg-black/30 px-3 py-1.5 text-xs text-white outline-none"
            value={position}
            onChange={(e) => setPosition(e.target.value)}
          >
            <option value="ALL">All positions</option>
            <option value="FWD">Forward</option>
            <option value="MID">Midfielder</option>
            <option value="DEF">Defender</option>
            <option value="GK">Goalkeeper</option>
          </select>

          <input
            type="number"
            className="w-24 rounded-lg border border-white/10 bg-black/30 px-3 py-1.5 text-xs text-white outline-none"
            placeholder="Max age"
            min={15}
            max={40}
            value={maxAge}
            onChange={(e) => setMaxAge(e.target.value)}
          />

          <select
            className="rounded-lg border border-white/10 bg-black/30 px-3 py-1.5 text-xs text-white outline-none"
            value={leagueTierMax}
            onChange={(e) => setLeagueTierMax(e.target.value)}
          >
            <option value="1">Big-5 Europe only</option>
            <option value="2">+ Mid Europe</option>
            <option value="3">All leagues (incl. Americas)</option>
          </select>

          <button
            type="button"
            onClick={() => handleSubmit()}
            disabled={loading || !query.trim()}
            className="ml-auto flex items-center gap-2 rounded-xl bg-lime-500 px-4 py-2 text-sm font-bold text-black transition hover:bg-lime-400 disabled:cursor-not-allowed disabled:opacity-50"
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
        <div className="mt-4">
          <p className="mb-2 text-xs text-slate-500">Try an example:</p>
          <div className="flex flex-wrap gap-2">
            {EXAMPLE_QUERIES.map((example) => (
              <button
                key={example}
                type="button"
                onClick={() => handleExampleClick(example)}
                className="rounded-full border border-white/10 bg-white/[0.03] px-3 py-1.5 text-xs text-slate-400 transition hover:border-lime-400/30 hover:text-lime-300"
              >
                {example.length > 60 ? example.slice(0, 57) + '…' : example}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="mt-4 rounded-xl border border-red-400/30 bg-red-500/10 p-4 text-sm text-red-300">
          <strong>Error:</strong> {error}
        </div>
      )}

      {/* Reasoning trace (shows while loading AND after) */}
      {(loading || streamingSteps.length > 0) && (
        <ReasoningTrace steps={streamingSteps} active={loading} />
      )}

      {/* Results */}
      {result && (
        <div className="mt-6 flex flex-col gap-6">
          {/* Player cards */}
          {result.players.length > 0 && (
            <div>
              <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-widest text-slate-400">
                <Trophy size={14} className="text-lime-300" />
                Top Candidates
              </h2>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
                {result.players.slice(0, 4).map((player, i) => (
                  <PlayerCard key={player.id} player={player} rank={i + 1} />
                ))}
              </div>
            </div>
          )}

          {/* Gemini scouting report */}
          {result.scouting_report && (
            <ScoutingReport report={result.scouting_report} />
          )}
        </div>
      )}
    </div>
  )
}
