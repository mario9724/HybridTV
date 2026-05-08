import express from 'express';
import axios from 'axios';
import { XMLParser } from 'fast-xml-parser';

const app = express();
const PORT = process.env.PORT || 3000;
const FLIX_BASE_URL = (process.env.FLIX_BASE_URL || '').replace(/\/$/, '');
const CATALOG_ID = process.env.CATALOG_ID || 'vavoo-country-spain-live';
const EPG_URL = process.env.EPG_URL || 'https://raw.githubusercontent.com/davidmuma/EPG_dobleM/master/guiatv.xml';
const USER_AGENT = process.env.USER_AGENT || 'Mozilla/5.0 (compatible; FlixTiviMateBridge/1.0)';
const REQUEST_TIMEOUT = Number(process.env.REQUEST_TIMEOUT || 15000);
const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY || 8));
const STREAM_NAME = process.env.STREAM_NAME || 'Flix-Streams';

if (!FLIX_BASE_URL) {
  console.warn('Missing FLIX_BASE_URL env var');
}

const http = axios.create({
  timeout: REQUEST_TIMEOUT,
  headers: { 'User-Agent': USER_AGENT }
});

const cache = {
  epg: { ts: 0, data: null },
  playlist: { ts: 0, data: null },
  channels: { ts: 0, data: null }
};

const TTL_MS = 1000 * 60 * 15;

function normalizeName(name = '') {
  return name
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\([^)]*\)/g, ' ')
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
    ['LALIGA', 12], ['MOVISTAR', 8], ['DAZN', 10], ['TELECINCO', 10], ['ANTENA', 10],
    ['CUATRO', 10], ['LASEXTA', 10], ['HOLLYWOOD', 8], ['AMC', 8], ['EUROSPORT', 8], ['AXN', 8], ['F1', 10]
  ];
  for (const [term, bonus] of boosts) {
    if (na.includes(term) && nb.includes(term)) score += bonus;
  }
  return Math.min(score, 99);
}

async function fetchCatalog() {
  const url = `${FLIX_BASE_URL}/catalog/tv/${CATALOG_ID}.json`;
  const { data } = await http.get(url);
  return Array.isArray(data?.metas) ? data.metas : [];
}

async function fetchStream(id) {
  const url = `${FLIX_BASE_URL}/stream/tv/${encodeURIComponent(id)}.json`;
  const { data } = await http.get(url);
  return Array.isArray(data?.streams) ? data.streams : [];
}

async function mapLimit(items, limit, fn) {
  const results = [];
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function fetchEpgData() {
  if (cache.epg.data && Date.now() - cache.epg.ts < TTL_MS) return cache.epg.data;
  const { data: xml } = await http.get(EPG_URL, { responseType: 'text' });
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
  const parsed = parser.parse(xml);
  const channelsRaw = parsed?.tv?.channel ? (Array.isArray(parsed.tv.channel) ? parsed.tv.channel : [parsed.tv.channel]) : [];
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
  cache.epg = { ts: Date.now(), data: channels };
  return channels;
}

function chooseEpg(channelName, epgChannels) {
  let best = null;
  let bestScore = 0;
  for (const epg of epgChannels) {
    const score = scoreMatch(channelName, epg.name);
    if (score > bestScore) {
      best = epg;
      bestScore = score;
    }
  }
  if (bestScore >= 55) return { ...best, score: bestScore };
  return null;
}

async function buildChannels() {
  if (cache.channels.data && Date.now() - cache.channels.ts < TTL_MS) return cache.channels.data;
  const [catalog, epgChannels] = await Promise.all([fetchCatalog(), fetchEpgData()]);
  const channels = await mapLimit(catalog, CONCURRENCY, async meta => {
    try {
      const streams = await fetchStream(meta.id);
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
        title: playable.title || meta.name,
        url: playable.url,
        source: playable.name || STREAM_NAME,
        notWebReady: Boolean(playable.behaviorHints?.notWebReady)
      };
    } catch (error) {
      return null;
    }
  });
  const clean = channels.filter(Boolean);
  cache.channels = { ts: Date.now(), data: clean };
  return clean;
}

async function buildPlaylist() {
  if (cache.playlist.data && Date.now() - cache.playlist.ts < TTL_MS) return cache.playlist.data;
  const channels = await buildChannels();
  const lines = ['#EXTM3U x-tvg-url="' + EPG_URL + '"'];
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
  const playlist = lines.join('\n');
  cache.playlist = { ts: Date.now(), data: playlist };
  return playlist;
}

app.get('/health', (_, res) => {
  res.json({ ok: true, service: 'flix-tivimate-bridge' });
});

app.get('/channels.json', async (_, res) => {
  try {
    const channels = await buildChannels();
    res.json({ count: channels.length, channels });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/playlist.m3u', async (_, res) => {
  try {
    const playlist = await buildPlaylist();
    res.setHeader('Content-Type', 'audio/x-mpegurl; charset=utf-8');
    res.send(playlist);
  } catch (error) {
    res.status(500).type('text/plain').send(`Error: ${error.message}`);
  }
});

app.get('/epg.xml', async (_, res) => {
  try {
    const { data } = await http.get(EPG_URL, { responseType: 'text' });
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.send(data);
  } catch (error) {
    res.status(500).type('text/plain').send(`Error: ${error.message}`);
  }
});

app.get('/', async (_, res) => {
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Flix TiviMate Bridge</title><style>body{font-family:Arial,sans-serif;margin:40px;background:#111;color:#eee}a{color:#7dd3fc}code{background:#222;padding:2px 6px;border-radius:4px}li{margin:8px 0}</style></head><body><h1>Flix TiviMate Bridge</h1><p>Endpoints disponibles:</p><ul><li><a href="/playlist.m3u">/playlist.m3u</a></li><li><a href="/epg.xml">/epg.xml</a></li><li><a href="/channels.json">/channels.json</a></li><li><a href="/health">/health</a></li></ul><p>Usa <code>/playlist.m3u</code> en TiviMate y el EPG externo con <code>/epg.xml</code> o el XMLTV original.</p></body></html>`;
  res.send(html);
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
