require('dotenv').config();
const { ClobClient, Side, OrderType } = require('@polymarket/clob-client-v2');
const { ethers } = require('ethers');
const axios = require('axios');

// ====================================================================
// CONFIGURAZIONE VARIABILI AMBIENTE
// ====================================================================
const CONFIG = {
  PRIVATE_KEY: process.env.PRIVATE_KEY || '',
  FUNDER_ADDRESS: process.env.FUNDER_ADDRESS || '',
  POLYMARKET_API_KEY: process.env.POLYMARKET_API_KEY || '',
  POLYMARKET_API_SECRET: process.env.POLYMARKET_API_SECRET || '',
  POLYMARKET_API_PASSPHRASE: process.env.POLYMARKET_API_PASSPHRASE || '',
  POLYGON_RPC: process.env.POLYGON_RPC || 'https://polygon-rpc.com',
  
  // IMPOSTAZIONI STRATEGIA
  SEARCH_KEYWORD: 'Crypto',    
  KELLY_MULT: 0.5,             
  MAX_POSITION_SIZE: 15.00,    
  MAX_PRICE_LIMIT: 0.85,       
  MIN_PRICE_LIMIT: 0.15,       
  POLLING_INTERVAL_MS: 6000,   
  ENABLE_REAL_TRADES: process.env.ENABLE_REAL_TRADES === 'true' || false 
};

// Validazione credenziali
if (!CONFIG.PRIVATE_KEY) {
  console.error('❌ ERRORE: PRIVATE_KEY non configurato in .env');
  process.exit(1);
}

function log(level, message) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [${level}] ${message}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ====================================================================
// CLASSE CORE POLYMARKET CLIENT V2
// ====================================================================
class PolymarketClient {
  constructor(walletInstance) {
    const credentials = {
      key: CONFIG.POLYMARKET_API_KEY,
      secret: CONFIG.POLYMARKET_API_SECRET,
      passphrase: CONFIG.POLYMARKET_API_PASSPHRASE
    };

    this.sdkClient = new ClobClient({
      host: 'https://polymarket.com',
      chain: 137, 
      signer: walletInstance,
      signatureType: 3, 
      funderAddress: CONFIG.FUNDER_ADDRESS,
      creds: credentials
    });
    
    this.authenticated = false;
  }

  async authenticate() {
    try {
      const ok = await this.sdkClient.getOk();
      if (ok === 'OK' || ok) {
        this.authenticated = true;
        log('INFO', 'Polymarket API L2 autenticata con successo via SDK V2');
        return true;
      }
      return false;
    } catch (e) {
      log('ERROR', `Autenticazione Polymarket fallita: ${e.message}`);
      return false;
    }
  }

  async getTradingBalance() {
    try {
      const balanceData = await this.sdkClient.getBalanceAllowance({ asset_type: 'COLLATERAL' });
      const rawBalance = parseFloat(balanceData.balance || 0);
      return rawBalance / 1000000; 
    } catch (e) {
      log('ERROR', `Errore lettura saldo USD: ${e.message}`);
      return 0;
    }
  }

  async getMarketPosition(marketId) {
    try {
      const balanceData = await this.sdkClient.getBalanceAllowance({ asset_type: 'CONDITIONAL', token_id: marketId });
      const rawBalance = parseFloat(balanceData.balance || 0);
      return rawBalance / 1000000; 
    } catch (e) {
      log('ERROR', `Errore lettura posizione token ${marketId}: ${e.message}`);
      return 0;
    }
  }

  async getMarketOrderBook(marketId) {
    try {
      return await this.sdkClient.getOrderBook({ tokenID: marketId });
    } catch (e) {
      log('ERROR', `Errore recupero Orderbook per ${marketId}: ${e.message}`);
      return null;
    }
  }

  async placeRealOrder(marketId, side, amount, price) {
    if (!CONFIG.ENABLE_REAL_TRADES) {
      log('SIMULATE', `Ordine SIMULATO: ${side} ${amount.toFixed(2)} quote a $${price.toFixed(2)}`);
      return { simulated: true, status: 'SIMULATED' };
    }
    try {
      const response = await this.sdkClient.createAndPostOrder(
        {
          tokenID: marketId,
          price: parseFloat(price.toFixed(2)),  
          size: parseFloat(amount.toFixed(2)),   
          side: side.toUpperCase() === 'BUY' ? Side.BUY : Side.SELL
        },
        { tickSize: '0.01', negRisk: false },
        OrderType.GTC 
      );

      log('TRADE', `Ordine INVIATO! ID: ${response.orderID || response.id} - Status: ${response.status}`);
      return {
        status: 'PLACED',
        orderId: response.orderID || response.id,
        amount,
        side,
        raw: response
      };
    } catch (e) {
      log('WARN', `Esecuzione ordine fallita: ${e.message}`);
      return { status: 'FAILED', error: e.message };
    }
  }

  async cancelAllOrders() {
    try {
      await this.sdkClient.cancelAll();
      log('TRADE', 'Tutti gli ordini pendenti sul conto sono stati rimossi.');
      return true;
    } catch (e) {
      log('ERROR', `Errore reset ordini: ${e.message}`);
      return false;
    }
  }
}

// ====================================================================
// FUNZIONI DI CALCOLO MATEMATICO E SIMULAZIONE KELLY
// ====================================================================
function calculateKellySize(edge, bankroll) {
  if (edge <= 0) return 0;
  const p = (50 + edge) / 100;
  const kelly = Math.max(0, 2 * p - 1);
  const size = bankroll * kelly * CONFIG.KELLY_MULT;
  return Math.min(size, CONFIG.MAX_POSITION_SIZE);
}

function simulateTrade(edge, size) {
  const p = (50 + edge) / 100;
  const roll = Math.random();
  const won = roll < p;
  const pnl = won ? size * (edge / 100) : -size * 0.5;
  return { won, pnl };
}

// ====================================================================
// RICERCA ED ESTRAZIONE STRATEGICA DEI MERCATI (API CORRETTA)
// ====================================================================
async function generateSignals() {
  try {
    // ✅ FIX: API endpoint corretto
    const url = `https://polymarket.com/api/markets?search=${encodeURIComponent(CONFIG.SEARCH_KEYWORD)}&active=true&order=volume&limit=5`;
    
    log('FETCH', `Richiesta API: ${url}`);
    
    const response = await axios.get(url, {
      timeout: 10000,
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'PolymarketBot/1.0'
      }
    });
    
    if (!response.data || response.data.length === 0) {
      log('SIGNAL', `Nessun mercato attivo rilevato per il trend: ${CONFIG.SEARCH_KEYWORD}`);
      return [];
    }

    const marketSignals = [];

    for (const event of response.data) {
      try {
        if (event.markets && Array.isArray(event.markets) && event.markets.length > 0) {
          const market = event.markets[0]; 
          
          if (market.clobTokenIds) {
            const tokenIds = typeof market.clobTokenIds === 'string' 
              ? JSON.parse(market.clobTokenIds) 
              : market.clobTokenIds;
            
            if (tokenIds && tokenIds.length > 0) {
              const volumeScore = parseFloat(market.volume || 1000);
              const edgeBase = volumeScore > 50000 ? 8.5 : 5.5;

              marketSignals.push({
                tokenID: tokenIds[0], 
                marketName: market.question || event.title,
                edge: edgeBase,
                winRate: 0.50 + (edgeBase / 100)
              });
              
              log('SIGNAL', `✅ Mercato trovato: "${market.question || event.title}"`);
            }
          }
        }
      } catch (itemError) {
        log('WARN', `Errore processamento mercato: ${itemError.message}`);
        continue;
      }
    }

    log('SIGNAL', `Scansione completata. Generati ${marketSignals.length} mercati target.`);
    return marketSignals;
  } catch (e) {
    log('ERROR', `Errore scansione API Polymarket: ${e.message}`);
    
    // Fallback: mercati sintetici
    log('FALLBACK', 'Utilizzo mercati sintetici...');
    return [
      {
        tokenID: 'synthetic-1',
        marketName: 'Bitcoin Above $100k',
        edge: 7.5,
        winRate: 0.575
      }
    ];
  }
}

// ====================================================================
// MOTORE OPERATIVO DI ASSET ANALYSIS ED EXECUTION
// ====================================================================
async function monitorAndTrade(bot) {
  const activeMarkets = await generateSignals();
  if (activeMarkets.length === 0) {
    log('STRATEGY', 'Nessun segnale operativo generato in questo ciclo.');
    return;
  }

  const targetMarket = activeMarkets[0]; 
  log('ANALYTICS', `Market Target: "${targetMarket.marketName}"`);
  log('ANALYTICS', `Token ID: ${targetMarket.tokenID.substring(0, 12)}... | Vantaggio Edge: ${targetMarket.edge}%`);

  const currentBalanceUSD = await bot.getTradingBalance();
  log('ANALYTICS', `Saldo Attuale Disponibile: $${currentBalanceUSD.toFixed(2)}`);

  const tradeSizeUSD = calculateKellySize(targetMarket.edge, currentBalanceUSD);
  log('STRATEGY', `Kelly Size Calcolata per il piazzamento: $${tradeSizeUSD.toFixed(2)}`);

  if (tradeSizeUSD <= 0 || currentBalanceUSD < tradeSizeUSD) {
    log('STRATEGY', 'Kelly Size troppo bassa o bilancio insufficiente. Operazione bypassata.');
    return;
  }

  try {
    const orderbook = await bot.getMarketOrderBook(targetMarket.tokenID);
    if (orderbook && orderbook.asks && orderbook.asks.length > 0) {
      
      const bestAsk = parseFloat(orderbook.asks[0].price); 
      const bestBid = orderbook.bids && orderbook.bids.length > 0 ? parseFloat(orderbook.bids[0].price) : 0.01; 
      const marketSpread = bestAsk - bestBid;

      log('ANALYTICS', `Orderbook -> Best Bid: $${bestBid} | Best Ask: $${bestAsk} | Spread: $${marketSpread.toFixed(2)}`);

      if (bestAsk >= CONFIG.MIN_PRICE_LIMIT && bestAsk <= CONFIG.MAX_PRICE_LIMIT) {
        const targetShares = tradeSizeUSD / bestAsk;

        const simulation = simulateTrade(targetMarket.edge, tradeSizeUSD);
        log('SIMULATE', `Simulazione Matematica -> Esito Vincente? ${simulation.won ? 'SÌ' : 'NO'} | Rendimento Atteso: $${simulation.pnl.toFixed(2)}`);

        await bot.placeRealOrder(targetMarket.tokenID, 'BUY', targetShares, bestAsk);
      } else {
        log('STRATEGY', `Prezzo Ask attuale ($${bestAsk}) fuori dai parametri di sicurezza. Ordine rifiutato.`);
      }
    } else {
      log('STRATEGY', 'L\'Orderbook del mercato non restituisce liquidità sufficiente.');
    }
  } catch (err) {
    log('ERROR', `Eccezione riscontrata durante l'analisi del book: ${err.message}`);
  }
}

// ====================================================================
// AVVIATORE PRINCIPALE (MAIN ENGINE)
// ====================================================================
async function main() {
  log('SYSTEM', 'Avvio del motore di trading Polymarket...');

  // ✅ FIX: ethers v6 syntax
  const provider = new ethers.JsonRpcProvider(CONFIG.POLYGON_RPC);
  const wallet = new ethers.Wallet(CONFIG.PRIVATE_KEY, provider);
  log('SYSTEM', `Wallet caricato. Indirizzo pubblico EOA: ${wallet.address}`);

  const bot = new PolymarketClient(wallet);

  const isAuth = await bot.authenticate();
  if (!isAuth) {
    log('CRITICAL', 'Bot arrestato. Impossibile autenticare le credenziali L2 sulla CLOB.');
    process.exit(1);
  }

  await bot.cancelAllOrders();

  log('SYSTEM', 'Inizio del loop infinito di trading.');
  let cycleCount = 0;
  
  while (true) {
    try {
      cycleCount++;
      log('CYCLE', `=== Ciclo #${cycleCount} ===`);
      await monitorAndTrade(bot);
    } catch (cycleError) {
      log('ERROR', `Errore isolato rilevato nel ciclo principale: ${cycleError.message}`);
    }
    await sleep(CONFIG.POLLING_INTERVAL_MS);
  }
}

main().catch((err) => {
  log('CRITICAL', `Errore irreversibile del processo: ${err.message}`);
  process.exit(1);
});
