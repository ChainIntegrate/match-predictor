# MatchPredictor

Esperimento: NFT collegati a risultati sportivi reali tramite un oracolo centralizzato, su LUKSO.

## Concetto

Un contratto smart non può "vedere" il mondo reale. Questo progetto implementa il pattern
più comune per risolvere il problema: un **oracolo centralizzato** — un semplice script
backend con una propria chiave privata, autorizzata a "riportare" un dato esterno (in questo
caso il risultato di una partita di calcio) al contratto.

```
football-data.org  →  oracle/reportResult.js  →  reportResult() on-chain  →  claim() possibile
   (dato reale)         (ponte/oracolo)            (smart contract)         (NFT premio)
```

## Flusso di gioco

1. **Owner** crea una partita: `createMatch(squadraCasa, squadraTrasferta, deadline)`
2. **Chiunque** pronostica prima della deadline: `predict(matchId, esito)`
   - esito: `1` = vittoria casa, `2` = pareggio, `3` = vittoria trasferta
3. La partita si gioca nel mondo reale
4. **Oracolo** (tu, via script) controlla il risultato reale e lo riporta: `reportResult(matchId, esitoReale)`
5. **Chi ha indovinato** rivendica il premio: `claim(matchId)` → riceve un NFT LSP8

## Setup

### 1. Installazione dipendenze

```bash
npm install
```

### 2. Configurazione

```bash
cp .env.example .env
```

Compila `.env` con:
- `DEPLOYER_PRIVATE_KEY` — chiave privata del wallet che farà il deploy (serve LYX per il gas)
- `OWNER_UP_ADDRESS` — la tua Universal Profile (proprietaria della collezione)
- `ORACLE_ADDRESS` — indirizzo pubblico di una EOA dedicata che farà da oracolo
  (genera una nuova coppia di chiavi solo per questo, non riusare un wallet esistente)
- `ORACLE_PRIVATE_KEY` — chiave privata di quella stessa EOA oracolo
- `FOOTBALL_DATA_API_KEY` — chiave gratuita da https://www.football-data.org/client/register

### 3. Compilazione e deploy

```bash
npm run compile
npm run deploy:testnet    # consigliato per i primi test
# oppure
npm run deploy:mainnet
```

Copia l'indirizzo del contratto deployato in `CONTRACT_ADDRESS` nel `.env`.

### 4. Creare una partita

Per ora va fatto via console Hardhat o un piccolo script (possiamo costruirlo insieme
quando arrivi a questo punto). La deadline va espressa come timestamp Unix (es. orario
del calcio d'inizio).

### 5. Trovare l'ID partita su football-data.org

Le competizioni gratuite nel tier free includono Serie A, Premier League, Champions League
e altre. Puoi cercare gli ID partita via:

```
GET https://api.football-data.org/v4/competitions/SA/matches
Header: X-Auth-Token: <tua_api_key>
```

(SA = Serie A; altri codici: PL = Premier League, CL = Champions League)

### 6. Eseguire l'oracolo dopo la partita

```bash
node oracle/reportResult.js <matchId_nel_tuo_contratto> <matchId_footballdata>
```

Lo script controlla se la partita è conclusa (`status: FINISHED`) e, se sì, riporta
il risultato on-chain. Se la lanci prima della fine, semplicemente non fa nulla.

## Note tecniche

- **Limiti API gratuita football-data.org**: 10 richieste/minuto, dati con qualche
  minuto di ritardo rispetto al live (va benissimo per un risultato finale già concluso).
- **Pattern owner/oracle**: stesso schema owner/admin già usato in Birra20VentiWelcome —
  l'owner (UP) gestisce la collezione, una EOA separata fa le operazioni tecniche.
- **Pronostici on-chain**: ogni `predict()` è una transazione e costa gas — è una scelta
  voluta per questo esperimento (massima trasparenza/verificabilità), non l'opzione più
  economica possibile.
- **Claim a richiesta**: il contratto non "spinge" l'NFT a chi vince — ogni vincitore deve
  chiamare `claim()` lui stesso. Questo evita di dover sapere in anticipo quanti vinceranno
  e tiene il gas a carico di chi riceve il beneficio.

## Prossimi passi possibili (non ancora implementati)

- Script helper per creare match e leggere lo stato senza usare la console Hardhat a mano
- Automazione dell'oracolo (cron job invece di lancio manuale)
- Metadata LSP4 per la collezione NFT (nome, immagine, descrizione)

## Frontend (`frontend/index.html`)

Pagina singola, nessuna build richiesta. Login tramite **Universal Profile Browser Extension**
(`window.lukso`), lettura del profilo (nome + immagine) via LSP3, pronostico e claim via ethers.js.

### Setup prima dell'uso

1. Apri `frontend/index.html` e modifica l'oggetto `CONFIG` in cima allo script:
   - `CONTRACT_ADDRESS`: indirizzo del contratto dopo il deploy
   - `CHAIN_ID_HEX`: `0x2A` per mainnet, `0x1069` per testnet
   - `MATCHES`: aggiorna `teamHome`/`teamAway` quando le squadre di semifinali/finale sono note
     (rimangono "TBD" finché non finiscono i quarti)
2. Serve l'estensione browser **Universal Profile** installata (da universalprofile.cloud)
3. Apri il file con un server locale qualsiasi (es. `python3 -m http.server`) — non aprirlo
   con `file://` perché i moduli ES non funzionano da filesystem locale in alcuni browser

### Dipendenze caricate da CDN (nessuna build necessaria)

- `ethers@6.13.4` via jsdelivr (`+esm`)
- `@erc725/erc725.js@0.28.4` via jsdelivr (`+esm`) — usato solo per leggere nome/immagine
  del profilo; se il caricamento fallisce per qualunque motivo, la pagina resta funzionante
  e mostra semplicemente l'indirizzo abbreviato invece del nome

### Note di design

- Pronostici e claim avvengono tramite l'estensione UP: il contratto Solidity non distingue
  tra una UP e una EOA normale (l'estensione gestisce il Key Manager "dietro le scene"),
  quindi nessuna modifica è stata necessaria al contratto.
- Se il match non esiste ancora on-chain, la card mostra comunque le info statiche da
  `CONFIG.MATCHES` (utile prima che tu abbia chiamato `createMatch`).

