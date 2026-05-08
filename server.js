import express from 'express';
import axios from 'axios';
import compression from 'compression';
import crypto from 'crypto';
import { XMLParser } from 'fast-xml-parser';

const app = express();
const PORT = process.env.PORT || 3000;

const FLIX_BASE_URL = (process.env.FLIX_BASE_URL || '').replace(/\/$/, '');
const CATALOG_ID = process.env.CATALOG_ID || 'vavoo-country-spain-live';
const EPG_URL = process.env.EPG_URL || 'https://raw.githubusercontent.com/davidmuma/EPG_dobleM/master/guiatv.xml';
const USER_AGENT = process.env.USER_AGENT || 'Mozilla/5.0 (compatible; FlixTiviMateBridge/1.0)';
const REQUEST_TIMEOUT = Number(process.env.REQUEST_TIMEOUT || 15000);
const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY || 6));
const STREAM_NAME = process.env.STREAM_NAME || 'Flix-Streams';

const CATALOG_TTL_MS = Number(process.env.CATALOG_TTL_MS || 1000 * 60 * 15);
const STREAM_TTL_MS = Number(process.env.STREAM_TTL_MS || 1000 * 60 * 45);
const EPG_TTL_MS = Number(process.env.EPG_TTL_MS || 1000 * 60 * 60 * 6);
const PLAYLIST_TTL_MS = Number(process.env.PLAYLIST_TTL_MS || 1000 * 60 * 15);

if (!FLIX_BASE_URL) {
  console.warn('Missing FLIX_BASE_URL env var');
}

app.disable('x-powered-by');
app.use(compression());

const http = axios.create({
  timeout: REQUEST_TIMEOUT,
  headers: {
    'User-Agent': USER_AGENT,
    'Accept-Encoding': 'gzip, deflate, br'
  }
});

const state = {
  catalog: { ts: 0,  null, promise: null },
  epg: { ts: 0, channels: null, raw: null, promise: null },
  streams: new Map(),
  playlist: {
    ts: 0,
    m3u: null,
    channels: null,
    etag: null,
    promise: null,
    lastError: null
  }
};

function now() {
  return Date.now();
}

function isFresh(ts, ttl) {
  return ts && (now() - ts < ttl);
}

function sha1(input) {
  return crypto.createHash('sha1').update(input).digest('hex');
}

function normalizeName(name = '') {
  return name
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\\([^)]*\\)/g, ' ')
    .replace(/\b(HD|FHD|UHD|SD|4K|HEVC|H265|H264|BACKUP|LAT|CAST|ESPANOL|ESPAÑOL)\b/gi, ' ')
    .replace(/\bTVE\b/gi, 'LA 1')
    .replace(/\bM\.?\+\b/gi, 'MOVISTAR PLUS')
    .replace(/\bMOVISTAR\+\b/gi, 'MOVISTAR PLUS')
    .replace(/\bM\.ACCION\b/gi, 'MOVISTAR ACCION')
    .replace(/\bM\.DEPORTES\b/gi, 'MOVISTAR DEPORTES')
    .replace(/\bM\.ESTRENOS\b/gi, 'MOVISTAR ESTRENOS')
    .replace(/\bM\.LIGA DE CAMPEONES\b/gi, 'MOVISTAR LIGA DE CAMPEONES')
    .replace(/\bM\+ LALIGA\b/gi, 'MOVISTAR LALIGA')
    .replace(/\bFDF\b/gi, 'FACTORIA DE FICCION')
    .replace(/\bLA SEXTA\b/gi, 'LASEXTA')
    .replace(/\b24 HORAS\b/gi, 'CANAL 24 HORAS')
    .replace(/[^A-Z0-9]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

function tokenize(name = '') {
  return new Set(normalizeName(name).split(' ').filter(Boolean));
}

function scoreMatch(a, b) {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (!na || !nb) return 0;
  if (na === nb) return 100;
  if (na.includes(nb) || nb.includes(na)) return 90;

  const ta = tokenize(a);
  const tb = tokenize(b);
  const inter = [...ta].filter(x => tb.has(x)).length;
  const union = new Set([...ta, ...tb]).size || 1;
  let score = Math.round((inter / union) * 70);

  const boosts = [
    ['LALIGA', 12],
    ['MOVISTAR', 8],
    ['DAZN', 10],
    ['TELECINCO', 10],
    ['ANTENA', 10],
    ['CUATRO', 10],
    ['LASEXTA', 10],
    ['HOLLYWOOD', 8],
    ['AMC', 8],
    ['EUROSPORT', 8],
    ['AXN', 8],
    ['F1', 10]
  ];

  for (const [term, bonus] of boosts) {
    if (na.includes(term) && nb.includes(term)) score += bonus;
  }

  return Math.min(score, 99);
}

const OVERRIDES = {
  'TVE LA 1 MADRID': { epgQuery: 'LA 1' },
  'LA 1': { epgQuery: 'LA 1' },
  'LA 1 HD': { epgQuery: 'LA 1' },
  'TELECINCO': { epgQuery: 'TELECINCO' },
  'TELECINCO HD': { epgQuery: 'TELECINCO' },
  'ANTENA 3': { epgQuery: 'ANTENA 3' },
  'ANTENA 3 HD': { epgQuery: 'ANTENA 3' },
  'CUATRO': { epgQuery: 'CUATRO' },
  'CUATRO HD': { epgQuery: 'CUATRO' },
  'LASEXTA': { epgQuery: 'LA SEXTA' },
  'LA SEXTA': { epgQuery: 'LA SEXTA' },
  'LA SEXTA HD': { epgQuery: 'LA SEXTA' },
  'CANAL 24 HORAS': { epgQuery: 'CANAL 24 HORAS' },
  'TELEDEPORTE': { epgQuery: 'TELEDEPORTE' },
  'MEGA': { epgQuery: 'MEGA' },
  'NOVA': { epgQuery: 'NOVA' },
  'DMAX': { epgQuery: 'DMAX' },
  'ENERGY': { epgQuery: 'ENERGY' },
  'FACTORIA DE FICCION': { epgQuery: 'FACTORIA DE FICCION' },
  'MOVISTAR F1': { epgQuery: 'DAZN F1' },
  'DAZN F1': { epgQuery: 'DAZN F1' },
  'DAZN 1': { epgQuery: 'DAZN 1' },
  'DAZN 2': { epgQuery: 'DAZN 2' },
  'MOVISTAR LALIGA': { epgQuery: 'MOVISTAR LALIGA' },
  'MOVISTAR LA LIGA': { epgQuery: 'MOVISTAR LALIGA' },
  'MOVISTAR LA LIGA BACKUP': { epgQuery: 'MOVISTAR LALIGA' },
  'M LIGA DE CAMPEONES': { epgQuery: 'MOVISTAR LIGA DE CAMPEONES' },
  'MOVISTAR LIGA DE CAMPEONES': { epgQuery: 'MOVISTAR LIGA DE CAMPEONES' },
  'MOVISTAR DEPORTES': { epgQuery: 'MOVISTAR DEPORTES' },
  'MOVISTAR ESTRENOS': { epgQuery: 'MOVISTAR ESTRENOS' },
  'MOVISTAR SERIES': { epgQuery: 'MOVISTAR SERIES' },
  'MOVISTAR COMEDIA': { epgQuery: 'MOVISTAR COMEDIA' },
  'MOVISTAR DRAMA': { epgQuery: 'MOVISTAR DRAMA' },
  'MOVISTAR ACCION': { epgQuery: 'MOVISTAR ACCION' },
  'CANAL COCINA': { epgQuery: 'CANAL COCINA' },
  'CANAL DECASA': { epgQuery: 'DECASA' },
  'DECASA': { epgQuery: 'DECASA' },
  'HISTORIA': { epgQuery: 'HISTORIA' },
  'AMC': { epgQuery: 'AMC' },
  'AMC BREAK': { epgQuery: 'AMC BREAK' },
  'AXN': { epgQuery: 'AXN' },
  'AXN HD': { epgQuery: 'AXN' },
  'AXN MOVIES': { epgQuery: 'AXN MOVIES' },
  'CALLE 13': { epgQuery: 'CALLE 13' },
  'WARNER TV': { epgQuery: 'WARNER TV' },
  'SYFY': { epgQuery: 'SYFY' },
  'SYFY HD': { epgQuery: 'SYFY' },
  'HOLLYWOOD': { epgQuery: 'HOLLYWOOD' },
  'CANAL HOLLYWOOD': { epgQuery: 'HOLLYWOOD' },
  'TCM': { epgQuery: 'TCM' },
  'EUROSPORT 1': { epgQuery: 'EUROSPORT 1' },
  'EUROSPORT 1 HD': { epgQuery: 'EUROSPORT 1' },
  'REAL MADRID TV': { epgQuery: 'REAL MADRID TV' },
  'GOL': { epgQuery: 'GOL' },
  'GOL TV': { epgQuery: 'GOL' }
};

function findEpgByExactName(epgChannels, query) {
  const nq = normalizeName(query);
  return epgChannels.find(ch => normalizeName(ch.name) === nq) || null;
}

function chooseEpg(channelName, epgChannels) {
  const normalized = normalizeName(channelName);
  const override = OVERRIDES[normalized];

  if (override?.tvgId) {
    const byId = epgChannels.find(ch => ch.id === override.tvgId);
    if (byId) return { ...byId, score: 100, override: true };
  }

  if (override?.epgQuery) {
    const direct = findEpgByExactName(epgChannels, override.epgQuery);
    if (direct) return { ...direct, score: 100, override: true };
  }

  let best = null;
  let bestScore = 0;
  for (const epg of epgChannels) {
    const score = scoreMatch(channelName, epg.name);
    if (score > bestScore) {
      best = epg;
      bestScore = score;
    }
  }

  if (bestScore >= 55) return { ...best, score: bestScore, override: false };
  return null;
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let index = 0;

  async function worker() {
    while (true) {
      const current = index++;
      if (current >= items.length) break;
      results[current] = await fn(items[current], current);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function fetchCatalogFresh() {
  const url = `${FLIX_BASE_URL}/catalog/tv/${CATALOG_ID}.json`;
  const { data } = await http.get(url);
  return Array.isArray(data?.metas) ? data.metas : [];
}

async function getCatalog(force = false) {
  if (!force && state.catalog.data && isFresh(state.catalog.ts, CATALOG_TTL_MS)) {
    return state.catalog.data;
  }

  if (state.catalog.promise) return state.catalog.promise;

  state.catalog.promise = (async () => {
    try {
      const data = await fetchCatalogFresh();
      state.catalog = { ts: now(), data, promise: null };
      return data;
    } catch (error) {
      state.catalog.promise = null;
      if (state.catalog.data) return state.catalog.data;
      throw error;
    }
  })();

  return state.catalog.promise;
}

async function fetchEpgFresh() {
  const {  xml } = await http.get(EPG_URL, { responseType: 'text' });
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
  const parsed = parser.parse(xml);

  const channelsRaw = parsed?.tv?.channel
    ? (Array.isArray(parsed.tv.channel) ? parsed.tv.channel : [parsed.tv.channel])
    : [];

  const channels = channelsRaw.map(ch => {
    const displayNameNode = Array.isArray(ch['display-name']) ? ch['display-name'][0] : ch['display-name'];
    const iconNode = ch.icon;
    const iconSrc = Array.isArray(iconNode) ? iconNode[0]?.['@_src'] : iconNode?.['@_src'];
    const name = typeof displayNameNode === 'string' ? displayNameNode : displayNameNode?.['#text'] || '';

    return {
      id: ch['@_id'] || '',
      name,
      logo: iconSrc || ''
    };
  }).filter(x => x.id && x.name);

  return { raw: xml, channels };
}

async function getEpg(force = false) {
  if (!force && state.epg.channels && isFresh(state.epg.ts, EPG_TTL_MS)) {
    return { raw: state.epg.raw, channels: state.epg.channels };
  }

  if (state.epg.promise) return state.epg.promise;

  state.epg.promise = (async () => {
    try {
      const data = await fetchEpgFresh();
      state.epg = { ts: now(), raw: data.raw, channels: data.channels, promise: null };
      return data;
    } catch (error) {
      state.epg.promise = null;
      if (state.epg.channels) return { raw: state.epg.raw, channels: state.epg.channels };
      throw error;
    }
  })();

  return state.epg.promise;
}

async function fetchStreamFresh(id) {
  const url = `${FLIX_BASE_URL}/stream/tv/${encodeURIComponent(id)}.json`;
  const { data } = await http.get(url);
  return Array.isArray(data?.streams) ? data.streams : [];
}

async function getStream(id, force = false) {
  const existing = state.streams.get(id);

  if (!force && existing?.data && isFresh(existing.ts, STREAM_TTL_MS)) {
    return existing.data;
  }

  if (existing?.promise) return existing.promise;

  const promise = (async () => {
    try {
      const data = await fetchStreamFresh(id);
      state.streams.set(id, { ts: now(), data, promise: null });
      return data;
    } catch (error) {
      const fallback = state.streams.get(id);
      if (fallback?.data) {
        state.streams.set(id, { ...fallback, promise: null });
        return fallback.data;
      }
      state.streams.delete(id);
      throw error;
    }
  })();

  state.streams.set(id, { ts: existing?.ts || 0,  existing?.data || null, promise });
  return promise;
}

function dedupeChannels(channels) {
  const seen = new Map();

  for (const ch of channels) {
    const key = normalizeName(ch.name);
    const current = seen.get(key);

    if (!current) {
      seen.set(key, ch);
      continue;
    }

    const currentScore =
      (current.matchScore || 0) +
      (current.override ? 20 : 0) +
      (/HD/i.test(current.name) ? 10 : 0) -
      (/BACKUP/i.test(current.name) ? 15 : 0);

    const newScore =
      (ch.matchScore || 0) +
      (ch.override ? 20 : 0) +
      (/HD/i.test(ch.name) ? 10 : 0) -
      (/BACKUP/i.test(ch.name) ? 15 : 0);

    if (newScore > currentScore) {
      seen.set(key, ch);
    }
  }

  return [...seen.values()];
}

async function buildChannelsFresh() {
  const [{ channels: epgChannels }, catalog] = await Promise.all([
    getEpg(),
    getCatalog()
  ]);

  const resolved = await mapLimit(catalog, CONCURRENCY, async meta => {
    try {
      const streams = await getStream(meta.id);
      const playable = streams.find(s => s.url) || streams[0];
      if (!playable?.url) return null;

      const epg = chooseEpg(meta.name, epgChannels);

      return {
        id: meta.id,
        name: meta.name,
        logo: epg?.logo || meta.poster || '',
        poster: meta.poster || '',
        group: 'Spain',
        tvgId: epg?.id || '',
        epgName: epg?.name || '',
        matchScore: epg?.score || 0,
        override: Boolean(epg?.override),
        title: playable.title || meta.name,
        url: playable.url,
        source: playable.name || STREAM_NAME,
        notWebReady: Boolean(playable.behaviorHints?.notWebReady)
      };
    } catch {
      return null;
    }
  });

  return dedupeChannels(resolved.filter(Boolean));
}

async function buildPlaylistSnapshot(force = false) {
  if (!force && state.playlist.m3u && isFresh(state.playlist.ts, PLAYLIST_TTL_MS)) {
    return state.playlist;
  }

  if (state.playlist.promise) return state.playlist.promise;

  state.playlist.promise = (async () => {
    try {
      const channels = await buildChannelsFresh();
      const lines = [`#EXTM3U x-tvg-url="${EPG_URL}"`];

      for (const ch of channels) {
        const attrs = [
          `tvg-id="${(ch.tvgId || '').replace(/"/g, '')}"`,
          `tvg-name="${(ch.name || '').replace(/"/g, '')}"`,
          `tvg-logo="${(ch.logo || '').replace(/"/g, '')}"`,
          `group-title="${(ch.group || 'TV').replace(/"/g, '')}"`
        ].join(' ');

        lines.push(`#EXTINF:-1 ${attrs},${ch.name}`);
        lines.push(ch.url);
      }

      const m3u = lines.join('\n');
      const etag = `"${sha1(m3u)}"`;

      state.playlist = {
        ts: now(),
        m3u,
        channels,
        etag,
        promise: null,
        lastError: null
      };

      return state.playlist;
    } catch (error) {
      if (state.playlist.m3u) {
        state.playlist.promise = null;
        state.playlist.lastError = error.message;
        return state.playlist;
      }
      state.playlist.promise = null;
      state.playlist.lastError = error.message;
      throw error;
    }
  })();

  return state.playlist.promise;
}

function refreshPlaylistInBackground() {
  if (state.playlist.promise) return;
  buildPlaylistSnapshot(true).catch(err => {
    state.playlist.lastError = err.message;
  });
}

function setCacheHeaders(res, seconds, etag = null) {
  res.setHeader('Cache-Control', `public, max-age=${seconds}, stale-while-revalidate=${seconds}`);
  if (etag) res.setHeader('ETag', etag);
}

function maybeSend304(req, res, etag) {
  const inm = req.headers['if-none-match'];
  if (etag && inm && inm === etag) {
    res.status(304).end();
    return true;
  }
  return false;
}

app.get('/health', (_, res) => {
  res.json({
    ok: true,
    service: 'flix-tivimate-bridge',
    cache: {
      catalogFresh: isFresh(state.catalog.ts, CATALOG_TTL_MS),
      epgFresh: isFresh(state.epg.ts, EPG_TTL_MS),
      playlistFresh: isFresh(state.playlist.ts, PLAYLIST_TTL_MS),
      streamCacheSize: state.streams.size,
      lastPlaylistError: state.playlist.lastError || null
    }
  });
});

app.get('/channels.json', async (req, res) => {
  try {
    const snapshot = await buildPlaylistSnapshot(false);
    setCacheHeaders(res, 300, snapshot.etag);
    if (maybeSend304(req, res, snapshot.etag)) return;

    res.json({
      count: snapshot.channels.length,
      generatedAt: new Date(snapshot.ts).toISOString(),
      cached: isFresh(snapshot.ts, PLAYLIST_TTL_MS),
      channels: snapshot.channels
    });

    if (!isFresh(snapshot.ts, PLAYLIST_TTL_MS)) {
      refreshPlaylistInBackground();
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/playlist.m3u', async (req, res) => {
  try {
    const snapshot = await buildPlaylistSnapshot(false);
    setCacheHeaders(res, 300, snapshot.etag);
    if (maybeSend304(req, res, snapshot.etag)) return;

    res.setHeader('Content-Type', 'audio/x-mpegurl; charset=utf-8');
    res.send(snapshot.m3u);

    if (!isFresh(snapshot.ts, PLAYLIST_TTL_MS)) {
      refreshPlaylistInBackground();
    }
  } catch (error) {
    res.status(500).type('text/plain').send(`Error: ${error.message}`);
  }
});

app.get('/epg.xml', async (req, res) => {
  try {
    const epg = await getEpg(false);
    const etag = `"${sha1(epg.raw)}"`;

    setCacheHeaders(res, 1800, etag);
    if (maybeSend304(req, res, etag)) return;

    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.send(epg.raw);
  } catch (error) {
    res.status(500).type('text/plain').send(`Error: ${error.message}`);
  }
});

app.get('/refresh', async (_, res) => {
  refreshPlaylistInBackground();
  res.json({ ok: true, message: 'Refresh started in background' });
});

app.get('/', (_, res) => {
  const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Flix TiviMate Bridge</title>
  <style>
    body{font-family:Arial,sans-serif;margin:40px;background:#111;color:#eee}
    a{color:#7dd3fc}
    code{background:#222;padding:2px 6px;border-radius:4px}
    li{margin:8px 0}
  </style>
</head>
<body>
  <h1>Flix TiviMate Bridge</h1>
  <p>Endpoints disponibles:</p>
  <ul>
    <li><a href="/playlist.m3u">/playlist.m3u</a></li>
    <li><a href="/epg.xml">/epg.xml</a></li>
    <li><a href="/channels.json">/channels.json</a></li>
    <li><a href="/health">/health</a></li>
    <li><a href="/refresh">/refresh</a></li>
  </ul>
  <p>Optimizado con caché, compresión y refresh en background.</p>
</body>
</html>`;
  res.send(html);
});

buildPlaylistSnapshot(true).catch(err => {
  state.playlist.lastError = err.message;
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
