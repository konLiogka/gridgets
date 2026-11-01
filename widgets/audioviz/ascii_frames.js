#!/usr/bin/env node
'use strict';
// Audio spectrum frames for the system audio (default sink monitor).
// Requires `parec` (pulseaudio-utils; works with PipeWire's pulse layer too).

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');

const RATE = 44100;
const FFT_N = 2048;
const MASK = FFT_N - 1;
const FULL_SCALE = FFT_N / 4;
const DB_RANGE = 60.0;

const SILENCE_PEAK = 0.002;
const SILENCE_RAW = SILENCE_PEAK * 32768;
const IDLE_AFTER_MS = 1000;
const STALE_MS = 100;
const BELL_PEAK = 0.85;
const IDLE_EASE = 0.08;
const IDLE_SETTLED = 0.004;
const IDLE_POLL_MS = 250;
const ONCE_TIMEOUT_MS = 400;

const MAX_BARS = 128;
const MAX_ROWS = 64;
const MAX_FPS = 60;

// ---------- helpers ----------
function fail(msg, code = 1) {
    try { fs.writeSync(1, `!${String(msg).replace(/[\r\n]+/g, '|')}\n`); } catch (_) { /* pipe gone */ }
    process.exit(code);
}

function clampInt(v, def, min, max) {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
}

function parseArgs(argv) {
    const a = { once: false, bars: 16, rows: 8, fps: 20, ascii: false, char: null, style: 'bars' };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        const eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
        const key = eq < 0 ? arg : arg.slice(0, eq);
        const inline = eq < 0 ? undefined : arg.slice(eq + 1);
        const next = () => (inline !== undefined ? inline : argv[++i]);
        switch (key) {
            case '--once': a.once = true; break;
            case '--stream': break;
            case '--ascii': a.ascii = true; break;
            case '--blocks': break;
            case '--bars': a.bars = clampInt(next(), 16, 1, MAX_BARS); break;
            case '--rows': a.rows = clampInt(next(), 8, 1, MAX_ROWS); break;
            case '--fps': a.fps = clampInt(next(), 20, 1, MAX_FPS); break;
            case '--char': a.char = next() || null; break;
            case '--style': a.style = next(); break;
            default: fail(`unknown argument: ${arg}`, 2);
        }
    }
    if (!['bars', 'mirror', 'wave'].includes(a.style))
        fail('--style must be bars, mirror, wave', 2);
    return a;
}

// ---------- DSP ----------
function makeBands(bars) {
    const nb = FFT_N / 2 + 1;
    const idx = [];
    for (let i = 0; i <= bars; i++) {
        const edgeHz = 40 * Math.pow(12000 / 40, i / bars);
        const p = Math.ceil(edgeHz * FFT_N / RATE - 1e-9);
        idx.push(Math.min(Math.max(p, 0), nb));
    }
    const bands = [];
    for (let i = 0; i < bars; i++) {
        const lo = Math.min(idx[i], nb - 1);
        bands.push([lo, Math.min(Math.max(idx[i + 1], lo + 1), nb)]);
    }
    return bands;
}

function makeHanning(n) {
    const w = new Float64Array(n);
    for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1));
    return w;
}

function makeFFT(n) {
    const bits = Math.log2(n);
    const rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
        let r = 0;
        for (let b = 0; b < bits; b++) if (i & (1 << b)) r |= 1 << (bits - 1 - b);
        rev[i] = r;
    }
    const cos = new Float64Array(n / 2);
    const sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
        cos[i] = Math.cos(2 * Math.PI * i / n);
        sin[i] = Math.sin(2 * Math.PI * i / n);
    }
    const re = new Float64Array(n);
    const im = new Float64Array(n);

    return function magnitudes(input, out, limit) {
        for (let i = 0; i < n; i++) { re[rev[i]] = input[i]; im[rev[i]] = 0; }
        for (let size = 2; size <= n; size <<= 1) {
            const half = size >> 1;
            const step = n / size;
            for (let i = 0; i < n; i += size) {
                for (let j = i, k = 0; j < i + half; j++, k += step) {
                    const l = j + half;
                    const tr = re[l] * cos[k] + im[l] * sin[k];
                    const ti = -re[l] * sin[k] + im[l] * cos[k];
                    re[l] = re[j] - tr;
                    im[l] = im[j] - ti;
                    re[j] += tr;
                    im[j] += ti;
                }
            }
        }
        for (let k = 0; k < limit; k++) out[k] = Math.hypot(re[k], im[k]);
    };
}

function bellCurve(bars) {
    const sigma = bars / 6;
    const out = new Float64Array(bars);
    for (let i = 0; i < bars; i++) {
        const x = i - (bars - 1) / 2;
        out[i] = BELL_PEAK * Math.exp(-0.5 * (x / sigma) ** 2);
    }
    return out;
}

function roundHalfEven(x) {
    const f = Math.floor(x);
    const d = x - f;
    if (d < 0.5) return f;
    if (d > 0.5) return f + 1;
    return f % 2 === 0 ? f : f + 1;
}

// ---------- main ----------
function main() {
    const a = parseArgs(process.argv.slice(2));
    const { bars, rows, style } = a;
    const frameInterval = 1000 / a.fps;
    const ch = Array.from(a.char || '')[0] || (a.ascii ? '#' : '\u2588');
    const FILL = ch + ch;
    const BLANK = '  ';
    const BASE = '._';

    const bands = makeBands(bars);
    const maxBin = bands.reduce((m, b) => Math.max(m, b[1]), 0);
    const window = makeHanning(FFT_N);
    const bell = bellCurve(bars);
    const fft = makeFFT(FFT_N);
    const mag = new Float64Array(FFT_N / 2 + 1);
    const windowed = new Float64Array(FFT_N);
    const lv = new Float64Array(bars);
    const smooth = new Float64Array(bars);
    const heights = new Int32Array(bars);

    const ring = new Float32Array(FFT_N);
    let wpos = 0;

    function ringPeak() {
        let p = 0;
        for (let i = 0; i < FFT_N; i++) {
            const v = ring[i] < 0 ? -ring[i] : ring[i];
            if (v > p) p = v;
        }
        return p;
    }

    function computeLevels(out) {
        for (let i = 0; i < FFT_N; i++) windowed[i] = ring[(wpos + i) & MASK] * window[i];
        fft(windowed, mag, maxBin);
        for (let b = 0; b < bars; b++) {
            const [lo, hi] = bands[b];
            let m = 0;
            for (let k = lo; k < hi; k++) if (mag[k] > m) m = mag[k];
            const db = 20 * Math.log10(m / FULL_SCALE + 1e-9);
            out[b] = Math.min(Math.max(1 + db / DB_RANGE, 0), 1);
        }
    }

    // ---- rendering ----
    const cellFor = {
        bars: (x, r) => (x >= r ? FILL : (r === 1 ? BASE : BLANK)),
        wave: (x, r) => (x === r ? FILL : BLANK),
        mirror: (x, r) => {
                const d = Math.abs(r - (rows + 1) / 2);
                return d + 0.5 <= x ? FILL : (d < 1 ? BASE : BLANK);
            },
    }[style];
    const heightMax = style === 'mirror' ? Math.ceil(rows / 2) : rows;
    const heightScale = heightMax;

    function render(levels, sep) {
        for (let i = 0; i < bars; i++)
            heights[i] = Math.min(Math.max(roundHalfEven(levels[i] * heightScale), 0), heightMax);
        const lines = new Array(rows);
        for (let r = rows, n = 0; r > 0; r--, n++) {
            let line = cellFor(heights[0], r);
            for (let i = 1; i < bars; i++) line += ' ' + cellFor(heights[i], r);
            lines[n] = line;
        }
        return lines.join(sep);
    }

    // ---- capture ----
    let proc;
    try {
        proc = spawn('parec', [
            '-d', '@DEFAULT_SINK@.monitor', '--format=s16le',
            `--rate=${RATE}`, '--channels=1', '--latency-msec=40',
            '--client-name=gridgets-audioviz', '--stream-name=spectrum',
        ], { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (e) {
        fail(`cannot start parec|${e.message}`);
    }

    process.on('exit', () => { try { proc.kill('SIGTERM'); } catch (_) { /* gone */ } });
    for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => process.exit(0));
    process.on('uncaughtException', e => fail(`audio helper error|${e && e.message}`));
    process.stdout.on('error', () => process.exit(0));
    proc.on('error', e => fail(e.code === 'ENOENT'
        ? 'parec not found|install pulseaudio-utils'
        : `cannot start parec|${e.message}`));
    proc.on('close', () => fail('audio capture stopped|is PulseAudio/PipeWire running?'));

    try { os.setPriority(0, 10); } catch (_) { /* not allowed, ignore */ }

    // ---- state ----
    let lastData = performance.now();
    let cleared = false;
    let carry = -1;
    let got = 0;
    let silentSince = -1;
    let idle = false;
    let sleeping = false;
    let timer = null;
    let lastOut = '';
    let finished = false;
    const parentPid = process.ppid;

    function tick() {
        timer = null;
        if (process.ppid !== parentPid) process.exit(0);
        const t0 = performance.now();

        if (!cleared && t0 - lastData > STALE_MS) { ring.fill(0); cleared = true; }

        if (ringPeak() < SILENCE_PEAK) {
            if (silentSince < 0) silentSince = t0;
            idle = t0 - silentSince >= IDLE_AFTER_MS;
        } else {
            silentSince = -1;
            idle = false;
        }

        let settled = false;
        if (idle) {
            let maxDiff = 0;
            for (let i = 0; i < bars; i++) {
                const d = bell[i] - smooth[i];
                smooth[i] += d * IDLE_EASE;
                const ad = d < 0 ? -d : d;
                if (ad > maxDiff) maxDiff = ad;
            }
            settled = maxDiff < IDLE_SETTLED;
        } else {
            computeLevels(lv);
            for (let i = 0; i < bars; i++)
                smooth[i] = lv[i] > smooth[i] ? lv[i] : smooth[i] * 0.8 + lv[i] * 0.2;
        }

        const out = render(smooth, '|');
        if (out !== lastOut && !process.stdout.writableNeedDrain) {
            lastOut = out;
            process.stdout.write(out + '\n');
        }

        sleeping = settled;
        timer = setTimeout(tick, settled ? IDLE_POLL_MS : Math.max(1, frameInterval - (performance.now() - t0)));
    }

    function wake() {
        if (!sleeping) return;
        sleeping = false;
        clearTimeout(timer);
        timer = setTimeout(tick, 0);
    }

    function finish() {                                         // --once
        if (finished) return;
        finished = true;
        let levels = bell;
        if (ringPeak() >= SILENCE_PEAK) { computeLevels(lv); levels = lv; }
        process.stdout.write(render(levels, '\n') + '\n', () => process.exit(0));
    }

    proc.stdout.on('data', chunk => {
        lastData = performance.now();
        cleared = false;
        const len = chunk.length;
        let i = 0;
        let peak = 0;
        if (carry >= 0 && len > 0) {
            const v = ((carry | (chunk[0] << 8)) << 16) >> 16;
            ring[wpos] = v / 32768;
            wpos = (wpos + 1) & MASK;
            got++;
            const m = v < 0 ? -v : v;
            if (m > peak) peak = m;
            carry = -1;
            i = 1;
        }
        for (; i + 1 < len; i += 2) {
            const v = ((chunk[i] | (chunk[i + 1] << 8)) << 16) >> 16;     // int16 LE
            ring[wpos] = v / 32768;
            wpos = (wpos + 1) & MASK;
            const m = v < 0 ? -v : v;
            if (m > peak) peak = m;
            got++;
        }
        if (i < len) carry = chunk[i];

        if (a.once) { if (got >= FFT_N) finish(); }
        else if (sleeping && peak >= SILENCE_RAW) wake();
    });

    if (a.once) setTimeout(finish, ONCE_TIMEOUT_MS);
    else timer = setTimeout(tick, 0);
}

main();