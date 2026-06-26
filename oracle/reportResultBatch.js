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

const RPC_URL = process.env.LUKSO_RPC_URL || "https://rpc.testnet.lukso.network";
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS;
const ORACLE_PRIVATE_KEY = process.env.ORACLE_PRIVATE_KEY;
const FOOTBALL_DATA_API_KEY = process.env.FOOTBALL_DATA_API_KEY;

if (!CONTRACT_ADDRESS || !ORACLE_PRIVATE_KEY || !FOOTBALL_DATA_API_KEY) {
  console.error("Errore: imposta CONTRACT_ADDRESS, ORACLE_PRIVATE_KEY e FOOTBALL_DATA_API_KEY nel file .env");
  process.exit(1);
}

const MATCH_ID_MAPPING = {
  1: 537337,
  2: 537344,
  3: 537343,
  4: 537331,
  5: 537332,
  6: 537355,
  7: 537356,
  8: 537361,
  9: 537362,
  10: 537349,
  11: 537350,
  12: 537395,
  13: 537396,
  14: 537373,
  15: 537374,
  16: 537367,
  17: 537368,
  18: 537413,
  19: 537414,
  20: 537407,
  21: 537408,
  22: 537401,
  23: 537402
};

const CONTRACT_ABI = [
  "function nextMatchId() external view returns (uint256)",
  "function matches(uint256) external view returns (string teamHome, string teamAway, uint256 predictionDeadline, bool resolved, uint8 actualResult, bool exists)",
  "function reportResult(uint256 matchId, uint8 actualResult) external"
];

const ResultEnum = { NONE: 0, HOME_WIN: 1, DRAW: 2, AWAY_WIN: 3 };

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
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const oracleWallet = new ethers.Wallet(ORACLE_PRIVATE_KEY, provider);
  const contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, oracleWallet);

  const nextMatchId = await contract.nextMatchId();
  console.log(`Totale match sul contratto: ${nextMatchId} (id 0 a ${Number(nextMatchId) - 1})`);

  for (let matchId = 0; matchId < Number(nextMatchId); matchId++) {
    const onChainMatch = await contract.matches(matchId);

    if (!onChainMatch.exists) {
      continue;
    }

    if (onChainMatch.resolved) {
      console.log(`Match #${matchId} (${onChainMatch.teamHome} vs ${onChainMatch.teamAway}): già risolto, salto.`);
      continue;
    }

    const footballDataId = MATCH_ID_MAPPING[matchId];
    if (!footballDataId) {
      console.log(`Match #${matchId} (${onChainMatch.teamHome} vs ${onChainMatch.teamAway}): nessun mapping football-data.org configurato, salto.`);
      continue;
    }

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