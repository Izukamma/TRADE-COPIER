//+------------------------------------------------------------------+
//| GabrielCopierBridge.mq5                                          |
//| Gabriel Trade Copier — MetaTrader 5 bridge Expert Advisor        |
//|                                                                  |
//| Role: reports account/positions/orders/quotes/specs to the       |
//| copier engine and executes the engine's deterministic commands.  |
//| It never decides to trade on its own.                            |
//|                                                                  |
//| Security: the MT5 login stays in the terminal. The EA signs      |
//| every request with a revocable device token (HMAC-SHA256) and    |
//| verifies the engine's signed responses. Use HTTPS.               |
//|                                                                  |
//| STATUS: source provided; NOT compiled or run in the development  |
//| environment. Compile in MetaEditor and test on a demo account.   |
//+------------------------------------------------------------------+
#property copyright "Gabriel Trade Copier"
#property version   "0.10"
#property description "Bridge between this MT5 terminal and the Gabriel Trade Copier engine."

#include <Trade/Trade.mqh>

input string InpBridgeUrl      = "https://copier.example.com"; // Engine base URL (must be in WebRequest allow list)
input string InpDeviceToken    = "";                           // Device token gtcd_<id>_<secret> from the dashboard
input int    InpPollMs         = 300;                          // Sync interval (ms)
input long   InpMagic          = 7710001;                      // Magic number for copier orders (must match engine)
input int    InpDeviationPts   = 30;                           // Max slippage for market orders (points)
input int    InpHttpTimeoutMs  = 5000;                         // HTTP timeout (ms)
input bool   InpVerbose        = false;                        // Extra logging (never logs the token)

#define GTC_PATH      "/bridge/v1/sync"
#define GTC_VERSION   "mt5-0.10"
#define MAX_DONE      500

string   g_tokenId  = "";
string   g_secret   = "";
string   g_results[];            // serialized command results awaiting acknowledgement
string   g_done[];               // command ids already executed (dedup across redeliveries)
string   g_watch[];              // symbols the engine wants quotes/specs for
bool     g_sendSymbols = true;
ulong    g_nonceCounter = 0;
datetime g_lastWarn = 0;

//+------------------------------------------------------------------+
//| Minimal JSON reader (objects, arrays, strings, numbers, bools)   |
//+------------------------------------------------------------------+
enum JType { J_NULL, J_BOOL, J_NUM, J_STR, J_ARR, J_OBJ };

class JNode
  {
public:
   JType             type;
   string            str;
   double            num;
   bool              b;
   string            keys[];
   JNode            *items[];
                     JNode(void) { type = J_NULL; num = 0; b = false; }
                    ~JNode(void) { for(int i = 0; i < ArraySize(items); i++) if(CheckPointer(items[i]) == POINTER_DYNAMIC) delete items[i]; }
   void              Add(string k, JNode *n) { int s = ArraySize(items); ArrayResize(items, s + 1); ArrayResize(keys, s + 1); items[s] = n; keys[s] = k; }
   JNode            *Get(string k) { for(int i = 0; i < ArraySize(keys); i++) if(keys[i] == k) return items[i]; return NULL; }
   int               Size(void) { return ArraySize(items); }
   JNode            *At(int i) { return (i >= 0 && i < ArraySize(items)) ? items[i] : NULL; }
   string            S(string k) { JNode *n = Get(k); return n == NULL ? "" : (n.type == J_STR ? n.str : (n.type == J_NUM ? DoubleToString(n.num, 8) : "")); }
   double            N(string k) { JNode *n = Get(k); return n == NULL ? 0 : (n.type == J_NUM ? n.num : (n.type == J_STR ? StringToDouble(n.str) : 0)); }
   bool              B(string k) { JNode *n = Get(k); return n != NULL && n.type == J_BOOL && n.b; }
  };

class JParser
  {
private:
   string            s;
   int               i;
   int               n;
   void              Ws(void) { while(i < n) { ushort c = StringGetCharacter(s, i); if(c == ' ' || c == '\t' || c == '\n' || c == '\r') i++; else break; } }
   string            ParseString(void)
     {
      string out = "";
      i++; // opening quote
      while(i < n)
        {
         ushort c = StringGetCharacter(s, i);
         if(c == '"') { i++; return out; }
         if(c == '\\' && i + 1 < n)
           {
            ushort e = StringGetCharacter(s, i + 1);
            if(e == 'n') out += "\n";
            else if(e == 't') out += "\t";
            else if(e == 'r') out += "\r";
            else if(e == 'u' && i + 5 < n) { out += ShortToString((ushort)StringToInteger("0x" + StringSubstr(s, i + 2, 4))); i += 4; }
            else out += ShortToString(e);
            i += 2;
            continue;
           }
         out += ShortToString(c);
         i++;
        }
      return out;
     }
public:
   JNode            *Parse(string text) { s = text; i = 0; n = StringLen(s); return Value(); }
   JNode            *Value(void)
     {
      Ws();
      if(i >= n) return NULL;
      ushort c = StringGetCharacter(s, i);
      JNode *node = new JNode();
      if(c == '{')
        {
         node.type = J_OBJ; i++; Ws();
         if(i < n && StringGetCharacter(s, i) == '}') { i++; return node; }
         while(i < n)
           {
            Ws();
            if(StringGetCharacter(s, i) != '"') { delete node; return NULL; }
            string k = ParseString(); Ws();
            if(i >= n || StringGetCharacter(s, i) != ':') { delete node; return NULL; }
            i++;
            JNode *v = Value();
            if(v == NULL) { delete node; return NULL; }
            node.Add(k, v); Ws();
            if(i < n && StringGetCharacter(s, i) == ',') { i++; continue; }
            if(i < n && StringGetCharacter(s, i) == '}') { i++; return node; }
            delete node; return NULL;
           }
        }
      else if(c == '[')
        {
         node.type = J_ARR; i++; Ws();
         if(i < n && StringGetCharacter(s, i) == ']') { i++; return node; }
         while(i < n)
           {
            JNode *v = Value();
            if(v == NULL) { delete node; return NULL; }
            node.Add("", v); Ws();
            if(i < n && StringGetCharacter(s, i) == ',') { i++; continue; }
            if(i < n && StringGetCharacter(s, i) == ']') { i++; return node; }
            delete node; return NULL;
           }
        }
      else if(c == '"') { node.type = J_STR; node.str = ParseString(); return node; }
      else if(StringSubstr(s, i, 4) == "true") { node.type = J_BOOL; node.b = true; i += 4; return node; }
      else if(StringSubstr(s, i, 5) == "false") { node.type = J_BOOL; node.b = false; i += 5; return node; }
      else if(StringSubstr(s, i, 4) == "null") { node.type = J_NULL; i += 4; return node; }
      else
        {
         int st = i;
         while(i < n) { ushort d = StringGetCharacter(s, i); if((d >= '0' && d <= '9') || d == '-' || d == '+' || d == '.' || d == 'e' || d == 'E') i++; else break; }
         node.type = J_NUM; node.num = StringToDouble(StringSubstr(s, st, i - st));
         return node;
        }
      delete node;
      return NULL;
     }
  };

//+------------------------------------------------------------------+
//| JSON writing helpers                                             |
//+------------------------------------------------------------------+
string JEsc(string v)
  {
   string o = "";
   int len = StringLen(v);
   for(int k = 0; k < len; k++)
     {
      ushort c = StringGetCharacter(v, k);
      if(c == '"') o += "\\\"";
      else if(c == '\\') o += "\\\\";
      else if(c == '\n') o += "\\n";
      else if(c == '\r') o += "\\r";
      else if(c == '\t') o += "\\t";
      else if(c < 0x20) o += StringFormat("\\u%04x", c);
      else o += ShortToString(c);
     }
   return o;
  }
string JStr(string v) { return "\"" + JEsc(v) + "\""; }
string JNum(double v, int digits = 8)
  {
   string s = DoubleToString(v, digits);
   if(StringFind(s, ".") >= 0)
     {
      while(StringLen(s) > 1 && StringGetCharacter(s, StringLen(s) - 1) == '0') s = StringSubstr(s, 0, StringLen(s) - 1);
      if(StringGetCharacter(s, StringLen(s) - 1) == '.') s = StringSubstr(s, 0, StringLen(s) - 1);
     }
   return s;
  }
string JNumOrNull(double v, int digits) { return v > 0 ? JNum(v, digits) : "null"; }
string JBool(bool v) { return v ? "true" : "false"; }

//+------------------------------------------------------------------+
//| Crypto: SHA-256 and HMAC-SHA256                                  |
//+------------------------------------------------------------------+
void Utf8(string text, uchar &out[])
  {
   int n = StringToCharArray(text, out, 0, WHOLE_ARRAY, CP_UTF8);
   if(n > 0 && out[n - 1] == 0) ArrayResize(out, n - 1); // drop terminator
  }
void Sha256(const uchar &data[], uchar &out[])
  {
   uchar key[];
   ArrayResize(key, 0);
   CryptEncode(CRYPT_HASH_SHA256, data, key, out);
  }
string Hex(const uchar &b[])
  {
   string h = "";
   for(int k = 0; k < ArraySize(b); k++) h += StringFormat("%02x", b[k]);
   return h;
  }
string Sha256Hex(string text) { uchar d[], o[]; Utf8(text, d); Sha256(d, o); return Hex(o); }
string HmacHex(string secret, string message)
  {
   uchar key[], msg[], k0[64], ipad[], opad[], inner[], outer[];
   Utf8(secret, key);
   Utf8(message, msg);
   if(ArraySize(key) > 64) { uchar hk[]; Sha256(key, hk); ArrayCopy(key, hk); ArrayResize(key, ArraySize(hk)); }
   ArrayInitialize(k0, 0);
   for(int k = 0; k < ArraySize(key); k++) k0[k] = key[k];
   ArrayResize(ipad, 64 + ArraySize(msg));
   ArrayResize(opad, 64 + 32);
   for(int k = 0; k < 64; k++) { ipad[k] = (uchar)(k0[k] ^ 0x36); opad[k] = (uchar)(k0[k] ^ 0x5c); }
   for(int k = 0; k < ArraySize(msg); k++) ipad[64 + k] = msg[k];
   Sha256(ipad, inner);
   for(int k = 0; k < 32; k++) opad[64 + k] = inner[k];
   Sha256(opad, outer);
   return Hex(outer);
  }
string Nonce()
  {
   g_nonceCounter++;
   string seed = StringFormat("%I64u-%I64u-%d-%d-%I64u", GetMicrosecondCount(), (ulong)TimeLocal(), MathRand(), MathRand(), g_nonceCounter);
   return StringSubstr(Sha256Hex(seed + g_secret), 0, 32);
  }

//+------------------------------------------------------------------+
//| Helpers                                                          |
//+------------------------------------------------------------------+
long ServerOffsetSec() { return (long)(TimeTradeServer() - TimeGMT()); }
long NowUtcMs() { return (long)TimeGMT() * 1000 + (long)(GetTickCount() % 1000); }
long ServerMscToUtcMs(long msc) { return msc - ServerOffsetSec() * 1000; }

bool InArray(string &arr[], string v) { for(int k = 0; k < ArraySize(arr); k++) if(arr[k] == v) return true; return false; }
void Push(string &arr[], string v) { int s = ArraySize(arr); ArrayResize(arr, s + 1); arr[s] = v; }

string DoneFile() { return StringFormat("GTC_%I64d_done.txt", AccountInfoInteger(ACCOUNT_LOGIN)); }
void LoadDone()
  {
   int h = FileOpen(DoneFile(), FILE_READ | FILE_TXT | FILE_ANSI);
   if(h == INVALID_HANDLE) return;
   while(!FileIsEnding(h)) { string l = FileReadString(h); if(l != "") Push(g_done, l); }
   FileClose(h);
   int extra = ArraySize(g_done) - MAX_DONE;
   if(extra > 0) ArrayRemove(g_done, 0, extra);
  }
void MarkDone(string id)
  {
   Push(g_done, id);
   if(ArraySize(g_done) > MAX_DONE) ArrayRemove(g_done, 0, ArraySize(g_done) - MAX_DONE);
   int h = FileOpen(DoneFile(), FILE_READ | FILE_WRITE | FILE_TXT | FILE_ANSI);
   if(h == INVALID_HANDLE) return;
   FileSeek(h, 0, SEEK_END);
   FileWriteString(h, id + "\n");
   FileClose(h);
  }

bool ParseToken(string tok)
  {
   // gtcd_<16 hex>_<43 base64url>
   if(StringSubstr(tok, 0, 5) != "gtcd_" || StringLen(tok) != 5 + 16 + 1 + 43) return false;
   g_tokenId = StringSubstr(tok, 5, 16);
   if(StringSubstr(tok, 21, 1) != "_") return false;
   g_secret = StringSubstr(tok, 22, 43);
   return true;
  }

ENUM_ORDER_TYPE_FILLING Filling(string sym)
  {
   long fm = SymbolInfoInteger(sym, SYMBOL_FILLING_MODE);
   if((fm & SYMBOL_FILLING_FOK) == SYMBOL_FILLING_FOK) return ORDER_FILLING_FOK;
   if((fm & SYMBOL_FILLING_IOC) == SYMBOL_FILLING_IOC) return ORDER_FILLING_IOC;
   return ORDER_FILLING_RETURN;
  }

//+------------------------------------------------------------------+
//| Snapshot serialisation                                           |
//+------------------------------------------------------------------+
string PositionsJson()
  {
   string out = "";
   int total = PositionsTotal();
   for(int k = 0; k < total; k++)
     {
      ulong t = PositionGetTicket(k);
      if(t == 0 || !PositionSelectByTicket(t)) continue;
      string sym = PositionGetString(POSITION_SYMBOL);
      int dg = (int)SymbolInfoInteger(sym, SYMBOL_DIGITS);
      long type = PositionGetInteger(POSITION_TYPE);
      if(out != "") out += ",";
      out += "{\"ticket\":" + JStr(IntegerToString((long)t)) +
             ",\"symbol\":" + JStr(sym) +
             ",\"side\":" + JStr(type == POSITION_TYPE_BUY ? "BUY" : "SELL") +
             ",\"volume\":" + JNum(PositionGetDouble(POSITION_VOLUME)) +
             ",\"openPrice\":" + JNum(PositionGetDouble(POSITION_PRICE_OPEN), dg) +
             ",\"openTime\":" + IntegerToString(ServerMscToUtcMs(PositionGetInteger(POSITION_TIME_MSC))) +
             ",\"sl\":" + JNumOrNull(PositionGetDouble(POSITION_SL), dg) +
             ",\"tp\":" + JNumOrNull(PositionGetDouble(POSITION_TP), dg) +
             ",\"comment\":" + JStr(StringSubstr(PositionGetString(POSITION_COMMENT), 0, 64)) +
             ",\"magic\":" + IntegerToString(PositionGetInteger(POSITION_MAGIC)) +
             ",\"profit\":" + JNum(PositionGetDouble(POSITION_PROFIT), 2) +
             ",\"orderTicket\":" + JStr(IntegerToString(PositionGetInteger(POSITION_IDENTIFIER))) + "}";
     }
   return "[" + out + "]";
  }

string OrdersJson()
  {
   string out = "";
   int total = OrdersTotal();
   for(int k = 0; k < total; k++)
     {
      ulong t = OrderGetTicket(k);
      if(t == 0 || !OrderSelect(t)) continue;
      long type = OrderGetInteger(ORDER_TYPE);
      if(type != ORDER_TYPE_BUY_LIMIT && type != ORDER_TYPE_SELL_LIMIT && type != ORDER_TYPE_BUY_STOP && type != ORDER_TYPE_SELL_STOP) continue;
      string sym = OrderGetString(ORDER_SYMBOL);
      int dg = (int)SymbolInfoInteger(sym, SYMBOL_DIGITS);
      bool buy = (type == ORDER_TYPE_BUY_LIMIT || type == ORDER_TYPE_BUY_STOP);
      bool lim = (type == ORDER_TYPE_BUY_LIMIT || type == ORDER_TYPE_SELL_LIMIT);
      if(out != "") out += ",";
      out += "{\"ticket\":" + JStr(IntegerToString((long)t)) +
             ",\"symbol\":" + JStr(sym) +
             ",\"side\":" + JStr(buy ? "BUY" : "SELL") +
             ",\"kind\":" + JStr(lim ? "LIMIT" : "STOP") +
             ",\"volume\":" + JNum(OrderGetDouble(ORDER_VOLUME_CURRENT)) +
             ",\"price\":" + JNum(OrderGetDouble(ORDER_PRICE_OPEN), dg) +
             ",\"sl\":" + JNumOrNull(OrderGetDouble(ORDER_SL), dg) +
             ",\"tp\":" + JNumOrNull(OrderGetDouble(ORDER_TP), dg) +
             ",\"createdTime\":" + IntegerToString(ServerMscToUtcMs(OrderGetInteger(ORDER_TIME_SETUP_MSC))) +
             ",\"comment\":" + JStr(StringSubstr(OrderGetString(ORDER_COMMENT), 0, 64)) +
             ",\"magic\":" + IntegerToString(OrderGetInteger(ORDER_MAGIC)) + "}";
     }
   return "[" + out + "]";
  }

void CollectSymbols(string &syms[])
  {
   ArrayResize(syms, 0);
   for(int k = 0; k < ArraySize(g_watch); k++) if(!InArray(syms, g_watch[k])) Push(syms, g_watch[k]);
   for(int k = 0; k < PositionsTotal(); k++) { ulong t = PositionGetTicket(k); if(t > 0 && PositionSelectByTicket(t)) { string s = PositionGetString(POSITION_SYMBOL); if(!InArray(syms, s)) Push(syms, s); } }
  }

string QuotesJson()
  {
   string out = "";
   string syms[];
   CollectSymbols(syms);
   for(int k = 0; k < ArraySize(syms); k++)
     {
      MqlTick tick;
      if(!SymbolInfoTick(syms[k], tick) || tick.bid <= 0 || tick.ask <= 0) continue;
      int dg = (int)SymbolInfoInteger(syms[k], SYMBOL_DIGITS);
      if(out != "") out += ",";
      out += "{\"symbol\":" + JStr(syms[k]) + ",\"bid\":" + JNum(tick.bid, dg) + ",\"ask\":" + JNum(tick.ask, dg) + ",\"time\":" + IntegerToString(ServerMscToUtcMs(tick.time_msc)) + "}";
     }
   return "[" + out + "]";
  }

string SymbolsJson()
  {
   string out = "";
   string syms[];
   CollectSymbols(syms);
   for(int k = 0; k < ArraySize(syms); k++)
     {
      string s = syms[k];
      if(!SymbolSelect(s, true)) continue;
      int dg = (int)SymbolInfoInteger(s, SYMBOL_DIGITS);
      double ask = SymbolInfoDouble(s, SYMBOL_ASK), bid = SymbolInfoDouble(s, SYMBOL_BID);
      double margin = 0;
      if(ask > 0 && !OrderCalcMargin(ORDER_TYPE_BUY, s, 1.0, ask, margin)) margin = 0;
      long mode = SymbolInfoInteger(s, SYMBOL_TRADE_MODE);
      if(out != "") out += ",";
      out += "{\"symbol\":" + JStr(s) +
             ",\"description\":" + JStr(StringSubstr(SymbolInfoString(s, SYMBOL_DESCRIPTION), 0, 190)) +
             ",\"digits\":" + IntegerToString(dg) +
             ",\"tickSize\":" + JNum(SymbolInfoDouble(s, SYMBOL_TRADE_TICK_SIZE), 10) +
             ",\"tickValue\":" + JNum(SymbolInfoDouble(s, SYMBOL_TRADE_TICK_VALUE), 10) +
             ",\"contractSize\":" + JNum(SymbolInfoDouble(s, SYMBOL_TRADE_CONTRACT_SIZE), 6) +
             ",\"profitCurrency\":" + JStr(SymbolInfoString(s, SYMBOL_CURRENCY_PROFIT)) +
             ",\"baseCurrency\":" + JStr(SymbolInfoString(s, SYMBOL_CURRENCY_BASE)) +
             ",\"volumeMin\":" + JNum(SymbolInfoDouble(s, SYMBOL_VOLUME_MIN)) +
             ",\"volumeMax\":" + JNum(SymbolInfoDouble(s, SYMBOL_VOLUME_MAX)) +
             ",\"volumeStep\":" + JNum(SymbolInfoDouble(s, SYMBOL_VOLUME_STEP)) +
             ",\"stopsLevelPoints\":" + IntegerToString(SymbolInfoInteger(s, SYMBOL_TRADE_STOPS_LEVEL)) +
             ",\"freezeLevelPoints\":" + IntegerToString(SymbolInfoInteger(s, SYMBOL_TRADE_FREEZE_LEVEL)) +
             ",\"tradeAllowed\":" + JBool(mode == SYMBOL_TRADE_MODE_FULL) +
             (margin > 0 ? ",\"marginPerLot\":" + JNum(margin, 2) : "") +
             (bid > 0 && ask > 0 ? ",\"bid\":" + JNum(bid, dg) + ",\"ask\":" + JNum(ask, dg) : "") + "}";
     }
   return "[" + out + "]";
  }

string BuildSync()
  {
   bool hedging = (AccountInfoInteger(ACCOUNT_MARGIN_MODE) == ACCOUNT_MARGIN_MODE_RETAIL_HEDGING);
   bool tradeAllowed = TerminalInfoInteger(TERMINAL_TRADE_ALLOWED) && MQLInfoInteger(MQL_TRADE_ALLOWED) && AccountInfoInteger(ACCOUNT_TRADE_ALLOWED);
   string results = "";
   for(int k = 0; k < ArraySize(g_results); k++) results += (k ? "," : "") + g_results[k];
   string body = "{\"protocol\":1,\"platform\":\"MT5\"" +
                 ",\"login\":" + JStr(IntegerToString(AccountInfoInteger(ACCOUNT_LOGIN))) +
                 ",\"server\":" + JStr(AccountInfoString(ACCOUNT_SERVER)) +
                 ",\"eaVersion\":" + JStr(GTC_VERSION) +
                 ",\"terminalConnected\":" + JBool(TerminalInfoInteger(TERMINAL_CONNECTED) != 0) +
                 ",\"tradeAllowed\":" + JBool(tradeAllowed) +
                 ",\"accounting\":" + JStr(hedging ? "HEDGING" : "NETTING") +
                 ",\"account\":{\"balance\":" + JNum(AccountInfoDouble(ACCOUNT_BALANCE), 2) +
                 ",\"equity\":" + JNum(AccountInfoDouble(ACCOUNT_EQUITY), 2) +
                 ",\"currency\":" + JStr(AccountInfoString(ACCOUNT_CURRENCY)) +
                 ",\"freeMargin\":" + JNum(AccountInfoDouble(ACCOUNT_MARGIN_FREE), 2) +
                 ",\"margin\":" + JNum(AccountInfoDouble(ACCOUNT_MARGIN), 2) + "}" +
                 ",\"serverTime\":" + IntegerToString((long)TimeGMT() * 1000) +
                 ",\"positions\":" + PositionsJson() +
                 ",\"orders\":" + OrdersJson() +
                 ",\"quotes\":" + QuotesJson() +
                 (g_sendSymbols ? ",\"symbols\":" + SymbolsJson() : "") +
                 ",\"results\":[" + results + "]}";
   return body;
  }

//+------------------------------------------------------------------+
//| Command execution                                                |
//+------------------------------------------------------------------+
void AddResult(string id, bool ok, long retcode, string msg, string orderTicket, string positionTicket, double fillPrice, double filledVolume)
  {
   Push(g_results, "{\"commandId\":" + JStr(id) + ",\"ok\":" + JBool(ok) + ",\"retcode\":" + IntegerToString(retcode) +
        ",\"message\":" + JStr(StringSubstr(msg, 0, 250)) +
        ",\"orderTicket\":" + (orderTicket == "" ? "null" : JStr(orderTicket)) +
        ",\"positionTicket\":" + (positionTicket == "" ? "null" : JStr(positionTicket)) +
        ",\"fillPrice\":" + (fillPrice > 0 ? JNum(fillPrice, 10) : "null") +
        ",\"filledVolume\":" + (filledVolume > 0 ? JNum(filledVolume) : "null") +
        ",\"executedAt\":" + IntegerToString(NowUtcMs()) + "}");
   MarkDone(id);
  }

// Idempotency: an order/position carrying this tag already exists (earlier delivery executed).
bool FindByTag(string tag, string &orderTicket, string &positionTicket, double &price, double &vol)
  {
   for(int k = 0; k < PositionsTotal(); k++)
     {
      ulong t = PositionGetTicket(k);
      if(t > 0 && PositionSelectByTicket(t) && PositionGetString(POSITION_COMMENT) == tag)
        { positionTicket = IntegerToString((long)t); orderTicket = IntegerToString(PositionGetInteger(POSITION_IDENTIFIER)); price = PositionGetDouble(POSITION_PRICE_OPEN); vol = PositionGetDouble(POSITION_VOLUME); return true; }
     }
   for(int k = 0; k < OrdersTotal(); k++)
     {
      ulong t = OrderGetTicket(k);
      if(t > 0 && OrderSelect(t) && OrderGetString(ORDER_COMMENT) == tag) { orderTicket = IntegerToString((long)t); return true; }
     }
   if(HistorySelect(TimeCurrent() - 86400, TimeCurrent() + 60))
     {
      for(int k = HistoryDealsTotal() - 1; k >= 0; k--)
        {
         ulong d = HistoryDealGetTicket(k);
         if(d > 0 && HistoryDealGetString(d, DEAL_COMMENT) == tag && HistoryDealGetInteger(d, DEAL_ENTRY) == DEAL_ENTRY_IN)
           { orderTicket = IntegerToString(HistoryDealGetInteger(d, DEAL_ORDER)); positionTicket = IntegerToString(HistoryDealGetInteger(d, DEAL_POSITION_ID)); price = HistoryDealGetDouble(d, DEAL_PRICE); vol = HistoryDealGetDouble(d, DEAL_VOLUME); return true; }
        }
     }
   return false;
  }

bool SendRequest(MqlTradeRequest &req, MqlTradeResult &res)
  {
   ResetLastError();
   bool sent = OrderSend(req, res);
   if(!sent && res.retcode == 0) res.retcode = (uint)GetLastError();
   return sent && (res.retcode == TRADE_RETCODE_DONE || res.retcode == TRADE_RETCODE_PLACED || res.retcode == TRADE_RETCODE_DONE_PARTIAL);
  }

void Execute(JNode *c)
  {
   string id = c.S("id"), kind = c.S("kind"), sym = c.S("symbol"), side = c.S("side"), tag = c.S("tag");
   double vol = c.N("volume"), price = c.N("price"), sl = c.N("sl"), tp = c.N("tp");
   ulong posTicket = (ulong)StringToInteger(c.S("positionTicket"));
   ulong ordTicket = (ulong)StringToInteger(c.S("orderTicket"));
   long magic = (long)c.N("magic");
   if(InArray(g_done, id)) { if(InpVerbose) PrintFormat("GTC: command %s already executed; skipping", id); return; }
   if(magic != 0 && magic != InpMagic) { AddResult(id, false, 0, "magic mismatch between engine and EA input", "", "", 0, 0); return; }

   MqlTradeRequest req;
   MqlTradeResult  res;
   ZeroMemory(req);
   ZeroMemory(res);
   req.magic = InpMagic;
   req.deviation = InpDeviationPts;

   if(kind == "OPEN_MARKET" || kind == "PLACE_PENDING")
     {
      string ot = "", pt = ""; double fp = 0, fv = 0;
      if(FindByTag(tag, ot, pt, fp, fv)) { AddResult(id, true, TRADE_RETCODE_DONE, "already executed (found by tag)", ot, pt, fp, fv); return; }
      if(!SymbolSelect(sym, true)) { AddResult(id, false, 0, "symbol not available: " + sym, "", "", 0, 0); return; }
      int dg = (int)SymbolInfoInteger(sym, SYMBOL_DIGITS);
      req.symbol = sym;
      req.volume = vol;
      req.sl = sl > 0 ? NormalizeDouble(sl, dg) : 0;
      req.tp = tp > 0 ? NormalizeDouble(tp, dg) : 0;
      req.comment = tag;
      req.type_filling = Filling(sym);
      if(kind == "OPEN_MARKET")
        {
         req.action = TRADE_ACTION_DEAL;
         req.type = side == "BUY" ? ORDER_TYPE_BUY : ORDER_TYPE_SELL;
         req.price = side == "BUY" ? SymbolInfoDouble(sym, SYMBOL_ASK) : SymbolInfoDouble(sym, SYMBOL_BID);
        }
      else
        {
         string pk = c.S("pendingKind");
         req.action = TRADE_ACTION_PENDING;
         req.type = side == "BUY" ? (pk == "STOP" ? ORDER_TYPE_BUY_STOP : ORDER_TYPE_BUY_LIMIT) : (pk == "STOP" ? ORDER_TYPE_SELL_STOP : ORDER_TYPE_SELL_LIMIT);
         req.price = NormalizeDouble(price, dg);
         req.type_time = ORDER_TIME_GTC;
         req.type_filling = ORDER_FILLING_RETURN;
        }
      bool ok = SendRequest(req, res);
      string positionTicket = "";
      if(ok && kind == "OPEN_MARKET")
        {
         // Hedging: the position ticket equals the opening order ticket. Netting: the symbol's position.
         if(AccountInfoInteger(ACCOUNT_MARGIN_MODE) == ACCOUNT_MARGIN_MODE_RETAIL_HEDGING) positionTicket = IntegerToString((long)res.order);
         else if(PositionSelect(sym)) positionTicket = IntegerToString(PositionGetInteger(POSITION_TICKET));
        }
      AddResult(id, ok, res.retcode, res.comment, ok ? IntegerToString((long)res.order) : "", positionTicket, ok && kind == "OPEN_MARKET" ? res.price : 0, ok && kind == "OPEN_MARKET" ? res.volume : 0);
      return;
     }

   if(kind == "MODIFY_POSITION" || kind == "CLOSE_POSITION")
     {
      if(!PositionSelectByTicket(posTicket)) { AddResult(id, false, 0, "position not found", "", "", 0, 0); return; }
      if(PositionGetInteger(POSITION_MAGIC) != InpMagic) { AddResult(id, false, 0, "refused: position was not opened by the copier", "", "", 0, 0); return; }
      string psym = PositionGetString(POSITION_SYMBOL);
      int dg = (int)SymbolInfoInteger(psym, SYMBOL_DIGITS);
      if(kind == "MODIFY_POSITION")
        {
         req.action = TRADE_ACTION_SLTP;
         req.position = posTicket;
         req.symbol = psym;
         req.sl = sl > 0 ? NormalizeDouble(sl, dg) : 0;
         req.tp = tp > 0 ? NormalizeDouble(tp, dg) : 0;
         bool ok = SendRequest(req, res);
         AddResult(id, ok, res.retcode, res.comment, "", IntegerToString((long)posTicket), 0, 0);
         return;
        }
      double cur = PositionGetDouble(POSITION_VOLUME);
      double closeVol = (vol > 0 && vol < cur) ? vol : cur;
      long ptype = PositionGetInteger(POSITION_TYPE);
      req.action = TRADE_ACTION_DEAL;
      req.position = posTicket;
      req.symbol = psym;
      req.volume = closeVol;
      req.type = ptype == POSITION_TYPE_BUY ? ORDER_TYPE_SELL : ORDER_TYPE_BUY;
      req.price = ptype == POSITION_TYPE_BUY ? SymbolInfoDouble(psym, SYMBOL_BID) : SymbolInfoDouble(psym, SYMBOL_ASK);
      req.type_filling = Filling(psym);
      req.comment = tag;
      bool ok = SendRequest(req, res);
      AddResult(id, ok, res.retcode, res.comment, ok ? IntegerToString((long)res.order) : "", IntegerToString((long)posTicket), ok ? res.price : 0, ok ? res.volume : 0);
      return;
     }

   if(kind == "MODIFY_PENDING" || kind == "CANCEL_PENDING")
     {
      if(!OrderSelect(ordTicket)) { AddResult(id, false, 0, "order not found", "", "", 0, 0); return; }
      if(OrderGetInteger(ORDER_MAGIC) != InpMagic) { AddResult(id, false, 0, "refused: order was not placed by the copier", "", "", 0, 0); return; }
      string osym = OrderGetString(ORDER_SYMBOL);
      int dg = (int)SymbolInfoInteger(osym, SYMBOL_DIGITS);
      req.order = ordTicket;
      req.symbol = osym;
      if(kind == "CANCEL_PENDING") req.action = TRADE_ACTION_REMOVE;
      else
        {
         req.action = TRADE_ACTION_MODIFY;
         req.price = price > 0 ? NormalizeDouble(price, dg) : OrderGetDouble(ORDER_PRICE_OPEN);
         req.sl = sl > 0 ? NormalizeDouble(sl, dg) : 0;
         req.tp = tp > 0 ? NormalizeDouble(tp, dg) : 0;
         req.type_time = ORDER_TIME_GTC;
        }
      bool ok = SendRequest(req, res);
      AddResult(id, ok, res.retcode, res.comment, IntegerToString((long)ordTicket), "", 0, 0);
      return;
     }
   AddResult(id, false, 0, "unknown command kind " + kind, "", "", 0, 0);
  }

//+------------------------------------------------------------------+
//| HTTP                                                             |
//+------------------------------------------------------------------+
string HeaderValue(string headers, string name)
  {
   string lines[];
   int n = StringSplit(headers, '\n', lines);
   string want = name;
   StringToLower(want);
   for(int k = 0; k < n; k++)
     {
      int p = StringFind(lines[k], ":");
      if(p <= 0) continue;
      string key = StringSubstr(lines[k], 0, p);
      StringToLower(key);
      StringTrimLeft(key); StringTrimRight(key);
      if(key == want) { string v = StringSubstr(lines[k], p + 1); StringTrimLeft(v); StringTrimRight(v); return v; }
     }
   return "";
  }

void Sync()
  {
   string body = BuildSync();
   string ts = IntegerToString((long)TimeGMT() * 1000);
   string nonce = Nonce();
   string sig = HmacHex(g_secret, ts + "\n" + nonce + "\nPOST\n" + GTC_PATH + "\n" + Sha256Hex(body));
   string headers = "Content-Type: application/json\r\nX-GTC-Key: " + g_tokenId + "\r\nX-GTC-Ts: " + ts + "\r\nX-GTC-Nonce: " + nonce + "\r\nX-GTC-Sig: " + sig + "\r\n";
   uchar data[], result[];
   string resultHeaders;
   Utf8(body, data);
   ResetLastError();
   int status = WebRequest("POST", InpBridgeUrl + GTC_PATH, headers, InpHttpTimeoutMs, data, result, resultHeaders);
   if(status == -1)
     {
      int err = GetLastError();
      if(TimeLocal() - g_lastWarn > 60)
        {
         g_lastWarn = TimeLocal();
         if(err == 4014) Print("GTC: WebRequest blocked. Add ", InpBridgeUrl, " under Tools > Options > Expert Advisors > Allow WebRequest for listed URL.");
         else PrintFormat("GTC: WebRequest failed (error %d)", err);
        }
      return;
     }
   string text = CharArrayToString(result, 0, WHOLE_ARRAY, CP_UTF8);
   if(status != 200)
     {
      if(TimeLocal() - g_lastWarn > 30) { g_lastWarn = TimeLocal(); PrintFormat("GTC: engine responded HTTP %d (check token / login / clock)", status); }
      return;
     }
   // Verify the engine's response signature before acting on any command.
   string expected = HmacHex(g_secret, ts + "\n" + nonce + "\n" + Sha256Hex(text));
   if(HeaderValue(resultHeaders, "x-gtc-sig") != expected) { Print("GTC: response signature invalid; ignoring response"); return; }

   // Results were delivered; the engine records them idempotently.
   ArrayResize(g_results, 0);

   JParser parser;
   JNode *root = parser.Parse(text);
   if(root == NULL) { Print("GTC: could not parse engine response"); return; }
   g_sendSymbols = root.B("sendSymbols");
   JNode *watch = root.Get("watchSymbols");
   if(watch != NULL && watch.type == J_ARR)
     {
      ArrayResize(g_watch, 0);
      for(int k = 0; k < watch.Size(); k++) { string s = watch.At(k).str; if(s != "") { Push(g_watch, s); SymbolSelect(s, true); } }
     }
   JNode *cmds = root.Get("commands");
   if(cmds != NULL && cmds.type == J_ARR)
     for(int k = 0; k < cmds.Size(); k++) Execute(cmds.At(k));
   delete root;
  }

//+------------------------------------------------------------------+
int OnInit()
  {
   if(!ParseToken(InpDeviceToken)) { Print("GTC: invalid or missing device token input"); return INIT_PARAMETERS_INCORRECT; }
   if(StringSubstr(InpBridgeUrl, 0, 8) != "https://") Print("GTC: WARNING bridge URL is not HTTPS; use HTTPS outside a private network");
   MathSrand((uint)(GetMicrosecondCount() & 0xFFFFFFFF));
   LoadDone();
   EventSetMillisecondTimer(MathMax(100, InpPollMs));
   PrintFormat("GTC bridge %s started for login %I64d (token %s)", GTC_VERSION, AccountInfoInteger(ACCOUNT_LOGIN), g_tokenId);
   return INIT_SUCCEEDED;
  }

void OnDeinit(const int reason)
  {
   EventKillTimer();
  }

void OnTimer()
  {
   Sync();
  }
//+------------------------------------------------------------------+
