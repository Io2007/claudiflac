import { Hono } from 'hono';
import { cors } from 'hono/cors';
import axios from 'axios';
import crypto from 'crypto';

const app = new Hono();

app.use('*', cors());

async function parseBody(c) {
try { return await c.req.json(); } catch(e) { return {}; }
}

const HIFI_INSTANCES = [
'https://hifi-api-pj08.onrender.com',
'https://mono.kennyy.com.br/hifi-api',
'https://api.iwakura.workers.dev',
'https://tidal-api.binimum.org',
'https://triton.squid.wtf',
'https://ohio-1.monochrome.tf',
'https://frankfurt-1.monochrome.tf',
'https://eu-central.monochrome.tf',
'https://monochrome-api.samidy.com',
'https://hifi-two.spotisaver.net',
'https://katze.qqdl.site',
'https://hund.qqdl.site',
'https://api.monochrome.tf',
];
let activeInstance = HIFI_INSTANCES[0];
let instanceHealthy = false;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36';
const QOBUZ_INSTANCES = [
'https://qobuz-api.stremio123.duckdns.org',
'https://qobuz-api1.onrender.com',
];
let activeQobuzInstance = QOBUZ_INSTANCES[0];

// ─── Redis-only caching (no in-memory cache) ─────────────────────────────────

// ─── Inflight deduplication ───────────────────────────────────────────────────
// Two simultaneous requests for the same stream share ONE outbound call.
const _inflight = new Map();
async function dedupeCall(key, fn) {
  if (_inflight.has(key)) return _inflight.get(key);
  const p = Promise.resolve().then(fn).finally(() => _inflight.delete(key));
  _inflight.set(key, p);
  return p;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function trackDuration(t) { return (t && t.duration) ? Math.floor(t.duration) : undefined; }
function trackArtist(t) {
if (!t) return 'Unknown';
if (t.artists && t.artists.length) return t.artists.map(function(a) { return a.name; }).join(', ');
if (t.artist && t.artist.name) return t.artist.name;
return 'Unknown';
}

function decodeManifest(manifest) {
try {
const raw = Buffer.from(manifest, 'base64').toString('utf8');
if (raw.trimStart().startsWith('<')) {
const urlMatch = raw.match(/<BaseURL[^>]*>([^<]+)<\/BaseURL>/i)
|| raw.match(/<SegmentURL[^>]+media="([^"]+)"/i);
if (urlMatch && urlMatch[1]) {
const url = urlMatch[1].trim()
.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
const codec = raw.match(/codecs="([^"]+)"/i)?.[1] || 'flac';
return { url, codec, isDash: true };
}
return null;
}
const decoded = JSON.parse(raw);
const url = (decoded.urls && decoded.urls.length > 0) ? decoded.urls[0] : (decoded.url || null);
const codec = decoded.codecs || decoded.codec || decoded.mimeType || null;
return { url, codec, isDash: false };
} catch(e) { return null; }
}

function isPlaylistUUID(id) {
return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(id));
}

function looksLikePlaylist(p) {
if (!p || !p.title) return false;
if (p.trackNumber !== undefined) return false;
if (p.replayGain !== undefined) return false;
if (p.peak !== undefined) return false;
if (p.isrc !== undefined) return false;
if (p.audioQuality !== undefined) return false;
return !!(p.uuid || p.creator || p.numberOfTracks !== undefined);
}

function artistRelevance(name, query) {
var n = (name || '').toLowerCase().trim();
var q = (query || '').toLowerCase().trim();
if (n === q) return 4;
if (n.startsWith(q) || q.startsWith(n)) return 3;
if (n.includes(q) || q.includes(n)) return 2;
return 0;
}

// ─── Deezer client ────────────────────────────────────────────────────────────
// deezerSearch: searches Deezer catalog by query string.
// Returns tracks with ISRC codes for exact matching downstream.
async function deezerSearch(query, limit) {
  if (!query) return { tracks: [], albums: [], artists: [], playlists: [] };
  
  try {
    const r = await axios.get('https://api.deezer.com/search', {
      params: { q: query, limit: Math.min(limit || 20, 50) },
      headers: { 'User-Agent': UA },
      timeout: 8000
    });
    
    const data = r.data || {};
    const items = data.data || [];
    
    const albumMap = {}, artistMap = {}, artistHits = {}, tracks = [];
    
    for (let i = 0; i < items.length; i++) {
      const t = items[i];
      if (!t || !t.id) continue;
      
      // Build album info
      if (t.album && t.album.id) {
        const abid = String(t.album.id);
        if (!albumMap[abid]) {
          albumMap[abid] = {
            id: abid,
            title: t.album.title || 'Unknown',
            artist: trackArtist(t),
            trackCount: t.album.nb_tracks,
            year: t.album.release_date ? String(t.album.release_date).slice(0, 4) : undefined,
            md5: t.album.md5_image || null
          };
        }
      }
      
      // Build artist info
      (t.contributors || [t.artist]).forEach(a => {
        if (!a || !a.id) return;
        const arid = String(a.id);
        if (!artistMap[arid]) {
          artistMap[arid] = {
            id: arid,
            name: a.name || 'Unknown'
          };
        }
        artistHits[arid] = (artistHits[arid] || 0) + 1;
      });
      
      const tTitle = t.title || 'Unknown';
      const tArtist = trackArtist(t);
      const isrc = t.isrc || null;
      const artwork = t.album?.cover_medium || t.album?.cover_big || t.album?.cover_small || null;
      
      tracks.push({
        id: String(t.id),
        title: tTitle,
        artist: tArtist,
        album: t.album ? t.album.title : undefined,
        duration: t.duration || undefined,
        isrc: isrc,
        format: 'flac',
        artwork: artwork
      });
    }
    
    // Build sorted artist list with relevance scoring
    const artistList = Object.keys(artistMap)
      .sort((a, b) => (artistRelevance(artistMap[b].name, query) * 100 + (artistHits[b] || 0)) - 
                       (artistRelevance(artistMap[a].name, query) * 100 + (artistHits[a] || 0)))
      .slice(0, 5).map(k => artistMap[k]);
    
    // Add artwork URLs to albums using md5_image from Deezer
    const albumList = Object.values(albumMap).slice(0, 8).map(album => ({
      ...album,
      artwork: `https://cdn-images.dzcdn.net/images/cover/${album.md5 || ''}/500x500-000000-80-0-0.jpg`
    }));
    
    // Add artwork URLs to artists
    const artistListWithArtwork = artistList.map(artist => ({
      ...artist,
      artwork: `https://cdn-images.dzcdn.net/images/artist/${artist.id}/500x500-000000-80-0-0.jpg`
    }));
    
    const result = {
      tracks,
      albums: albumList,
      artists: artistListWithArtwork,
      playlists: []
    };
    
    return result;
  } catch(e) {
    console.warn('deezer: search error', e.message);
    return { tracks: [], albums: [], artists: [], playlists: [] };
  }
}

// deezerGetTrack: fetches a single track by ID to get full metadata including ISRC.
// This function is no longer used - removed to simplify code

// ─── Hi-Fi API client ─────────────────────────────────────────────────────────
// Races ALL instances in parallel (Promise.any) — first success wins.
// Eliminates the sequential 15s-per-instance fallback that caused retry storms.
async function hifiGet(path, params) {
  const instances = instanceHealthy
    ? [activeInstance].concat(HIFI_INSTANCES.filter(i => i !== activeInstance))
    : HIFI_INSTANCES.slice();

  try {
    return await Promise.any(instances.map(inst =>
      axios.get(inst + path, {
        params,
        headers: { 'User-Agent': UA, 'Accept': 'application/json' },
        timeout: 8000
      }).then(r => {
        if (r.status === 200 && r.data) {
          if (inst !== activeInstance) { activeInstance = inst; instanceHealthy = true; }
          return r.data;
        }
        throw new Error('bad response from ' + inst);
      })
    ));
  } catch(e) {
    throw new Error('All Hi-Fi instances failed');
  }
}

async function hifiGetSafe(path, params) {
  try { return await hifiGet(path, params); } catch(e) { return null; }
}

async function hifiGetForToken(instanceUrl, path, params) {
  if (instanceUrl) {
    try {
      const r = await axios.get(instanceUrl + path, {
        params,
        headers: { 'User-Agent': UA, 'Accept': 'application/json' },
        timeout: 8000
      });
      if (r.status === 200 && r.data) return r.data;
      throw new Error('Non-200 from custom instance: ' + r.status);
    } catch(e) {
      throw new Error('Custom instance failed: ' + instanceUrl + ': ' + e.message);
    }
  }
  return hifiGet(path, params);
}

async function hifiGetForTokenSafe(instanceUrl, path, params) {
  try { return await hifiGetForToken(instanceUrl, path, params); } catch(e) { return null; }
}

// ─── Upstash Redis REST API ───────────────────────────────────────────────────
const UPSTASH_URL = typeof UPSTASH_REDIS_REST_URL !== 'undefined' ? UPSTASH_REDIS_REST_URL : null;
const UPSTASH_TOKEN = typeof UPSTASH_REDIS_REST_TOKEN !== 'undefined' ? UPSTASH_REDIS_REST_TOKEN : null;

async function upstashCmd(...args) {
if (!UPSTASH_URL || !UPSTASH_TOKEN) return null;
try {
const res = await fetch(UPSTASH_URL, {
method: 'POST',
headers: { 'Authorization': 'Bearer ' + UPSTASH_TOKEN, 'Content-Type': 'application/json' },
body: JSON.stringify(args)
});
const json = await res.json();
return json.result ?? null;
} catch(e) { return null; }
}

// Cache successful ISRC matches in Redis with 1 year TTL (ISRCs are permanent identifiers)
async function redisCacheIsrcMatch(isrc, source, matchedId) {
if (!isrc || !matchedId) return;
const norm = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const key = 'mc:isrc:' + norm(isrc);
await upstashCmd('SET', key, JSON.stringify({ source, matchedId }), 'EX', 31536000);
}

// Load cached ISRC match from Redis
async function redisLoadIsrcMatch(isrc) {
if (!isrc) return null;
const norm = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const key = 'mc:isrc:' + norm(isrc);
const raw = await upstashCmd('GET', key);
if (!raw) return null;
try { return JSON.parse(raw); } catch(e) { return null; }
}

async function redisSave(token, entry) {
await upstashCmd('SET', 'mc:token:' + token, JSON.stringify({
createdAt: entry.createdAt,
lastUsed: entry.lastUsed,
reqCount: entry.reqCount || 0,
instanceUrl: entry.instanceUrl || null,
preferredQuality: entry.preferredQuality || null
}), 'EX', 2592000);
}

async function redisLoad(token) {
const raw = await upstashCmd('GET', 'mc:token:' + token);
if (!raw) return null;
try {
const p = JSON.parse(raw);
return {
createdAt: p.createdAt || Date.now(),
lastUsed: p.lastUsed || Date.now(),
reqCount: p.reqCount || 0,
instanceUrl: p.instanceUrl || null,
preferredQuality: p.preferredQuality || null
};
} catch(e) { return null; }
}

// ─── Token auth ───────────────────────────────────────────────────────────────
const TOKEN_CACHE = new Map();
const IP_CREATES = new Map();
const MAX_TOKENS_PER_IP = 10, RATE_MAX = 80, RATE_WINDOW_MS = 60000;

function generateToken() { return crypto.randomBytes(14).toString('hex'); }

function getOrCreateIpBucket(ip) {
var now = Date.now();
var b = IP_CREATES.get(ip);
if (!b || now > b.resetAt) { b = { count: 0, resetAt: now + 86400000 }; IP_CREATES.set(ip, b); }
return b;
}

async function getTokenEntry(token) {
if (TOKEN_CACHE.has(token)) return TOKEN_CACHE.get(token);
var saved = await redisLoad(token);
if (saved) {
var entry = { createdAt: saved.createdAt, lastUsed: saved.lastUsed, reqCount: saved.reqCount, instanceUrl: saved.instanceUrl || null, preferredQuality: saved.preferredQuality || null, rateWin: [] };
TOKEN_CACHE.set(token, entry);
return entry;
}
if (/^[a-f0-9]{28}$/.test(token)) {
var fresh = { createdAt: Date.now(), lastUsed: Date.now(), reqCount: 0, rateWin: [], instanceUrl: null, preferredQuality: null };
TOKEN_CACHE.set(token, fresh);
return fresh;
}
return null;
}

function checkRateLimit(entry) {
var now = Date.now();
entry.rateWin = (entry.rateWin || []).filter(function(t) { return now - t < RATE_WINDOW_MS; });
if (entry.rateWin.length >= RATE_MAX) return false;
entry.rateWin.push(now); entry.lastUsed = now; entry.reqCount = (entry.reqCount || 0) + 1; return true;
}

function getBaseUrl(req) { return (req.headers['x-forwarded-proto'] || req.protocol) + '://' + req.get('host'); }

// ─── withToken ────────────────────────────────────────────────────────────────
async function withToken(c, handler) {
const rawParam = c.req.param('token');
const { token, embeddedInstance } = parseTokenParam(rawParam);
const entry = await getTokenEntry(token);
if (!entry) return Response.json({ error: 'Invalid token.' }, { status: 404 });
if (!checkRateLimit(entry)) return Response.json({ error: 'Rate limit exceeded.' }, { status: 429 });
if (embeddedInstance) entry.instanceUrl = embeddedInstance;
if (entry.reqCount % 20 === 0) await redisSave(token, entry);
return handler(entry);
}

function parseTokenParam(rawParam) {
const tilde = rawParam.indexOf('~');
if (tilde === -1) return { token: rawParam, embeddedInstance: null };
const token = rawParam.slice(0, tilde);
try {
const embeddedInstance = Buffer.from(rawParam.slice(tilde + 1), 'base64url').toString('utf8');
return { token, embeddedInstance };
} catch(e) { return { token, embeddedInstance: null }; }
}

// ─── Config page ──────────────────────────────────────────────────────────────
function buildConfigPage(baseUrl) {
var h = '';
h += '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">';
h += '<meta name="viewport" content="width=device-width,initial-scale=1">';
h += '<title>Claudochrome - TIDAL Addon</title>';
h += '<style>*{box-sizing:border-box;margin:0;padding:0}';
h += 'body{background:#080808;color:#e0e0e0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:48px 20px 64px}';
h += '.card{background:#111;border:1px solid #1e1e1e;border-radius:18px;padding:36px;max-width:540px;width:100%;box-shadow:0 24px 64px rgba(0,0,0,.6);margin-bottom:20px}';
h += 'h1{font-size:22px;font-weight:700;margin-bottom:6px;color:#fff}h2{font-size:16px;font-weight:700;margin-bottom:14px;color:#fff}';
h += 'p.sub{font-size:14px;color:#666;margin-bottom:20px;line-height:1.6}';
h += '.tip{background:#0a0a0a;border:1px solid #1e1e1e;border-radius:10px;padding:12px 14px;margin-bottom:20px;font-size:12px;color:#888;line-height:1.7}.tip b{color:#ccc}';
h += '.pills{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:24px}';
h += '.pill{border-radius:20px;font-size:11px;font-weight:600;padding:4px 10px;background:#181818;color:#aaa;border:1px solid #2a2a2a}';
h += '.pill.hi{background:#0d1520;color:#4a9eff;border-color:#1a3050}';
h += '.lbl{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:#444;margin-bottom:8px;margin-top:16px}';
h += 'input{width:100%;background:#0a0a0a;border:1px solid #1e1e1e;border-radius:10px;color:#e0e0e0;font-size:14px;padding:12px 14px;margin-bottom:6px;outline:none;transition:border-color .15s}';
h += 'input:focus{border-color:#fff}input::placeholder{color:#2e2e2e}';
h += '.hint{font-size:12px;color:#3a3a3a;margin-bottom:12px;line-height:1.7}';
h += 'button{cursor:pointer;border:none;border-radius:10px;font-size:15px;font-weight:700;padding:13px;width:100%;margin-top:6px;margin-bottom:12px;transition:background .15s}';
h += '.bw{background:#fff;color:#000}.bw:hover{background:#e0e0e0}.bw:disabled{background:#1e1e1e;color:#333;cursor:not-allowed}';
h += '.bg{background:#141414;color:#e0e0e0;border:1px solid #2a2a2a}.bg:hover{background:#1e1e1e}.bg:disabled{background:#0f0f0f;color:#333;cursor:not-allowed}';
h += '.bd{background:#0f0f0f;color:#777;border:1px solid #1a1a1a;font-size:13px;padding:10px}.bd:hover{background:#1a1a1a;color:#fff}';
h += '.box{display:none;background:#0a0a0a;border:1px solid #1a1a1a;border-radius:12px;padding:18px;margin-bottom:14px}';
h += '.blbl{font-size:10px;color:#444;text-transform:uppercase;letter-spacing:.07em;margin-bottom:8px}';
h += '.burl{font-size:12px;color:#fff;word-break:break-all;font-family:"SF Mono","Fira Code",monospace;margin-bottom:14px;line-height:1.5}';
h += 'hr{border:none;border-top:1px solid #161616;margin:24px 0}';
h += '.steps{display:flex;flex-direction:column;gap:12px}.step{display:flex;gap:12px;align-items:flex-start}';
h += '.sn{background:#161616;border:1px solid #222;border-radius:50%;width:26px;height:26px;min-width:26px;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:#555}';
h += '.st{font-size:13px;color:#555;line-height:1.6}.st b{color:#999}';
h += '.warn{background:#0d0d0d;border:1px solid #1e1e1e;border-radius:10px;padding:14px;margin-top:20px;font-size:12px;color:#555;line-height:1.7}';
h += '.inst-list{display:flex;flex-direction:column;gap:6px;margin-top:10px}';
h += '.inst{display:flex;align-items:center;gap:8px;font-size:12px;padding:8px 12px;background:#0a0a0a;border:1px solid #161616;border-radius:8px}';
h += '.dot{width:7px;height:7px;border-radius:50%;background:#333;flex-shrink:0}.dot.ok{background:#4a9a4a}.dot.err{background:#c04040}';
h += '.inst-url{flex:1;color:#666;font-family:"SF Mono","Fira Code",monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}';
h += '.inst-ms{color:#444;margin-left:auto;font-size:11px}';
h += '.badge{display:none;background:#0d1a0d;border:1px solid #1a3a1a;border-radius:8px;padding:8px 12px;font-size:12px;color:#4a9a4a;margin-bottom:10px}';
h += '.ql-row{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:6px}';
h += '.ql-btn{flex:1;cursor:pointer;border:1px solid #2a2a2a;border-radius:10px;background:#0a0a0a;color:#555;font-size:12px;font-weight:700;padding:10px 6px;text-align:center;transition:all .15s;letter-spacing:.04em}';
h += '.ql-btn:hover{border-color:#444;color:#aaa}';
h += '.ql-btn.sel{background:#0d1520;border-color:#4a9eff;color:#4a9eff}';
h += 'footer{margin-top:32px;font-size:12px;color:#2a2a2a;text-align:center;line-height:1.8}';
h += '</style></head><body>';
h += '<svg width="52" height="52" viewBox="0 0 52 52" fill="none" style="margin-bottom:22px"><circle cx="26" cy="26" r="26" fill="#fff"/><rect x="10" y="20" width="4" height="12" rx="2" fill="#000"/><rect x="17" y="14" width="4" height="24" rx="2" fill="#000"/><rect x="24" y="18" width="4" height="16" rx="2" fill="#000"/><rect x="31" y="11" width="4" height="30" rx="2" fill="#000"/><rect x="38" y="17" width="4" height="18" rx="2" fill="#000"/></svg>';
h += '<div class="card">';
h += '<h1>Claudochrome for Eclipse</h1>';
h += '<p class="sub">Full Deezer catalog &mdash; lossless FLAC, HiRes, AAC 320 &mdash; no account, no subscription. Artwork/search: Deezer. Streams: Qobuz Hi-Res (24-bit) &rarr; TIDAL via ISRC match (30-day cache).</p>';
h += '<div class="tip"><b>Save your URL.</b> Paste it below to refresh without reinstalling.</div>';
h += '<div class="pills"><span class="pill">Tracks &middot; Albums &middot; Artists</span><span class="pill hi">FLAC / HiRes</span><span class="pill hi">AAC 320</span><span class="pill hi">Qobuz 24-bit</span></div>';
h += '<div class="lbl">Custom Hi&#8209;Fi Instance <span style="color:#2a2a2a;font-weight:400;text-transform:none">(optional)</span></div>';
h += '<input type="text" id="customInstance" placeholder="https://your-instance.example.com">';
h += '<div class="hint">Leave blank to use the shared pool. Paste your own self-hosted Hi-Fi API URL to lock this token exclusively to your instance.</div>';
h += '<div class="lbl">Preferred Audio Quality <span style="color:#2a2a2a;font-weight:400;text-transform:none">(optional)</span></div>';
h += '<div class="ql-row">';
h += '<div class="ql-btn" id="ql-HI_RES_LOSSLESS" onclick="selectQuality(\'HI_RES_LOSSLESS\')">Hi-Res Max<br><span style="font-size:10px;font-weight:400;color:inherit;opacity:.6">TIDAL MAX / MQA</span></div>';
h += '<div class="ql-btn" id="ql-LOSSLESS" onclick="selectQuality(\'LOSSLESS\')">Lossless<br><span style="font-size:10px;font-weight:400;color:inherit;opacity:.6">FLAC 16-bit CD</span></div>';
h += '<div class="ql-btn" id="ql-HIGH" onclick="selectQuality(\'HIGH\')">AAC 320<br><span style="font-size:10px;font-weight:400;color:inherit;opacity:.6">AAC 320 kbps</span></div>';
h += '<div class="ql-btn" id="ql-LOW" onclick="selectQuality(\'LOW\')">AAC 96<br><span style="font-size:10px;font-weight:400;color:inherit;opacity:.6">AAC 96 kbps</span></div>';
h += '</div>';
h += '<div class="hint" id="qlHint">No preference &mdash; addon auto-selects: Qobuz Hi-Res &rarr; TIDAL Lossless &rarr; AAC 320 &rarr; AAC 96.</div>';
h += '<button class="bw" id="genBtn" onclick="generate()">Generate My Addon URL</button>';
h += '<div class="box" id="genBox"><div class="badge" id="genBadge">&#10003; Locked to your custom instance</div><div class="blbl">Your addon URL &mdash; paste into Eclipse</div><div class="burl" id="genUrl"></div><button class="bd" id="copyGenBtn" onclick="copyGen()">Copy URL</button></div>';
h += '<hr>';
h += '<div class="lbl">Refresh existing URL</div>';
h += '<input type="text" id="existingUrl" placeholder="Paste your existing addon URL here">';
h += '<div class="hint">Keeps the same URL active &mdash; nothing to reinstall.</div>';
h += '<button class="bg" id="refBtn" onclick="doRefresh()">Refresh Existing URL</button>';
h += '<div class="box" id="refBox"><div class="blbl">Refreshed &mdash; same URL still works in Eclipse</div><div class="burl" id="refUrl"></div><button class="bd" id="copyRefBtn" onclick="copyRef()">Copy URL</button></div>';
h += '<hr>';
h += '<div class="steps">';
h += '<div class="step"><div class="sn">1</div><div class="st">Generate and copy your URL above</div></div>';
h += '<div class="step"><div class="sn">2</div><div class="st">Open <b>Eclipse</b> &rarr; Settings &rarr; Connections &rarr; Add Connection &rarr; Addon</div></div>';
h += '<div class="step"><div class="sn">3</div><div class="st">Paste your URL and tap Install</div></div>';
h += '<div class="step"><div class="sn">4</div><div class="st">Search Deezer catalog - Qobuz Hi-Res via ISRC match (30-day cache)</div></div>';
h += '</div>';
h += '<div class="warn">Stream priority: <b>Qobuz Hi-Res 24-bit</b> &rarr; TIDAL Lossless/HiRes &rarr; lower quality fallback. Searches/artwork: Deezer catalog. ISRC matches cached 30 days.</div>';
h += '</div>';
h += '<div class="card">';
h += '<h2>Instance Health</h2>';
h += '<p class="sub" style="margin-bottom:14px">Live status of all Hi-Fi API v2.7 instances.</p>';
h += '<div class="inst-list" id="instList"><div style="color:#333;font-size:13px">Checking...</div></div>';
h += '<button class="bg" style="margin-top:14px" onclick="checkHealth()">Refresh Status</button>';
h += '</div>';
h += '<footer>Claudochrome Eclipse Addon v2.5.0 &bull; Deezer catalog + Qobuz/TIDAL ISRC streams (1-year Redis cache)</footer>';
h += '<script>';
h += 'var gu,ru,selQ=null;';
h += 'var QLABELS={"HI_RES_LOSSLESS":"Hi-Res Max (TIDAL MAX / MQA)","LOSSLESS":"Lossless (FLAC 16-bit CD)","HIGH":"AAC 320 kbps","LOW":"AAC 96 kbps"};';
h += 'function selectQuality(q){if(selQ===q)selQ=null;else selQ=q;["HI_RES_LOSSLESS","LOSSLESS","HIGH","LOW"].forEach(function(k){document.getElementById("ql-"+k).classList.toggle("sel",selQ===k);});document.getElementById("qlHint").textContent=selQ?"Preferred: "+QLABELS[selQ]+" \u2014 fallback to lower if unavailable.":"\u00a0No preference \u2014 auto-selects: Qobuz Hi-Res \u2192 TIDAL Lossless \u2192 AAC 320 \u2192 AAC 96.";}';
h += 'function generate(){var btn=document.getElementById("genBtn");btn.disabled=true;btn.textContent="Generating...";var ci=document.getElementById("customInstance").value.trim();while(ci.length&&ci[ci.length-1]=="/")ci=ci.slice(0,-1);var body={};if(ci)body.instanceUrl=ci;if(selQ)body.preferredQuality=selQ;fetch("/generate",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)}).then(function(r){return r.json();}).then(function(d){if(d.error){alert(d.error);btn.disabled=false;btn.textContent="Generate My Addon URL";return;}gu=d.manifestUrl;document.getElementById("genUrl").textContent=gu;document.getElementById("genBadge").style.display=d.usingCustomInstance?"block":"none";document.getElementById("genBox").style.display="block";btn.disabled=false;btn.textContent="Regenerate URL";}).catch(function(e){alert("Error: "+e.message);btn.disabled=false;btn.textContent="Generate My Addon URL";});}';
h += 'function copyGen(){if(!gu)return;navigator.clipboard.writeText(gu).then(function(){var b=document.getElementById("copyGenBtn");b.textContent="Copied!";setTimeout(function(){b.textContent="Copy URL";},1500);});}';
h += 'function doRefresh(){var btn=document.getElementById("refBtn");var eu=document.getElementById("existingUrl").value.trim();if(!eu){alert("Paste your existing addon URL first.");return;}btn.disabled=true;btn.textContent="Refreshing...";fetch("/refresh",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({existingUrl:eu})}).then(function(r){return r.json();}).then(function(d){if(d.error){alert(d.error);btn.disabled=false;btn.textContent="Refresh Existing URL";return;}ru=d.manifestUrl;document.getElementById("refUrl").textContent=ru;document.getElementById("refBox").style.display="block";btn.disabled=false;btn.textContent="Refresh Again";}).catch(function(e){alert("Error: "+e.message);btn.disabled=false;btn.textContent="Refresh Existing URL";});}';
h += 'function copyRef(){if(!ru)return;navigator.clipboard.writeText(ru).then(function(){var b=document.getElementById("copyRefBtn");b.textContent="Copied!";setTimeout(function(){b.textContent="Copy URL";},1500);});}';
h += 'function checkHealth(){var list=document.getElementById("instList");list.innerHTML=\'<div style="color:#333;font-size:13px">Checking...</div>\';fetch("/instances").then(function(r){return r.json();}).then(function(data){list.innerHTML="";data.instances.forEach(function(inst){var row=document.createElement("div");row.className="inst";var dot=document.createElement("span");dot.className=inst.ok?"dot ok":"dot err";var urlSpan=document.createElement("span");urlSpan.className="inst-url";function maskUrl(u){var pre="https://";if(u.startsWith(pre)){var rest=u.slice(pre.length);return pre+rest.slice(0,6)+"\u2022".repeat(Math.max(0,rest.length-6));}return u.slice(0,14)+"\u2022".repeat(Math.max(0,u.length-14));}urlSpan.textContent=maskUrl(inst.url);row.appendChild(dot);row.appendChild(urlSpan);if(inst.ok){var ms=document.createElement("span");ms.className="inst-ms";ms.textContent=inst.ms+"ms";row.appendChild(ms);}list.appendChild(row);});}).catch(function(){list.innerHTML=\'<div style="color:#c04040;font-size:13px">Could not reach server</div>\';});}';
h += 'checkHealth();';
h += '</script></body></html>';
return h;
}

// ─── Routes ───────────────────────────────────────────────────────────────────
app.get('/', async c => {
const baseUrl = (c.req.header('x-forwarded-proto') || 'https') + '://' + c.req.header('host');
return new Response(buildConfigPage(baseUrl), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
});

app.post('/generate', async c => {
const body = await parseBody(c);
const ip = (c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for') || 'unknown').split(',')[0].trim();
const bucket = getOrCreateIpBucket(ip);
if (bucket.count >= MAX_TOKENS_PER_IP) return Response.json({ error: 'Too many tokens from this IP today.' }, { status: 429 });
let instanceUrl = (body && body.instanceUrl) ? String(body.instanceUrl).trim().replace(/\/$/, '') : null;
if (instanceUrl) {
if (!/^https?:\/\//.test(instanceUrl)) return Response.json({ error: 'Instance URL must start with http or https' }, { status: 400 });
try {
await axios.get(instanceUrl + '/search', { params: { s: 'test', limit: 1 }, timeout: 8000 });
} catch(e) { return Response.json({ error: 'Could not reach your instance: ' + e.message }, { status: 400 }); }
}
const VALID_QUALITIES = ['HI_RES_LOSSLESS', 'LOSSLESS', 'HIGH', 'LOW'];
const preferredQuality = (body && body.preferredQuality && VALID_QUALITIES.includes(body.preferredQuality)) ? body.preferredQuality : null;
const token = generateToken();
const entry = { createdAt: Date.now(), lastUsed: Date.now(), reqCount: 0, rateWin: [], instanceUrl, preferredQuality };
TOKEN_CACHE.set(token, entry);
await redisSave(token, entry);
bucket.count++;
const baseUrl = (c.req.header('x-forwarded-proto') || 'https') + '://' + c.req.header('host');
const tokenSegment = instanceUrl ? token + '~' + Buffer.from(instanceUrl).toString('base64url') : token;
return Response.json({ token, manifestUrl: baseUrl + '/u/' + tokenSegment + '/manifest.json', usingCustomInstance: !!instanceUrl, preferredQuality });
});

app.post('/refresh', async c => {
const body = await parseBody(c);
const raw = (body && body.existingUrl) ? String(body.existingUrl).trim() : '';
const segMatch = raw.match(/\/u\/([^/]+)\/manifest\.json/);
const rawSegment = segMatch ? segMatch[1] : raw;
const { token: parsedToken } = parseTokenParam(rawSegment);
const token = parsedToken;
if (!token || !/^[a-f0-9]{28}$/.test(token)) return Response.json({ error: 'Paste your full addon URL.' }, { status: 400 });
const entry = await getTokenEntry(token);
if (!entry) return Response.json({ error: 'URL not found. Generate a new one.' }, { status: 404 });
const baseUrl = (c.req.header('x-forwarded-proto') || 'https') + '://' + c.req.header('host');
const instanceUrl = entry.instanceUrl;
const tokenSegment = instanceUrl ? token + '~' + Buffer.from(instanceUrl).toString('base64url') : token;
return Response.json({ token, manifestUrl: baseUrl + '/u/' + tokenSegment + '/manifest.json', refreshed: true });
});

app.get('/instances', async c => {
  const cached = await upstashCmd('GET', 'instances:health');
  if (cached) return Response.json({ instances: JSON.parse(cached), cached: true });
  const results = await Promise.all(HIFI_INSTANCES.map(async inst => {
    const start = Date.now();
    try {
      await axios.get(inst + '/search', { params: { s: 'test', limit: 1 }, timeout: 6000 });
      return { url: inst, ok: true, ms: Date.now() - start };
    } catch(e) { return { url: inst, ok: false, ms: null }; }
  }));
  await upstashCmd('SET', 'instances:health', JSON.stringify(results), 'EX', 30);
  return Response.json({ instances: results });
});

app.get('/health', c => {
return Response.json({ status: 'ok', version: '2.5.0', activeInstance, instanceHealthy, qobuzBase: activeQobuzInstance, timestamp: new Date().toISOString() });
});

app.get('/u/:token/manifest.json', async c => {
return withToken(c, entry => {
const rawParam = c.req.param('token');
const { token } = parseTokenParam(rawParam);
return Response.json({
id: 'com.eclipse.monochrome.' + token.slice(0, 8),
name: 'Monochrome',
version: '2.3.0',
description: 'Deezer catalog search with exact ISRC matching for stream resolution. Falls back to TIDAL. No account required.',
icon: 'https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcSQeDbvCgGyEcwqhFv8S-Y7ULHa-0FCSHlfJQqpB0CuQs10',
resources: ['search', 'stream', 'catalog'],
types: ['track', 'album', 'artist', 'playlist']
});
});
});

// ─── Search — Deezer catalog only (no caching) ─────────────────────
app.get('/u/:token/search', async c => {
return withToken(c, async entry => {
const q = String(c.req.query('q') || c.req.query('query') || c.req.query('s') || '').trim();
const limit = Math.min(parseInt(c.req.query('limit') || '20', 10) || 20, 50);
if (!q) return Response.json({ tracks: [], albums: [], artists: [], playlists: [] });

try {
// Use Deezer as the primary catalog/search source
const deezerResults = await deezerSearch(q, limit);
const tracks = deezerResults.tracks || [];
const albums = deezerResults.albums || [];
const artists = deezerResults.artists || [];
const playlists = deezerResults.playlists || [];

const result = { tracks, albums, artists, playlists };
return Response.json(result);
} catch(e) {
return Response.json({ error: 'Search failed: ' + e.message, tracks: [], albums: [], artists: [], playlists: [] }, { status: 502 });
}
});
});

// ─── Qobuz client — ISRC exact match for stream resolution ────────────────────
async function qobuzSearchByIsrc(isrc, limit) {
  if (!isrc) return [];
  
  try {
    const r = await axios.get(activeQobuzInstance + '/search', {
      params: { q: 'isrc:' + isrc, limit: Math.min(limit || 10, 50) },
      headers: { 'User-Agent': UA },
      timeout: 8000
    });
    
    const data = r.data || {};
    const tracksData = data.tracks || {};
    const items = (tracksData.items || []).map(item => {
      const t = item?.content || item;
      if (!t || !t.id) return null;
      return {
        id: String(t.id),
        title: t.title || 'Unknown',
        artist: t.performer?.name || 'Unknown',
        isrc: t.isrc || null,
        duration: t.duration || undefined,
        album: t.album?.title || undefined,
        format: 'flac'
      };
    }).filter(Boolean);
    
    return tracksData;
  } catch(e) {
    console.warn('qobuz: ISRC search error', e.message);
    return [];
  }
}

// ─── Stream: Qobuz Hi-Res first (ISRC match), TIDAL fallback ───────────────────
app.get('/u/:token/stream/:id', async c => {
return withToken(c, async entry => {
const tid = c.req.param('id');
const inst = entry.instanceUrl;
const pref = entry.preferredQuality;

return dedupeCall('stream:' + tid + ':' + (inst || 'pool'), async () => {

// Step 1: title+artist from Eclipse query params (some clients send these)
let qTitle = String(c.req.query('title') || '').trim();
let qArtist = String(c.req.query('artist') || '').trim();

// Step 2: get ISRC from query params
let qIsrc = String(c.req.query('isrc') || '').trim() || null;

if (!qTitle && !qIsrc) console.log('meta: no query params for tid', tid, '- skipping ISRC lookup');

// Step 4: Qobuz — ISRC exact match ONLY (no fuzzy matching)
if (qIsrc) {
try {
const norm = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const wantIsrc = norm(qIsrc);

// Check Redis cache for successful ISRC match first
const cachedMatch = await redisLoadIsrcMatch(qIsrc);
let exactMatch = null;

if (cachedMatch && cachedMatch.source === 'qobuz') {
console.log('qobuz: ISRC cache HIT', qIsrc, '->', cachedMatch.matchedId);
// Fetch track details to get title for logging
const qobuzTracks = await qobuzSearchByIsrc(qIsrc, 10);
exactMatch = qobuzTracks.find(t => t.id === cachedMatch.matchedId);
}

if (!exactMatch) {
const qobuzTracks = await qobuzSearchByIsrc(qIsrc, 10);
exactMatch = qobuzTracks.find(t => t.isrc && norm(t.isrc) === wantIsrc);
}

if (exactMatch && exactMatch.id) {
console.log('qobuz: ISRC EXACT MATCH', qIsrc, '->', exactMatch.id, exactMatch.title);
// Cache the successful match in Redis
await redisCacheIsrcMatch(qIsrc, 'qobuz', exactMatch.id);
// Get stream URL via Qobuz API instance /stream endpoint
try {
const qStream = await axios.get(activeQobuzInstance + '/stream/' + exactMatch.id, {
params: { format_id: 27 }, // Try HiRes first (27=192kHz, 7=96kHz, 6=FLAC, 5=MP3)
headers: { 'User-Agent': UA },
timeout: 8000
});
if (qStream.data && qStream.data.url) {
const qQuality = qStream.data.bit_depth >= 24 ? 'hires' : (qStream.data.bit_depth >= 16 ? 'lossless' : 'standard');
return Response.json({ url: qStream.data.url, format: 'flac', quality: qQuality, source: 'qobuz', expiresAt: Math.floor(Date.now() / 1000 + 1680) });
}
} catch(e) {
console.warn('qobuz: stream URL fetch error', e.message);
// Fall through to TIDAL
}
} else {
console.log('qobuz: no exact ISRC match for', qIsrc, '- TIDAL fallback');
}
} catch(e) {
console.warn('qobuz: ISRC lookup error', e.message);
}
} else if (qTitle) {
// Enrich ISRC from Deezer catalog search (Deezer is search/catalog only)
try {
const deezerResults = await deezerSearch((qArtist ? qArtist + ' ' : '') + qTitle, 5);
const tracks = deezerResults.tracks || [];
if (tracks.length > 0 && tracks[0].isrc) {
qIsrc = tracks[0].isrc;
console.log('deezer: enriched ISRC from catalog search', qTitle, '->', qIsrc);
}
} catch(e) {
console.warn('deezer: catalog search error', e.message);
}
}

// Step 5: TIDAL fallback with ISRC matching and caching
const ALL_QUALITIES = ['HI_RES_LOSSLESS', 'LOSSLESS', 'HIGH', 'LOW'];
const AUTO_QUALITIES = ['LOSSLESS', 'HIGH', 'LOW'];
const qualities = pref ? [pref, ...ALL_QUALITIES.filter(q => ALL_QUALITIES.indexOf(q) > ALL_QUALITIES.indexOf(pref))] : AUTO_QUALITIES;

// If we have ISRC, try TIDAL ISRC match first with caching
if (qIsrc) {
try {
const norm = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const wantIsrc = norm(qIsrc);

// Check Redis cache for successful TIDAL ISRC match first
const cachedTidalMatch = await redisLoadIsrcMatch(qIsrc);
let tidalExactMatch = null;

if (cachedTidalMatch && cachedTidalMatch.source === 'tidal') {
console.log('tidal: ISRC cache HIT', qIsrc, '->', cachedTidalMatch.matchedId);
// Use cached matched ID directly
tidalExactMatch = { id: cachedTidalMatch.matchedId };
} else {
// Search TIDAL by ISRC using hifi API
const tidalSearchResult = await hifiGetForToken(inst, '/search', { query: 'isrc:' + qIsrc, limit: 10 });
const tracks = tidalSearchResult?.tracks?.items || tidalSearchResult?.tracks || [];
tidalExactMatch = tracks.find(t => t.isrc && norm(t.isrc) === wantIsrc);
}

if (tidalExactMatch && tidalExactMatch.id) {
console.log('tidal: ISRC EXACT MATCH', qIsrc, '->', tidalExactMatch.id);
// Cache the successful match in Redis
await redisCacheIsrcMatch(qIsrc, 'tidal', tidalExactMatch.id);
// Try to get stream using the matched TIDAL track ID
for (let qi = 0; qi < qualities.length; qi++) {
const ql = qualities[qi];
try {
const data = await hifiGetForToken(inst, '/track', { id: String(tidalExactMatch.id), quality: ql });
const payload = data && data.data ? data.data : data;


if (payload && payload.manifest) {
const decoded = decodeManifest(payload.manifest);
if (decoded && decoded.url) {
const codec = (decoded.codec || '').toLowerCase();
const isFlac = decoded.isDash || codec.includes('flac') || codec.includes('audio/flac');
const qualityLabel = ql === 'HI_RES_LOSSLESS' ? 'hires' : ql === 'LOSSLESS' ? 'lossless' : ql === 'HIGH' ? '320kbps' : '96kbps';
return Response.json({ url: decoded.url, format: isFlac ? 'flac' : 'aac', quality: qualityLabel, codec: decoded.codec || null, expiresAt: Math.floor(Date.now() / 1000 + 3600) });
}
}
if (payload && payload.url) {
const looksLikeFlac = (payload.url || '').match(/\.flac(\?|$)/i);
const isLosslessTier = ql === 'HI_RES_LOSSLESS' || ql === 'LOSSLESS';
return Response.json({ url: payload.url, format: (looksLikeFlac || isLosslessTier) ? 'flac' : 'aac', quality: qualityLabel, expiresAt: Math.floor(Date.now() / 1000 + 3600) });
}
} catch(e) {
// Continue to next quality
}
}
} else {
console.log('tidal: no exact ISRC match for', qIsrc);
}
} catch(e) {
console.warn('tidal: ISRC lookup error', e.message);
}
}

// Original TIDAL fallback by track ID (when ISRC match fails or no ISRC available)
for (let qi = 0; qi < qualities.length; qi++) {
const ql = qualities[qi];
try {
const data = await hifiGetForToken(inst, '/track', { id: tid, quality: ql });
const payload = data && data.data ? data.data : data;
if (payload && payload.manifest) {
const decoded = decodeManifest(payload.manifest);
if (decoded && decoded.url) {
const codec = (decoded.codec || '').toLowerCase();
const isFlac = decoded.isDash || codec.includes('flac') || codec.includes('audio/flac');
const qualityLabel = ql === 'HI_RES_LOSSLESS' ? 'hires' : ql === 'LOSSLESS' ? 'lossless' : ql === 'HIGH' ? '320kbps' : '96kbps';
return Response.json({ url: decoded.url, format: isFlac ? 'flac' : 'aac', quality: qualityLabel, codec: decoded.codec || null, expiresAt: Math.floor(Date.now() / 1000 + 21600) });
}
}
if (payload && payload.url) {
const looksLikeFlac = (payload.url || '').match(/\.flac(\?|$)/i);
const isLosslessTier = ql === 'HI_RES_LOSSLESS' || ql === 'LOSSLESS';
const qualityLabel = ql === 'HI_RES_LOSSLESS' ? 'hires' : ql === 'LOSSLESS' ? 'lossless' : ql === 'HIGH' ? '320kbps' : '96kbps';
return Response.json({ url: payload.url, format: (looksLikeFlac || isLosslessTier) ? 'flac' : 'aac', quality: qualityLabel, expiresAt: Math.floor(Date.now() / 1000 + 21600) });
}
} catch(e) {
if (qi === qualities.length - 1) return Response.json({ error: 'Could not get stream URL for track ' + tid + ': ' + e.message }, { status: 502 });
}
}

return Response.json({ error: 'No stream found for track ' + tid }, { status: 404 });
}); // end dedupeCall

});
});

// ─── Album ────────────────────────────────────────────────────────────────────
app.get('/u/:token/album/:id', async c => {
return withToken(c, async entry => {
const aid = c.req.param('id');
const inst = entry.instanceUrl;
try {
  const data = await hifiGetForToken(inst, '/album', { id: aid, limit: 100, offset: 0 });
  // Unwrap all known HiFi API response shapes
  const album = data?.data?.id ? data.data
    : data?.data?.album?.id ? data.data.album
    : data?.album?.id ? data.album
    : data?.id ? data
    : data?.data ? data.data
    : data;
  // Collect track items — handle every nesting shape the API might return
  let rawItems = album?.items
    || album?.tracks?.items
    || album?.tracks
    || data?.items
    || data?.tracks?.items
    || [];
  if (!Array.isArray(rawItems)) rawItems = [];
  const artistName = album?.artist?.name
    || album?.artists?.map(a => a.name).join(', ')
    || 'Unknown';
  const tracks = rawItems.map((item, i) => {
    const t = item?.item || item;
    // Don't hard-filter on streamReady — TIDAL sometimes incorrectly marks playable tracks false
    if (!t || !t.id) return null;
    const tTitle = t.title || 'Unknown';
    const tArtist = trackArtist(t) || artistName;
    return { id: String(t.id), title: tTitle, artist: tArtist, duration: trackDuration(t), trackNumber: t.trackNumber || i + 1 };
  }).filter(Boolean);
  return Response.json({ id: String(album?.id || aid), title: album?.title || 'Unknown', artist: artistName, year: album?.releaseDate ? String(album.releaseDate).slice(0, 4) : undefined, trackCount: album?.numberOfTracks || tracks.length, tracks });
} catch(e) {
  return Response.json({ error: 'Album fetch failed: ' + e.message }, { status: 502 });
}
});
});

// ─── Artist ───────────────────────────────────────────────────────────────────
app.get('/u/:token/artist/:id', async c => {
  return withToken(c, async entry => {
    const aid = parseInt(c.req.param('id'), 10);
    const inst = entry.instanceUrl;
    if (isNaN(aid)) return Response.json({ error: 'Invalid artist ID' }, { status: 400 });

    // Pick the active base URL (custom instance or pool)
    const base = inst || activeInstance;

    try {
      // ── Step 1: Fire ALL known endpoints in parallel ─────────────────────────
      // Different HiFi instances expose different endpoint shapes/paths.
      // We fire them all at once and merge — zero extra latency vs. sequential.
      const [
        infoRes,       // GET /artist/?id=   — basic artist info
        discRes,       // GET /artist/?f=&skip_tracks=false  — full discography (albums+tracks)
        disc2Res,      // GET /artist/discography/?id=  — alternate discography endpoint
        topRes,        // GET /artist/toptracks/?id=
        albRes,        // GET /artist/albums/?id=  — no filter (returns whatever default is)
        albAlbumsRes,  // GET /artist/albums/?id=&filter=ALBUMS
        albEpsRes,     // GET /artist/albums/?id=&filter=EPSSINGLES
        albCompRes,    // GET /artist/albums/?id=&filter=COMPILATIONS
        albAltRes,     // GET /artist/albums/?artistId=  — some instances use artistId param
        searchRes,     // GET /search/?s=artistName  — fallback
      ] = await Promise.allSettled([
        axios.get(base + '/artist/',         { params: { id: aid },                                    headers: { 'User-Agent': UA, Accept: 'application/json' }, timeout: 12000 }),
        axios.get(base + '/artist/',         { params: { f: aid, skip_tracks: false },                 headers: { 'User-Agent': UA, Accept: 'application/json' }, timeout: 12000 }),
        axios.get(base + '/artist/discography/', { params: { id: aid, limit: 100 },                   headers: { 'User-Agent': UA, Accept: 'application/json' }, timeout: 12000 }),
        axios.get(base + '/artist/toptracks/', { params: { id: aid, limit: 30 },                      headers: { 'User-Agent': UA, Accept: 'application/json' }, timeout: 12000 }),
        axios.get(base + '/artist/albums/',  { params: { id: aid, limit: 100, offset: 0 },            headers: { 'User-Agent': UA, Accept: 'application/json' }, timeout: 12000 }),
        axios.get(base + '/artist/albums/',  { params: { id: aid, filter: 'ALBUMS',       limit: 100 }, headers: { 'User-Agent': UA, Accept: 'application/json' }, timeout: 12000 }),
        axios.get(base + '/artist/albums/',  { params: { id: aid, filter: 'EPSSINGLES',   limit: 100 }, headers: { 'User-Agent': UA, Accept: 'application/json' }, timeout: 12000 }),
        axios.get(base + '/artist/albums/',  { params: { id: aid, filter: 'COMPILATIONS', limit: 100 }, headers: { 'User-Agent': UA, Accept: 'application/json' }, timeout: 12000 }),
        axios.get(base + '/artist/albums/',  { params: { artistId: aid, limit: 100 },                 headers: { 'User-Agent': UA, Accept: 'application/json' }, timeout: 12000 }),
        // search result deferred — we need artistName first, filled below if needed
        Promise.resolve(null),
      ]);

      // ── Step 2: Extract artist info ──────────────────────────────────────────
      const extractData = r => {
        if (!r || r.status !== 'fulfilled' || !r.value) return {};
        return r.value.data?.data || r.value.data || {};
      };

      let artistInfo = {};
      const infoD = extractData(infoRes);
      if      (infoD.artist?.id)   artistInfo = infoD.artist;
      else if (infoD.id && infoD.name) artistInfo = infoD;
      // Fallback: disc response often has artist embedded
      if (!artistInfo.name) {
        const discD = extractData(discRes);
        if      (discD.artist?.id)    artistInfo = discD.artist;
        else if (discD.id && discD.name) artistInfo = discD;
      }
      if (!artistInfo.name) {
        const disc2D = extractData(disc2Res);
        if      (disc2D.artist?.id)     artistInfo = disc2D.artist;
        else if (disc2D.id && disc2D.name) artistInfo = disc2D;
      }

      const artistName = artistInfo.name || 'Unknown';

      // ── Step 3: Merge albums from every source ────────────────────────────────
      const albumMap = {};
      const addAlbums = arr => {
        for (const a of (Array.isArray(arr) ? arr : [])) {
          if (!a?.id) continue;
          albumMap[String(a.id)] = albumMap[String(a.id)] || a;
        }
      };
      const extractAlbums = r => {
        const d = extractData(r);
        if (Array.isArray(d))               return d;
        if (Array.isArray(d.albums))        return d.albums;
        if (Array.isArray(d.albums?.items)) return d.albums.items;
        if (Array.isArray(d.items))         return d.items;
        return [];
      };
      const extractTracks = r => {
        const d = extractData(r);
        if (Array.isArray(d.tracks))        return d.tracks;
        if (Array.isArray(d.tracks?.items)) return d.tracks.items;
        if (Array.isArray(d.items))         return d.items;
        if (Array.isArray(d))               return d;
        return [];
      };

      // Albums from discography endpoints
      addAlbums(extractAlbums(discRes));
      addAlbums(extractAlbums(disc2Res));
      addAlbums(extractAlbums(infoRes));

      // Albums from per-type album endpoints
      for (const r of [albRes, albAlbumsRes, albEpsRes, albCompRes, albAltRes]) {
        addAlbums(extractAlbums(r));
      }

      // If any per-type page came back full (100), fetch page 2
      const albumTypeParams = [
        { filter: undefined },
        { filter: 'ALBUMS' },
        { filter: 'EPSSINGLES' },
        { filter: 'COMPILATIONS' },
      ];
      const page2Fetches = [];
      const typeResults  = [albRes, albAlbumsRes, albEpsRes, albCompRes];
      for (let i = 0; i < typeResults.length; i++) {
        const r = typeResults[i];
        if (r.status !== 'fulfilled') continue;
        const page1 = extractAlbums(r);
        if (page1.length >= 100) {
          const p = { id: aid, limit: 100, offset: 100 };
          if (albumTypeParams[i].filter) p.filter = albumTypeParams[i].filter;
          page2Fetches.push(
            axios.get(base + '/artist/albums/', { params: p, headers: { 'User-Agent': UA, Accept: 'application/json' }, timeout: 12000 })
              .then(r2 => { addAlbums(extractAlbums({ status: 'fulfilled', value: r2 })); })
              .catch(() => {})
          );
        }
      }
      if (page2Fetches.length) await Promise.allSettled(page2Fetches);

      // ── Step 4: Search fallback if albums still empty ────────────────────────
      const trackMap = {};
      const addTracks = arr => {
        for (const t of (Array.isArray(arr) ? arr : [])) {
          if (!t?.id) continue;
          trackMap[String(t.id)] = trackMap[String(t.id)] || t;
        }
      };

      // Tracks from discography
      addTracks(extractTracks(discRes));
      addTracks(extractTracks(disc2Res));
      // Tracks from toptracks
      addTracks(extractTracks(topRes));

      // Search fallback — always run to supplement tracks; albums only if still empty
      try {
        const sr = await axios.get(base + '/search/', {
          params: { s: artistName, limit: 50 },
          headers: { 'User-Agent': UA, Accept: 'application/json' },
          timeout: 12000,
        });
        const sItems = sr.data?.data?.items || sr.data?.items || [];
        const want   = artistName.toLowerCase();
        const isMain = t => {
          const arts = t.artists || (t.artist ? [t.artist] : []);
          if (!arts.length) return false;
          const mains = arts.filter(a => !a.type || a.type === 'MAIN');
          return (mains.length ? mains : [arts[0]]).some(a => {
            const n = (a.name || '').toLowerCase();
            return n === want || n.includes(want) || want.includes(n);
          });
        };
        for (const t of sItems) {
          if (!t?.id) continue;
          const ar = trackArtist(t).toLowerCase();
          if (ar.includes(want) || want.includes(ar)) addTracks([t]);
          if (t.album?.id && isMain(t)) {
            const alId = String(t.album.id);
            albumMap[alId] = albumMap[alId] || {
              id: t.album.id, title: t.album.title,
              releaseDate: t.album.releaseDate, numberOfTracks: t.album.numberOfTracks,
            };
          }
        }
      } catch(_) {}

      // ── Step 5: Build topTracks ───────────────────────────────────────────────
      const seenTrackIds = new Set();
      const topTracks = Object.values(trackMap)
        .filter(t => {
          if (!t?.id || t.allowStreaming === false) return false;
          const k = String(t.id);
          if (seenTrackIds.has(k)) return false;
          seenTrackIds.add(k);
          return true;
        })
        .sort((a, b) => (b.popularity || 0) - (a.popularity || 0))
        .slice(0, 20)
        .map(t => {
          const tTitle  = t.title || 'Unknown';
          const tArtist = trackArtist(t) || artistName;
          return {
            id: String(t.id), title: tTitle, artist: tArtist,
            duration: trackDuration(t),
          };
        });

      // ── Step 6: Build albums ──────────────────────────────────────────────────
      const albums = Object.values(albumMap)
        .sort((a, b) => {
          const ya = a.releaseDate ? parseInt(String(a.releaseDate).slice(0, 4), 10) : 0;
          const yb = b.releaseDate ? parseInt(String(b.releaseDate).slice(0, 4), 10) : 0;
          if (yb !== ya) return yb - ya;
          return (b.releaseDate || '').localeCompare(a.releaseDate || '');
        })
        .map(al => ({
          id: String(al.id), title: al.title || 'Unknown', artist: artistName,
          trackCount: al.numberOfTracks,
          year: al.releaseDate ? String(al.releaseDate).slice(0, 4) : undefined,
        }));

      return Response.json({
        id: String(artistInfo.id || aid), name: artistName,
        bio: null, topTracks, albums,
      });
    } catch(e) {
      return Response.json({ error: 'Artist fetch failed: ' + e.message }, { status: 502 });
    }
  });
});

// ─── Playlist ─────────────────────────────────────────────────────────────────
app.get('/u/:token/playlist/:id', async c => {
return withToken(c, async entry => {
const pid = c.req.param('id');
const inst = entry.instanceUrl;
if (!isPlaylistUUID(pid)) return Response.json({ error: 'Invalid playlist ID. TIDAL playlist IDs must be UUIDs.' }, { status: 404 });
try {
const data = await hifiGetForToken(inst, '/playlist', { id: pid, limit: 100, offset: 0 });
let pl = null, rawItems = [];
if (data.playlist?.uuid || data.playlist?.id) { pl = data.playlist; rawItems = data.items || data.playlist.items || []; }
else if (data.data?.playlist) { pl = data.data.playlist; rawItems = data.data.items || data.items || []; }
else if (data.uuid || data.title) { pl = data; rawItems = data.items || []; }
else if (data.data?.uuid || data.data?.title) { pl = data.data; rawItems = data.data.items || data.items || []; }
else { pl = data; rawItems = data.items || []; }
const tracks = rawItems.map(item => {
const t = item.item || item;
if (!t || !t.id || t.streamReady === false) return null;
const tTitle = t.title || 'Unknown';
const tArtist = trackArtist(t);
return { id: String(t.id), title: tTitle, artist: tArtist, duration: trackDuration(t) };
}).filter(Boolean);
return Response.json({ id: String(pl?.uuid || pl?.id || pid), title: pl?.title || 'Playlist', creator: pl?.creator?.name, trackCount: pl?.numberOfTracks || tracks.length, tracks });
} catch(e) {
return Response.json({ error: 'Playlist fetch failed: ' + e.message }, { status: 502 });
}
});
});

export default app;
