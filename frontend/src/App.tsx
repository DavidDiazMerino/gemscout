import type { CSSProperties, ReactNode } from 'react'
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity,
  BadgeEuro,
  Bot,
  ChevronDown,
  CircleAlert,
  CircleDot,
  Database,
  Gauge,
  Loader2,
  Save,
  Search,
  Share2,
  Scale,
  SlidersHorizontal,
  Sparkles,
  TrendingDown,
  TrendingUp,
  Trophy,
  UserPlus,
  X,
} from 'lucide-react'
import ScoutMode from './ScoutMode'

type MetricKey =
  | 'xg'
  | 'goals'
  | 'assists'
  | 'xa'
  | 'xg_chain'
  | 'xg_buildup'
  | 'minutes'
  | 'shots'
  | 'key_passes'
  | 'npg'
  | 'npxg'
  | 'save_percent'
  | 'goals_prevented'
  | 'clean_sheets'
  | 'rating'
type Position = 'ALL' | 'GK' | 'DEF' | 'MID' | 'FWD'

type PlayerRow = {
  id: string
  name: string
  position: string | null
  position_detail: string | null
  age: number | null
  team_name: string | null
  league_name: string | null
  season: string
  value: number
  goals: number | null
  assists: number | null
  minutes: number | null
  xg: number | null
  xa: number | null
  metrics: Record<string, number | string | null>
  metrics_normalized: Record<string, number | string | null>
  stats_source: string | null
  stats_fetched_at: string | null
  om_value_eur: number | null
  tm_value_eur: number | null
  tm_value_date: string | null
  tm_fetched_at: string | null
  tm_delta_eur: number | null
  explanation: {
    summary: string
    drivers: Array<{
      metric: string
      label: string
      percentile: number
      weight: number
      impact: number
    }>
    penalties: string[]
  }
  confidence_label: 'Alta' | 'Media' | 'Baja'
  confidence_reasons: string[]
  trend: {
    direction: 'up' | 'flat' | 'down' | 'insufficient'
    values_by_season: Record<string, number>
    minutes_by_season: Record<string, number | null>
  }
  market_reading: {
    label: string
    summary: string
    notes: string[]
  }
}

type PlayerHistoryRow = {
  season: string
  value: number
  metrics: Record<string, number | string | null> | null
  metrics_normalized: Record<string, number | string | null> | null
}

type OpportunityView = 'ranking' | 'undervalued' | 'overvalued' | 'young-up' | 'veterans' | 'missing-tm'

type CuratedTemplate = {
  id: string
  name: string
  description: string | null
  position: Position | null
  weights: Partial<Record<MetricKey, number>>
  filters: Record<string, number>
  top_players: Array<{
    id: string
    name: string
    team_name: string | null
    value: number
  }>
}

type PublicTemplate = {
  id: string
  name: string
  description: string | null
  position: Position | null
  weights: Partial<Record<MetricKey, number>>
  filters: Record<string, number>
}

const metrics: Array<{ key: MetricKey; label: string; hint: string; accent: string }> = [
  { key: 'xg', label: 'xG', hint: 'Calidad de ocasiones', accent: '#b8ff3d' },
  { key: 'goals', label: 'Goles', hint: 'Produccion directa', accent: '#66e0ff' },
  { key: 'assists', label: 'Asistencias', hint: 'Ultimo pase', accent: '#b891ff' },
  { key: 'xa', label: 'xA', hint: 'Pases que generan xG', accent: '#ffb86b' },
  { key: 'xg_chain', label: 'xGChain', hint: 'Participacion total', accent: '#51f0b0' },
  { key: 'xg_buildup', label: 'xGBuildup', hint: 'Construccion sin tiro/asistencia', accent: '#ff729f' },
  { key: 'minutes', label: 'Minutos', hint: 'Fiabilidad y volumen', accent: '#d8e2ff' },
  { key: 'shots', label: 'Tiros', hint: 'Volumen ofensivo', accent: '#f5d76e' },
  { key: 'key_passes', label: 'Pases clave', hint: 'Creacion antes del remate', accent: '#7dd3fc' },
  { key: 'npg', label: 'Goles no penalti', hint: 'Produccion sin penaltis', accent: '#fb7185' },
  { key: 'npxg', label: 'npxG', hint: 'xG sin penaltis', accent: '#c4b5fd' },
  { key: 'save_percent', label: 'Save %', hint: 'Paradas sobre tiros a puerta', accent: '#67e8f9' },
  { key: 'goals_prevented', label: 'Goles evitados', hint: 'Rendimiento vs xG recibido', accent: '#86efac' },
  { key: 'clean_sheets', label: 'Porterias a 0', hint: 'Partidos sin encajar', accent: '#fde68a' },
  { key: 'rating', label: 'Rating', hint: 'Nota SofaScore', accent: '#f0abfc' },
]

const leagues = [
  { value: 'ALL', label: 'Big 5' },
  { value: 'premier-league', label: 'Premier League' },
  { value: 'la-liga', label: 'La Liga' },
  { value: 'serie-a', label: 'Serie A' },
  { value: 'bundesliga', label: 'Bundesliga' },
  { value: 'ligue-1', label: 'Ligue 1' },
]

const fallbackSeasons = ['2025-26']
const positions: Position[] = ['ALL', 'FWD', 'MID', 'DEF', 'GK']

const initialWeights: Record<MetricKey, number> = {
  xg: 42,
  goals: 28,
  assists: 8,
  xa: 10,
  xg_chain: 6,
  xg_buildup: 2,
  minutes: 12,
  shots: 12,
  key_passes: 4,
  npg: 18,
  npxg: 34,
  save_percent: 0,
  goals_prevented: 0,
  clean_sheets: 0,
  rating: 0,
}

const positionPresets: Record<Position, Record<MetricKey, number>> = {
  ALL: {
    xg: 14,
    goals: 12,
    assists: 10,
    xa: 12,
    xg_chain: 16,
    xg_buildup: 10,
    minutes: 16,
    shots: 6,
    key_passes: 8,
    npg: 8,
    npxg: 10,
    save_percent: 0,
    goals_prevented: 0,
    clean_sheets: 0,
    rating: 0,
  },
  FWD: {
    xg: 26,
    goals: 22,
    assists: 4,
    xa: 6,
    xg_chain: 8,
    xg_buildup: 2,
    minutes: 8,
    shots: 12,
    key_passes: 2,
    npg: 18,
    npxg: 24,
    save_percent: 0,
    goals_prevented: 0,
    clean_sheets: 0,
    rating: 0,
  },
  MID: {
    xg: 6,
    goals: 6,
    assists: 14,
    xa: 20,
    xg_chain: 24,
    xg_buildup: 18,
    minutes: 14,
    shots: 4,
    key_passes: 22,
    npg: 4,
    npxg: 6,
    save_percent: 0,
    goals_prevented: 0,
    clean_sheets: 0,
    rating: 0,
  },
  DEF: {
    xg: 2,
    goals: 2,
    assists: 6,
    xa: 8,
    xg_chain: 16,
    xg_buildup: 34,
    minutes: 28,
    shots: 0,
    key_passes: 8,
    npg: 0,
    npxg: 2,
    save_percent: 0,
    goals_prevented: 0,
    clean_sheets: 0,
    rating: 0,
  },
  GK: {
    xg: 0,
    goals: 0,
    assists: 0,
    xa: 0,
    xg_chain: 0,
    xg_buildup: 0,
    minutes: 100,
    shots: 0,
    key_passes: 0,
    npg: 0,
    npxg: 0,
    save_percent: 30,
    goals_prevented: 30,
    clean_sheets: 20,
    rating: 10,
  },
}

type SavedPreset = {
  id: string
  name: string
  position: Position
  weights: Record<MetricKey, number>
}

const savedPresetsKey = 'openmercat.presets.v1'

function normalizedWeights(weights: Record<MetricKey, number>) {
  const total = Object.values(weights).reduce((sum, value) => sum + value, 0)
  if (total <= 0) return null

  const normalized = {} as Record<MetricKey, number>
  for (const metric of metrics) {
    normalized[metric.key] = Number((weights[metric.key] / total).toFixed(4))
  }
  return normalized
}

function formatNumber(value: number | null | undefined, digits = 1) {
  if (value === null || value === undefined) return '0'
  return value.toLocaleString('en-US', {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  })
}

function rawMetricValue(player: PlayerRow, key: MetricKey) {
  if (key === 'xg') return player.xg
  if (key === 'xa') return player.xa
  if (key === 'goals') return player.goals
  if (key === 'assists') return player.assists
  if (key === 'minutes') return player.minutes
  return player.metrics[key]
}

function metricPercentile(player: PlayerRow, key: MetricKey) {
  const value = player.metrics_normalized[key]
  return typeof value === 'number' ? value : null
}

function formatEuro(value: number | null | undefined) {
  if (value === null || value === undefined) return '-'
  const sign = value < 0 ? '-' : ''
  const absoluteValue = Math.abs(value)
  if (absoluteValue >= 1_000_000) return `${sign}€${formatNumber(absoluteValue / 1_000_000, 1)}m`
  if (absoluteValue >= 1_000) return `${sign}€${formatNumber(absoluteValue / 1_000, 0)}k`
  return `${sign}€${absoluteValue}`
}

function formatShortDate(value: string | null | undefined) {
  if (!value) return '-'
  return new Date(value).toLocaleDateString('es-ES', {
    day: '2-digit',
    month: 'short',
    year: '2-digit',
  })
}

function deltaClass(value: number | null) {
  if (value === null) return 'text-slate-500'
  if (value > 0) return 'text-emerald-300'
  if (value < 0) return 'text-rose-300'
  return 'text-slate-400'
}

function confidenceClass(label: PlayerRow['confidence_label']) {
  if (label === 'Alta') return 'border-emerald-300/30 bg-emerald-300/10 text-emerald-200'
  if (label === 'Media') return 'border-amber-300/30 bg-amber-300/10 text-amber-200'
  return 'border-rose-300/30 bg-rose-300/10 text-rose-200'
}

function trendLabel(direction: PlayerRow['trend']['direction']) {
  if (direction === 'up') return 'Sube'
  if (direction === 'down') return 'Baja'
  if (direction === 'flat') return 'Estable'
  return 'Sin muestra'
}

function marketReadingClass(label: string) {
  if (label === 'Oportunidad') return 'border-emerald-300/30 bg-emerald-300/10 text-emerald-200'
  if (label === 'Caro') return 'border-rose-300/30 bg-rose-300/10 text-rose-200'
  if (label === 'En precio') return 'border-sky-300/30 bg-sky-300/10 text-sky-200'
  return 'border-white/10 bg-white/[0.035] text-slate-300'
}

function radarAccentClass(view: OpportunityView) {
  if (view === 'undervalued') return 'text-emerald-200'
  if (view === 'overvalued') return 'text-rose-200'
  if (view === 'young-up') return 'text-lime-200'
  if (view === 'veterans') return 'text-sky-200'
  if (view === 'missing-tm') return 'text-amber-200'
  return 'text-slate-200'
}

function loadSavedPresets(): SavedPreset[] {
  try {
    const raw = window.localStorage.getItem(savedPresetsKey)
    if (!raw) return []
    const parsed = JSON.parse(raw) as SavedPreset[]
    if (!Array.isArray(parsed)) return []
    return parsed.map((preset) => ({
      ...preset,
      weights: metrics.reduce(
        (nextWeights, metric) => ({
          ...nextWeights,
          [metric.key]: preset.weights[metric.key] ?? 0,
        }),
        {} as Record<MetricKey, number>,
      ),
    }))
  } catch {
    return []
  }
}

function leagueQuery(league: string) {
  return league === 'ALL' ? '' : `&league_slug=${encodeURIComponent(league)}`
}

function searchQueryParam(query: string) {
  const trimmed = query.trim()
  return trimmed.length >= 2 ? `&q=${encodeURIComponent(trimmed)}` : ''
}

function App() {
  const [weights, setWeights] = useState(initialWeights)
  const [league, setLeague] = useState('ALL')
  const [position, setPosition] = useState<Position>('FWD')
  const [season, setSeason] = useState('2025-26')
  const [seasons, setSeasons] = useState(fallbackSeasons)
  const [savedPresets, setSavedPresets] = useState<SavedPreset[]>(loadSavedPresets)
  const [curatedTemplates, setCuratedTemplates] = useState<CuratedTemplate[]>([])
  const [publicTemplates, setPublicTemplates] = useState<PublicTemplate[]>([])
  const [presetName, setPresetName] = useState('')
  const [shareName, setShareName] = useState('')
  const [isShareDialogOpen, setIsShareDialogOpen] = useState(false)
  const [players, setPlayers] = useState<PlayerRow[]>([])
  const [expandedPlayerId, setExpandedPlayerId] = useState<string | null>(null)
  const [historyByPlayerId, setHistoryByPlayerId] = useState<Record<string, PlayerHistoryRow[]>>({})
  const [historyLoadingPlayerId, setHistoryLoadingPlayerId] = useState<string | null>(null)
  const [opportunityView, setOpportunityView] = useState<OpportunityView>('ranking')
  const [playerSearch, setPlayerSearch] = useState('')
  const [isRadarOpen, setIsRadarOpen] = useState(false)
  const [compareIds, setCompareIds] = useState<string[]>([])
  const [templateId, setTemplateId] = useState<string | null>(null)
  const [sharedTemplateId, setSharedTemplateId] = useState<string | null>(() => {
    const templatePathMatch = window.location.pathname.match(/^\/t\/([^/]+)/)
    const playerTemplateId = new URLSearchParams(window.location.search).get('t')
    return templatePathMatch?.[1] ?? playerTemplateId
  })
  const [initialPlayerId] = useState<string | null>(() => {
    const match = window.location.pathname.match(/^\/p\/([^/]+)/)
    return match?.[1] ?? null
  })
  const [sharedTemplateName, setSharedTemplateName] = useState<string | null>(null)
  const [hasForkedSharedTemplate, setHasForkedSharedTemplate] = useState(false)
  const [loadedSharedTemplateId, setLoadedSharedTemplateId] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const requestSeq = useRef(0)
  const [appMode, setAppMode] = useState<'scout' | 'explorer'>('scout')

  const apiWeights = useMemo(() => normalizedWeights(weights), [weights])
  const totalWeight = Object.values(weights).reduce((sum, value) => sum + value, 0)
  const activePlayerSearch = playerSearch.trim().length >= 2 ? playerSearch.trim() : ''
  const activeMetrics = useMemo(
    () =>
      metrics
        .filter((metric) => weights[metric.key] > 0)
        .sort((left, right) => weights[right.key] - weights[left.key])
        .slice(0, 6),
    [weights],
  )
  const leader = players[0]
  const playersLimit = 50
  const comparedPlayers = useMemo(
    () =>
      compareIds
        .map((id) => players.find((player) => player.id === id))
        .filter((player): player is PlayerRow => Boolean(player)),
    [compareIds, players],
  )

  const playersRequestUrl = useCallback((nextTemplateId: string) => {
    return `/api/players?template_id=${nextTemplateId}&season=${season}${leagueQuery(league)}${searchQueryParam(activePlayerSearch)}&limit=${playersLimit}`
  }, [activePlayerSearch, league, playersLimit, season])

  const previewRequestUrl = useCallback(() => {
    return `/api/rankings/preview`
  }, [])

  const visiblePlayers = useMemo(() => {
    const filtered = players.filter((player) => {
      if (opportunityView === 'undervalued') return (player.tm_delta_eur ?? 0) > 0
      if (opportunityView === 'overvalued') return (player.tm_delta_eur ?? 0) < 0
      if (opportunityView === 'young-up') {
        return (player.age ?? 99) <= 23 && player.trend.direction === 'up'
      }
      if (opportunityView === 'veterans') {
        return (player.age ?? 0) >= 30 && player.value >= 75 && (player.tm_value_eur ?? 0) <= 15_000_000
      }
      if (opportunityView === 'missing-tm') return player.tm_value_eur === null
      return true
    })
    return filtered.slice(0, 50)
  }, [opportunityView, players])

  const marketRadar = useMemo(() => {
    const withGap = players.filter((player) => player.tm_delta_eur !== null)
    const opportunities = [...withGap]
      .filter((player) => (player.tm_delta_eur ?? 0) > 0)
      .sort((left, right) => (right.tm_delta_eur ?? 0) - (left.tm_delta_eur ?? 0))
      .slice(0, 3)
    const expensive = [...withGap]
      .filter((player) => (player.tm_delta_eur ?? 0) < 0)
      .sort((left, right) => (left.tm_delta_eur ?? 0) - (right.tm_delta_eur ?? 0))
      .slice(0, 3)
    const youngUp = [...players]
      .filter((player) => (player.age ?? 99) <= 23 && player.trend.direction === 'up')
      .sort((left, right) => right.value - left.value)
      .slice(0, 3)
    const veterans = [...players]
      .filter((player) => (player.age ?? 0) >= 30 && player.value >= 75 && (player.tm_value_eur ?? 0) <= 15_000_000)
      .sort((left, right) => right.value - left.value)
      .slice(0, 3)
    const missingTm = [...players]
      .filter((player) => player.tm_value_eur === null)
      .sort((left, right) => right.value - left.value)
      .slice(0, 3)

    return [
      {
        view: 'undervalued' as const,
        title: 'Oportunidades',
        hint: 'OM por encima de TM',
        icon: <BadgeEuro size={16} />,
        players: opportunities,
      },
      {
        view: 'overvalued' as const,
        title: 'Caros',
        hint: 'TM por encima de OM',
        icon: <TrendingDown size={16} />,
        players: expensive,
      },
      {
        view: 'young-up' as const,
        title: 'Jovenes al alza',
        hint: 'Suben y tienen reventa',
        icon: <TrendingUp size={16} />,
        players: youngUp,
      },
      {
        view: 'veterans' as const,
        title: 'Veteranos utiles',
        hint: 'Rendimiento barato',
        icon: <UserPlus size={16} />,
        players: veterans,
      },
      {
        view: 'missing-tm' as const,
        title: 'Sin TM',
        hint: 'Cobertura pendiente',
        icon: <CircleAlert size={16} />,
        players: missingTm,
      },
    ]
  }, [players])

  useEffect(() => {
    if (!expandedPlayerId) return
    const isVisible = visiblePlayers.some((player) => player.id === expandedPlayerId)
    if (!isVisible) return
    window.setTimeout(() => {
      document
        .querySelector(`[data-player-row="${expandedPlayerId}"]`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }, 50)
  }, [expandedPlayerId, visiblePlayers])

  useEffect(() => {
    if (!initialPlayerId || expandedPlayerId) return
    const exists = players.some((player) => player.id === initialPlayerId)
    if (!exists) return
    const timeout = window.setTimeout(() => setExpandedPlayerId(initialPlayerId), 0)
    return () => window.clearTimeout(timeout)
  }, [expandedPlayerId, initialPlayerId, players])

  useEffect(() => {
    if (!expandedPlayerId || !templateId || historyByPlayerId[expandedPlayerId]) return
    const playerId = expandedPlayerId
    const controller = new AbortController()
    async function loadHistory() {
      setHistoryLoadingPlayerId(playerId)
      try {
        const response = await fetch(
          `/api/players/${playerId}/history?template_id=${templateId}`,
          { signal: controller.signal },
        )
        if (!response.ok) throw new Error(`GET /players/${playerId}/history`)
        const rows = (await response.json()) as PlayerHistoryRow[]
        setHistoryByPlayerId((current) => ({ ...current, [playerId]: rows }))
      } catch (caught) {
        if (!controller.signal.aborted) {
          console.error(caught)
        }
      } finally {
        if (!controller.signal.aborted) setHistoryLoadingPlayerId(null)
      }
    }
    void loadHistory()
    return () => controller.abort()
  }, [expandedPlayerId, historyByPlayerId, templateId])

  useEffect(() => {
    const controller = new AbortController()
    async function loadCuratedTemplates() {
      try {
        const response = await fetch(
          `/api/templates/curated?season=${season}${leagueQuery(league)}`,
          { signal: controller.signal },
        )
        if (!response.ok) throw new Error(`GET /templates/curated ${response.status}`)
        setCuratedTemplates((await response.json()) as CuratedTemplate[])
      } catch (caught) {
        if (!controller.signal.aborted) {
          console.error(caught)
        }
      }
    }
    void loadCuratedTemplates()
    return () => controller.abort()
  }, [league, season])

  useEffect(() => {
    const controller = new AbortController()
    async function loadPublicTemplates() {
      try {
        const response = await fetch('/api/templates?limit=6', { signal: controller.signal })
        if (!response.ok) throw new Error(`GET /templates ${response.status}`)
        setPublicTemplates((await response.json()) as PublicTemplate[])
      } catch (caught) {
        if (!controller.signal.aborted) {
          console.error(caught)
        }
      }
    }
    void loadPublicTemplates()
    return () => controller.abort()
  }, [templateId])

  useEffect(() => {
    const controller = new AbortController()
    async function loadSeasons() {
      try {
        const response = await fetch('/api/seasons', { signal: controller.signal })
        if (!response.ok) throw new Error(`GET /seasons ${response.status}`)
        const nextSeasons = (await response.json()) as string[]
        if (nextSeasons.length > 0) setSeasons(nextSeasons)
      } catch (caught) {
        if (!controller.signal.aborted) {
          console.error(caught)
        }
      }
    }
    void loadSeasons()
    return () => controller.abort()
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    const seq = ++requestSeq.current

    const timeout = window.setTimeout(async () => {
      if (sharedTemplateId && !hasForkedSharedTemplate) {
        if (loadedSharedTemplateId === sharedTemplateId) return
        setIsLoading(true)
        setError(null)
        try {
          const templateResponse = await fetch(`/api/templates/${sharedTemplateId}`, {
            signal: controller.signal,
          })
          if (!templateResponse.ok) throw new Error(`GET /templates/${sharedTemplateId}`)
          const template = (await templateResponse.json()) as {
            id: string
            name: string
            position: Position | null
            weights: Partial<Record<MetricKey, number>>
          }
          const nextWeights = metrics.reduce(
            (acc, metric) => ({
              ...acc,
              [metric.key]: Math.round((template.weights[metric.key] ?? 0) * 100),
            }),
            {} as Record<MetricKey, number>,
          )
          setWeights(nextWeights)
          setPosition(template.position ?? 'ALL')
          setSharedTemplateName(template.name)
          setTemplateId(template.id)
          setLoadedSharedTemplateId(template.id)

          const playersResponse = await fetch(playersRequestUrl(template.id), {
            signal: controller.signal,
          })
          if (!playersResponse.ok) throw new Error(`GET /players ${playersResponse.status}`)
          const rows = (await playersResponse.json()) as PlayerRow[]
          if (seq === requestSeq.current) {
            setPlayers(rows)
            setHistoryByPlayerId({})
            setExpandedPlayerId(null)
          }
        } catch (caught) {
          if (!controller.signal.aborted) {
            setError(caught instanceof Error ? caught.message : 'No se pudo cargar el template.')
          }
        } finally {
          if (seq === requestSeq.current) setIsLoading(false)
        }
        return
      }

      if (!apiWeights) {
        setPlayers([])
        setHistoryByPlayerId({})
        setError('Sube al menos una metrica para calcular.')
        setIsLoading(false)
        return
      }

      setIsLoading(true)
      setError(null)

      try {
        const previewResponse = await fetch(previewRequestUrl(), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            name: `preview ${Date.now()}`,
            season,
            position: position === 'ALL' ? null : position,
            league_slug: league === 'ALL' ? null : league,
            weights: apiWeights,
            q: activePlayerSearch || null,
            limit: playersLimit,
          }),
          signal: controller.signal,
        })

        if (!previewResponse.ok) {
          throw new Error(`POST /rankings/preview ${previewResponse.status}`)
        }

        const rows = (await previewResponse.json()) as PlayerRow[]
        if (seq === requestSeq.current) {
          setTemplateId(null)
          setPlayers(rows)
          setHistoryByPlayerId({})
          setExpandedPlayerId(null)
        }
      } catch (caught) {
        if (controller.signal.aborted) return
        setError(caught instanceof Error ? caught.message : 'No se pudo calcular el ranking.')
      } finally {
        if (seq === requestSeq.current) {
          setIsLoading(false)
        }
      }
    }, 300)

    return () => {
      window.clearTimeout(timeout)
      controller.abort()
    }
  }, [
    apiWeights,
    hasForkedSharedTemplate,
    league,
    loadedSharedTemplateId,
    activePlayerSearch,
    playersLimit,
    playersRequestUrl,
    previewRequestUrl,
    position,
    season,
    sharedTemplateId,
  ])

  function updateWeight(metric: MetricKey, value: number) {
    if (sharedTemplateId && !hasForkedSharedTemplate) {
      setHasForkedSharedTemplate(true)
      setSharedTemplateId(null)
      window.history.pushState(null, '', '/')
    }
    setWeights((current) => ({ ...current, [metric]: value }))
  }

  function changePosition(nextPosition: Position) {
    if (sharedTemplateId && !hasForkedSharedTemplate) {
      setHasForkedSharedTemplate(true)
      setSharedTemplateId(null)
      window.history.pushState(null, '', '/')
    }
    setPosition(nextPosition)
    setWeights(positionPresets[nextPosition])
  }

  async function shareTemplate() {
    if (templateId) {
      const url = `${window.location.origin}/t/${templateId}`
      await navigator.clipboard.writeText(url)
      return
    }
    if (!apiWeights) return
    if (!isShareDialogOpen) {
      setShareName(`${position} ${season} template`)
      setIsShareDialogOpen(true)
      return
    }
    setIsLoading(true)
    setError(null)
    try {
      const name = shareName.trim() || `${position} ${season} template`
      const response = await fetch('/api/templates', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name,
          season,
          position: position === 'ALL' ? null : position,
          league_slug: league === 'ALL' ? null : league,
          weights: apiWeights,
          is_public: true,
        }),
      })
      if (!response.ok) throw new Error(`POST /templates ${response.status}`)
      const template = (await response.json()) as { template_id: string }
      setTemplateId(template.template_id)
      setSharedTemplateId(template.template_id)
      setSharedTemplateName(name)
      setPublicTemplates((current) => [
        {
          id: template.template_id,
          name,
          description: null,
          position: position === 'ALL' ? null : position,
          weights: apiWeights,
          filters: {},
        },
        ...current.filter((item) => item.id !== template.template_id),
      ].slice(0, 6))
      setHasForkedSharedTemplate(false)
      setLoadedSharedTemplateId(template.template_id)
      setIsShareDialogOpen(false)
      const url = `${window.location.origin}/t/${template.template_id}`
      window.history.pushState(null, '', `/t/${template.template_id}`)
      await navigator.clipboard.writeText(url)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'No se pudo compartir el template.')
    } finally {
      setIsLoading(false)
    }
  }

  function savePreset() {
    const fallbackName = `${position} custom ${savedPresets.length + 1}`
    const name = presetName.trim() || fallbackName
    const nextPresets = [
      ...savedPresets,
      {
        id: crypto.randomUUID(),
        name,
        position,
        weights,
      },
    ]
    setSavedPresets(nextPresets)
    setPresetName('')
    window.localStorage.setItem(savedPresetsKey, JSON.stringify(nextPresets))
  }

  function applySavedPreset(id: string) {
    const preset = savedPresets.find((item) => item.id === id)
    if (!preset) return
    setPosition(preset.position)
    setWeights(preset.weights)
  }

  async function loadPublicTemplate(templateIdToLoad: string, templateName?: string) {
    requestSeq.current += 1
    setIsLoading(true)
    setError(null)
    setPlayers([])
    setHistoryByPlayerId({})
    try {
      const templateResponse = await fetch(`/api/templates/${templateIdToLoad}`)
      if (!templateResponse.ok) throw new Error(`GET /templates/${templateIdToLoad}`)
      const template = (await templateResponse.json()) as {
        id: string
        name: string
        position: Position | null
        weights: Partial<Record<MetricKey, number>>
      }
      const nextWeights = metrics.reduce(
        (acc, metric) => ({
          ...acc,
          [metric.key]: Math.round((template.weights[metric.key] ?? 0) * 100),
        }),
        {} as Record<MetricKey, number>,
      )
      setWeights(nextWeights)
      setPosition(template.position ?? 'ALL')
      setSharedTemplateName(templateName ?? template.name)
      setTemplateId(template.id)
      setLoadedSharedTemplateId(template.id)

      const playersResponse = await fetch(playersRequestUrl(template.id))
      if (!playersResponse.ok) throw new Error(`GET /players ${playersResponse.status}`)
      const rows = (await playersResponse.json()) as PlayerRow[]
      setPlayers(rows)
      setHistoryByPlayerId({})
      setExpandedPlayerId(null)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'No se pudo cargar el template.')
    } finally {
      setIsLoading(false)
    }
  }

  function applyCuratedTemplate(template: CuratedTemplate) {
    setSharedTemplateId(template.id)
    setHasForkedSharedTemplate(false)
    setLoadedSharedTemplateId(template.id)
    setSharedTemplateName(template.name)
    setTemplateId(template.id)
    window.history.pushState(null, '', `/t/${template.id}`)
    void loadPublicTemplate(template.id, template.name)
  }

  function toggleCompare(playerId: string) {
    setCompareIds((current) => {
      if (current.includes(playerId)) return current.filter((id) => id !== playerId)
      if (current.length >= 4) return [...current.slice(1), playerId]
      return [...current, playerId]
    })
  }

  function openPlayer(player: PlayerRow) {
    setExpandedPlayerId((current) => (current === player.id ? null : player.id))
    const templateQuery = templateId ? `?t=${encodeURIComponent(templateId)}` : ''
    window.history.pushState(null, '', `/p/${player.id}${templateQuery}`)
  }

  function trendRowsForPlayer(player: PlayerRow) {
    const history = historyByPlayerId[player.id]
    if (history) {
      return history.map((row) => ({
        season: row.season,
        value: row.value,
        minutes:
          typeof row.metrics?.minutes === 'number'
            ? row.metrics.minutes
            : typeof row.metrics?.minutes === 'string'
              ? Number(row.metrics.minutes)
              : null,
      }))
    }
    const trendEntries = Object.entries(player.trend.values_by_season)
    if (trendEntries.length > 0) {
      return trendEntries.map(([itemSeason, value]) => ({
        season: itemSeason,
        value,
        minutes: player.trend.minutes_by_season[itemSeason] ?? null,
      }))
    }
    return [{ season: player.season, value: player.value, minutes: player.minutes }]
  }

  return (
    <main className="min-h-screen overflow-hidden bg-[#07080a] text-slate-100">
      <div className="absolute inset-0 -z-0 bg-[radial-gradient(circle_at_25%_10%,rgba(184,255,61,0.12),transparent_26%),radial-gradient(circle_at_85%_18%,rgba(102,224,255,0.1),transparent_22%),linear-gradient(180deg,#0b0d10_0%,#07080a_52%,#050607_100%)]" />
      <div className="relative z-10 mx-auto flex min-h-screen max-w-[1500px] flex-col px-4 py-4 sm:px-6 lg:px-8">

        {/* ── Mode switcher ─────────────────────────────────────── */}
        <div className="mb-4 flex items-center justify-between rounded-2xl border border-white/10 bg-black/30 p-1">
          <button
            type="button"
            onClick={() => setAppMode('scout')}
            className={`flex flex-1 items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold transition ${
              appMode === 'scout'
                ? 'bg-lime-500 text-black shadow-lg shadow-lime-500/20'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            <Sparkles size={15} />
            GemScout Agent
          </button>
          <button
            type="button"
            onClick={() => setAppMode('explorer')}
            className={`flex flex-1 items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold transition ${
              appMode === 'explorer'
                ? 'bg-white/10 text-white'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            <SlidersHorizontal size={15} />
            Explorer
          </button>
        </div>

        {/* ── Scout Mode ───────────────────────────────────────── */}
        {appMode === 'scout' && <ScoutMode />}

        {/* ── Explorer Mode (original OpenMercat UI) ───────────── */}
        {appMode === 'explorer' && <>

        <header className="mb-4 flex flex-col gap-3 border-b border-white/10 pb-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-lime-300/20 bg-lime-300/10 px-3 py-1 text-xs font-medium text-lime-200">
              <CircleDot size={14} />
              GemScout · Player Explorer
            </div>
            <h1 className="text-3xl font-semibold tracking-normal text-white sm:text-4xl">
              Pondera el mercado a tu manera.
            </h1>
            {sharedTemplateName ? (
              <p className="mt-2 text-sm text-slate-400">
                Estas viendo el template de {sharedTemplateName}. Mueve los sliders para crear el tuyo.
              </p>
            ) : null}
          </div>

          <section className="grid grid-cols-[repeat(3,minmax(0,1fr))_auto] gap-2 rounded-lg border border-white/10 bg-white/[0.045] p-2 shadow-2xl shadow-black/30">
            <Field label="Liga">
              <select value={league} onChange={(event) => setLeague(event.target.value)}>
                {leagues.map((item) => (
                  <option key={item.value} value={item.value}>
                    {item.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Posicion">
              <select
                value={position}
                onChange={(event) => changePosition(event.target.value as Position)}
              >
                {positions.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Temporada">
              <select value={season} onChange={(event) => setSeason(event.target.value)}>
                {seasons.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </select>
            </Field>
            <button className="icon-button self-end" type="button" onClick={shareTemplate} title="Compartir">
              <Share2 size={16} />
            </button>
          </section>
        </header>

        <section className="mb-4">
          <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="text-xs uppercase tracking-[0.18em] text-slate-500">Entrada rapida</p>
              <h2 className="text-xl font-semibold text-white">Templates destacados</h2>
            </div>
            <div className="w-full sm:w-40">
              <Field label="Temporada">
                <select value={season} onChange={(event) => setSeason(event.target.value)}>
                  {seasons.map((item) => (
                    <option key={item} value={item}>
                      {item}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
          </div>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {curatedTemplates.map((template) => (
              <button
                key={template.id}
                className="template-card text-left"
                type="button"
                onClick={() => applyCuratedTemplate(template)}
              >
                <div className="mb-3 flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="truncate text-base font-semibold text-white">{template.name}</h3>
                    <p className="mt-1 min-h-10 text-sm leading-5 text-slate-400">
                      {template.description}
                    </p>
                  </div>
                  <span className="rounded-md border border-white/10 bg-black/30 px-2 py-1 text-xs font-semibold text-lime-200">
                    {template.position ?? 'ALL'}
                  </span>
                </div>
                <div className="space-y-2">
                  {template.top_players.map((player, index) => (
                    <div key={player.id} className="grid grid-cols-[24px_minmax(0,1fr)_auto] gap-2 text-sm">
                      <span className="text-slate-500">{index + 1}</span>
                      <span className="truncate text-slate-100">{player.name}</span>
                      <span className="max-w-28 truncate text-slate-500">{player.team_name ?? '-'}</span>
                    </div>
                  ))}
                  {template.top_players.length === 0 ? (
                    <p className="text-sm text-slate-500">Sin ranking calculado todavia</p>
                  ) : null}
                </div>
              </button>
            ))}
          </div>
          {publicTemplates.length > 0 ? (
            <div className="mt-4 border-t border-white/10 pt-3">
              <div className="mb-2 flex items-center justify-between gap-3">
                <h3 className="text-sm font-semibold text-white">Templates guardados</h3>
                <span className="text-xs text-slate-500">{publicTemplates.length}</span>
              </div>
              <div className="flex gap-2 overflow-x-auto pb-1">
                {publicTemplates.map((template) => (
                  <button
                    key={template.id}
                    className="min-w-56 rounded-lg border border-white/10 bg-white/[0.035] px-3 py-2 text-left text-sm transition hover:border-lime-300/30 hover:bg-white/[0.06]"
                    type="button"
                    onClick={() => void loadPublicTemplate(template.id, template.name)}
                  >
                    <span className="block truncate font-semibold text-white">{template.name}</span>
                    <span className="mt-1 block text-xs text-slate-500">
                      {template.position ?? 'ALL'} · {Object.keys(template.weights).length} pesos
                    </span>
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </section>

        <div className="grid flex-1 gap-4 lg:grid-cols-[390px_minmax(0,1fr)]">
          <aside className="rounded-lg border border-white/10 bg-[#101318]/95 p-4 shadow-2xl shadow-black/30">
            <div className="mb-5 flex items-center justify-between">
              <div>
                <p className="text-xs uppercase tracking-[0.18em] text-slate-500">Modelo</p>
                <h2 className="mt-1 flex items-center gap-2 text-xl font-semibold text-white">
                  <SlidersHorizontal size={20} className="text-lime-300" />
                  Pesos
                </h2>
              </div>
              <div className="rounded-md border border-white/10 bg-black/30 px-3 py-2 text-right">
                <p className="text-[11px] text-slate-500">Total bruto</p>
                <p className="text-sm font-semibold text-white">{totalWeight}</p>
              </div>
            </div>

            <div className="mb-5 rounded-lg border border-white/10 bg-black/20 p-3">
              <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
                <input
                  className="preset-input"
                  value={presetName}
                  placeholder={`${position} preset`}
                  onChange={(event) => setPresetName(event.target.value)}
                />
                <button className="icon-button" type="button" onClick={savePreset} title="Guardar preset">
                  <Save size={16} />
                </button>
              </div>
              <select
                className="mt-2 h-9 rounded-md border border-white/10 bg-[#101318] px-2 text-sm text-slate-200"
                value=""
                onChange={(event) => applySavedPreset(event.target.value)}
              >
                <option value="">Presets guardados</option>
                {savedPresets.map((preset) => (
                  <option key={preset.id} value={preset.id}>
                    {preset.name} · {preset.position}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-4">
              {metrics.map((metric) => {
                const normalized = apiWeights ? Math.round(apiWeights[metric.key] * 100) : 0
                return (
                  <label key={metric.key} className="group block">
                    <div className="mb-2 flex items-start justify-between gap-4">
                      <span>
                        <span className="block text-sm font-medium text-white">{metric.label}</span>
                        <span className="text-xs text-slate-500">{metric.hint}</span>
                      </span>
                      <span className="rounded-md border border-white/10 bg-white/[0.04] px-2 py-1 text-xs font-semibold text-slate-200">
                        {normalized}%
                      </span>
                    </div>
                    <input
                      className="metric-slider"
                      type="range"
                      min="0"
                      max="100"
                      value={weights[metric.key]}
                      style={
                        {
                          '--accent': metric.accent,
                          '--track-fill': `${weights[metric.key]}%`,
                        } as CSSProperties
                      }
                      onChange={(event) => updateWeight(metric.key, Number(event.target.value))}
                    />
                  </label>
                )
              })}
            </div>

            <div className="mt-5 grid grid-cols-2 gap-3">
              <SummaryTile icon={<Gauge size={16} />} label="Ranking" value={players.length} />
              <SummaryTile
                icon={isLoading ? <Loader2 size={16} className="animate-spin" /> : <Activity size={16} />}
                label="Estado"
                value={isLoading ? 'Sync' : 'Live'}
              />
            </div>
          </aside>

          <section className="min-w-0 rounded-lg border border-white/10 bg-[#0d1015]/95 shadow-2xl shadow-black/30">
            <div className="flex flex-col gap-3 border-b border-white/10 p-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <p className="text-xs uppercase tracking-[0.18em] text-slate-500">Top 50</p>
                <h2 className="mt-1 flex items-center gap-2 text-xl font-semibold text-white">
                  <Trophy size={20} className="text-lime-300" />
                  Jugadores por valor calculado
                </h2>
              </div>

              <div className="grid grid-cols-2 gap-2 sm:flex">
                <Kpi label="Lider" value={leader?.name ?? 'Sin datos'} />
                <Kpi
                  label={activePlayerSearch ? 'Busqueda' : 'Vista'}
                  value={`${visiblePlayers.length}/${players.length}`}
                />
              </div>
            </div>

            {error ? (
              <div className="p-6 text-sm text-rose-200">{error}</div>
            ) : (
              <>
              <div className="border-b border-white/10 p-3">
                <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                  <button
                    className="flex min-w-0 items-center justify-between gap-3 rounded-md border border-white/10 bg-white/[0.025] px-3 py-2 text-left transition hover:bg-white/[0.045] lg:w-72"
                    type="button"
                    onClick={() => setIsRadarOpen((current) => !current)}
                  >
                    <span className="min-w-0">
                      <span className="block text-xs uppercase tracking-[0.18em] text-slate-500">Radar</span>
                      <span className="block truncate text-sm font-semibold text-white">
                        Lecturas rapidas de mercado
                      </span>
                    </span>
                    <ChevronDown
                      className={`shrink-0 text-slate-500 transition-transform ${isRadarOpen ? 'rotate-180' : ''}`}
                      size={16}
                    />
                  </button>
                  <div className="flex gap-2 overflow-x-auto pb-1 lg:flex-wrap lg:justify-end lg:overflow-visible lg:pb-0">
                    {marketRadar.map((lane) => (
                      <button
                        key={lane.view}
                        className={`shrink-0 rounded-md border px-2.5 py-1.5 text-xs font-semibold ${
                          opportunityView === lane.view
                            ? 'border-lime-300/50 bg-lime-300/15 text-lime-100'
                            : 'border-white/10 bg-white/[0.025] text-slate-400 hover:text-slate-100'
                        }`}
                        type="button"
                        onClick={() => {
                          setOpportunityView(lane.view)
                          setIsRadarOpen(true)
                        }}
                      >
                        <span className={radarAccentClass(lane.view)}>{lane.players.length}</span>{' '}
                        {lane.title}
                      </button>
                    ))}
                  </div>
                </div>
                {isRadarOpen ? (
                  <div className="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-5">
                    {marketRadar.map((lane) => (
                      <RadarLane
                        key={lane.view}
                        lane={lane}
                        onOpen={(player) => {
                          setOpportunityView(lane.view)
                          openPlayer(player)
                        }}
                      />
                    ))}
                  </div>
                ) : null}
              </div>
              <div className="flex flex-col gap-3 border-b border-white/10 p-3 xl:flex-row xl:items-center xl:justify-between">
                <div className="relative min-w-0 xl:w-80">
                  <Search
                    className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-500"
                    size={16}
                  />
                  <input
                    className="w-full rounded-md border border-white/10 bg-black/25 py-2 pl-9 pr-3 text-sm text-white outline-none transition focus:border-lime-300/50"
                    placeholder="Buscar jugador, club o liga"
                    value={playerSearch}
                    onChange={(event) => {
                      setPlayerSearch(event.target.value)
                      setOpportunityView('ranking')
                    }}
                  />
                </div>
                <div className="flex flex-wrap gap-2">
                  {[
                    ['ranking', 'Ranking'],
                    ['undervalued', 'Infravalorados'],
                    ['overvalued', 'Sobrevalorados'],
                    ['young-up', 'Jovenes al alza'],
                    ['veterans', 'Veteranos utiles'],
                    ['missing-tm', 'Sin TM'],
                  ].map(([value, label]) => (
                    <button
                      key={value}
                      className={`rounded-md border px-3 py-1.5 text-xs font-semibold ${
                        opportunityView === value
                          ? 'border-lime-300/50 bg-lime-300/15 text-lime-100'
                          : 'border-white/10 bg-white/[0.035] text-slate-400 hover:text-slate-100'
                      }`}
                      type="button"
                      onClick={() => setOpportunityView(value as OpportunityView)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              {comparedPlayers.length > 0 ? (
                <ComparePanel
                  players={comparedPlayers}
                  onOpen={openPlayer}
                  onRemove={(player) => toggleCompare(player.id)}
                  onClear={() => setCompareIds([])}
                />
              ) : null}
              <div className="overflow-x-auto">
                <table className="w-full min-w-[860px] border-collapse text-left">
                  <thead>
                    <tr className="border-b border-white/10 text-xs uppercase tracking-[0.14em] text-slate-500">
                      <th className="w-16 px-4 py-3">#</th>
                      <th className="px-4 py-3">Jugador</th>
                      <th className="px-4 py-3">Club</th>
                      <th className="px-4 py-3">Liga</th>
                      <th className="px-4 py-3 text-right">Score</th>
                      <th className="px-4 py-3 text-right">Valor OM</th>
                      <th className="px-4 py-3 text-right">Valor TM</th>
                      <th className="px-4 py-3 text-right">Gap EUR</th>
                      {activeMetrics.map((metric) => (
                        <th key={metric.key} className="px-4 py-3 text-right">
                          {metric.label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {visiblePlayers.length === 0 ? (
                      <tr>
                        <td className="px-4 py-8 text-center text-sm text-slate-500" colSpan={8 + activeMetrics.length}>
                          {activePlayerSearch
                            ? `Sin resultados para "${activePlayerSearch}" con los filtros actuales.`
                            : 'Sin jugadores para esta vista.'}
                        </td>
                      </tr>
                    ) : null}
                    {visiblePlayers.map((player, index) => (
                      <Fragment key={player.id}>
                      <tr
                        data-player-row={player.id}
                        className="border-b border-white/[0.06] text-sm text-slate-300 transition-colors hover:bg-white/[0.035]"
                      >
                        <td className="px-4 py-3 text-slate-500">{index + 1}</td>
                        <td className="px-4 py-3">
                          <button
                            className="text-left font-medium text-white hover:text-lime-200"
                            type="button"
                            onClick={() => openPlayer(player)}
                          >
                            {player.name}
                          </button>
                          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-slate-500">
                            <span>
                              {player.position ?? 'ALL'}
                              {player.position_detail ? ` · ${player.position_detail}` : ''}
                              {player.age ? ` · ${player.age}` : ''}
                            </span>
                            <span className={`rounded border px-1.5 py-0.5 ${confidenceClass(player.confidence_label)}`}>
                              {player.confidence_label}
                            </span>
                            <span className="rounded border border-white/10 bg-white/[0.035] px-1.5 py-0.5 text-slate-300">
                              {trendLabel(player.trend.direction)}
                            </span>
                            <span className={`rounded border px-1.5 py-0.5 ${marketReadingClass(player.market_reading.label)}`}>
                              {player.market_reading.label}
                            </span>
                            <span className="rounded border border-sky-300/20 bg-sky-300/10 px-1.5 py-0.5 text-sky-200">
                              {player.stats_source ?? 'stats'} {formatShortDate(player.stats_fetched_at)}
                            </span>
                            <span className="rounded border border-white/10 bg-white/[0.035] px-1.5 py-0.5 text-slate-300">
                              TM {formatShortDate(player.tm_value_date ?? player.tm_fetched_at)}
                            </span>
                            <button
                              className={`rounded border px-1.5 py-0.5 ${
                                compareIds.includes(player.id)
                                  ? 'border-lime-300/50 bg-lime-300/15 text-lime-100'
                                  : 'border-white/10 bg-white/[0.035] text-slate-300 hover:text-white'
                              }`}
                              type="button"
                              onClick={() => toggleCompare(player.id)}
                            >
                              Comparar
                            </button>
                          </div>
                        </td>
                        <td className="px-4 py-3">{player.team_name ?? '-'}</td>
                        <td className="px-4 py-3">{player.league_name ?? '-'}</td>
                        <td className="px-4 py-3 text-right">
                          <span className="inline-flex min-w-16 justify-center rounded-md bg-lime-300 px-2 py-1 text-xs font-bold text-black">
                            {formatNumber(player.value, 2)}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-right">{formatEuro(player.om_value_eur)}</td>
                        <td className="px-4 py-3 text-right">{formatEuro(player.tm_value_eur)}</td>
                        <td className={`px-4 py-3 text-right font-semibold ${deltaClass(player.tm_delta_eur)}`}>
                          {player.tm_delta_eur === null
                            ? '-'
                            : `${player.tm_delta_eur > 0 ? '+' : ''}${formatEuro(player.tm_delta_eur)}`}
                        </td>
                        {activeMetrics.map((metric) => {
                          const raw = rawMetricValue(player, metric.key)
                          const percentile = metricPercentile(player, metric.key)
                          return (
                            <td key={metric.key} className="px-4 py-3 text-right">
                              <div className="font-medium text-slate-100">
                                {typeof raw === 'number'
                                  ? metric.key === 'minutes'
                                    ? raw.toLocaleString('en-US')
                                    : formatNumber(raw)
                                  : '-'}
                              </div>
                              <div className="text-[11px] text-slate-500">
                                p{percentile === null ? '-' : Math.round(percentile)}
                              </div>
                            </td>
                          )
                        })}
                      </tr>
                      {expandedPlayerId === player.id ? (
                        <tr className="border-b border-white/[0.06] bg-black/20 text-sm text-slate-300">
                          <td className="px-4 py-4" colSpan={8 + activeMetrics.length}>
                            <div className="grid gap-4 xl:grid-cols-[1.2fr_1fr_1fr_1fr]">
                              <div>
                                <p className="mb-2 font-medium text-white">{player.explanation.summary}</p>
                                <div className="mb-3 grid grid-cols-2 gap-2 text-xs">
                                  <div className="rounded-md border border-white/10 bg-white/[0.035] p-2">
                                    <p className="flex items-center gap-1 text-slate-500">
                                      <Database size={12} />
                                      Stats
                                    </p>
                                    <p className="font-semibold text-white">
                                      {player.stats_source ?? '-'} · {formatShortDate(player.stats_fetched_at)}
                                    </p>
                                  </div>
                                  <div className="rounded-md border border-white/10 bg-white/[0.035] p-2">
                                    <p className="text-slate-500">Transfermarkt</p>
                                    <p className="font-semibold text-white">
                                      {formatShortDate(player.tm_value_date ?? player.tm_fetched_at)}
                                    </p>
                                  </div>
                                </div>
                                <div className="flex flex-wrap gap-2">
                                  {player.explanation.drivers.map((driver) => (
                                    <span
                                      key={driver.metric}
                                      className="rounded-md border border-lime-300/20 bg-lime-300/10 px-2 py-1 text-xs text-lime-100"
                                    >
                                      {driver.label} p{Math.round(driver.percentile)}
                                    </span>
                                  ))}
                                </div>
                              </div>
                              <div>
                                <p className="mb-2 text-xs uppercase tracking-[0.14em] text-slate-500">
                                  Mercado
                                </p>
                                <div className="space-y-2">
                                  <span className={`inline-flex rounded border px-2 py-1 text-xs font-semibold ${marketReadingClass(player.market_reading.label)}`}>
                                    {player.market_reading.label}
                                  </span>
                                  <p className="text-xs leading-5 text-slate-400">
                                    {player.market_reading.summary}
                                  </p>
                                  <div className="grid grid-cols-3 gap-2 text-xs">
                                    <div className="rounded-md border border-white/10 bg-white/[0.035] p-2">
                                      <p className="text-slate-500">OM</p>
                                      <p className="font-semibold text-white">{formatEuro(player.om_value_eur)}</p>
                                    </div>
                                    <div className="rounded-md border border-white/10 bg-white/[0.035] p-2">
                                      <p className="text-slate-500">TM</p>
                                      <p className="font-semibold text-white">{formatEuro(player.tm_value_eur)}</p>
                                    </div>
                                    <div className="rounded-md border border-white/10 bg-white/[0.035] p-2">
                                      <p className="text-slate-500">Gap</p>
                                      <p className={`font-semibold ${deltaClass(player.tm_delta_eur)}`}>
                                        {player.tm_delta_eur === null
                                          ? '-'
                                          : `${player.tm_delta_eur > 0 ? '+' : ''}${formatEuro(player.tm_delta_eur)}`}
                                      </p>
                                    </div>
                                  </div>
                                </div>
                              </div>
                              <div>
                                <p className="mb-2 text-xs uppercase tracking-[0.14em] text-slate-500">
                                  Riesgos
                                </p>
                                <div className="space-y-1 text-xs text-slate-400">
                                  {[
                                    ...new Set([
                                      ...player.explanation.penalties,
                                      ...player.market_reading.notes,
                                    ]),
                                  ].slice(0, 5).map((item) => (
                                    <p key={item}>{item}</p>
                                  ))}
                                </div>
                              </div>
                              <div>
                                <p className="mb-2 text-xs uppercase tracking-[0.14em] text-slate-500">
                                  Tendencia
                                </p>
                                <div className="grid grid-cols-3 gap-2 text-xs">
                                  {historyLoadingPlayerId === player.id ? (
                                    <div className="rounded-md border border-white/10 bg-white/[0.035] p-2 text-slate-500">
                                      Cargando
                                    </div>
                                  ) : null}
                                  {trendRowsForPlayer(player).map((item) => (
                                    <div
                                      key={item.season}
                                      className="rounded-md border border-white/10 bg-white/[0.035] p-2"
                                    >
                                      <p className="text-slate-500">{item.season}</p>
                                      <p className="font-semibold text-white">{formatNumber(item.value, 1)}</p>
                                      <p className="text-slate-500">
                                        {item.minutes?.toLocaleString('en-US') ?? '-'} min
                                      </p>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            </div>
                          </td>
                        </tr>
                      ) : null}
                      </Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
              </>
            )}

            <div className="flex items-center justify-between border-t border-white/10 px-4 py-3 text-xs text-slate-500">
              <span>{templateId ? `template ${templateId.slice(0, 8)}` : 'preview sin guardar'}</span>
              <span>debounce 300ms · sin escrituras</span>
            </div>
          </section>
        </div>
      </div>
      {isShareDialogOpen ? (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 px-4">
          <div className="w-full max-w-md rounded-lg border border-white/10 bg-[#101318] p-4 shadow-2xl shadow-black/60">
            <div className="mb-4 flex items-start justify-between gap-3">
              <div>
                <p className="text-xs uppercase tracking-[0.18em] text-slate-500">Compartir</p>
                <h2 className="mt-1 text-lg font-semibold text-white">Guardar template publico</h2>
              </div>
              <button
                className="icon-button"
                type="button"
                onClick={() => setIsShareDialogOpen(false)}
                title="Cerrar"
              >
                <X size={16} />
              </button>
            </div>
            <label className="block">
              <span className="mb-1 block text-[11px] uppercase tracking-[0.14em] text-slate-500">
                Nombre
              </span>
              <input
                className="preset-input"
                value={shareName}
                maxLength={120}
                onChange={(event) => setShareName(event.target.value)}
              />
            </label>
            <div className="mt-4 flex justify-end gap-2">
              <button
                className="rounded-md border border-white/10 bg-white/[0.035] px-3 py-2 text-sm text-slate-300 hover:text-white"
                type="button"
                onClick={() => setIsShareDialogOpen(false)}
              >
                Cancelar
              </button>
              <button
                className="rounded-md border border-lime-300/40 bg-lime-300 px-3 py-2 text-sm font-semibold text-black"
                type="button"
                onClick={shareTemplate}
              >
                Guardar y copiar
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="min-w-0">
      <span className="mb-1 block text-[11px] uppercase tracking-[0.14em] text-slate-500">
        {label}
      </span>
      <div className="select-shell">{children}</div>
    </label>
  )
}

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-28 rounded-md border border-white/10 bg-black/25 px-3 py-2">
      <p className="text-[11px] uppercase tracking-[0.14em] text-slate-500">{label}</p>
      <p className="truncate text-sm font-semibold text-white">{value}</p>
    </div>
  )
}

function SummaryTile({
  icon,
  label,
  value,
}: {
  icon: ReactNode
  label: string
  value: string | number
}) {
  return (
    <div className="rounded-lg border border-white/10 bg-white/[0.035] p-3">
      <div className="mb-2 text-lime-300">{icon}</div>
      <p className="text-xs text-slate-500">{label}</p>
      <p className="mt-1 text-lg font-semibold text-white">{value}</p>
    </div>
  )
}

function RadarLane({
  lane,
  onOpen,
}: {
  lane: {
    view: OpportunityView
    title: string
    hint: string
    icon: ReactNode
    players: PlayerRow[]
  }
  onOpen: (player: PlayerRow) => void
}) {
  return (
    <div className="rounded-lg border border-white/10 bg-white/[0.025] p-3">
      <div className="mb-3 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className={`flex items-center gap-1.5 text-sm font-semibold ${radarAccentClass(lane.view)}`}>
            {lane.icon}
            <span className="truncate">{lane.title}</span>
          </p>
          <p className="mt-1 text-xs text-slate-500">{lane.hint}</p>
        </div>
        <span className="rounded border border-white/10 bg-black/25 px-1.5 py-0.5 text-xs text-slate-400">
          {lane.players.length}
        </span>
      </div>
      <div className="space-y-1.5">
        {lane.players.map((player) => (
          <button
            key={player.id}
            className="grid w-full grid-cols-[minmax(0,1fr)_auto] gap-2 rounded-md px-2 py-1.5 text-left text-xs text-slate-300 transition hover:bg-white/[0.045]"
            type="button"
            onClick={() => onOpen(player)}
          >
            <span className="min-w-0">
              <span className="block truncate font-medium text-white">{player.name}</span>
              <span className="block truncate text-slate-500">{player.team_name ?? '-'}</span>
            </span>
            <span className="text-right">
              <span className="block font-semibold text-slate-100">{formatNumber(player.value, 1)}</span>
              <span className={`block ${deltaClass(player.tm_delta_eur)}`}>
                {player.tm_delta_eur === null
                  ? formatEuro(player.tm_value_eur)
                  : `${player.tm_delta_eur > 0 ? '+' : ''}${formatEuro(player.tm_delta_eur)}`}
              </span>
            </span>
          </button>
        ))}
        {lane.players.length === 0 ? (
          <p className="rounded-md border border-white/10 bg-black/15 px-2 py-2 text-xs text-slate-500">
            Sin casos con estos filtros.
          </p>
        ) : null}
      </div>
    </div>
  )
}

function ComparePanel({
  players,
  onOpen,
  onRemove,
  onClear,
}: {
  players: PlayerRow[]
  onOpen: (player: PlayerRow) => void
  onRemove: (player: PlayerRow) => void
  onClear: () => void
}) {
  return (
    <div className="border-b border-white/10 bg-black/15 p-3">
      <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <Scale size={16} className="text-lime-300" />
          <div>
            <p className="text-xs uppercase tracking-[0.18em] text-slate-500">Comparador</p>
            <h3 className="text-sm font-semibold text-white">{players.length}/4 jugadores</h3>
          </div>
        </div>
        <button
          className="self-start rounded-md border border-white/10 bg-white/[0.035] px-2 py-1 text-xs text-slate-400 hover:text-white sm:self-auto"
          type="button"
          onClick={onClear}
        >
          Limpiar
        </button>
      </div>
      <div className="overflow-x-auto">
        <div
          className="grid min-w-[720px] gap-2"
          style={{ gridTemplateColumns: `repeat(${players.length}, minmax(170px, 1fr))` }}
        >
          {players.map((player) => (
            <div key={player.id} className="rounded-lg border border-white/10 bg-white/[0.03] p-3">
              <div className="mb-3 flex items-start justify-between gap-2">
                <button
                  className="min-w-0 text-left"
                  type="button"
                  onClick={() => onOpen(player)}
                >
                  <p className="truncate text-sm font-semibold text-white hover:text-lime-200">
                    {player.name}
                  </p>
                  <p className="truncate text-xs text-slate-500">{player.team_name ?? '-'}</p>
                </button>
                <button
                  className="rounded border border-white/10 bg-black/20 p-1 text-slate-500 hover:text-white"
                  type="button"
                  onClick={() => onRemove(player)}
                  title="Quitar"
                >
                  <X size={13} />
                </button>
              </div>
              <div className="grid grid-cols-2 gap-2 text-xs">
                <CompareStat label="Score" value={formatNumber(player.value, 1)} />
                <CompareStat label="Edad" value={player.age?.toString() ?? '-'} />
                <CompareStat label="OM" value={formatEuro(player.om_value_eur)} />
                <CompareStat label="TM" value={formatEuro(player.tm_value_eur)} />
                <CompareStat
                  label="Gap"
                  value={
                    player.tm_delta_eur === null
                      ? '-'
                      : `${player.tm_delta_eur > 0 ? '+' : ''}${formatEuro(player.tm_delta_eur)}`
                  }
                  valueClass={deltaClass(player.tm_delta_eur)}
                />
                <CompareStat label="Tend." value={trendLabel(player.trend.direction)} />
              </div>
              <div className="mt-3 flex flex-wrap gap-1.5">
                {player.explanation.drivers.slice(0, 3).map((driver) => (
                  <span
                    key={driver.metric}
                    className="rounded border border-white/10 bg-black/20 px-1.5 py-0.5 text-[11px] text-slate-300"
                  >
                    {driver.label} p{Math.round(driver.percentile)}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

        </> /* end explorer mode */}

      </div>
    </main>
  )
}

function CompareStat({
  label,
  value,
  valueClass = 'text-white',
}: {
  label: string
  value: string
  valueClass?: string
}) {
  return (
    <div className="rounded-md border border-white/10 bg-black/20 p-2">
      <p className="text-[11px] text-slate-500">{label}</p>
      <p className={`mt-0.5 truncate font-semibold ${valueClass}`}>{value}</p>
    </div>
  )
}

export default App
