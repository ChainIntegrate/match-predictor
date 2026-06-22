/**
 * Oracolo MatchPredictor
 * ----------------------
 * Script che fa da ponte tra il mondo reale (risultati calcio via football-data.org)
 * e il contratto MatchPredictor su LUKSO.
 *
 * Flusso:
 *   1. Interroga football-data.org per lo stato di una partita specifica
 *   2. Se la partita è conclusa (status FINISHED), traduce il risultato nell'enum del contratto
 *   3. Firma e invia la transazione reportResult() con la EOA oracolo
 *
 * Uso:
 *   node oracle/reportResult.js <matchId_contratto> <matchId_footballdata>
 *
 * Esempio:
 *   node oracle/reportResult.js 0 436125
 *   (0 = matchId nel TUO contratto, 436125 = id della partita su football-data.org)
 */

require("dotenv").config();
const { ethers } = require("ethers");
const fetch = require("node-fetch");

// --- Configurazione da .env ---
const RPC_URL = process.env.LUKSO_RPC_URL || "https://rpc.lukso.gateway.fm";
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS;
const ORACLE_PRIVATE_KEY = process.env.ORACLE_PRIVATE_KEY;
const FOOTBALL_DATA_API_KEY = process.env.FOOTBALL_DATA_API_KEY;

if (!CONTRACT_ADDRESS || !ORACLE_PRIVATE_KEY || !FOOTBALL_DATA_API_KEY) {
  console.error(
    "Errore: imposta CONTRACT_ADDRESS, ORACLE_PRIVATE_KEY e FOOTBALL_DATA_API_KEY nel file .env"
  );
  process.exit(1);
}

// ABI minimale: solo le funzioni che servono all'oracolo
const CONTRACT_ABI = [
  "function reportResult(uint256 matchId, uint8 actualResult) external",
  "function matches(uint256) external view returns (string teamHome, string teamAway, uint256 predictionDeadline, bool resolved, uint8 actualResult, bool exists)"
];

// Deve corrispondere esattamente all'enum Result nel contratto Solidity
const ResultEnum = {
  NONE: 0,
  HOME_WIN: 1,
  DRAW: 2,
  AWAY_WIN: 3
};

/**
 * Interroga football-data.org per lo stato/risultato di una partita.
 * Doc API: https://www.football-data.org/documentation/quickstart
 */
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

  const winner = data.score.winner; // "HOME_TEAM" | "AWAY_TEAM" | "DRAW"
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
  const [contractMatchId, footballDataMatchId] = process.argv.slice(2);

  if (!contractMatchId || !footballDataMatchId) {
    console.error(
      "Uso: node oracle/reportResult.js <matchId_contratto> <matchId_footballdata>"
    );
    process.exit(1);
  }

  console.log(`Controllo partita football-data.org #${footballDataMatchId}...`);
  const matchInfo = await fetchMatchResult(footballDataMatchId);

  if (!matchInfo.finished) {
    console.log(`Partita non ancora conclusa (status: ${matchInfo.status}). Nessuna azione.`);
    return;
  }

  console.log(
    `Risultato finale: ${matchInfo.homeTeam} ${matchInfo.score} ${matchInfo.awayTeam}`
  );
  console.log(`Mappato su enum contratto: ${matchInfo.result}`);

  // --- Connessione a LUKSO e invio transazione ---
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const oracleWallet = new ethers.Wallet(ORACLE_PRIVATE_KEY, provider);
  const contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, oracleWallet);

  // Verifica che il match esista e non sia già risolto, per evitare di sprecare gas
  const onChainMatch = await contract.matches(contractMatchId);
  if (!onChainMatch.exists) {
    console.error(`Errore: il match #${contractMatchId} non esiste sul contratto.`);
    process.exit(1);
  }
  if (onChainMatch.resolved) {
    console.log(`Il match #${contractMatchId} è già stato risolto on-chain. Nessuna azione.`);
    return;
  }

  console.log("Invio transazione reportResult() on-chain...");
  const tx = await contract.reportResult(contractMatchId, matchInfo.result);
  console.log(`Transazione inviata: ${tx.hash}`);

  const receipt = await tx.wait();
  console.log(`✅ Confermata nel blocco ${receipt.blockNumber}`);
}

main().catch((error) => {
  console.error("Errore oracolo:", error.message);
  process.exitCode = 1;
});
