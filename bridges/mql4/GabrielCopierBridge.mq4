//+------------------------------------------------------------------+
//| GabrielCopierBridge.mq4                                          |
//| Gabriel Trade Copier — MetaTrader 4 bridge Expert Advisor        |
//|                                                                  |
//| Same protocol as the MT5 bridge (docs/BRIDGE_PROTOCOL.md).       |
//| MT4 specifics: positions and pending orders share the order      |
//| pool; a partial close gives the remainder a NEW ticket whose     |
//| comment is "from #<old>" — reported as fromTicket.               |
//|                                                                  |
//| STATUS: source provided; NOT compiled or run in the development  |
//| environment. Compile in MetaEditor (build 1090+) and test on a   |
//| demo account first.                                              |
//+------------------------------------------------------------------+
#property copyright "Gabriel Trade Copier"
#property version   "0.10"
#property strict
#property description "Bridge between this MT4 terminal and the Gabriel Trade Copier engine."

input string InpBridgeUrl      = "https://copier.example.com"; // Engine base URL (must be in WebRequest allow list)
input string InpDeviceToken    = "";                           // Device token gtcd_<id>_<secret> from the dashboard
input int    InpPollMs         = 300;                          // Sync interval (ms)
input int    InpMagic          = 7710001;                      // Magic number for copier orders (must match engine)
input int    InpSlippagePts    = 30;                           // Max slippage for market orders (points)
input int    InpHttpTimeoutMs  = 5000;                         // HTTP timeout (ms)
input bool   InpVerbose        = false;                        // Extra logging (never logs the token)

#define GTC_PATH      "/bridge/v1/sync"
#define GTC_VERSION   "mt4-0.10"
#define MAX_DONE      500

string   g_tokenId  = "";
string   g_secret   = "";
string   g_results[];
string   g_done[];
string   g_watch[];
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
   string seed = IntegerToString(GetMicrosecondCount()) + "-" + IntegerToString((long)TimeLocal()) + "-" + IntegerToString(MathRand()) + "-" + IntegerToString(MathRand()) + "-" + IntegerToString((long)g_nonceCounter);
   return StringSubstr(Sha256Hex(seed + g_secret), 0, 32);
  }

//+------------------------------------------------------------------+
//| Helpers                                                          |
//+------------------------------------------------------------------+
long ServerOffsetSec() { return (long)(TimeCurrent() - TimeGMT()); }
long NowUtcMs() { return (long)TimeGMT() * 1000 + (long)(GetTickCount() % 1000); }
long ServerSecToUtcMs(datetime t) { return ((long)t - ServerOffsetSec()) * 1000; }

bool InArray(string &arr[], string v) { for(int k = 0; k < ArraySize(arr); k++) if(arr[k] == v) return true; return false; }
void Push(string &arr[], string v) { int s = ArraySize(arr); ArrayResize(arr, s + 1); arr[s] = v; }
void RemoveFirst(string &arr[], int count) { int n = ArraySize(arr); if(count <= 0) return; for(int k = count; k < n; k++) arr[k - count] = arr[k]; ArrayResize(arr, MathMax(0, n - count)); }

string DoneFile() { return "GTC_" + IntegerToString(AccountNumber()) + "_done.txt"; }
void LoadDone()
  {
   int h = FileOpen(DoneFile(), FILE_READ | FILE_TXT | FILE_ANSI);
   if(h == INVALID_HANDLE) return;
   while(!FileIsEnding(h)) { string l = FileReadString(h); if(l != "") Push(g_done, l); }
   FileClose(h);
   int extra = ArraySize(g_done) - MAX_DONE;
   if(extra > 0) RemoveFirst(g_done, extra);
  }
void MarkDone(string id)
  {
   Push(g_done, id);
   if(ArraySize(g_done) > MAX_DONE) RemoveFirst(g_done, ArraySize(g_done) - MAX_DONE);
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


//+------------------------------------------------------------------+
//| Snapshot serialisation                                           |
//+------------------------------------------------------------------+
bool IsMarket(int type) { return type == OP_BUY || type == OP_SELL; }
bool IsPending(int type) { return type == OP_BUYLIMIT || type == OP_SELLLIMIT || type == OP_BUYSTOP || type == OP_SELLSTOP; }

string FromTicket(string comment)
  {
   int p = StringFind(comment, "from #");
   if(p < 0) return "";
   string t = StringSubstr(comment, p + 6);
   int sp = StringFind(t, " ");
   if(sp > 0) t = StringSubstr(t, 0, sp);
   return t;
  }

string PositionsJson()
  {
   string out = "";
   for(int k = 0; k < OrdersTotal(); k++)
     {
      if(!OrderSelect(k, SELECT_BY_POS, MODE_TRADES) || !IsMarket(OrderType())) continue;
      int dg = (int)MarketInfo(OrderSymbol(), MODE_DIGITS);
      string from = FromTicket(OrderComment());
      if(out != "") out += ",";
      out += "{\"ticket\":" + JStr(IntegerToString(OrderTicket())) +
             ",\"symbol\":" + JStr(OrderSymbol()) +
             ",\"side\":" + JStr(OrderType() == OP_BUY ? "BUY" : "SELL") +
             ",\"volume\":" + JNum(OrderLots()) +
             ",\"openPrice\":" + JNum(OrderOpenPrice(), dg) +
             ",\"openTime\":" + IntegerToString(ServerSecToUtcMs(OrderOpenTime())) +
             ",\"sl\":" + JNumOrNull(OrderStopLoss(), dg) +
             ",\"tp\":" + JNumOrNull(OrderTakeProfit(), dg) +
             ",\"comment\":" + JStr(StringSubstr(OrderComment(), 0, 64)) +
             ",\"magic\":" + IntegerToString(OrderMagicNumber()) +
             ",\"profit\":" + JNum(OrderProfit() + OrderSwap() + OrderCommission(), 2) +
             ",\"orderTicket\":" + JStr(IntegerToString(OrderTicket())) +
             (from != "" ? ",\"fromTicket\":" + JStr(from) : "") + "}";
     }
   return "[" + out + "]";
  }

string OrdersJson()
  {
   string out = "";
   for(int k = 0; k < OrdersTotal(); k++)
     {
      if(!OrderSelect(k, SELECT_BY_POS, MODE_TRADES) || !IsPending(OrderType())) continue;
      int type = OrderType();
      int dg = (int)MarketInfo(OrderSymbol(), MODE_DIGITS);
      bool buy = (type == OP_BUYLIMIT || type == OP_BUYSTOP);
      bool lim = (type == OP_BUYLIMIT || type == OP_SELLLIMIT);
      if(out != "") out += ",";
      out += "{\"ticket\":" + JStr(IntegerToString(OrderTicket())) +
             ",\"symbol\":" + JStr(OrderSymbol()) +
             ",\"side\":" + JStr(buy ? "BUY" : "SELL") +
             ",\"kind\":" + JStr(lim ? "LIMIT" : "STOP") +
             ",\"volume\":" + JNum(OrderLots()) +
             ",\"price\":" + JNum(OrderOpenPrice(), dg) +
             ",\"sl\":" + JNumOrNull(OrderStopLoss(), dg) +
             ",\"tp\":" + JNumOrNull(OrderTakeProfit(), dg) +
             ",\"createdTime\":" + IntegerToString(ServerSecToUtcMs(OrderOpenTime())) +
             ",\"comment\":" + JStr(StringSubstr(OrderComment(), 0, 64)) +
             ",\"magic\":" + IntegerToString(OrderMagicNumber()) + "}";
     }
   return "[" + out + "]";
  }

void CollectSymbols(string &syms[])
  {
   ArrayResize(syms, 0);
   for(int k = 0; k < ArraySize(g_watch); k++) if(!InArray(syms, g_watch[k])) Push(syms, g_watch[k]);
   for(int k = 0; k < OrdersTotal(); k++) if(OrderSelect(k, SELECT_BY_POS, MODE_TRADES) && !InArray(syms, OrderSymbol())) Push(syms, OrderSymbol());
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
      int dg = (int)MarketInfo(syms[k], MODE_DIGITS);
      if(out != "") out += ",";
      out += "{\"symbol\":" + JStr(syms[k]) + ",\"bid\":" + JNum(tick.bid, dg) + ",\"ask\":" + JNum(tick.ask, dg) + ",\"time\":" + IntegerToString(ServerSecToUtcMs(tick.time)) + "}";
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
      int dg = (int)MarketInfo(s, MODE_DIGITS);
      double bid = MarketInfo(s, MODE_BID), ask = MarketInfo(s, MODE_ASK);
      double margin = MarketInfo(s, MODE_MARGINREQUIRED);
      if(out != "") out += ",";
      out += "{\"symbol\":" + JStr(s) +
             ",\"description\":" + JStr(StringSubstr(SymbolInfoString(s, SYMBOL_DESCRIPTION), 0, 190)) +
             ",\"digits\":" + IntegerToString(dg) +
             ",\"tickSize\":" + JNum(MarketInfo(s, MODE_TICKSIZE), 10) +
             ",\"tickValue\":" + JNum(MarketInfo(s, MODE_TICKVALUE), 10) +
             ",\"contractSize\":" + JNum(MarketInfo(s, MODE_LOTSIZE), 6) +
             ",\"profitCurrency\":" + JStr(SymbolInfoString(s, SYMBOL_CURRENCY_PROFIT)) +
             ",\"baseCurrency\":" + JStr(SymbolInfoString(s, SYMBOL_CURRENCY_BASE)) +
             ",\"volumeMin\":" + JNum(MarketInfo(s, MODE_MINLOT)) +
             ",\"volumeMax\":" + JNum(MarketInfo(s, MODE_MAXLOT)) +
             ",\"volumeStep\":" + JNum(MarketInfo(s, MODE_LOTSTEP)) +
             ",\"stopsLevelPoints\":" + IntegerToString((int)MarketInfo(s, MODE_STOPLEVEL)) +
             ",\"freezeLevelPoints\":" + IntegerToString((int)MarketInfo(s, MODE_FREEZELEVEL)) +
             ",\"tradeAllowed\":" + JBool(MarketInfo(s, MODE_TRADEALLOWED) != 0) +
             (margin > 0 ? ",\"marginPerLot\":" + JNum(margin, 2) : "") +
             (bid > 0 && ask > 0 ? ",\"bid\":" + JNum(bid, dg) + ",\"ask\":" + JNum(ask, dg) : "") + "}";
     }
   return "[" + out + "]";
  }

string BuildSync()
  {
   bool tradeAllowed = TerminalInfoInteger(TERMINAL_TRADE_ALLOWED) && IsTradeAllowed() && AccountInfoInteger(ACCOUNT_TRADE_ALLOWED);
   string results = "";
   for(int k = 0; k < ArraySize(g_results); k++) results += (k > 0 ? "," : "") + g_results[k];
   return "{\"protocol\":1,\"platform\":\"MT4\"" +
          ",\"login\":" + JStr(IntegerToString(AccountNumber())) +
          ",\"server\":" + JStr(AccountServer()) +
          ",\"eaVersion\":" + JStr(GTC_VERSION) +
          ",\"terminalConnected\":" + JBool(IsConnected()) +
          ",\"tradeAllowed\":" + JBool(tradeAllowed) +
          ",\"accounting\":\"HEDGING\"" +
          ",\"account\":{\"balance\":" + JNum(AccountBalance(), 2) +
          ",\"equity\":" + JNum(AccountEquity(), 2) +
          ",\"currency\":" + JStr(AccountCurrency()) +
          ",\"freeMargin\":" + JNum(AccountFreeMargin(), 2) +
          ",\"margin\":" + JNum(AccountMargin(), 2) + "}" +
          ",\"serverTime\":" + IntegerToString((long)TimeGMT() * 1000) +
          ",\"positions\":" + PositionsJson() +
          ",\"orders\":" + OrdersJson() +
          ",\"quotes\":" + QuotesJson() +
          (g_sendSymbols ? ",\"symbols\":" + SymbolsJson() : "") +
          ",\"results\":[" + results + "]}";
  }

//+------------------------------------------------------------------+
//| Command execution                                                |
//+------------------------------------------------------------------+
void AddResult(string id, bool ok, int code, string msg, string orderTicket, string positionTicket, double fillPrice, double filledVolume)
  {
   Push(g_results, "{\"commandId\":" + JStr(id) + ",\"ok\":" + JBool(ok) + ",\"retcode\":" + IntegerToString(code) +
        ",\"message\":" + JStr(StringSubstr(msg, 0, 250)) +
        ",\"orderTicket\":" + (orderTicket == "" ? "null" : JStr(orderTicket)) +
        ",\"positionTicket\":" + (positionTicket == "" ? "null" : JStr(positionTicket)) +
        ",\"fillPrice\":" + (fillPrice > 0 ? JNum(fillPrice, 10) : "null") +
        ",\"filledVolume\":" + (filledVolume > 0 ? JNum(filledVolume) : "null") +
        ",\"executedAt\":" + IntegerToString((long)TimeGMT() * 1000) + "}");
   MarkDone(id);
  }

bool FindByTag(string tag, string &ticket, double &price, double &vol)
  {
   for(int k = 0; k < OrdersTotal(); k++)
      if(OrderSelect(k, SELECT_BY_POS, MODE_TRADES) && OrderComment() == tag) { ticket = IntegerToString(OrderTicket()); price = OrderOpenPrice(); vol = OrderLots(); return true; }
   for(int k = OrdersHistoryTotal() - 1; k >= 0 && k >= OrdersHistoryTotal() - 500; k--)
      if(OrderSelect(k, SELECT_BY_POS, MODE_HISTORY) && OrderComment() == tag) { ticket = IntegerToString(OrderTicket()); price = OrderOpenPrice(); vol = OrderLots(); return true; }
   return false;
  }

string Err(int code) { return "error " + IntegerToString(code); }

void Execute(JNode *c)
  {
   string id = c.S("id"), kind = c.S("kind"), sym = c.S("symbol"), side = c.S("side"), tag = c.S("tag");
   double vol = c.N("volume"), price = c.N("price"), sl = c.N("sl"), tp = c.N("tp");
   int posTicket = (int)StringToInteger(c.S("positionTicket"));
   int ordTicket = (int)StringToInteger(c.S("orderTicket"));
   int magic = (int)c.N("magic");
   if(InArray(g_done, id)) return;
   if(magic != 0 && magic != InpMagic) { AddResult(id, false, 0, "magic mismatch between engine and EA input", "", "", 0, 0); return; }
   if(IsTradeContextBusy()) { AddResult(id, false, 146, "trade context busy", "", "", 0, 0); return; }
   RefreshRates();

   if(kind == "OPEN_MARKET" || kind == "PLACE_PENDING")
     {
      string t = ""; double fp = 0, fv = 0;
      if(FindByTag(tag, t, fp, fv)) { AddResult(id, true, 0, "already executed (found by tag)", t, kind == "OPEN_MARKET" ? t : "", fp, fv); return; }
      if(!SymbolSelect(sym, true)) { AddResult(id, false, 0, "symbol not available: " + sym, "", "", 0, 0); return; }
      int dg = (int)MarketInfo(sym, MODE_DIGITS);
      int cmd;
      double px;
      if(kind == "OPEN_MARKET") { cmd = side == "BUY" ? OP_BUY : OP_SELL; px = side == "BUY" ? MarketInfo(sym, MODE_ASK) : MarketInfo(sym, MODE_BID); }
      else
        {
         string pk = c.S("pendingKind");
         cmd = side == "BUY" ? (pk == "STOP" ? OP_BUYSTOP : OP_BUYLIMIT) : (pk == "STOP" ? OP_SELLSTOP : OP_SELLLIMIT);
         px = NormalizeDouble(price, dg);
        }
      ResetLastError();
      int ticket = OrderSend(sym, cmd, vol, px, InpSlippagePts, sl > 0 ? NormalizeDouble(sl, dg) : 0, tp > 0 ? NormalizeDouble(tp, dg) : 0, tag, InpMagic, 0, clrNONE);
      if(ticket < 0) { int e = GetLastError(); AddResult(id, false, e, Err(e), "", "", 0, 0); return; }
      double fill = 0, lots = 0;
      if(OrderSelect(ticket, SELECT_BY_TICKET)) { fill = OrderOpenPrice(); lots = OrderLots(); }
      AddResult(id, true, 0, "done", IntegerToString(ticket), kind == "OPEN_MARKET" ? IntegerToString(ticket) : "", kind == "OPEN_MARKET" ? fill : 0, kind == "OPEN_MARKET" ? lots : 0);
      return;
     }

   int target = (kind == "MODIFY_POSITION" || kind == "CLOSE_POSITION") ? posTicket : ordTicket;
   if(!OrderSelect(target, SELECT_BY_TICKET) || OrderCloseTime() != 0) { AddResult(id, false, 0, "ticket not found or already closed", "", "", 0, 0); return; }
   if(OrderMagicNumber() != InpMagic) { AddResult(id, false, 0, "refused: ticket was not opened by the copier", "", "", 0, 0); return; }
   string osym = OrderSymbol();
   int dg = (int)MarketInfo(osym, MODE_DIGITS);
   ResetLastError();

   if(kind == "MODIFY_POSITION" || kind == "MODIFY_PENDING")
     {
      double newPrice = (kind == "MODIFY_PENDING" && price > 0) ? NormalizeDouble(price, dg) : OrderOpenPrice();
      bool ok = OrderModify(target, newPrice, sl > 0 ? NormalizeDouble(sl, dg) : 0, tp > 0 ? NormalizeDouble(tp, dg) : 0, 0, clrNONE);
      int e = ok ? 0 : GetLastError();
      // Error 1 = no change: treat as success (levels already match).
      if(!ok && e == 1) ok = true;
      AddResult(id, ok, e, ok ? "done" : Err(e), kind == "MODIFY_PENDING" ? IntegerToString(target) : "", kind == "MODIFY_POSITION" ? IntegerToString(target) : "", 0, 0);
      return;
     }
   if(kind == "CANCEL_PENDING")
     {
      bool ok = OrderDelete(target, clrNONE);
      int e = ok ? 0 : GetLastError();
      AddResult(id, ok, e, ok ? "done" : Err(e), IntegerToString(target), "", 0, 0);
      return;
     }
   if(kind == "CLOSE_POSITION")
     {
      double cur = OrderLots();
      double closeVol = (vol > 0 && vol < cur) ? vol : cur;
      double px = OrderType() == OP_BUY ? MarketInfo(osym, MODE_BID) : MarketInfo(osym, MODE_ASK);
      bool ok = OrderClose(target, closeVol, px, InpSlippagePts, clrNONE);
      int e = ok ? 0 : GetLastError();
      string remainder = IntegerToString(target);
      double closePrice = 0;
      if(ok)
        {
         if(OrderSelect(target, SELECT_BY_TICKET)) closePrice = OrderClosePrice();
         if(closeVol < cur)
           {
            // MT4 opens the remainder under a new ticket with comment "from #<target>".
            for(int k = 0; k < OrdersTotal(); k++)
               if(OrderSelect(k, SELECT_BY_POS, MODE_TRADES) && FromTicket(OrderComment()) == IntegerToString(target)) { remainder = IntegerToString(OrderTicket()); break; }
           }
        }
      AddResult(id, ok, e, ok ? "done" : Err(e), "", remainder, closePrice, ok ? closeVol : 0);
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
      key = StringTrimLeft(StringTrimRight(key));
      if(key == want) return StringTrimLeft(StringTrimRight(StringSubstr(lines[k], p + 1)));
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
         if(err == 4060 || err == 4014) Print("GTC: WebRequest blocked. Add ", InpBridgeUrl, " under Tools > Options > Expert Advisors > Allow WebRequest for listed URL.");
         else Print("GTC: WebRequest failed (error ", err, ")");
        }
      return;
     }
   string text = CharArrayToString(result, 0, WHOLE_ARRAY, CP_UTF8);
   if(status != 200)
     {
      if(TimeLocal() - g_lastWarn > 30) { g_lastWarn = TimeLocal(); Print("GTC: engine responded HTTP ", status, " (check token / login / clock)"); }
      return;
     }
   string expected = HmacHex(g_secret, ts + "\n" + nonce + "\n" + Sha256Hex(text));
   if(HeaderValue(resultHeaders, "x-gtc-sig") != expected) { Print("GTC: response signature invalid; ignoring response"); return; }
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
   MathSrand((uint)GetTickCount());
   LoadDone();
   EventSetMillisecondTimer(MathMax(100, InpPollMs));
   Print("GTC bridge ", GTC_VERSION, " started for login ", AccountNumber(), " (token ", g_tokenId, ")");
   return INIT_SUCCEEDED;
  }

void OnDeinit(const int reason) { EventKillTimer(); }
void OnTimer() { Sync(); }
//+------------------------------------------------------------------+
