// F1 25 telemetry relay: UDP (game) -> Server-Sent Events (browser). No npm install needed.
// Run:  node server.js          (live from the game)
//       node server.js --demo   (fake data to test the dashboard)
// Completed laps are also saved to laps.csv next to this file.
const dgram = require('dgram'), http = require('http'), fs = require('fs'), path = require('path');
const UDP_PORT = 20777, HTTP_PORT = 3000, DEMO = process.argv.includes('--demo');
const CSV = path.join(__dirname, 'laps.csv');
const clients = new Set();
const state = { tel: null, lap: null, wear: null, laps: [], invalid: false, warn: null };
const EXPECT = { 2: 1285, 6: 1352, 10: 1041 }; // F1 25 packet sizes from the official spec
const seen = new Set();
let lastSent = 0;

function push() {
  if (!state.tel && !state.warn) return;
  const now = Date.now();
  if (now - lastSent < 30) return; // cap at ~30 updates/sec
  lastSent = now;
  const msg = `data: ${JSON.stringify({ ...state.tel, warn: state.warn, lap: state.lap, wear: state.wear, laps: state.laps })}\n\n`;
  clients.forEach(res => res.write(msg));
}

http.createServer((req, res) => {
  if (req.url === '/stream') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    clients.add(res);
    req.on('close', () => clients.delete(res));
  } else {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(path.join(__dirname, 'index.html')));
  }
}).listen(HTTP_PORT, () => console.log(`Dashboard: http://localhost:${HTTP_PORT}  (${DEMO ? 'DEMO data' : 'listening for game on UDP ' + UDP_PORT})`));

// All per-car packets: 29-byte header, then 22 cars. Stride is derived from packet length,
// so small struct-size changes between game updates don't break the offsets.
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
}

function recordLap(num, ms, invalid) {
  const lap = { lap: num, ms, invalid, wear: state.wear };
  state.laps.push(lap);
  const w = state.wear || [0, 0, 0, 0];
  if (!fs.existsSync(CSV)) fs.writeFileSync(CSV, 'lap,time_ms,invalid,wear_RL,wear_RR,wear_FL,wear_FR\n');
  fs.appendFileSync(CSV, `${num},${ms},${invalid ? 1 : 0},${w.join(',')}\n`);
}

function onLap(cur) { // called with {last, cur, num, sector, pos, invalid}
  const prev = state.lap;
  if (prev && cur.num < prev.num) state.laps = [];            // new session: reset history
  if (prev && cur.num > prev.num && cur.last > 0) { recordLap(prev.num, cur.last, state.invalid); state.invalid = false; }
  if (cur.invalid) state.invalid = true;
  state.lap = cur;
}

function parseLap(b) { // packet id 2, 57 bytes per car
  const o = carOffset(b);
  onLap({ last: b.readUInt32LE(o), cur: b.readUInt32LE(o + 4), pos: b.readUInt8(o + 32), num: b.readUInt8(o + 33),
    sector: b.readUInt8(o + 36), invalid: b.readUInt8(o + 37) });
}

function parseDamage(b) { // packet id 10, tyre wear % is the first 4 floats
  const o = carOffset(b);
  state.wear = four(i => +b.readFloatLE(o + i * 4).toFixed(1));
}

if (DEMO) {
  let t = 0, lapNum = 1, lapStart = 0, last = 0;
  setInterval(() => {
    t += 0.033;
    if (t - lapStart > 20) { last = Math.round((t - lapStart) * 1000 + (Math.random() - 0.5) * 900); lapStart = t; lapNum++; }
    const p = (Math.sin(t * 0.8) + 1) / 2, thr = Math.min(1, p * 1.6), brk = p < 0.15 ? 0.9 : 0;
    const speed = Math.round(90 + p * 240), gear = Math.max(1, Math.min(8, Math.ceil(speed / 42)));
    const rpm = Math.round(6000 + ((speed % 42) / 42) * 6500);
    state.tel = { speed, throttle: thr, brake: brk, steer: Math.sin(t * 0.5) * 0.6, gear, rpm, drs: p > 0.8 ? 1 : 0,
      revPct: Math.min(100, Math.round((rpm - 6000) / 65)), brakesTemp: [520, 520, 640, 640].map(x => x + brk * 300),
      tyreSurf: [92, 93, 96, 97], tyreInner: [98, 99, 101, 102], engineTemp: 108, tyrePress: [21.4, 21.5, 23.1, 23.2] };
    state.wear = [1.2, 1.1, 1.8, 1.9].map(x => +(x * (1 + t / 12)).toFixed(1));
    onLap({ last, cur: Math.round((t - lapStart) * 1000), pos: 3, num: lapNum, sector: Math.min(2, Math.floor((t - lapStart) / 6.7)), invalid: 0 });
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
    if (id === 6) parseTelemetry(b); else if (id === 2) parseLap(b); else if (id === 10) parseDamage(b);
    push();
  });
  sock.bind(UDP_PORT);
}
