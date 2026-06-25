// server.js
//
// Backend dedicato a MatchPredictor.
// Unico scopo per ora: fare da proxy verso football-data.org, tenendo
// la chiave API al sicuro lato server (il frontend pubblico non la vede mai).
//
// Gestito da PM2 come processo indipendente, su una porta propria,
// dietro Nginx sul sottodominio matchpredictor.chainintegrate.it.

require("dotenv").config();
const express = require("express");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3006;

const FOOTBALL_DATA_BASE_URL = "https://api.football-data.org/v4";

// ── Middleware ──────────────────────────────────────────────────────────
app.use(cors({
  origin: [
    "https://matchpredictor.chainintegrate.it",
    "http://localhost:8910" // utile per test locali del frontend
  ]
}));
app.use(express.json());

// ── Cache in memoria ────────────────────────────────────────────────────
// Un match FINISHED non cambia più risultato: cache permanente per processo,
// utile anche per rispettare il limite di 10 richieste/minuto del tier gratuito.
const scoreCache = new Map();

// ── Health check ────────────────────────────────────────────────────────
app.get("/api/health", (req, res) => {
  res.json({ success: true, status: "online", service: "matchpredictor-backend" });
});

// ── Proxy punteggio partita ─────────────────────────────────────────────
// GET /api/match-score/:footballDataMatchId
app.get("/api/match-score/:footballDataMatchId", async (req, res) => {
  const { footballDataMatchId } = req.params;

  if (!/^\d+$/.test(footballDataMatchId)) {
    return res.status(400).json({ success: false, error: "ID match non valido" });
  }

  if (scoreCache.has(footballDataMatchId)) {
    return res.json({ success: true, data: scoreCache.get(footballDataMatchId) });
  }

  try {
    const response = await fetch(
      `${FOOTBALL_DATA_BASE_URL}/matches/${footballDataMatchId}`,
      { headers: { "X-Auth-Token": process.env.FOOTBALL_DATA_API_KEY } }
    );

    if (!response.ok) {
      return res.status(502).json({
        success: false,
        error: `football-data.org ha risposto con status ${response.status}`,
      });
    }

    const data = await response.json();

    if (data.status !== "FINISHED") {
      return res.json({
        success: true,
        data: { finished: false, status: data.status },
      });
    }

    const result = {
      finished: true,
      status: data.status,
      homeTeam: data.homeTeam.name,
      awayTeam: data.awayTeam.name,
      homeScore: data.score.fullTime.home,
      awayScore: data.score.fullTime.away,
    };

    scoreCache.set(footballDataMatchId, result);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Avvio ───────────────────────────────────────────────────────────────
app.listen(PORT, "127.0.0.1", () => {
  console.log("═══════════════════════════════════════");
  console.log("  MatchPredictor Backend");
  console.log("═══════════════════════════════════════");
  console.log(`  API:     http://localhost:${PORT}/api`);
  console.log(`  Health:  http://localhost:${PORT}/api/health`);
  console.log("═══════════════════════════════════════");
});
