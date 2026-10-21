// F1 25 telemetry relay: UDP (game) -> Server-Sent Events (browser). No npm install needed.
// Run:  node server.js          (live from the game)
//       node server.js --demo   (fake data to test the dashboard)
// Optional: --http-port 3000  --udp-port 20777  --data-dir <folder>  --piper-dir <folder>
//           (or the environment variables F1T_HTTP_PORT, F1T_UDP_PORT, F1T_DATA_DIR, F1T_PIPER_DIR)
// Completed laps are saved to laps.csv in the data folder (default: next to this file; demo laps go to laps-demo.csv),
// and each lap's trace (speed/throttle/brake/position over distance) to traces/ (demo: traces-demo/).
// The race engineer can speak with a local Piper neural voice: see /tts below and README.md.
const dgram = require('dgram'), http = require('http'), fs = require('fs'), path = require('path');
const crypto = require('crypto'), { spawn } = require('child_process');
const arg = name => { const i = process.argv.indexOf('--' + name); return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : null; };
const opt = (name, env, def) => arg(name) || process.env[env] || def;

// ======================= CONFIG: change paths and settings here =======================
const CONFIG = {
  httpPort: +opt('http-port', 'F1T_HTTP_PORT', 3000),
  udpPort: +opt('udp-port', 'F1T_UDP_PORT', 20777),
  dataDir: path.resolve(opt('data-dir', 'F1T_DATA_DIR', __dirname)), // laps.csv, traces/, tts-cache/ go here
  piper: {
    dir: path.resolve(opt('piper-dir', 'F1T_PIPER_DIR', path.join(__dirname, 'piper'))), // holds piper.exe (keep the whole unzipped Piper folder)
    exe: process.platform === 'win32' ? 'piper.exe' : 'piper',
    voicesSub: 'voices',     // voice files (*.onnx + *.onnx.json) live in <dir>\voices
    lengthScale: 1.0,        // > 1 = slower speech, < 1 = faster (the speed slider overrides it per request)
    noiseScale: 0.667,       // voice variation; lower = flatter and steadier, higher = more expressive (0.3 to 1)
    noiseW: 0.8,             // timing variation between phonemes; lower = more robotic rhythm (0.3 to 1)
    cacheMB: 200,            // tts-cache size cap; oldest-used clips are deleted first
    timeoutMs: 20000,        // kill Piper if one sentence takes longer than this
    maxParallel: 2,          // Piper processes at once
    maxChars: 400,           // longest sentence accepted
  },
};
// ======================================================================================

const UDP_PORT = CONFIG.udpPort, HTTP_PORT = CONFIG.httpPort, DEMO = process.argv.includes('--demo'), DATA = CONFIG.dataDir;
fs.mkdirSync(DATA, { recursive: true });
const CSV = path.join(DATA, DEMO ? 'laps-demo.csv' : 'laps.csv');
const TRACE_DIR = path.join(DATA, DEMO ? 'traces-demo' : 'traces');

// When started by the desktop app (Electron utilityProcess or child_process.fork) report status to it
const parent = process.parentPort ? { send: m => process.parentPort.postMessage(m) } : process.send ? { send: m => process.send(m) } : null;
const tell = m => { try { parent && parent.send(m); } catch (e) {} };
function fatal(which, port, err) {
  const msg = err.code === 'EADDRINUSE'
    ? `${which.toUpperCase()} port ${port} is already in use (another telemetry program, or a second copy of this one?).`
    : `Could not open ${which.toUpperCase()} port ${port}: ${err.message}`;
  console.error('ERROR: ' + msg + (parent ? '' : ` Close the other program or start with --${which}-port <other port>.`));
  tell({ type: 'error', which, port, code: err.code, message: msg });
  process.exit(2);
}
let up = 0; const ready = () => { if (++up === 2) tell({ type: 'ready', httpPort: HTTP_PORT, udpPort: UDP_PORT, dataDir: DATA, demo: DEMO }); };
const HEADER = 'recorded_at,session_uid,track,session_type,lap,time_ms,invalid,pit,sc,wear_RL,wear_RR,wear_FL,wear_FR';
const clients = new Set();
const state = { tel: null, lap: null, wear: null, laps: [], warn: null, sc: 0, pos: null, traceVer: 0,
  session: { uid: null, track: null, type: null } };
// What happened during the lap in progress. Each flag stores the lap distance where it was first seen
// (null = not seen), so a flashback to an earlier point can undo it.
const newFlags = () => ({ invalid: null, pit: null, sc: null, scType: 0 });
let flags = newFlags();
const lapFlags = new Map(); // lap number -> flags of completed laps this session (restored on a flashback across the line)
function rewindFlags(f, dist) {
  for (const k of ['invalid', 'pit', 'sc']) if (f[k] !== null && f[k] > dist) f[k] = null;
  if (f.sc === null) f.scType = 0;
  return f;
}
const EXPECT = { 2: 1285, 6: 1352, 7: 1239, 10: 1041 }; // F1 25 packet sizes from the official spec (7 = Car Status, from memory of the spec)
const seen = new Set();

// Lookup tables from the F1 25 UDP spec
const TRACKS = { 0: 'Melbourne', 2: 'Shanghai', 3: 'Sakhir', 4: 'Catalunya', 5: 'Monaco', 6: 'Montreal', 7: 'Silverstone',
  9: 'Hungaroring', 10: 'Spa', 11: 'Monza', 12: 'Singapore', 13: 'Suzuka', 14: 'Abu Dhabi', 15: 'Texas', 16: 'Brazil',
  17: 'Austria', 19: 'Mexico', 20: 'Baku', 26: 'Zandvoort', 27: 'Imola', 29: 'Jeddah', 30: 'Miami', 31: 'Las Vegas',
  32: 'Losail', 39: 'Silverstone (Reverse)', 40: 'Austria (Reverse)', 41: 'Zandvoort (Reverse)' };
const SESSION_TYPES = ['Unknown', 'P1', 'P2', 'P3', 'Short Practice', 'Q1', 'Q2', 'Q3', 'Short Qualifying', 'One-Shot Qualifying',
  'Sprint Shootout 1', 'Sprint Shootout 2', 'Sprint Shootout 3', 'Short Sprint Shootout', 'One-Shot Sprint Shootout',
  'Race', 'Race 2', 'Race 3', 'Time Trial'];

// ---- Sending to the browser: max ~30 updates/sec, but the latest state is always delivered ----
let lastSent = 0, pending = null;
function push() {
  if (!state.tel && !state.warn) return;
  const wait = 30 - (Date.now() - lastSent);
  if (wait > 0) { // too soon: send once the window has passed so the last update isn't lost
    if (!pending) pending = setTimeout(() => { pending = null; push(); }, wait);
    return;
  }
  lastSent = Date.now();
  const msg = `data: ${JSON.stringify({ ...state.tel, warn: state.warn, lap: state.lap, wear: state.wear, laps: state.laps,
    session: state.session, sc: state.sc, pos: state.pos, traceVer: state.traceVer, seg: SEG, rivals: rivals(), me: state.me, field: field() })}\n\n`;
  clients.forEach(res => res.write(msg));
}

// ---- Race engineer voice: local Piper TTS ----
// GET /tts/voices          -> { ok, reason, voices: [{ id, name, lang, quality, speakers }] }
// GET /tts?voice=&text=&speed=  -> audio/wav of one sentence (cached on disk), or JSON { error } with 404/500/503
const TTS = { cacheDir: path.join(DATA, 'tts-cache'), running: 0, waiting: [], inflight: new Map(), files: new Map(), bytes: 0 };
const piperExe = () => [CONFIG.piper.dir, path.join(DATA, 'piper')].map(d => path.join(d, CONFIG.piper.exe)).find(f => fs.existsSync(f)) || null;
function piperVoices() { // voices from <piper dir>\voices, plus <data dir>\piper\voices (handy when the app folder is read-only)
  const dirs = [...new Set([path.join(CONFIG.piper.dir, CONFIG.piper.voicesSub), path.join(DATA, 'piper', CONFIG.piper.voicesSub)])], out = new Map();
  for (const d of dirs) {
    let files = []; try { files = fs.readdirSync(d); } catch (e) { continue; }
    for (const f of files.filter(f => f.endsWith('.onnx'))) {
      const id = f.slice(0, -5), model = path.join(d, f), cfgFile = model + '.json';
      if (out.has(id) || !fs.existsSync(cfgFile)) continue; // a voice needs both files
      let c = {}; try { c = JSON.parse(fs.readFileSync(cfgFile, 'utf8')); } catch (e) { continue; }
      const m = id.match(/^([a-z]{2,3}_[A-Z]{2})-(.+)-(x_low|low|medium|high)$/);
      out.set(id, { id, model, name: (m ? m[2] : c.dataset || id).replace(/_/g, ' '), lang: (c.language && c.language.code) || (m && m[1]) || '',
        quality: (c.audio && c.audio.quality) || (m && m[3]) || '', speakers: c.num_speakers || 1 });
    }
  }
  return [...out.values()];
}
function ttsStatus() {
  const exe = piperExe(), voices = piperVoices();
  const reason = !exe ? `Piper not found: put ${CONFIG.piper.exe} in ${CONFIG.piper.dir}` : !voices.length ? `no Piper voices in ${path.join(CONFIG.piper.dir, CONFIG.piper.voicesSub)}` : null;
  return { ok: !reason, reason, voices: voices.map(({ model, ...v }) => v) };
}

// Disk cache, keyed by a hash of voice + settings + text. Size-capped; least recently used clips go first.
fs.mkdirSync(TTS.cacheDir, { recursive: true });
for (const f of fs.readdirSync(TTS.cacheDir)) {
  const p = path.join(TTS.cacheDir, f);
  if (!f.endsWith('.wav')) { if (f.endsWith('.tmp')) fs.rmSync(p, { force: true }); continue; }
  try { const s = fs.statSync(p); TTS.files.set(f, { size: s.size, used: s.mtimeMs }); TTS.bytes += s.size; } catch (e) {}
}
function trimCache() {
  const cap = CONFIG.piper.cacheMB * 1048576;
  if (TTS.bytes <= cap) return;
  for (const [f, m] of [...TTS.files].sort((a, b) => a[1].used - b[1].used)) {
    if (TTS.bytes <= cap * 0.9) break;
    fs.rmSync(path.join(TTS.cacheDir, f), { force: true }); TTS.files.delete(f); TTS.bytes -= m.size;
  }
}
function runPiper(voice, text, s, out) { // one Piper process per sentence: text on stdin, WAV written to a temp file
  return new Promise((resolve, reject) => {
    const exe = piperExe(), tmp = out + '.' + process.pid + '.' + Date.now() + '.tmp';
    const p = spawn(exe, ['--model', voice.model, '--output_file', tmp, '--length_scale', String(s.length),
      '--noise_scale', String(s.noise), '--noise_w', String(s.noiseW), '--sentence_silence', '0', '--quiet'],
      { cwd: path.dirname(exe), windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
    let err = '', done = false;
    const finish = e => { if (done) return; done = true; clearTimeout(timer); if (e) { fs.rmSync(tmp, { force: true }); reject(e); } else resolve(tmp); };
    const timer = setTimeout(() => { p.kill(); finish(new Error(`Piper took longer than ${CONFIG.piper.timeoutMs / 1000} s`)); }, CONFIG.piper.timeoutMs);
    p.stderr.on('data', d => { err = (err + d).slice(-600); });
    p.on('error', e => finish(new Error(e.code === 'ENOENT' ? 'Piper could not be started (file missing)' : e.code === 'EPERM' || e.code === 'EACCES'
      ? 'Piper was blocked from starting (antivirus or permissions?)' : 'Piper failed to start: ' + e.message)));
    p.on('close', (code, sig) => {
      let ok = false; try { ok = fs.statSync(tmp).size > 44; } catch (e) {}
      finish(code === 0 && ok ? null : new Error(`Piper ${code === null ? 'crashed (' + sig + ')' : 'exited with code ' + code}${err.trim() ? ': ' + err.trim().split(/\r?\n/).pop() : ''}`));
    });
    p.stdin.on('error', () => {}); // Piper died before reading: reported by 'close'
    p.stdin.end(text.replace(/\s+/g, ' ').trim() + '\n', 'utf8');
  });
}
function slot() { return new Promise(r => { if (TTS.running < CONFIG.piper.maxParallel) { TTS.running++; r(); } else TTS.waiting.push(r); }); }
function release() { const n = TTS.waiting.shift(); if (n) n(); else TTS.running--; }
async function synth(voice, text, s) { // -> path of the cached WAV
  const key = crypto.createHash('sha1').update(JSON.stringify([voice.id, fs.statSync(voice.model).size, s.length, s.noise, s.noiseW, text])).digest('hex');
  const name = key + '.wav', file = path.join(TTS.cacheDir, name), hit = TTS.files.get(name);
  if (hit && fs.existsSync(file)) { hit.used = Date.now(); fs.utimes(file, new Date(), new Date(), () => {}); return file; }
  if (TTS.inflight.has(key)) return TTS.inflight.get(key); // the same sentence is already being made (e.g. a preload)
  const job = (async () => {
    await slot();
    try {
      const tmp = await runPiper(voice, text, s, file);
      fs.renameSync(tmp, file);
      const size = fs.statSync(file).size; TTS.files.set(name, { size, used: Date.now() }); TTS.bytes += size; trimCache();
      return file;
    } finally { release(); TTS.inflight.delete(key); }
  })();
  TTS.inflight.set(key, job);
  return job;
}
async function handleTts(req, res, q) {
  const fail = (code, error) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify({ error })); };
  const text = (q.get('text') || '').slice(0, CONFIG.piper.maxChars), st = ttsStatus();
  if (!text.trim()) return fail(400, 'no text');
  if (!piperExe()) return fail(503, st.reason);
  const voices = piperVoices(), voice = voices.find(v => v.id === q.get('voice')) || (!q.get('voice') && voices[0]);
  if (!voice) return fail(404, q.get('voice') ? `voice ${q.get('voice')} is not installed` : st.reason);
  const clamp = (v, lo, hi, d) => { v = parseFloat(v); return Number.isFinite(v) ? +Math.min(hi, Math.max(lo, v)).toFixed(2) : d; };
  const speed = clamp(q.get('speed'), 0.5, 2, 1);
  const s = { length: +(CONFIG.piper.lengthScale / speed).toFixed(3), noise: clamp(q.get('noise'), 0, 1.5, CONFIG.piper.noiseScale), noiseW: clamp(q.get('noisew'), 0, 1.5, CONFIG.piper.noiseW) };
  try {
    const file = await synth(voice, text, s);
    res.writeHead(200, { 'Content-Type': 'audio/wav', 'Cache-Control': 'no-store' }); res.end(fs.readFileSync(file));
  } catch (e) { console.log('TTS: ' + e.message); fail(500, e.message); }
}

const json = (res, obj) => { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0], tr = url.match(/^\/trace\/([\w-]+)$/);
  if (url === '/tts/voices') return json(res, ttsStatus());
  if (url === '/tts') return handleTts(req, res, new URL(req.url, 'http://x').searchParams);
  if (url === '/traces') return json(res, [...traceIndex.values()].sort((a, b) => b.recordedAt.localeCompare(a.recordedAt)));
  if (tr) {
    const f = path.join(TRACE_DIR, tr[1] + '.json');
    if (!traceIndex.has(tr[1]) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); return res.end(fs.readFileSync(f));
  }
  if (url === '/stream') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    clients.add(res);
    req.on('close', () => clients.delete(res));
  } else {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(path.join(__dirname, 'index.html')));
  }
});
server.on('error', e => fatal('http', HTTP_PORT, e));
server.listen(HTTP_PORT, () => {
  const t = ttsStatus();
  console.log(`Dashboard: http://localhost:${HTTP_PORT}  (${DEMO ? 'DEMO data -> ' + CSV : 'listening for game on UDP ' + UDP_PORT})`);
  console.log(t.ok ? `Engineer voice: Piper with ${t.voices.length} voice(s): ${t.voices.map(v => v.id).join(', ')}` : `Engineer voice: browser speech (${t.reason})`);
  ready();
});

// ---- CSV ----
function ensureCsv() {
  if (fs.existsSync(CSV)) {
    if (fs.readFileSync(CSV, 'utf8').split(/\r?\n/, 1)[0] === HEADER) return;
    const old = CSV.replace(/\.csv$/, `-old-${Date.now()}.csv`); // different columns: keep it, start a new file
    fs.renameSync(CSV, old);
    console.log(`Existing ${path.basename(CSV)} has an older layout; moved it to ${path.basename(old)}`);
  }
  fs.writeFileSync(CSV, HEADER + '\n');
}
ensureCsv();

// ---- Lap traces ----
// A sample every ~4 m of lap distance: [distance m, lap time ms, speed, throttle %, brake %, x, z]
const COLS = ['dist', 'time', 'speed', 'throttle', 'brake', 'x', 'z'];
let trace = [];                 // lap in progress
const sessionTraces = new Map(); // completed laps of the current session, kept so a flashback can resume them
const traceIndex = new Map();    // id -> metadata of every saved trace file (for the lap picker)
fs.mkdirSync(TRACE_DIR, { recursive: true });
for (const f of fs.readdirSync(TRACE_DIR).filter(f => f.endsWith('.json'))) {
  try { const { samples, ...meta } = JSON.parse(fs.readFileSync(path.join(TRACE_DIR, f), 'utf8')); traceIndex.set(meta.id, meta); }
  catch (e) { console.log(`Skipping unreadable trace ${f}`); }
}
const traceId = num => `${state.session.uid}_${num}`;

function sample() { // called on every telemetry packet
  const l = state.lap, t = state.tel;
  if (!l || !t || !(l.dist >= 0)) return; // negative distance = before the first line crossing
  const last = trace[trace.length - 1];
  if (last && l.dist < last[0] - 1) { while (trace.length && trace[trace.length - 1][0] > l.dist) trace.pop(); return; } // rewound
  if (last && l.dist - last[0] < 4) return;
  const p = state.pos;
  trace.push([Math.round(l.dist), l.cur, t.speed, Math.round(t.throttle * 100), Math.round(t.brake * 100),
    p ? +p.x.toFixed(1) : null, p ? +p.z.toFixed(1) : null]);
}

function saveTrace(lap) {
  const samples = trace; trace = [];
  sessionTraces.set(lap.lap, samples);
  if (samples.length < 10 || samples[0][0] > 50) return; // joined or resumed mid-lap / no telemetry: nothing useful to preview
  const s = state.session, meta = { id: traceId(lap.lap), uid: s.uid, track: s.track, type: s.type, lap: lap.lap, ms: lap.ms,
    invalid: lap.invalid, pit: lap.pit, sc: lap.sc, recordedAt: new Date().toISOString(), samples: samples.length };
  fs.writeFileSync(path.join(TRACE_DIR, meta.id + '.json'), JSON.stringify({ ...meta, cols: COLS, samples }));
  traceIndex.set(meta.id, meta); state.traceVer++;
}

function dropTracesFrom(num, dist) { // flashback into lap `num`: resume its trace, forget later ones
  trace = (sessionTraces.get(num) || []).filter(r => r[0] <= dist); // never reuse the later lap's samples
  for (const n of [...sessionTraces.keys()]) if (n >= num) sessionTraces.delete(n);
  for (const [id, m] of traceIndex) if (m.uid === state.session.uid && m.lap >= num) {
    traceIndex.delete(id); fs.rmSync(path.join(TRACE_DIR, id + '.json'), { force: true }); state.traceVer++;
  }
}

function recordLap(num, ms) {
  const s = state.session, w = state.wear || [0, 0, 0, 0];
  const lap = { lap: num, ms, invalid: flags.invalid !== null, pit: flags.pit !== null, sc: flags.scType, wear: state.wear };
  lapFlags.set(num, { ...flags });
  state.laps.push(lap);
  saveTrace(lap);
  if (!fs.existsSync(CSV)) ensureCsv();
  fs.appendFileSync(CSV, [new Date().toISOString(), s.uid, s.track || '', s.type || '', num, ms,
    +lap.invalid, +lap.pit, lap.sc, ...w].join(',') + '\n');
}

// Flashback rewound past the start/finish line: forget laps from `num` onwards (memory and CSV)
function dropLapsFrom(num) {
  state.laps = state.laps.filter(l => l.lap < num);
  if (!fs.existsSync(CSV)) return;
  const lines = fs.readFileSync(CSV, 'utf8').split(/\r?\n/).filter(Boolean);
  const kept = lines.filter((line, i) => { const c = line.split(','); return i === 0 || !(c[1] === state.session.uid && +c[4] >= num); });
  if (kept.length !== lines.length) fs.writeFileSync(CSV, kept.join('\n') + '\n');
}


// ---- Rival comparison ----
// Every car's lap is cut into SEG-metre mini-sectors; we record the lap time at which each car crosses each boundary.
// Comparing your time through a mini-sector with the rival's (same lap number when possible) shows where you gain or lose.
const SEG = 100;
const newCar = () => ({ lap: null, dist: null, time: null, cross: [], next: 0, laps: new Map(), pos: 0, active: false, gapFront: 0, xz: null,
  pit: 0, stops: 0, lead: 0, tyre: null, age: null }); // pit status, pit stops made, gap to the race leader (ms), visual compound, tyre age (laps)
let cars = Array.from({ length: 22 }, newCar);
let drivers = []; // index -> { name, number } from the participants packet
state.me = 0;

function updateCar(c, { num, dist, cur, last, pos, active, gapFront, pit = 0, stops = 0, lead = 0 }) {
  Object.assign(c, { pos, active, gapFront, pit, stops, lead });
  if (!num) return;
  const k = d => Math.floor(d / SEG) + 1; // first boundary index after distance d
  if (c.lap === null || num > c.lap + 1) { c.lap = num; c.cross = []; c.next = dist < 0 ? 0 : k(dist); c.dist = null; } // joined mid-lap
  else if (num === c.lap + 1) { // crossed the line: close the lap, the last mini-sector ends at the line
    if (last > 0) { c.laps.set(c.lap, { cross: c.cross, end: last, endIdx: c.next }); if (c.laps.size > 4) c.laps.delete(c.laps.keys().next().value); }
    c.lap = num; c.cross = [0]; c.next = 1; c.dist = null;
  } else if (num < c.lap) { // flashback across the line (the whole field rewinds): resume that lap's boundaries
    const back = c.laps.get(num);
    for (const n of [...c.laps.keys()]) if (n >= num) c.laps.delete(n);
    c.lap = num; c.next = dist < 0 ? 0 : k(dist); c.cross = back ? back.cross.slice(0, c.next) : []; c.dist = null;
  } else if (c.dist !== null && dist < c.dist - 5) { // flashback within the lap
    c.next = dist < 0 ? 0 : k(dist); c.cross.length = Math.min(c.cross.length, c.next); c.dist = null;
  }
  while (dist >= 0 && c.next * SEG <= dist) { // boundaries passed since the last packet, interpolated between packets
    const b = c.next * SEG;
    c.cross[c.next] = c.dist !== null && dist > c.dist && c.dist < b ? c.time + (b - c.dist) / (dist - c.dist) * (cur - c.time) : cur;
    c.next++;
  }
  c.dist = dist; c.time = cur;
}

// Time spent in each mini-sector (null where unknown)
function segTimes(l) {
  const out = [], n = l.end != null ? l.endIdx : l.cross.length - 1;
  for (let i = 0; i < n; i++) {
    const a = l.cross[i], b = l.end != null && i + 1 === l.endIdx ? l.end : l.cross[i + 1];
    out.push(a != null && b != null ? b - a : null);
  }
  return out;
}
const current = c => ({ cross: c.cross, end: null });

function compare(lapNum, mine, r) {
  let rl = r.lap === lapNum ? current(r) : r.laps.get(lapNum), rLap = lapNum;
  if (!rl && r.laps.size) { rLap = Math.max(...r.laps.keys()); rl = r.laps.get(rLap); } // e.g. qualifying: their latest full lap
  if (!rl) return null;
  const m = segTimes(mine), t = segTimes(rl);
  return { lap: lapNum, rivalLap: rLap, gained: m.map((v, i) => v != null && t[i] != null ? Math.round(t[i] - v) : null) }; // + = you were quicker
}

// Compact running order for the strategy view (undercut / overcut warnings): every active car
function field() {
  return cars.map((c, i) => c.active && c.pos ? { i, pos: c.pos, lap: c.lap, pit: c.pit, stops: c.stops, lead: c.lead, tyre: c.tyre, age: c.age,
    name: drivers[i] ? drivers[i].name : null, num: drivers[i] ? drivers[i].number : null } : null).filter(Boolean);
}

function rivals() {
  const me = cars[state.me];
  if (!me || !me.pos || me.lap === null) return null;
  const out = {};
  for (const [key, p] of [['ahead', me.pos - 1], ['behind', me.pos + 1]]) {
    const i = p > 0 ? cars.findIndex((c, j) => j !== state.me && c.active && c.pos === p) : -1;
    if (i < 0) { out[key] = null; continue; }
    const r = cars[i], prev = me.laps.get(me.lap - 1);
    out[key] = { idx: i, pos: r.pos, driver: drivers[i] || null, xz: r.xz, gap: key === 'ahead' ? me.gapFront : r.gapFront,
      current: compare(me.lap, current(me), r), last: prev ? compare(me.lap - 1, prev, r) : null };
  }
  return out;
}

// Every packet carries the session UID; a new UID means a new or restarted session
function checkSession(uid) {
  if (uid === state.session.uid) return;
  state.session = { uid, track: null, type: null };
  state.laps = []; state.lap = null; state.sc = 0; flags = newFlags(); lapFlags.clear();
  trace = []; sessionTraces.clear();
  cars = Array.from({ length: 22 }, newCar); drivers = [];
}

// ---- Parsers ----
// All per-car packets: 29-byte header, then 22 cars.
const carOffset = b => 29 + b.readUInt8(27) * Math.floor((b.length - 29) / 22);
const four = fn => [0, 1, 2, 3].map(fn); // tyre order: RL, RR, FL, FR

function parseTelemetry(b) { // packet id 6, 60 bytes per car
  const o = 29 + b.readUInt8(27) * 60;
  if (b.length < o + 60) return;
  state.tel = {
    speed: b.readUInt16LE(o), throttle: b.readFloatLE(o + 2), steer: b.readFloatLE(o + 6), brake: b.readFloatLE(o + 10),
    gear: b.readInt8(o + 15), rpm: b.readUInt16LE(o + 16), drs: b.readUInt8(o + 18), revPct: b.readUInt8(o + 19),
    brakesTemp: four(i => b.readUInt16LE(o + 22 + i * 2)), tyreSurf: four(i => b.readUInt8(o + 30 + i)),
    tyreInner: four(i => b.readUInt8(o + 34 + i)), engineTemp: b.readUInt16LE(o + 38),
    tyrePress: four(i => b.readFloatLE(o + 40 + i * 4)),
  };
  sample();
}

function parseMotion(b) { // packet id 0, 60 bytes per car: world position x, y, z are the first 3 floats
  if (b.length < 29 + 22 * 60) return;
  for (let i = 0; i < 22; i++) { const o = 29 + i * 60; cars[i].xz = { x: b.readFloatLE(o), z: b.readFloatLE(o + 8) }; }
  state.pos = cars[b.readUInt8(27)].xz;
}

function parseParticipants(b) { // packet id 4, 57 bytes per car after a 1-byte car count; name is 32 bytes at +7
  if (b.length !== 30 + 22 * 57) return; // layout differs in other game versions: just go without names
  drivers = Array.from({ length: 22 }, (_, i) => { const o = 30 + i * 57;
    return { name: b.toString('utf8', o + 7, o + 39).replace(/\0[\s\S]*$/, '').trim(), number: b.readUInt8(o + 5) }; });
}

function onLap(cur) { // called with {last, cur, num, sector, pos, invalid, pit, dist}
  const prev = state.lap;
  if (prev && cur.num < prev.num) { // flashback across the line: back into lap cur.num
    const f = lapFlags.get(cur.num);
    for (const n of [...lapFlags.keys()]) if (n >= cur.num) lapFlags.delete(n);
    dropLapsFrom(cur.num); dropTracesFrom(cur.num, cur.dist);
    flags = f ? rewindFlags({ ...f }, cur.dist) : newFlags(); // keep what happened before the rewind point
  } else if (prev && cur.num === prev.num && cur.dist < prev.dist - 5) { // flashback within the lap
    rewindFlags(flags, cur.dist);
  } else if (prev && cur.num > prev.num && cur.last > 0) { recordLap(prev.num, cur.last); flags = newFlags(); } // lap done
  if (cur.invalid && flags.invalid === null) flags.invalid = cur.dist;
  if (cur.pit && flags.pit === null) flags.pit = cur.dist;
  if (state.sc && flags.sc === null) { flags.sc = cur.dist; flags.scType = state.sc; } // 1 = SC, 2 = VSC, 3 = formation lap
  state.lap = cur;
}

function parseLap(b) { // packet id 2, 57 bytes per car
  state.me = b.readUInt8(27);
  for (let i = 0; i < 22; i++) {
    const c = 29 + i * 57, status = b.readUInt8(c + 45); // resultStatus: 2 = active, 3 = finished
    updateCar(cars[i], { last: b.readUInt32LE(c), cur: b.readUInt32LE(c + 4), dist: b.readFloatLE(c + 20), pos: b.readUInt8(c + 32),
      num: b.readUInt8(c + 33), gapFront: b.readUInt16LE(c + 14) + b.readUInt8(c + 16) * 60000, active: status === 2 || status === 3,
      pit: b.readUInt8(c + 34), stops: b.readUInt8(c + 35), lead: b.readUInt16LE(c + 17) + b.readUInt8(c + 19) * 60000 });
  }
  const o = carOffset(b);
  onLap({ last: b.readUInt32LE(o), cur: b.readUInt32LE(o + 4), dist: b.readFloatLE(o + 20), pos: b.readUInt8(o + 32), num: b.readUInt8(o + 33),
    pit: b.readUInt8(o + 34), sector: b.readUInt8(o + 36), invalid: b.readUInt8(o + 37) });
}

function parseSession(b) { // packet id 1
  if (b.length < 154) return;
  const type = b.readUInt8(35), track = b.readInt8(36);
  state.session.type = SESSION_TYPES[type] || `Type ${type}`;
  state.session.track = TRACKS[track] || `Track ${track}`;
  state.sc = b.readUInt8(153); // safetyCarStatus, after 21 marshal zones of 5 bytes
}

function parseStatus(b) { // packet id 7, 55 bytes per car: visual tyre compound (26), tyre age in laps (27)
  for (let i = 0; i < 22; i++) { const o = 29 + i * 55; cars[i].tyre = b.readUInt8(o + 26); cars[i].age = b.readUInt8(o + 27); }
}

function parseDamage(b) { // packet id 10, tyre wear % is the first 4 floats
  const o = carOffset(b);
  state.wear = four(i => +b.readFloatLE(o + i * 4).toFixed(1));
}

if (DEMO) {
  let t = 0, lapNum = 1, lapStart = 0, last = 0;
  state.session = { uid: 'demo' + Date.now().toString(16), track: 'Demo', type: 'Race' };
  const L = 4000, shape = u => { const a = 2 * Math.PI * u; return { x: 600 * Math.cos(a) + 150 * Math.cos(3 * a), z: 350 * Math.sin(a) + 80 * Math.sin(2 * a) }; };
  // Two fake rivals: a steady pace plus a position-dependent wobble, so each is quicker in some places and slower in others
  const bots = [{ i: 1, lapT: 20.15, off: 0.05, amp: 30, f: 3, ph: 0 }, { i: 2, lapT: 19.93, off: -0.04, amp: 22, f: 2, ph: 1 }];
  drivers = [{ name: 'YOU', number: 1 }, { name: 'AHEAD', number: 44 }, { name: 'BEHIND', number: 16 }];
  bots.forEach(b => { b.lap = 1; b.start = 0; b.last = 0; });
  bots[0].stopLaps = [11, 23]; bots[1].stopLaps = [7, 16]; // demo pit stops, to exercise the undercut / overcut warnings
  const pitState = (b, num, dist) => { // in the pit lane over the last 300 m of a stop lap and the first 300 m of the next
    const inLane = (b.stopLaps.includes(num) && dist > L - 300) || (b.stopLaps.includes(num - 1) && dist < 300);
    return { pit: inLane ? 1 : 0, stops: b.stopLaps.filter(n => n < num || (n === num && dist > L - 300)).length };
  };
  setInterval(() => {
    t += 0.033;
    if (t - lapStart > 20) { last = Math.round((t - lapStart) * 1000); lapStart = t; lapNum++; }
    const u = (t - lapStart) / 20, a = 2 * Math.PI * u; // position on a made-up closed circuit, 4 km long
    const p = (Math.sin(5 * a + lapNum * 0.08) + 1) / 2, // speed follows the track position, shifting slightly per lap
          thr = Math.min(1, p * 1.6), brk = p < 0.15 ? 0.9 : 0;
    const speed = Math.round(90 + p * 240), gear = Math.max(1, Math.min(8, Math.ceil(speed / 42)));
    const rpm = Math.round(6000 + ((speed % 42) / 42) * 6500);
    state.tel = { speed, throttle: thr, brake: brk, steer: Math.sin(t * 0.5) * 0.6, gear, rpm, drs: p > 0.8 ? 1 : 0,
      revPct: Math.min(100, Math.round((rpm - 6000) / 65)), brakesTemp: [520, 520, 640, 640].map(x => x + brk * 300),
      tyreSurf: [92, 93, 96, 97], tyreInner: [98, 99, 101, 102], engineTemp: 108, tyrePress: [21.4, 21.5, 23.1, 23.2] };
    state.pos = shape(u);
    const meR = { i: 0, D: (lapNum - 1 + u) * L }, runners = [meR];
    bots.forEach(b => { const d0 = (t / b.lapT + b.off) * L; b.D = d0 + b.amp * Math.sin(2 * Math.PI * b.f * d0 / L + b.ph); runners.push(b); });
    runners.sort((x, y) => y.D - x.D).forEach((r, k) => { r.pos = k + 2; }); // P2..P4
    const leadD = runners[0].D + 0.06 * L, lead = r => Math.round((leadD - r.D) / L * 20000); // imaginary P1 just up the road
    const byPos = p => runners.find(r => r.pos === p), gapTo = (a, b) => a && b ? Math.round((a.D - b.D) / L * 20000) : 0;
    bots.forEach(b => {
      const num = Math.floor(b.D / L) + 1;
      if (num !== b.lap) { b.last = Math.round((t - b.start) * 1000); b.start = t; b.lap = num; }
      const ps = pitState(b, num, b.D - (num - 1) * L);
      updateCar(cars[b.i], { num, dist: b.D - (num - 1) * L, cur: Math.round((t - b.start) * 1000), last: b.last, pos: b.pos, active: true,
        gapFront: gapTo(byPos(b.pos - 1), b), lead: lead(b), ...ps });
      const lastStop = Math.max(0, ...b.stopLaps.filter(n => n < num)); cars[b.i].tyre = lastStop ? 18 : 17; cars[b.i].age = num - 1 - lastStop;
      cars[b.i].xz = shape((b.D % L) / L);
    });
    const mePos = meR.pos;
    updateCar(cars[0], { num: lapNum, dist: u * L, cur: Math.round((t - lapStart) * 1000), last, pos: mePos, active: true, gapFront: gapTo(byPos(mePos - 1), meR),
      lead: lead(meR), pit: lapNum % 6 === 0 ? 1 : 0, stops: Math.floor(lapNum / 6) });
    cars[0].tyre = lapNum >= 6 ? 18 : 16; cars[0].age = (lapNum - 1) % 6;
    cars[0].xz = state.pos;
    state.wear = [1.2, 1.1, 1.8, 1.9].map(x => +(x * (1 + t / 12)).toFixed(1));
    onLap({ last, cur: Math.round((t - lapStart) * 1000), dist: u * 4000, pos: mePos, num: lapNum, sector: Math.min(2, Math.floor((t - lapStart) / 6.7)),
      invalid: 0, pit: lapNum % 6 === 0 ? 1 : 0 }); // every 6th lap is a pit lap, to exercise the UI
    sample();
    push();
  }, 33);
} else {
  const sock = dgram.createSocket('udp4');
  sock.on('message', b => {
    if (b.length < 29) return;
    const format = b.readUInt16LE(0), id = b.readUInt8(6);
    if (format !== 2025) { // other formats have different layouts and would show garbage
      state.warn = `Game is sending UDP format ${format}. In F1 25 set Settings > Telemetry > UDP Format to 2025.`;
      if (!seen.has('fmt')) { seen.add('fmt'); console.log('WARNING: ' + state.warn); }
      return push();
    }
    if (EXPECT[id] && b.length !== EXPECT[id]) {
      if (!seen.has('len' + id)) { seen.add('len' + id); console.log(`WARNING: packet ${id} is ${b.length} bytes, expected ${EXPECT[id]}. Ignoring.`); }
      return;
    }
    if (EXPECT[id] && !seen.has(id)) { seen.add(id); console.log(`Receiving packet ${id} (${b.length} bytes, format ${format}, game version ${b.readUInt8(3)}.${String(b.readUInt8(4)).padStart(2, '0')})`); }
    state.warn = null;
    checkSession(b.readBigUInt64LE(7).toString(16));
    if (id === 6) parseTelemetry(b); else if (id === 2) parseLap(b); else if (id === 10) parseDamage(b); else if (id === 1) parseSession(b); else if (id === 0) parseMotion(b); else if (id === 4) parseParticipants(b); else if (id === 7) parseStatus(b);
    push();
  });
  sock.on('error', e => fatal('udp', UDP_PORT, e));
  sock.bind(UDP_PORT, ready);
}
if (DEMO) ready(); // no UDP socket in demo mode

// Clean shutdown (Ctrl+C, or the desktop app quitting)
function shutdown() { try { server.close(); } catch (e) {} clients.forEach(r => { try { r.end(); } catch (e) {} }); setTimeout(() => process.exit(0), 50); }
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
if (process.parentPort) process.parentPort.on('message', e => { if (e.data && e.data.type === 'quit') shutdown(); });
else if (process.send) process.on('message', m => { if (m && m.type === 'quit') shutdown(); });
