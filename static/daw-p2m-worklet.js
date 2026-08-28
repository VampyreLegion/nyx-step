// DAW Hum→MIDI worklet: live monophonic pitch detection (autocorrelation).
// Runs in an AudioWorkletGlobalScope. Posts {type:'pitch'|'silence', ...} to the
// main thread which converts f0 → quantized MIDI notes.
const _P2MW_SR = (typeof sampleRate !== "undefined") ? sampleRate : 48000;

class DAWP2MProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.sr = _P2MW_SR;
    this.cap = Math.floor(this.sr);                       // 1s ring buffer
    this.buf = new Float32Array(this.cap);
    this.pos = 0;
    this.filled = 0;
    this.win = Math.min(1024, Math.max(512, Math.floor(this.sr / 20)));   // ~20 ms window
    this.minLag = Math.max(2, Math.floor(this.sr / 2100));               // up to ~2.1 kHz
    this.maxLag = Math.min(this.win - 2, Math.floor(this.sr / 105));     // down to ~105 Hz
    this.frame = 0;
  }

  _rms(back, wStart, len) {
    const L = Math.min(back, this.cap);
    let e = 0;
    for (let i = 0; i < len && i < L; i++) {
      const v = this.buf[(wStart + i) % this.cap];
      e += v * v;
    }
    return Math.sqrt(e / Math.max(1, len));
  }

  _corrSum(k, s0) {
    let c = 0;
    for (let i = 0; i < this.win; i += 2) {
      c += this.buf[(s0 + i) % this.cap] * this.buf[(s0 + i + k) % this.cap];
    }
    return c;
  }

  process(inputs) {
    const ch = inputs && inputs[0] && inputs[0][0];
    if (!ch) return true;
    const n = ch.length;
    for (let i = 0; i < n; i++) {
      this.buf[this.pos] = ch[i];
      this.pos = (this.pos + 1) % this.cap;
      if (this.filled < this.cap) this.filled++;
    }
    this.frame += n;
    if (this.frame % 1024 !== 0) return true;             // detect ~ every 21 ms
    if (this.filled < this.win) return true;

    const s0 = (this.pos - this.win + this.cap) % this.cap;
    const rms = this._rms(Math.floor(this.sr * 0.04), s0, this.win);
    if (rms < 0.004) { this.port.postMessage({ type: "silence", rms }); return true; }

    // Normalized autocorrelation over the window, strided by 2.
    let eS = 0;
    for (let i = 0; i < this.win; i += 2) {
      const v = this.buf[(s0 + i) % this.cap];
      eS += v * v;
    }
    if (eS < 4e-6) { this.port.postMessage({ type: "silence", rms }); return true; }

    let bestLag = -1, bestN = 0;
    for (let k = this.minLag; k <= this.maxLag; k++) {
      const nk = this._corrSum(k, s0) / eS;
      if (nk > bestN) { bestN = nk; bestLag = k; }
    }
    if (bestLag <= 0 || bestN < 0.82) {
      this.port.postMessage({ type: "silence", rms });
      return true;
    }

    // Octave resolve: prefer the shortest period (highest f0) whose correlation is
    // comparable to the argmax — tries /2, /3, /4 so both 2T-locks (subharmonic)
    // and 3T-locks drop back to the fundamental (165/110 Hz instead of 330 Hz).
    let lag = bestLag, lagN = bestN;
    let changed = true;
    while (changed) {
      changed = false;
      for (let d = 4; d >= 2; d--) {
        const cand = Math.round(lag / d);
        if (cand < this.minLag || cand > this.maxLag || cand >= lag) continue;
        const nCand = this._corrSum(cand, s0) / eS;
        if (nCand >= 0.90 * lagN) { lag = cand; lagN = nCand; changed = true; }
      }
    }

    // Parabolic interpolation of the lag for sub-sample frequency resolution.
    const corrAt = (k) => {
      const kk = Math.max(1, Math.min(this.win - 1, k));
      return this._corrSum(kk, s0);
    };
    const y0 = corrAt(lag - 1), y1 = corrAt(lag), y2 = corrAt(lag + 1);
    const denom = 2 * (y0 - 2 * y1 + y2);
    if (Math.abs(denom) > 1e-12) {
      const d = (y0 - y2) / denom;
      lag += Math.max(-0.5, Math.min(0.5, d));
    }
    if (lag <= 0) { this.port.postMessage({ type: "silence", rms }); return true; }

    this.port.postMessage({ type: "pitch", f: this.sr / lag, conf: lagN, rms });
    return true;
  }
}

if (typeof AudioWorkletProcessor !== "undefined" && typeof registerProcessor === "function") {
  registerProcessor("daw-p2m-processor", DAWP2MProcessor);
}