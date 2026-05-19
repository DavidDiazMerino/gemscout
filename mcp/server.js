/**
 * GemScout MCP Server
 *
 * Exposes MongoDB Atlas (GemScout players collection) as MCP tools
 * so Google Cloud Agent Builder / Gemini can query the database directly.
 *
 * Tools:
 *   search_players  — Atlas $search (full-text) + stat filters + ranking
 *   get_player      — full profile by Wikidata QID
 *   top_players     — top-N by position/metric, no text query needed
 *
 * Transport: streamable HTTP (POST /mcp) — compatible with Agent Builder.
 */

import express from "express";
import { MongoClient } from "mongodb";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

// ─── MongoDB ────────────────────────────────────────────────────────────────

const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_DB  = process.env.MONGODB_DB || "gemscout";

if (!MONGODB_URI) throw new Error("MONGODB_URI env var required");

const mongo = new MongoClient(MONGODB_URI);
await mongo.connect();
const db      = mongo.db(MONGODB_DB);
const players = db.collection("players");

// ─── Helpers ────────────────────────────────────────────────────────────────

const PROJECT_NO_EMBEDDING = { embedding: 1 };  // 1 means exclude? No, use 0
const EXCLUDE = { embedding: 0 };

function buildMatchStage(position, max_age, min_age, league_slug, league_tier_max, season) {
  const match = { season: season ?? "2025-26" };
  if (position)        match.position     = position.toUpperCase();
  if (max_age != null) match.age          = { ...match.age, $lte: max_age };
  if (min_age != null) match.age          = { ...match.age, $gte: min_age };
  if (league_slug)     match.league_slug  = league_slug;
  if (league_tier_max != null) match.league_tier = { $lte: league_tier_max };
  return match;
}

function playerSummary(doc) {
  const norm = doc.metrics_normalized ?? {};
  const stats = doc.stats ?? {};
  return {
    qid:           doc._id,
    name:          doc.name,
    age:           doc.age,
    position:      doc.position,
    nationality:   doc.nationality,
    current_team:  doc.current_team,
    league:        doc.league,
    league_slug:   doc.league_slug,
    league_tier:   doc.league_tier,
    market_value_eur: doc.market_value_eur,
    minutes:       stats.minutes,
    goals:         stats.goals,
    assists:       stats.assists,
    xg:            stats.xg,
    xa:            stats.xa,
    percentiles: {
      xg:         norm.xg,
      xa:         norm.xa,
      xg_chain:   norm.xg_chain,
      xg_buildup: norm.xg_buildup,
      key_passes: norm.key_passes,
      goals:      norm.goals,
      assists:    norm.assists,
      save_percent:    norm.save_percent,
      goals_prevented: norm.goals_prevented,
      clean_sheets:    norm.clean_sheets,
    },
    profile_text_snippet: (doc.profile_text ?? "").slice(0, 300),
  };
}

// ─── MCP Server ─────────────────────────────────────────────────────────────

const mcp = new McpServer({
  name:    "gemscout-mongodb",
  version: "1.0.0",
});

// ── Tool: search_players ────────────────────────────────────────────────────
mcp.tool(
  "search_players",
  `Search the GemScout database of 2,200+ football players for the 2025-26 season.
Uses MongoDB Atlas full-text search on tactical profiles combined with filters.
Returns players ranked by profile relevance + statistical percentile scores.
Call this first when a director gives you a natural language scouting request.`,
  {
    query: z.string().describe(
      "Tactical description: playing style, physical attributes, role. " +
      "E.g. 'box-to-box midfielder high pressing ball progression'"
    ),
    position:       z.enum(["FWD","MID","DEF","GK"]).optional().describe("Filter by position"),
    max_age:        z.number().int().optional().describe("Maximum age inclusive"),
    min_age:        z.number().int().optional().describe("Minimum age inclusive"),
    league_slug:    z.string().optional().describe("E.g. premier-league, la-liga, bundesliga, serie-a, ligue-1"),
    league_tier_max: z.number().int().optional().describe("1=Big5 Europe, 2=Mid Europe, 3=all incl Americas"),
    season:         z.string().default("2025-26"),
    limit:          z.number().int().default(8).describe("Max players to return (max 20)"),
  },
  async ({ query, position, max_age, min_age, league_slug, league_tier_max, season, limit }) => {
    const matchStage = buildMatchStage(position, max_age, min_age, league_slug, league_tier_max, season);

    const pipeline = [
      {
        $search: {
          index: "player_text_index",
          compound: {
            should: [
              { text: { query, path: "profile_text", score: { boost: { value: 3 } } } },
              { text: { query, path: ["name","nationality","current_team","league"] } },
            ],
          },
        },
      },
      { $match: matchStage },
      { $limit: Math.min(limit, 20) },
      { $project: EXCLUDE },
    ];

    let docs;
    try {
      docs = await players.aggregate(pipeline).toArray();
    } catch (err) {
      // Fallback if Atlas Search index not ready: plain find sorted by xg percentile
      docs = await players
        .find(matchStage, { projection: EXCLUDE })
        .sort({ "metrics_normalized.xg_chain": -1 })
        .limit(Math.min(limit, 20))
        .toArray();
    }

    const result = docs.map(playerSummary);
    return {
      content: [{
        type: "text",
        text: JSON.stringify({ total: result.length, players: result }, null, 2),
      }],
    };
  }
);

// ── Tool: get_player ────────────────────────────────────────────────────────
mcp.tool(
  "get_player",
  `Get the full profile of a specific player by their Wikidata QID.
Use this after search_players to investigate top candidates in depth.
Returns complete stats, percentile scores for all metrics, and the
3-season World Cup cycle trajectory (2023-24, 2024-25, 2025-26).`,
  {
    qid: z.string().describe("Wikidata QID from search_players result, e.g. Q12345"),
  },
  async ({ qid }) => {
    const doc = await players.findOne({ _id: qid }, { projection: EXCLUDE });
    if (!doc) {
      return { content: [{ type: "text", text: `Player ${qid} not found` }] };
    }

    const history = doc.history ?? {};
    const norm    = doc.metrics_normalized ?? {};
    const stats   = doc.stats ?? {};

    // Build WC cycle trajectory
    const trajectory = {};
    for (const [season, data] of Object.entries(history)) {
      const n = data.metrics_normalized ?? {};
      const s = data.stats ?? {};
      trajectory[season] = {
        minutes: s.minutes,
        goals: s.goals, assists: s.assists, xg: s.xg, xa: s.xa,
        percentiles: {
          xg: n.xg, xa: n.xa, xg_chain: n.xg_chain,
          xg_buildup: n.xg_buildup, key_passes: n.key_passes,
          save_percent: n.save_percent, goals_prevented: n.goals_prevented,
        },
      };
    }
    trajectory[doc.season ?? "2025-26"] = {
      minutes: stats.minutes,
      goals: stats.goals, assists: stats.assists, xg: stats.xg, xa: stats.xa,
      percentiles: {
        xg: norm.xg, xa: norm.xa, xg_chain: norm.xg_chain,
        xg_buildup: norm.xg_buildup, key_passes: norm.key_passes,
        save_percent: norm.save_percent, goals_prevented: norm.goals_prevented,
        clean_sheets: norm.clean_sheets, goals: norm.goals, assists: norm.assists,
      },
    };

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          qid: doc._id,
          name: doc.name,
          age: doc.age,
          position: doc.position,
          nationality: doc.nationality,
          current_team: doc.current_team,
          league: doc.league,
          league_tier: doc.league_tier,
          market_value_eur: doc.market_value_eur,
          profile_text: doc.profile_text,
          world_cup_cycle_trajectory: trajectory,
        }, null, 2),
      }],
    };
  }
);

// ── Tool: top_players ───────────────────────────────────────────────────────
mcp.tool(
  "top_players",
  `Get top players ranked by a specific metric percentile.
Use this when the director wants to find the statistically best players
in a category without a text description — e.g. 'highest xG forwards under 23'.`,
  {
    metric: z.string().describe(
      "Metric to rank by. Options: xg, xa, xg_chain, xg_buildup, key_passes, " +
      "goals, assists, save_percent, goals_prevented, clean_sheets, minutes, rating"
    ),
    position:        z.enum(["FWD","MID","DEF","GK"]).optional(),
    max_age:         z.number().int().optional(),
    min_age:         z.number().int().optional(),
    league_slug:     z.string().optional(),
    league_tier_max: z.number().int().optional(),
    season:          z.string().default("2025-26"),
    limit:           z.number().int().default(10),
  },
  async ({ metric, position, max_age, min_age, league_slug, league_tier_max, season, limit }) => {
    const matchStage = buildMatchStage(position, max_age, min_age, league_slug, league_tier_max, season);
    const sortKey = `metrics_normalized.${metric}`;

    const docs = await players
      .find(matchStage, { projection: EXCLUDE })
      .sort({ [sortKey]: -1 })
      .limit(Math.min(limit, 20))
      .toArray();

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          ranked_by: metric,
          players: docs.map(d => ({
            ...playerSummary(d),
            [`${metric}_percentile`]: d.metrics_normalized?.[metric],
          })),
        }, null, 2),
      }],
    };
  }
);

// ─── HTTP Server (streamable MCP) ───────────────────────────────────────────

const app = express();
app.use(express.json());

app.post("/mcp", async (req, res) => {
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await mcp.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

// Health check for Cloud Run
app.get("/health", (_req, res) => res.json({ status: "ok", service: "gemscout-mcp" }));

const PORT = process.env.PORT || 8081;
app.listen(PORT, () => console.log(`GemScout MCP server on :${PORT}`));
