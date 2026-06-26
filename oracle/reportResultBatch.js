/**
 * Oracolo MatchPredictor
 * ----------------------
 * Script che fa da ponte tra il mondo reale (risultati calcio via football-data.org)
 * e il contratto MatchPredictor su LUKSO.
 *
 * A differenza della versione precedente, il mapping matchId -> footballDataMatchId
 * NON è più hardcoded in questo file: viene letto dinamicamente da matches-data.json
 * (lo stesso file che il pannello admin aggiorna tramite firma owner, senza accesso VPS).
 * Questo significa che ogni volta che l'owner importa/salva nuove partite dal sito,
 * questo script le conosce automaticamente al prossimo lancio, senza modifiche manuali.
 *
 * Pensato per essere lanciato periodicamente da un cron job (vedi README/crontab),
 * così i risultati appaiono sul sito senza bisogno di accesso VPS per eseguirlo.
 *
 * Uso:
 *   node oracle/reportResultBatch.js
 */

require("dotenv").config();
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

const RPC_URL = process.env.LUKSO_RPC_URL || "https://rpc.testnet.lukso.network";
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS;
const ORACLE_PRIVATE_KEY = process.env.ORACLE_PRIVATE_KEY;
const FOOTBALL_DATA_API_KEY = process.env.FOOTBALL_DATA_API_KEY;

// Path del file dati condiviso, scritto dal backend (server.js) quando
// l'owner clicca "Save matches data to server" nel pannello admin.
const MATCHES_DATA_PATH = path.join(__dirname, "..", "backend", "matches-data.json");

if (!CONTRACT_ADDRESS || !ORACLE_PRIVATE_KEY || !FOOTBALL_DATA_API_KEY) {
  console.error("Errore: imposta CONTRACT_ADDRESS, ORACLE_PRIVATE_KEY e FOOTBALL_DATA_API_KEY nel file .env");
  process.exit(1);
}

const CONTRACT_ABI = [
  "function nextMatchId() external view returns (uint256)",
  "function matches(uint256) external view returns (string teamHome, string teamAway, uint256 predictionDeadline, bool resolved, uint8 actualResult, bool exists)",
  "function reportResult(uint256 matchId, uint8 actualResult) external"
];

const ResultEnum = { NONE: 0, HOME_WIN: 1, DRAW: 2, AWAY_WIN: 3 };

// Tier gratuito football-data.org: max 10 richieste/minuto.
// Una pausa di 7s tra le chiamate tiene il ritmo a ~8.5/minuto,
// con margine di sicurezza anche se il cron job si sovrappone
// a un'esecuzione precedente ancora in corso.
const DELAY_BETWEEN_CALLS_MS = 7000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadMatchIdMapping() {
  if (!fs.existsSync(MATCHES_DATA_PATH)) {
    console.error(`Errore: ${MATCHES_DATA_PATH} non trovato. Salva almeno una volta i dati dal pannello admin.`);
    process.exit(1);
  }
  const raw = fs.readFileSync(MATCHES_DATA_PATH, "utf8");
  const data = JSON.parse(raw);
  return data.matchIdMapping || {};
}

async function fetchMatchResult(footballDataMatchId) {
  const url = `https://api.football-data.org/v4/matches/${footballDataMatchId}`;
  const response = await fetch(url, {
    headers: { "X-Auth-Token": FOOTBALL_DATA_API_KEY }
  });

  if (!response.ok) {
    throw new Error(`football-data.org ha risposto con status ${response.status}`);
  }

  const data = await response.json();

  if (data.status !== "FINISHED") {
    return { finished: false, status: data.status };
  }

  const winner = data.score.winner;
  let result;
  if (winner === "HOME_TEAM") result = ResultEnum.HOME_WIN;
  else if (winner === "AWAY_TEAM") result = ResultEnum.AWAY_WIN;
  else if (winner === "DRAW") result = ResultEnum.DRAW;
  else throw new Error(`Esito non riconosciuto da football-data.org: ${winner}`);

  return {
    finished: true,
    result,
    homeTeam: data.homeTeam.name,
    awayTeam: data.awayTeam.name,
    score: `${data.score.fullTime.home}-${data.score.fullTime.away}`
  };
}

async function main() {
  const matchIdMapping = loadMatchIdMapping();
  console.log(`Mapping caricato da matches-data.json: ${Object.keys(matchIdMapping).length} partite conosciute.`);

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const oracleWallet = new ethers.Wallet(ORACLE_PRIVATE_KEY, provider);
  const contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, oracleWallet);

  const nextMatchId = await contract.nextMatchId();
  console.log(`Totale match sul contratto: ${nextMatchId} (id 0 a ${Number(nextMatchId) - 1})`);

  let isFirstCall = true;

  for (let matchId = 0; matchId < Number(nextMatchId); matchId++) {
    const onChainMatch = await contract.matches(matchId);

    if (!onChainMatch.exists) {
      continue;
    }

    if (onChainMatch.resolved) {
      console.log(`Match #${matchId} (${onChainMatch.teamHome} vs ${onChainMatch.teamAway}): già risolto, salto.`);
      continue;
    }

    const footballDataId = matchIdMapping[String(matchId)];
    if (!footballDataId) {
      console.log(`Match #${matchId} (${onChainMatch.teamHome} vs ${onChainMatch.teamAway}): nessun mapping football-data.org configurato, salto.`);
      continue;
    }

    if (!isFirstCall) {
      await sleep(DELAY_BETWEEN_CALLS_MS);
    }
    isFirstCall = false;

    console.log(`Match #${matchId} (${onChainMatch.teamHome} vs ${onChainMatch.teamAway}): controllo football-data.org #${footballDataId}...`);

    try {
      const matchInfo = await fetchMatchResult(footballDataId);

      if (!matchInfo.finished) {
        console.log(`  -> Non ancora conclusa (status: ${matchInfo.status}).`);
        continue;
      }

      console.log(`  -> Risultato finale: ${matchInfo.homeTeam} ${matchInfo.score} ${matchInfo.awayTeam}`);

      const tx = await contract.reportResult(matchId, matchInfo.result);
      console.log(`  -> Transazione inviata: ${tx.hash}`);

      const receipt = await tx.wait();
      console.log(`  -> ✅ Confermata nel blocco ${receipt.blockNumber}`);
    } catch (err) {
      console.error(`  -> Errore per match #${matchId}: ${err.message}`);
    }
  }

  console.log("Ciclo completato.");
}

main().catch((error) => {
  console.error("Errore generale:", error.message);
  process.exitCode = 1;
});