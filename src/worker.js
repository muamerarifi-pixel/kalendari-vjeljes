// Kalendari i Vjeljes — shërbimi i njoftimeve (Cloudflare Worker)
//
// /api/vapid        GET   çelësi publik për abonimin
// /api/subscribe    POST  ruan ose përditëson abonimin dhe zgjedhjet (zonat, llojet, sa ditë para)
// /api/unsubscribe  POST  fshin abonimin
// /api/test         POST  dërgon menjëherë një njoftim provë
// Çdo gjë tjetër shërbehet nga skedarët statikë (public/).
//
// Çdo mëngjes (cron 06:00 dhe 07:00 UTC) dërgohet njoftimi kur ora në Kosovë është 8:00.

const TZ = 'Europe/Belgrade';
const SEND_HOUR = 8;
const ZONES = { pr: 'Prishtinë', op: 'Opojë' };
const CATS = ['f', 'p', 'e'];
const LEADS = [0, 3, 7];
const MON = ['janar', 'shkurt', 'mars', 'prill', 'maj', 'qershor', 'korrik', 'gusht', 'shtator', 'tetor', 'nëntor', 'dhjetor'];
const PUSH_HOSTS = [/\.googleapis\.com$/, /\.mozilla\.com$/, /\.push\.apple\.com$/, /\.notify\.windows\.com$/];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    try {
      if (url.pathname === '/api/vapid' && request.method === 'GET') {
        return json({ key: env.VAPID_PUBLIC_KEY });
      }
      if (request.method !== 'POST') return json({ error: 'Metodë e palejuar' }, 405);
      const body = await readJson(request);
      if (url.pathname === '/api/subscribe') return await subscribe(env, body);
      if (url.pathname === '/api/unsubscribe') return await unsubscribe(env, body);
      if (url.pathname === '/api/test') return await sendTest(env, body);
      if (url.pathname === '/api/dev/run' && env.DEV_ALLOW_ANY_ENDPOINT === '1') return json(await runDaily(env, new Date(body.now || Date.now())));
      return json({ error: 'Nuk u gjet' }, 404);
    } catch (err) {
      return json({ error: err.message || 'Gabim' }, err.status || 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runDaily(env, new Date(event.scheduledTime)));
  }
};

// ---------- HTTP helpers ----------
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  });
}
function httpError(message, status = 400) {
  const e = new Error(message); e.status = status; return e;
}
async function readJson(request) {
  const text = await request.text();
  if (text.length > 4096) throw httpError('Kërkesa është shumë e madhe', 413);
  try { return JSON.parse(text || '{}'); } catch { throw httpError('JSON i pavlefshëm'); }
}

// ---------- subscriptions ----------
function checkEndpoint(env, endpoint) {
  let u;
  try { u = new URL(endpoint); } catch { throw httpError('Adresë njoftimi e pavlefshme'); }
  if (env.DEV_ALLOW_ANY_ENDPOINT === '1') return u;
  if (u.protocol !== 'https:' || !PUSH_HOSTS.some((re) => re.test(u.hostname))) throw httpError('Shërbim njoftimesh i panjohur');
  return u;
}
function cleanSub(env, sub) {
  if (!sub || typeof sub.endpoint !== 'string' || !sub.keys) throw httpError('Abonim i pavlefshëm');
  checkEndpoint(env, sub.endpoint);
  const { p256dh, auth } = sub.keys;
  if (!/^[A-Za-z0-9_-]{80,100}$/.test(p256dh || '') || !/^[A-Za-z0-9_-]{16,32}$/.test(auth || '')) throw httpError('Çelësat e abonimit janë të pavlefshëm');
  return { endpoint: sub.endpoint, keys: { p256dh, auth } };
}
function cleanPrefs(body) {
  const zones = Array.isArray(body.zones) ? [...new Set(body.zones.filter((z) => z in ZONES))] : [];
  const cats = Array.isArray(body.cats) ? [...new Set(body.cats.filter((c) => CATS.includes(c)))] : [];
  const lead = LEADS.includes(Number(body.lead)) ? Number(body.lead) : 0;
  if (!zones.length || !cats.length) throw httpError('Zgjidhni të paktën një zonë dhe një lloj');
  return { zones, cats, lead };
}
async function keyFor(endpoint) {
  const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint));
  return 'sub:' + [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function subscribe(env, body) {
  const sub = cleanSub(env, body.sub);
  const key = await keyFor(sub.endpoint);
  let prev = await env.SUBS.get(key, 'json');
  let prefs;
  if (body.oldEndpoint && !body.zones) {
    // pushsubscriptionchange: kalojmë zgjedhjet nga abonimi i vjetër
    const oldKey = await keyFor(String(body.oldEndpoint));
    const old = await env.SUBS.get(oldKey, 'json');
    if (!old) throw httpError('Abonimi i vjetër nuk u gjet', 404);
    prefs = { zones: old.zones, cats: old.cats, lead: old.lead };
    prev = prev || old;
    if (oldKey !== key) await env.SUBS.delete(oldKey);
  } else {
    prefs = cleanPrefs(body);
  }
  const now = new Date().toISOString();
  const rec = { sub, ...prefs, created: prev?.created || now, updated: now, last: prev?.last || '', lastTest: prev?.lastTest || 0 };
  await env.SUBS.put(key, JSON.stringify(rec));
  return json({ ok: true, ...prefs });
}

async function unsubscribe(env, body) {
  if (typeof body.endpoint !== 'string') throw httpError('Mungon adresa');
  await env.SUBS.delete(await keyFor(body.endpoint));
  return json({ ok: true });
}

async function sendTest(env, body) {
  if (typeof body.endpoint !== 'string') throw httpError('Mungon adresa');
  const key = await keyFor(body.endpoint);
  const rec = await env.SUBS.get(key, 'json');
  if (!rec) throw httpError('Kjo pajisje nuk është e abonuar', 404);
  if (Date.now() - (rec.lastTest || 0) < 30000) throw httpError('Prisni pak para se ta provoni sërish', 429);
  const crops = await loadCrops(env);
  const today = localParts(nowFor(env));
  const next = nextEvent(crops, rec, today);
  const msg = {
    title: 'Njoftimet janë aktive',
    body: next
      ? `Njoftimi i radhës vjen më ${fmt(next.notify)}: ${lc(next.crop.n)} (${ZONES[next.zone]}).`
      : 'Do t’ju njoftojmë në orën 8:00 kur të fillojë vjelja.',
    tag: 'vjelja-test',
    url: './'
  };
  const res = await sendPush(env, rec.sub, msg, 3600);
  if (res.status === 404 || res.status === 410) { await env.SUBS.delete(key); throw httpError('Abonimi ka skaduar. Aktivizoni njoftimet sërish.', 410); }
  if (!res.ok) throw httpError('Shërbimi i njoftimeve u përgjigj me ' + res.status, 502);
  rec.lastTest = Date.now();
  await env.SUBS.put(key, JSON.stringify(rec));
  return json({ ok: true });
}

// ---------- daily run ----------
function nowFor(env) {
  return new Date();
}
async function runDaily(env, now) {
  const today = localParts(now);
  if (today.h !== SEND_HOUR) return { skipped: 'hour', hour: today.h };
  const crops = await loadCrops(env);
  const stamp = isoDate(today);
  let cursor, sent = 0, removed = 0, checked = 0;
  do {
    const page = await env.SUBS.list({ prefix: 'sub:', cursor });
    for (const k of page.keys) {
      const rec = await env.SUBS.get(k.name, 'json');
      if (!rec) continue;
      checked++;
      if (rec.last === stamp) continue;
      const msg = buildMessage(crops, rec, today);
      if (!msg) continue;
      try {
        const res = await sendPush(env, rec.sub, msg, 20 * 3600);
        if (res.status === 404 || res.status === 410) { await env.SUBS.delete(k.name); removed++; continue; }
        if (res.ok) { rec.last = stamp; await env.SUBS.put(k.name, JSON.stringify(rec)); sent++; }
      } catch (e) { /* provojmë nesër sërish */ }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return { date: stamp, checked, sent, removed };
}

// ---------- crops & dates ----------
let cropCache = null;
async function loadCrops(env) {
  if (cropCache) return cropCache;
  const res = await env.ASSETS.fetch(new Request('https://assets.local/crops.json'));
  if (!res.ok) throw new Error('crops.json mungon');
  const data = await res.json();
  const parse = (s) => { const [m, d] = s.split('-').map(Number); return { m, d }; };
  const ranges = (s) => (s ? s.split(',').map((x) => { const [a, b] = x.split('/'); return { a: parse(a), b: parse(b) }; }) : null);
  cropCache = data.map((c) => ({ ...c, pr: ranges(c.pr), op: ranges(c.op) }));
  return cropCache;
}
function localParts(date) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23'
  }).formatToParts(date).map((p) => [p.type, p.value]));
  return { y: +parts.year, m: +parts.month, d: +parts.day, h: +parts.hour };
}
function addDays(p, n) {
  const t = new Date(Date.UTC(p.y, p.m - 1, p.d + n));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}
const isoDate = (p) => `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
const fmt = (p) => `${p.d} ${MON[p.m - 1]}`;
const lc = (s) => s.charAt(0).toLowerCase() + s.slice(1);
const WHEN = { 0: 'sot', 3: 'pas 3 ditësh', 7: 'pas një jave' };

function startsOn(crops, rec, target) {
  const hits = [];
  for (const zone of rec.zones) {
    for (const crop of crops) {
      if (!rec.cats.includes(crop.c) || !crop[zone]) continue;
      for (const r of crop[zone]) {
        if (r.a.m === target.m && r.a.d === target.d) hits.push({ zone, crop, range: r });
      }
    }
  }
  return hits;
}

function buildMessage(crops, rec, today) {
  const lead = rec.lead || 0;
  const target = addDays(today, lead);
  const hits = startsOn(crops, rec, target);
  if (!hits.length) return null;
  const tag = 'vjelja-' + isoDate(target);
  if (hits.length === 1) {
    const { zone, crop, range } = hits[0];
    return {
      title: `${crop.n} · ${ZONES[zone]}`,
      body: lead === 0
        ? `Fillon vjelja sot. Sezoni zgjat deri më ${fmt(range.b)}.`
        : `Vjelja fillon ${WHEN[lead]}, më ${fmt(range.a)}, dhe zgjat deri më ${fmt(range.b)}.`,
      tag,
      url: './#k-' + crop.id
    };
  }
  const byZone = {};
  hits.forEach((h) => { (byZone[h.zone] = byZone[h.zone] || []).push(lc(h.crop.n)); });
  const unique = new Set(hits.map((h) => h.crop.id)).size;
  return {
    title: lead === 0 ? `Fillon vjelja sot: ${unique} kultura` : `Vjelja fillon ${WHEN[lead]}: ${unique} kultura`,
    body: Object.keys(byZone).map((z) => `${ZONES[z]}: ${byZone[z].join(', ')}`).join('\n'),
    tag,
    url: './'
  };
}

function nextEvent(crops, rec, today) {
  // the nearest day (today or later) on which a notification will be sent
  const lead = rec.lead || 0;
  for (let i = 0; i < 366; i++) {
    const notify = addDays(today, i);
    const target = addDays(notify, lead);
    const hits = startsOn(crops, rec, target);
    if (hits.length) return { notify, zone: hits[0].zone, crop: hits[0].crop };
  }
  return null;
}

// ---------- Web Push (RFC 8291 + VAPID RFC 8292) ----------
const enc = (s) => new TextEncoder().encode(s);
function b64uDecode(s) {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}
function b64uEncode(bytes) {
  let s = ''; bytes.forEach((b) => { s += String.fromCharCode(b); });
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function concat(...arrs) {
  const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0));
  let o = 0; arrs.forEach((a) => { out.set(a, o); o += a.length; });
  return out;
}
async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8));
}

async function encryptPayload(p256dh, authSecret, plaintext) {
  const uaPublic = b64uDecode(p256dh);
  const auth = b64uDecode(authSecret);
  const asKeys = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', asKeys.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, asKeys.privateKey, 256));
  const ikm = await hkdf(auth, shared, concat(enc('WebPush: info\x00'), uaPublic, asPublic), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc('Content-Encoding: aes128gcm\x00'), 16);
  const nonce = await hkdf(salt, ikm, enc('Content-Encoding: nonce\x00'), 12);
  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, concat(plaintext, new Uint8Array([2]))));
  const header = new Uint8Array(21 + asPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = asPublic.length;
  header.set(asPublic, 21);
  return concat(header, cipher);
}

let signingKey = null;
async function vapidKey(env) {
  if (signingKey) return signingKey;
  const pub = b64uDecode(env.VAPID_PUBLIC_KEY);
  const jwk = { kty: 'EC', crv: 'P-256', d: env.VAPID_PRIVATE_KEY, x: b64uEncode(pub.slice(1, 33)), y: b64uEncode(pub.slice(33, 65)), ext: true };
  signingKey = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  return signingKey;
}
async function vapidJwt(env, audience) {
  const header = b64uEncode(enc(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64uEncode(enc(JSON.stringify({ aud: audience, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: env.VAPID_SUBJECT })));
  const input = `${header}.${claims}`;
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, await vapidKey(env), enc(input)));
  return `${input}.${b64uEncode(sig)}`;
}

async function sendPush(env, sub, message, ttl) {
  const endpoint = checkEndpoint(env, sub.endpoint);
  const jwt = await vapidJwt(env, endpoint.origin);
  const body = await encryptPayload(sub.keys.p256dh, sub.keys.auth, enc(JSON.stringify(message)));
  return fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      TTL: String(ttl),
      Urgency: 'normal',
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      Authorization: `vapid t=${jwt}, k=${env.VAPID_PUBLIC_KEY}`,
      Topic: (message.tag || 'vjelja').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32)
    },
    body
  });
}
