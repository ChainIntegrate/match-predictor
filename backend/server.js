// server.js
//
// Backend dedicato a MatchPredictor.
// 1. Proxy verso football-data.org (punteggi + partite programmate)
// 2. Storage condiviso per le partite del sito (matches-data.json),
//    leggibile da chiunque, scrivibile solo dall'owner della UP
//    (verificato via firma ERC-1271, nessuna chiave privata coinvolta).
//
// Gestito da PM2 come processo indipendente, su una porta propria,
// dietro Nginx sul sottodominio matchpredictor.chainintegrate.it.

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const app = express();
const PORT = process.env.PORT || 3006;

const FOOTBALL_DATA_BASE_URL = "https://api.football-data.org/v4";
const RPC_URL = process.env.LUKSO_RPC_URL || "https://rpc.testnet.lukso.network";
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS; // MatchPredictor
const OWNER_UP_ADDRESS = process.env.OWNER_UP_ADDRESS; // la Universal Profile owner

const MATCHES_DATA_PATH = path.join(__dirname, "matches-data.json");

// ── Middleware ──────────────────────────────────────────────────────────
app.use(cors({
  origin: [
    "https://matchpredictor.chainintegrate.it",
    "http://localhost:8910"
  ]
}));
app.use(express.json());

// ── Cache punteggi (in memoria) ───────────────────────────────────────
const scoreCache = new Map();

// ── Helper: legge/scrive il file condiviso delle partite ──────────────
function readMatchesData() {
  try {
    if (!fs.existsSync(MATCHES_DATA_PATH)) {
      return { matches: [], matchIdMapping: {} };
    }
    const raw = fs.readFileSync(MATCHES_DATA_PATH, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    console.error("Errore lettura matches-data.json:", err.message);
    return { matches: [], matchIdMapping: {} };
  }
}

function writeMatchesData(data) {
  fs.writeFileSync(MATCHES_DATA_PATH, JSON.stringify(data, null, 2), "utf8");
}

// ── Helper: verifica che una firma provenga da un controller
// autorizzato (permesso SIGN) della Universal Profile owner ───────────
async function verifyOwnerSignature(message, signature) {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const upAbi = [
    "function isValidSignature(bytes32 hash, bytes memory signature) external view returns (bytes4)"
  ];
  const up = new ethers.Contract(OWNER_UP_ADDRESS, upAbi, provider);

  const messageHash = ethers.hashMessage(message); // applica il prefisso EIP-191 standard
  const ERC1271_MAGIC_VALUE = "0x1626ba7e";

  try {
    const result = await up.isValidSignature(messageHash, signature);
    return result.toLowerCase() === ERC1271_MAGIC_VALUE;
  } catch (err) {
    console.error("Errore verifica firma:", err.message);
    return false;
  }
}

// ── Health check ────────────────────────────────────────────────────────
app.get("/api/health", (req, res) => {
  res.json({ success: true, status: "online", service: "matchpredictor-backend" });
});

// ── Proxy punteggio partita ─────────────────────────────────────────────
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
        error: `football-data.org ha risposto con status ${response.status}`
      });
    }

    const data = await response.json();

    if (data.status !== "FINISHED") {
      return res.json({ success: true, data: { finished: false, status: data.status } });
    }

    const result = {
      finished: true,
      status: data.status,
      homeTeam: data.homeTeam.name,
      awayTeam: data.awayTeam.name,
      homeScore: data.score.fullTime.home,
      awayScore: data.score.fullTime.away
    };

    scoreCache.set(footballDataMatchId, result);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Proxy lista partite programmate (per il bottone Import) ───────────
app.get("/api/upcoming-matches", async (req, res) => {
  const { dateFrom, dateTo } = req.query;

  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateFrom || !dateTo || !dateRegex.test(dateFrom) || !dateRegex.test(dateTo)) {
    return res.status(400).json({
      success: false,
      error: "Parametri dateFrom e dateTo richiesti, formato YYYY-MM-DD"
    });
  }

  try {
    const response = await fetch(
      `${FOOTBALL_DATA_BASE_URL}/competitions/WC/matches?dateFrom=${dateFrom}&dateTo=${dateTo}&status=SCHEDULED`,
      { headers: { "X-Auth-Token": process.env.FOOTBALL_DATA_API_KEY } }
    );

    if (!response.ok) {
      return res.status(502).json({
        success: false,
        error: `football-data.org ha risposto con status ${response.status}`
      });
    }

    const data = await response.json();

    const knownMatches = (data.matches || [])
      .filter((m) => m.homeTeam?.name && m.awayTeam?.name && m.homeTeam.name !== "TBD")
      .map((m) => ({
        footballDataMatchId: m.id,
        teamHome: m.homeTeam.name,
        teamAway: m.awayTeam.name,
        kickoff: m.utcDate,
        group: m.group || m.stage || "World Cup 2026"
      }));

    res.json({ success: true, data: knownMatches });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── GET dati partite correnti (pubblico, nessuna autenticazione) ──────
// Usato dal frontend al posto di CONFIG.MATCHES statico, e dall'oracolo
// al posto di MATCH_ID_MAPPING hardcoded.
app.get("/api/matches-data", (req, res) => {
  const data = readMatchesData();
  res.json({ success: true, data });
});

// ── POST aggiornamento dati partite (solo owner, verificato via firma) ─
// Body atteso: { message, signature, matches, matchIdMapping }
// "message" deve essere il testo esatto che è stato firmato dall'estensione UP.
app.post("/api/matches-data", async (req, res) => {
  const { message, signature, matches, matchIdMapping } = req.body;

  if (!message || !signature || !Array.isArray(matches) || typeof matchIdMapping !== "object") {
    return res.status(400).json({
      success: false,
      error: "Body non valido: servono message, signature, matches (array), matchIdMapping (oggetto)"
    });
  }

  // Anti-replay basilare: il messaggio deve contenere un timestamp recente
  // (entro 5 minuti), così una firma intercettata non può essere riusata
  // indefinitamente per richieste successive.
  const timestampMatch = message.match(/(\d{13})/); // timestamp in ms
  if (!timestampMatch) {
    return res.status(400).json({
      success: false,
      error: "Il messaggio firmato deve contenere un timestamp in millisecondi"
    });
  }
  const signedAt = parseInt(timestampMatch[1], 10);
  const ageMs = Date.now() - signedAt;
  if (ageMs > 5 * 60 * 1000 || ageMs < -60 * 1000) {
    return res.status(401).json({
      success: false,
      error: "Firma scaduta o con timestamp non valido. Riprova generando una nuova firma."
    });
  }

  const isValid = await verifyOwnerSignature(message, signature);
  if (!isValid) {
    return res.status(403).json({
      success: false,
      error: "Firma non valida o non autorizzata per questa Universal Profile"
    });
  }

  try {
    writeMatchesData({ matches, matchIdMapping });
    res.json({ success: true, message: "Dati partite aggiornati con successo" });
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
