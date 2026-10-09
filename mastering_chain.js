// mastering_chain.js (v3)
// Light "enhancement" chain, not a full mastering brickwall: gentle saturation +
// transient clarity + continuous, density-aware dynamics control (roughly half the
// strength of the previous version) + real LUFS-based loudness targeting with a
// true-peak ceiling, plus genre profiles (soul/funk, universal, hip-hop, EDM).

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.MasteringChain = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------------- utils ----------------
  function dbToLin(db) { return Math.pow(10, db / 20); }
  function linToDb(lin) { return 20 * Math.log10(Math.max(Math.abs(lin), 1e-9)); }
  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
  function lerp(a, b, t) { return a + (b - a) * t; }

  // ---------------- biquad (RBJ cookbook) ----------------
  function biquadCoeffs(type, freq, sampleRate, Q, gainDb) {
    Q = Q || 0.7071;
    gainDb = gainDb || 0;
    const A = Math.pow(10, gainDb / 40);
    const w0 = 2 * Math.PI * clamp(freq, 5, sampleRate / 2 - 10) / sampleRate;
    const alpha = Math.sin(w0) / (2 * Q);
    const cosw0 = Math.cos(w0);
    let b0, b1, b2, a0, a1, a2;
    if (type === 'lowpass') {
      b0 = (1 - cosw0) / 2; b1 = 1 - cosw0; b2 = (1 - cosw0) / 2;
      a0 = 1 + alpha; a1 = -2 * cosw0; a2 = 1 - alpha;
    } else if (type === 'highpass') {
      b0 = (1 + cosw0) / 2; b1 = -(1 + cosw0); b2 = (1 + cosw0) / 2;
      a0 = 1 + alpha; a1 = -2 * cosw0; a2 = 1 - alpha;
    } else if (type === 'lowshelf') {
      const sq = 2 * Math.sqrt(A) * alpha;
      b0 = A * ((A + 1) - (A - 1) * cosw0 + sq);
      b1 = 2 * A * ((A - 1) - (A + 1) * cosw0);
      b2 = A * ((A + 1) - (A - 1) * cosw0 - sq);
      a0 = (A + 1) + (A - 1) * cosw0 + sq;
      a1 = -2 * ((A - 1) + (A + 1) * cosw0);
      a2 = (A + 1) + (A - 1) * cosw0 - sq;
    } else if (type === 'highshelf') {
      const sq = 2 * Math.sqrt(A) * alpha;
      b0 = A * ((A + 1) + (A - 1) * cosw0 + sq);
      b1 = -2 * A * ((A - 1) + (A + 1) * cosw0);
      b2 = A * ((A + 1) + (A - 1) * cosw0 - sq);
      a0 = (A + 1) - (A - 1) * cosw0 + sq;
      a1 = 2 * ((A - 1) - (A + 1) * cosw0);
      a2 = (A + 1) - (A - 1) * cosw0 - sq;
    } else if (type === 'peaking') {
      b0 = 1 + alpha * A; b1 = -2 * cosw0; b2 = 1 - alpha * A;
      a0 = 1 + alpha / A; a1 = -2 * cosw0; a2 = 1 - alpha / A;
    } else {
      throw new Error('unknown biquad type ' + type);
    }
    return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
  }

  function makeBiquad(type, freq, sampleRate, Q, gainDb) {
    const c = biquadCoeffs(type, freq, sampleRate, Q, gainDb);
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    return function (x) {
      const y = c.b0 * x + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
      x2 = x1; x1 = x; y2 = y1; y1 = y;
      return y;
    };
  }

  function makeCrossoverLP(freq, sampleRate) {
    const a = makeBiquad('lowpass', freq, sampleRate, 0.5412);
    const b = makeBiquad('lowpass', freq, sampleRate, 1.3066);
    return function (x) { return b(a(x)); };
  }
  function makeCrossoverHP(freq, sampleRate) {
    const a = makeBiquad('highpass', freq, sampleRate, 0.5412);
    const b = makeBiquad('highpass', freq, sampleRate, 1.3066);
    return function (x) { return b(a(x)); };
  }

  // ---------------- envelope follower ----------------
  function makeEnvelope(sampleRate, attackMs, releaseMs) {
    const aCoef = Math.exp(-1 / (sampleRate * Math.max(attackMs, 0.01) / 1000));
    const rCoef = Math.exp(-1 / (sampleRate * Math.max(releaseMs, 0.01) / 1000));
    let env = 0;
    return function (rectified) {
      const coef = rectified > env ? aCoef : rCoef;
      env = coef * env + (1 - coef) * rectified;
      return env;
    };
  }

  // Transient guard: 0 on sustained material, rising to 1 on attacks (fast envelope
  // 6+ dB above the slow one). Colour stages fade their wet signal out on attacks so
  // saturation colours the body of a sound without rounding off its front edge.
  function makeTransientGuard(sampleRate) {
    const fast = makeEnvelope(sampleRate, 0.5, 8);
    const slow = makeEnvelope(sampleRate, 30, 120);
    return function (rectified) {
      const d = linToDb(fast(rectified)) - linToDb(slow(rectified));
      return d <= 0 ? 0 : (d >= 6 ? 1 : d / 6);
    };
  }

  // ---------------- K-weighting (ITU-R BS.1770-style) + integrated LUFS ----------------
  // Filter design values below are the standard analog-prototype parameters used to
  // redesign the BS.1770 K-weighting filters at arbitrary sample rates (stage 1: high
  // shelf ~+4dB around 1.7kHz; stage 2: high-pass around 38Hz, RLB weighting).
  function makeKWeighting(sampleRate) {
    const shelf = makeBiquad('highshelf', 1681.9744509555319, sampleRate, 0.7071752369554196, 3.999843853973347);
    const hp = makeBiquad('highpass', 38.13547087602444, sampleRate, 0.5003270373238773, 0);
    return function (x) { return hp(shelf(x)); };
  }

  function loudnessFromPower(z) { return -0.691 + 10 * Math.log10(Math.max(z, 1e-12)); }

  function measureLUFS(left, right, sampleRate) {
    const n = left.length;
    const blockSize = Math.round(sampleRate * 0.4);
    const hopSize = Math.round(sampleRate * 0.1);
    if (n < blockSize) return -70;

    const kL = makeKWeighting(sampleRate);
    const kR = makeKWeighting(sampleRate);
    const wl = new Float32Array(n), wr = new Float32Array(n);
    for (let i = 0; i < n; i++) { wl[i] = kL(left[i]); wr[i] = kR(right[i]); }

    const blockPower = [];
    for (let start = 0; start + blockSize <= n; start += hopSize) {
      let sumL = 0, sumR = 0;
      for (let i = start; i < start + blockSize; i++) { sumL += wl[i] * wl[i]; sumR += wr[i] * wr[i]; }
      blockPower.push(sumL / blockSize + sumR / blockSize);
    }
    if (!blockPower.length) return -70;

    const absGated = blockPower.filter(z => loudnessFromPower(z) > -70);
    if (!absGated.length) return -70;
    const meanAbs = absGated.reduce((a, b) => a + b, 0) / absGated.length;
    const relThreshold = loudnessFromPower(meanAbs) - 10;

    const relGated = absGated.filter(z => loudnessFromPower(z) > relThreshold);
    const finalPower = relGated.length ? relGated.reduce((a, b) => a + b, 0) / relGated.length : meanAbs;
    return loudnessFromPower(finalPower);
  }

  // ---------------- stage 0: analysis + continuous density score ----------------
  function analyzeSource(left, right, sampleRate) {
    const n = left.length;
    let sumSq = 0, peak = 0;
    for (let i = 0; i < n; i++) {
      const l = left[i], r = right[i];
      sumSq += l * l + r * r;
      const a = Math.max(Math.abs(l), Math.abs(r));
      if (a > peak) peak = a;
    }
    const rms = Math.sqrt(sumSq / (n * 2));
    const rmsDb = linToDb(rms);
    const peakDb = linToDb(peak);
    const crestFactorDb = peakDb - rmsDb;

    const lp = makeCrossoverLP(100, sampleRate);
    const hp = makeCrossoverHP(6000, sampleRate);
    let lowE = 0, highE = 0, totalE = 0;
    for (let i = 0; i < n; i++) {
      const mono = (left[i] + right[i]) * 0.5;
      const lo = lp(mono);
      const hi = hp(mono);
      lowE += lo * lo;
      highE += hi * hi;
      totalE += mono * mono;
    }
    const wideSpectrumRatio = totalE > 1e-12 ? (lowE + highE) / totalE : 0;

    return { rmsDb, peakDb, crestFactorDb, wideSpectrumRatio };
  }

  // Continuous 0..1 "how dense/loud/wide is this source" score, replacing the old
  // binary normal/dense_dynamic switch so every track gets a proportionate amount
  // of processing instead of one of two fixed settings.
  function densityScore(metrics) {
    const loudScore = clamp((metrics.rmsDb - (-30)) / ((-8) - (-30)), 0, 1);
    const crestScore = clamp((14 - metrics.crestFactorDb) / (14 - 4), 0, 1);
    const wideScore = clamp(metrics.wideSpectrumRatio / 0.4, 0, 1);
    return clamp((loudScore + crestScore + wideScore) / 3, 0, 1);
  }

  function classifySource(metrics, opts) {
    opts = opts || {};
    const loudThresh = opts.loudRmsThresholdDb != null ? opts.loudRmsThresholdDb : -14;
    const denseThresh = opts.denseCrestThresholdDb != null ? opts.denseCrestThresholdDb : 8;
    const wideThresh = opts.wideSpectrumThreshold != null ? opts.wideSpectrumThreshold : 0.15;
    let votes = 0;
    if (metrics.rmsDb >= loudThresh) votes++;
    if (metrics.crestFactorDb <= denseThresh) votes++;
    if (metrics.wideSpectrumRatio >= wideThresh) votes++;
    return votes >= 2 ? 'dense_dynamic' : 'normal';
  }

  // ---------------- genre profiles ----------------
  // These bias a handful of parameters per the user's brief:
  //  - jazz/acoustic: a bit wider than the original + than other genres (+5-10%),
  //    a bit more saturation/character (+5-8%) than other genres
  //  - hip-hop: crisp transients, loud, but processing stays light (warmthMult < 1)
  //    — loudness comes from the final LUFS stage, not from squashing the signal
  //  - EDM/house/trap/bass: tighter, cleaner low end (lower low-band threshold +
  //    higher low-band ratio + slightly higher mono-sum point), loud, clear transients
  // mbBandGainDb: per-band (low <98Hz / mid 98-1660Hz / high >1660Hz) trims applied in
  // the multiband, capped at +/-1 dB, that nudge each genre's balance toward the iZotope
  // Tonal Balance Control reference curve for that genre. RnB-Soul & Hip-Hop curves show
  // a fuller low-mid; these are gentle pulls toward that shape, not heavy EQ.
  const GENRE_PROFILES = {
    universal: { label: 'Universal', stWidth: 1.05, trueIronMixMult: 1.0, enhancerMixMult: 1.0, lowBandRatioMult: 1.0, lowBandThreshAdjustDb: 0, monoMkrHz: 45, transientAmount: 0.35, warmthMult: 1.0, airAmount: 0.45, mbBandGainDb: [0.5, 0.5, 0] },
    soulfunk: { label: 'Soul / Funk', colour: 0.85, stWidth: 1.30, trueIronMixMult: 1.13, enhancerMixMult: 1.15, lowBandRatioMult: 1.0, lowBandThreshAdjustDb: 0, monoMkrHz: 40, transientAmount: 0.32, warmthMult: 1.15, airAmount: 0.62, mbBandGainDb: [1.0, 1.0, 0] },
    hiphop: { label: 'Rap / Hip-Hop', colour: 0.75, stWidth: 1.18, trueIronMixMult: 1.0, enhancerMixMult: 1.0, lowBandRatioMult: 1.0, lowBandThreshAdjustDb: 0, monoMkrHz: 50, transientAmount: 0.40, warmthMult: 0.85, airAmount: 0.50, mbBandGainDb: [1.0, 0.5, 0] },
    edm: { label: 'EDM / House / Trap', colour: 0.5, stWidth: 1.08, trueIronMixMult: 1.0, enhancerMixMult: 0.95, lowBandRatioMult: 1.3, lowBandThreshAdjustDb: -3, monoMkrHz: 70, transientAmount: 0.45, warmthMult: 1.0, airAmount: 0.60, mbBandGainDb: [0, 0, 0] },
    // Vinyl and Tape: character modes — minimal standard processing upstream, then the
    // dedicated stage takes over. Both normalise to a fixed -11 LUFS (same as soul/funk)
    // so the character is loud and clearly audible. Multiband is skipped (no mbBandGainDb
    // routing needed — these modes branch differently in buildPipeline).
    vinyl: { label: 'Vinyl', stWidth: 1.02, trueIronMixMult: 0.6, enhancerMixMult: 0.6, lowBandRatioMult: 1.0, lowBandThreshAdjustDb: 0, monoMkrHz: 60, transientAmount: 0.20, warmthMult: 0.7, airAmount: 0.30, mbBandGainDb: [0, 0, 0] },
    tape: { label: 'Tape / VHS', stWidth: 1.03, trueIronMixMult: 0.7, enhancerMixMult: 0.7, lowBandRatioMult: 1.0, lowBandThreshAdjustDb: 0, monoMkrHz: 55, transientAmount: 0.22, warmthMult: 0.8, airAmount: 0.25, mbBandGainDb: [0, 0, 0] },
  };
  // colour (Strong 0.85 / Medium 0.75 / Light 0.5): how hard the colouring stages (True
  // Iron, enhancer blend, Kazrog warmth) are driven. Profiles without it (universal and
  // the vinyl/tape effects) keep the older intensityScale-only gating.
  // stWidth on the three levels is the side gain above ~1.2 kHz; the low-mids get half
  // of it, and it is capped on sources that are already wide (see widthForSource).
  function getGenreProfile(genre) { return GENRE_PROFILES[genre] || GENRE_PROFILES.universal; }

  // Side/mid energy ratio (dB) in the 300 Hz - 8 kHz band, where stereo width is
  // actually heard. Broadband side/mid is dominated by the (mono) bass, so any bass
  // boost reads as "narrower" even when the stereo image is untouched.
  function measureSideMidDb(left, right, sampleRate) {
    const hpM = makeBiquad('highpass', 300, sampleRate, 0.707), lpM = makeBiquad('lowpass', 8000, sampleRate, 0.707);
    const hpS = makeBiquad('highpass', 300, sampleRate, 0.707), lpS = makeBiquad('lowpass', 8000, sampleRate, 0.707);
    let m = 0, sd = 0;
    for (let i = 0; i < left.length; i++) {
      const mv = lpM(hpM((left[i] + right[i]) * 0.5));
      const sv = lpS(hpS((left[i] - right[i]) * 0.5));
      m += mv * mv; sd += sv * sv;
    }
    return 10 * Math.log10(Math.max(sd, 1e-12) / Math.max(m, 1e-12));
  }

  // Punch protection on the three processing levels: how much of the saturation wet
  // signal is faded out on attacks, and a slower enhancer-compressor attack so the
  // front edge of a hit passes before gain reduction lands (bypassed: 4 ms).
  const TRANSIENT_GUARD = 0.85;
  // With unity-gain saturation the wet path no longer rides ~+5..8 dB over the dry one,
  // so the same mix carries far fewer harmonics; the levels drive it harder to compensate.
  const LEVEL_IRON_MIX_BOOST = 4.0;
  const LEVEL_WARMTH_BOOST = 2.0;
  const ENHANCER_ATTACK_MS_LEVELS = 15;

  // Don't push an already-wide source past MAX_SIDE_MID_DB (phasey, weak in mono clubs).
  const MAX_SIDE_MID_DB = -4;
  function widthForSource(stWidth, sourceSideMidDb) {
    if (stWidth <= 1) return stWidth;
    const roomDb = Math.max(0, MAX_SIDE_MID_DB - sourceSideMidDb);
    return Math.min(stWidth, dbToLin(roomDb));
  }

  // ---------------- adaptive tonal balance (measured, bidirectional) ----------------
  // The OLD tonal nudge (TONAL_NUDGE_PROFILES below) is a static, one-directional EQ:
  // it always ADDS the same dB at the same frequencies regardless of what the source
  // actually contains. That fails on a track whose voice already pokes out at ~1.8 kHz
  // -- the static +0.8 dB there makes it worse.
  //
  // This adaptive stage instead measures the source's own long-term band balance in a
  // single pre-pass, compares each band to a genre REFERENCE balance (read off iZotope
  // Tonal Balance Control), and corrects BY THE DIFFERENCE in BOTH directions: cut a
  // band that sits ABOVE the reference, boost one that sits BELOW it. Correction per
  // band is (reference - measured) * strength, hard-capped at +/- ADAPTIVE_CAP_DB so we
  // never override the artist's intent -- just pull an outlier back toward the curve.
  //
  // Bands are the SAME log centres the static nudge used (plus a low-mid control band),
  // so the two systems shape the same regions -- this one just decides direction and
  // amount from measurement instead of assuming a neutral source.
  const ADAPTIVE_CAP_DB = 2.5;      // max cut/boost per band (protects artist intent)
  const ADAPTIVE_STRENGTH = 0.8;    // fraction of the measured deviation we correct

  // Analysis band centres (Hz). Each is measured with a bandpass built from LR crossovers
  // and shaped as a peaking (or shelf at the ends) move. Ordered low -> high.
  const ADAPTIVE_BANDS = [
    { freq: 120,  lo: 60,   hi: 240,  type: 'lowshelf',  Q: 0.7 },
    { freq: 350,  lo: 240,  hi: 500,  type: 'peaking',   Q: 0.9 },
    { freq: 700,  lo: 500,  hi: 1000, type: 'peaking',   Q: 0.9 },
    { freq: 1800, lo: 1200, hi: 2600, type: 'peaking',   Q: 1.0 }, // "voice pokes out" band
    { freq: 4000, lo: 2600, hi: 6000, type: 'peaking',   Q: 0.9 },
    { freq: 9000, lo: 6000, hi: 14000,type: 'highshelf', Q: 0.7 },
  ];

  // Genre reference band balances, in dB RELATIVE to each curve's own broadband average
  // (i.e. how much louder/quieter each band sits vs the whole-spectrum mean). Read off
  // the iZotope Tonal Balance Control target curves. Soul/Funk: fuller low-mids and a
  // gentle presence/air shoulder. Hip-Hop: strong lows, scooped low-mids, controlled
  // presence. Only genres with a reference get adaptive correction; others fall back to
  // the static nudge (or nothing).
  const ADAPTIVE_REFERENCE = {
    //          120    350    700   1800   4000   9000
    soulfunk: [ +4.0,  +1.0,  +0.5,  -0.5,  -1.5,  -3.0 ],
    hiphop:   [ +5.5,  -1.0,  +0.5,  -0.5,  -2.0,  -4.0 ],
    // [INIT] EDM / electronic: heavy, clean lows, no low-mid shoulder, a smooth decline
    // and a brighter top than hip-hop. A placeholder shape until it is calibrated on
    // real electronic masters.
    electronic: [ +6.0, -0.5, -1.0,  -1.0,  -1.5,  -2.0 ],
  };

  // User-selectable tonal styles (independent of the processing level) and the
  // reference curve each one pulls toward.
  const TONAL_STYLES = {
    acoustic:   { label: 'Acoustic-Live', reference: 'soulfunk' },
    modern:     { label: 'Modern',        reference: 'hiphop' },
    electronic: { label: 'Electronic',    reference: 'electronic' },
  };

  // Measure the source's long-term average energy in each ADAPTIVE_BANDS band, expressed
  // in dB relative to the source's own broadband average -- directly comparable to the
  // ADAPTIVE_REFERENCE entries. One extra pass over the audio (mono sum).
  function measureBandBalance(left, right, sampleRate) {
    const n = left.length;
    // Independent bandpass per band (cascaded LR high-pass + low-pass).
    const filters = ADAPTIVE_BANDS.map(function (b) {
      const hp = b.lo > 20 ? makeCrossoverHP(b.lo, sampleRate) : null;
      const lp = b.hi < sampleRate / 2 - 200 ? makeCrossoverLP(b.hi, sampleRate) : null;
      return function (x) { let v = x; if (hp) v = hp(v); if (lp) v = lp(v); return v; };
    });
    const energy = new Float64Array(ADAPTIVE_BANDS.length);
    let totalE = 0;
    for (let i = 0; i < n; i++) {
      const mono = (left[i] + right[i]) * 0.5;
      totalE += mono * mono;
      for (let k = 0; k < filters.length; k++) {
        const v = filters[k](mono);
        energy[k] += v * v;
      }
    }
    // Convert each band's RMS to dB, then express as a SHAPE: each band relative to the
    // AVERAGE of all band dBs. This removes the source's overall level and broadband tilt
    // and leaves only the relative balance between bands -- the same quantity the
    // ADAPTIVE_REFERENCE curves encode, so measured and reference are directly comparable.
    const bandDb = [];
    for (let k = 0; k < ADAPTIVE_BANDS.length; k++) {
      const bandRms = Math.sqrt(energy[k] / Math.max(n, 1));
      bandDb.push(linToDb(bandRms));
    }
    let mean = 0;
    for (let k = 0; k < bandDb.length; k++) mean += bandDb[k];
    mean /= bandDb.length;
    return bandDb.map(function (d) { return d - mean; });
  }

  // Build the bidirectional correction moves for a genre by comparing the measured source
  // balance against the reference. Returns an array of {type,freq,Q,gainDb} ready for the
  // same biquad chain the static nudge uses. gainDb is already capped; direction and size
  // come from the measurement. Bands within DEADBAND_DB of the reference are left alone.
  const ADAPTIVE_DEADBAND_DB = 0.5; // don't fiddle with bands already close to target
  function buildAdaptiveTonalMoves(genreKey, measuredBalanceDb) {
    const ref = ADAPTIVE_REFERENCE[genreKey];
    if (!ref || !measuredBalanceDb) return null;
    // Center the reference on its own band-mean so it lives in the same "shape relative to
    // band-average" space as measuredBalanceDb (which measureBandBalance already centers).
    let refMean = 0;
    for (let k = 0; k < ref.length; k++) refMean += ref[k];
    refMean /= ref.length;
    const moves = [];
    for (let k = 0; k < ADAPTIVE_BANDS.length; k++) {
      const b = ADAPTIVE_BANDS[k];
      const refCentered = ref[k] - refMean;
      const deviation = refCentered - measuredBalanceDb[k]; // + => source too low, boost; - => too high, cut
      if (Math.abs(deviation) <= ADAPTIVE_DEADBAND_DB) continue;
      const gainDb = clamp(deviation * ADAPTIVE_STRENGTH, -ADAPTIVE_CAP_DB, ADAPTIVE_CAP_DB);
      moves.push({ type: b.type, freq: b.freq, Q: b.Q, gainDb: gainDb });
    }
    return moves;
  }

  // Apply a set of measured tonal moves (same biquad-chain shape as the static nudge).
  // The scale argument gates the amount so already-dense sources are corrected more gently.
  function adaptiveTonalStage(left, right, sampleRate, moves, intensityScale) {
    const scale = intensityScale != null ? intensityScale : 1.0;
    if (!moves || !moves.length || scale <= 0.02) return { left, right, applied: [] };
    const applied = moves.map(function (m) {
      return { type: m.type, freq: m.freq, Q: m.Q, gainDb: clamp(m.gainDb * scale, -ADAPTIVE_CAP_DB, ADAPTIVE_CAP_DB) };
    }).filter(function (m) { return Math.abs(m.gainDb) > 0.01; });
    if (!applied.length) return { left, right, applied: [] };
    const chainL = applied.map(m => makeBiquad(m.type, m.freq, sampleRate, m.Q, m.gainDb));
    const chainR = applied.map(m => makeBiquad(m.type, m.freq, sampleRate, m.Q, m.gainDb));
    const n = left.length;
    for (let i = 0; i < n; i++) {
      let l = left[i], r = right[i];
      for (let k = 0; k < chainL.length; k++) { l = chainL[k](l); r = chainR[k](r); }
      left[i] = l; right[i] = r;
    }
    return { left, right, applied: applied };
  }

  // ---------------- tonal nudge profiles (legacy static fallback) ----------------
  // Small, capped (+/-1.3dB max) EQ moves toward the *shape* read off iZotope Tonal
  // Balance Control reference curves for each genre (Fine View, no absolute dB scale
  // was visible in the screenshots -- these are shape-matching nudges, not a measured
  // match to an exact target curve). Hip-hop/RnB-Soul-style curves showed a dip around
  // 250-400Hz and a warmth shoulder around 700-1200Hz before rolling off; the EDM curve
  // declined smoothly with no such low-mid shoulder. No jazz/orchestral reference was
  // provided, so jazz gets no nudge here. Used only for genres WITHOUT an adaptive
  // reference; soul/funk and hip-hop now use the measured adaptive stage instead.
  const TONAL_NUDGE_PROFILES = {
    universal: [],
    // Soul/Funk: the analysis showed our output was consistently darker/thinner than
    // the reference in the low-mid..highs. A gentle broad presence lift (kept within the
    // +/-1.3 dB cap per band) nudges toward the reference's warmer, fuller, brighter
    // balance without heavy EQ. This is intentionally more than the empty jazz profile
    // it replaces.
    soulfunk: [
      { type: 'peaking', freq: 500, Q: 0.8, gainDb: 1.0 },
      { type: 'peaking', freq: 1800, Q: 0.9, gainDb: 0.8 },
      { type: 'highshelf', freq: 6000, Q: 0.7, gainDb: 1.0 },
    ],
    hiphop: [
      { type: 'peaking', freq: 320, Q: 1.1, gainDb: -1.0 },
      { type: 'peaking', freq: 950, Q: 1.1, gainDb: 1.0 },
      { type: 'highshelf', freq: 6000, Q: 0.7, gainDb: -0.5 },
    ],
    // Vinyl and Tape: tonal shaping is handled entirely inside vinylStage/tapeStage —
    // no separate tonal nudge needed here.
    vinyl: [],
    tape: [],
  };

  function tonalNudgeStage(left, right, sampleRate, genreKey, intensityScale) {
    const scale = intensityScale != null ? intensityScale : 1.0;
    const moves = TONAL_NUDGE_PROFILES[genreKey] || TONAL_NUDGE_PROFILES.universal;
    if (!moves || !moves.length || scale <= 0.02) return { left, right };
    const chainL = moves.map(m => makeBiquad(m.type, m.freq, sampleRate, m.Q, clamp(m.gainDb * scale, -1.3, 1.3)));
    const chainR = moves.map(m => makeBiquad(m.type, m.freq, sampleRate, m.Q, clamp(m.gainDb * scale, -1.3, 1.3)));
    const n = left.length;
    for (let i = 0; i < n; i++) {
      let l = left[i], r = right[i];
      for (let k = 0; k < chainL.length; k++) { l = chainL[k](l); r = chainR[k](r); }
      left[i] = l; right[i] = r;
    }
    return { left, right };
  }

  // ---------------- stage 0b: gentle subsonic high-pass (22 Hz) ----------------
  // Removes inaudible sub-22Hz rumble/DC drift that otherwise wastes headroom and
  // muddies the low end. Deliberately gentle: a single 2nd-order (12 dB/oct) high-pass
  // at 22 Hz is essentially inaudible on the musical low end (kick/bass fundamentals
  // sit well above this) but clears out subsonic energy for a more transparent mix.
  function subsonicHighpassStage(left, right, sampleRate) {
    const hpL = makeBiquad('highpass', 22, sampleRate, 0.7071);
    const hpR = makeBiquad('highpass', 22, sampleRate, 0.7071);
    const n = left.length;
    for (let i = 0; i < n; i++) { left[i] = hpL(left[i]); right[i] = hpR(right[i]); }
    return { left, right };
  }

  // ---------------- stage 1: headroom normalization ----------------
  function normalizeHeadroom(left, right, peakDb, targetDb) {
    let gainDb = 0;
    if (peakDb > -0.5) gainDb = targetDb - peakDb;
    else if (peakDb < -3.0) gainDb = targetDb - peakDb;
    if (gainDb === 0) return { left, right, appliedGainDb: 0 };
    const g = dbToLin(gainDb);
    for (let i = 0; i < left.length; i++) { left[i] *= g; right[i] *= g; }
    return { left, right, appliedGainDb: gainDb };
  }

  // ---------------- stage 2: True Iron (transformer saturation) ----------------
  function trueIronStage(left, right, params) {
    const strength = params.strength != null ? params.strength : 5.14;
    const mix = params.mix != null ? params.mix : 0.6;
    const drive = 1 + strength * 0.30; // gentler curve than before -- even a reduced mix% was
                                        // still costing real crest factor via harmonic stacking
    // Normalising by tanh(drive) gives the curve a small-signal gain of drive/tanh(drive)
    // (~+8 dB here): quiet parts get louder while peaks are held -- upward compression
    // that flattens hit-vs-background contrast. The processing levels normalise by drive
    // instead (unity gain for quiet signals, only peaks are rounded).
    const tanhDrive = params.unityGain ? drive : Math.tanh(drive);
    const lowShelfL = makeBiquad('lowshelf', 90, params.sampleRate, 0.707, 1.2);
    const lowShelfR = makeBiquad('lowshelf', 90, params.sampleRate, 0.707, 1.2);

    function sat(x) {
      const wet = Math.tanh(x * drive) / tanhDrive;
      const k = 0.025;
      // bounded 2nd-harmonic coloration: guaranteed within [-1,1] for |wet|<=1
      return (wet + k * wet * wet * Math.sign(wet)) / (1 + k);
    }
    const guardDepth = params.transientGuard || 0;
    const guard = guardDepth > 0 ? makeTransientGuard(params.sampleRate) : null;
    for (let i = 0; i < left.length; i++) {
      const dl = left[i], dr = right[i];
      const wl = sat(lowShelfL(dl));
      const wr = sat(lowShelfR(dr));
      const m = guard ? mix * (1 - guardDepth * guard(Math.max(Math.abs(dl), Math.abs(dr)))) : mix;
      left[i] = dl * (1 - m) + wl * m;
      right[i] = dr * (1 - m) + wr * m;
    }
    return { left, right };
  }

  // ---------------- stage 2b: transient emphasis ("readable transients") ----------------
  // Compares a very fast envelope against a slower one; when the fast one spikes above
  // the slow one (i.e. an attack is happening right now) it applies a brief, bounded
  // gain boost. This restores/adds punch *before* the gentler compressors below run,
  // rather than relying on compression to create the sense of loudness.
  function transientEmphasisStage(left, right, sampleRate, amount) {
    if (!amount || amount <= 0) return { left, right };
    const fastEnv = makeEnvelope(sampleRate, 0.5, 6);
    const slowEnv = makeEnvelope(sampleRate, 25, 90);
    const n = left.length;
    for (let i = 0; i < n; i++) {
      const rect = Math.max(Math.abs(left[i]), Math.abs(right[i]));
      const fe = fastEnv(rect);
      const se = slowEnv(rect);
      const diffDb = linToDb(fe) - linToDb(se);
      const boostDb = diffDb > 0 ? Math.min(diffDb, 4) * amount : 0;
      const g = dbToLin(boostDb);
      left[i] *= g; right[i] *= g;
    }
    return { left, right };
  }

  // ---------------- stage 6b: air & sparkle exciter ----------------
  // Restores/adds top-end "air" that mp3 encoding and the multiband crossover both
  // eat into. Two complementary techniques used by high-end mastering exciters:
  //  1) HARMONIC GENERATION: gently saturate a high-passed copy of the signal to
  //     synthesize NEW high-frequency harmonics from existing upper-mid content --
  //     this restores perceived brightness even when the original top octave was
  //     stripped by mp3 (a plain EQ boost can't add what isn't there; this can).
  //  2) HF TRANSIENT SPARKLE: a fast/slow envelope detector on the high band only,
  //     boosting high-frequency transients (cymbal/hat/consonant attacks) for
  //     "readable", crisp detail without raising sustained hiss.
  // Plus a gentle high-shelf to compensate the measured ~1dB crossover treble loss.
  function airExciterStage(left, right, sampleRate, amount) {
    if (!amount || amount <= 0) return { left, right };
    const n = left.length;

    // compensation shelf: makes up the multiband crossover's high-frequency loss.
    // Two overlapping shelves (a lower one at 3.5k for the 4-8kHz dip, a higher one at
    // 9k for the top octave) reconstruct the measured crossover loss curve more evenly
    // than a single shelf, which otherwise leaves a 4-8kHz notch.
    const compScale = clamp(amount / 0.5, 0, 1);
    const compLowL = makeBiquad('highshelf', 3500, sampleRate, 0.6, 1.0 * compScale);
    const compLowR = makeBiquad('highshelf', 3500, sampleRate, 0.6, 1.0 * compScale);
    const compShelfL = makeBiquad('highshelf', 9000, sampleRate, 0.7, 0.8 * compScale);
    const compShelfR = makeBiquad('highshelf', 9000, sampleRate, 0.7, 0.8 * compScale);

    // harmonic-generation path: isolate highs, saturate to create new harmonics
    const hpGenL = makeCrossoverHP(7500, sampleRate);
    const hpGenR = makeCrossoverHP(7500, sampleRate);
    // band-limit the generated harmonics so we don't create aliasing-like harshness
    const genLpL = makeBiquad('lowpass', 17000, sampleRate, 0.7);
    const genLpR = makeBiquad('lowpass', 17000, sampleRate, 0.7);

    // HF transient detector (on a high-passed sidechain)
    const hpDetL = makeCrossoverHP(5000, sampleRate);
    const hpDetR = makeCrossoverHP(5000, sampleRate);
    const fastEnv = makeEnvelope(sampleRate, 0.3, 4);
    const slowEnv = makeEnvelope(sampleRate, 20, 70);
    // The sparkle boosts HF transients. We extract the high band with a highpass and
    // apply a time-varying gain to THAT component directly (adding it back on top). The
    // previous version used a fixed-0dB highshelf biquad whose output ≈ input, so the
    // boost was always ~0 — dead code. A highpass with a per-sample scalar gain actually
    // moves the high frequencies in time with detected transients.
    const sparkleHpL = makeCrossoverHP(7000, sampleRate);
    const sparkleHpR = makeCrossoverHP(7000, sampleRate);

    const genMix = 0.12 * amount;      // how much synthesized harmonic content to add
    const sparkleAmount = 0.6 * amount; // HF transient boost depth

    for (let i = 0; i < n; i++) {
      let l = compShelfL(compLowL(left[i]));
      let r = compShelfR(compLowR(right[i]));

      // 1) harmonic generation: soft asymmetric saturation of the isolated top band,
      //    band-limited, then mixed back in
      const genInL = hpGenL(left[i]);
      const genInR = hpGenR(right[i]);
      const harmL = genLpL(Math.tanh(genInL * 3.0) - genInL * 0.6); // 2nd/3rd harmonic residue
      const harmR = genLpR(Math.tanh(genInR * 3.0) - genInR * 0.6);
      l += harmL * genMix;
      r += harmR * genMix;

      // 2) HF transient sparkle: detect high-band attacks, briefly lift the high band
      const detRect = Math.max(Math.abs(hpDetL(left[i])), Math.abs(hpDetR(right[i])));
      const fe = fastEnv(detRect);
      const se = slowEnv(detRect);
      const transientStrength = clamp(linToDb(fe) - linToDb(se), 0, 6) / 6; // 0..1
      const sparkleBoost = transientStrength * sparkleAmount; // 0..sparkleAmount
      // add a fraction of the (highpassed) high band back on top, scaled by transient strength
      const hiL = sparkleHpL(l);
      const hiR = sparkleHpR(r);
      l += hiL * sparkleBoost;
      r += hiR * sparkleBoost;

      left[i] = l; right[i] = r;
    }
    return { left, right };
  }


  // ---------------- stage 3: bx_enhancer (EQ/Sculpt + compressor + Colour) ----------------
  function bxEnhancerStage(left, right, params) {
    const sampleRate = params.sampleRate;
    const sculptBasis = params.sculptBasis != null ? params.sculptBasis : 0.03;
    const sculptBoost = params.sculptBoost != null ? params.sculptBoost : 0.09;
    const colourBass = params.colourBass != null ? params.colourBass : 0.06;
    const colourExcite = params.colourExcite != null ? params.colourExcite : 0.02;
    const monoMkrHz = params.monoMkrHz != null ? params.monoMkrHz : 45;
    const stWidth = params.stWidth != null ? params.stWidth : 1.05;
    const compThreshDb = params.compThresholdDb != null ? params.compThresholdDb : -10.8;
    const compReleaseMs = params.compReleaseMs != null ? params.compReleaseMs : 132;
    const compAttackMs = params.compAttackMs != null ? params.compAttackMs : 4;
    const finalMix = params.mix != null ? params.mix : 0.36;
    const intensityScale = params.intensityScale != null ? params.intensityScale : 0.5;
    const ratio = params.ratio != null ? params.ratio : 1.8;

    const n = left.length;
    const dryL = left.slice(), dryR = right.slice();

    const bassShelfL = makeBiquad('lowshelf', 150, sampleRate, 0.707, sculptBasis * 6);
    const bassShelfR = makeBiquad('lowshelf', 150, sampleRate, 0.707, sculptBasis * 6);
    const presenceL = makeBiquad('peaking', 2500, sampleRate, 0.9, sculptBoost * 9);
    const presenceR = makeBiquad('peaking', 2500, sampleRate, 0.9, sculptBoost * 9);
    const colourBassShelfL = makeBiquad('lowshelf', 100, sampleRate, 0.707, colourBass * 10);
    const colourBassShelfR = makeBiquad('lowshelf', 100, sampleRate, 0.707, colourBass * 10);
    const exciteShelfL = makeBiquad('highshelf', 8000, sampleRate, 0.707, colourExcite * 14);
    const exciteShelfR = makeBiquad('highshelf', 8000, sampleRate, 0.707, colourExcite * 14);
    const monoLpFinalL = makeCrossoverLP(monoMkrHz, sampleRate);
    const monoLpFinalR = makeCrossoverLP(monoMkrHz, sampleRate);
    const monoHpFinalL = makeCrossoverHP(monoMkrHz, sampleRate);
    const monoHpFinalR = makeCrossoverHP(monoMkrHz, sampleRate);

    const envFollower = makeEnvelope(sampleRate, compAttackMs, compReleaseMs);
    // Side split at 1.2 kHz: low-mid side gets half the widening, highs get all of it.
    // sideLo + (side - sideLo) reconstructs side exactly, so width 1 is a true bypass.
    const sideLp = makeBiquad('lowpass', 1200, sampleRate, 0.707);
    // Only the three processing levels use the split; the effects keep flat side gain.
    const widthLo = params.widthSplit ? 1 + (stWidth - 1) * 0.5 : stWidth;

    for (let i = 0; i < n; i++) {
      let l = colourBassShelfL(bassShelfL(dryL[i]));
      let r = colourBassShelfR(bassShelfR(dryR[i]));
      l = exciteShelfL(presenceL(l));
      r = exciteShelfR(presenceR(r));

      const rectified = Math.max(Math.abs(l), Math.abs(r));
      const env = envFollower(rectified);
      const envDb = linToDb(env);
      const over = envDb - compThreshDb;
      const grDb = over > 0 ? over * (1 - 1 / ratio) : 0;
      const g = dbToLin(-grDb) * intensityScale + (1 - intensityScale);
      l *= g; r *= g;

      // dry/wet blend happens BEFORE the width step, so width isn't entangled
      // with how much wet signal made it through
      const blL = dryL[i] * (1 - finalMix) + l * finalMix;
      const blR = dryR[i] * (1 - finalMix) + r * finalMix;

      // frequency-selective width+mono-sum on the final blend (single crossover
      // pass instead of one-per-path -- cheaper, and correct either way since
      // this is the only mono-sum point that matters for the actual output)
      const lowFL = monoLpFinalL(blL), lowFR = monoLpFinalR(blR);
      // Processing levels: complementary split (high = input - low), so the mono-maker's
      // LR4 allpass no longer smears the kick (45-130 Hz) against its attack. The effects
      // keep the original LR4 high-pass.
      const highFL = params.widthSplit ? blL - lowFL : monoHpFinalL(blL);
      const highFR = params.widthSplit ? blR - lowFR : monoHpFinalR(blR);
      const lowFMono = (lowFL + lowFR) * 0.5;
      const midHigh = (highFL + highFR) * 0.5;
      const side = (highFL - highFR) * 0.5;
      const sideLo = sideLp(side);
      const sideHigh = sideLo * widthLo + (side - sideLo) * stWidth;
      left[i] = lowFMono + midHigh + sideHigh;
      right[i] = lowFMono + midHigh - sideHigh;
    }
    return { left, right };
  }

  // ---------------- soft-knee gain reduction (dB domain) ----------------
  // Standard soft-knee compressor transfer function: quadratic interpolation across
  // a knee region of width W centered on the threshold, continuous with the hard-knee
  // formula outside the knee. Used for the multiband bands (Ableton's Soft Knee toggle
  // was on in the reference screenshot).
  function softKneeGrDb(inputDb, thresholdDb, ratio, kneeWidthDb) {
    const over = inputDb - thresholdDb;
    const kneeHalf = kneeWidthDb / 2;
    if (over < -kneeHalf) return 0;
    if (over > kneeHalf) return over * (1 - 1 / ratio);
    const x = over + kneeHalf;
    return ((1 - 1 / ratio) * x * x) / (2 * kneeWidthDb);
  }

  // ---------------- stage 4: adaptive multiband compressor ----------------
  function multibandStage(left, right, params) {
    const sampleRate = params.sampleRate;
    const intensityScale = params.intensityScale != null ? params.intensityScale : 0.45;
    const lowBandRatioMult = params.lowBandRatioMult != null ? params.lowBandRatioMult : 1.0;
    const lowBandThreshAdjustDb = params.lowBandThreshAdjustDb != null ? params.lowBandThreshAdjustDb : 0;
    // per-band output makeup gain [low, mid, high] in dB -- lets a genre add a touch of
    // low/mid weight (soul/funk) the way you'd nudge a band's Output trim on the device.
    // Hard-clamped to +/-1 dB: these are Tonal-Balance nudges toward a reference curve,
    // never heavy EQ.
    const bandGainDb = params.bandGainDb || [0, 0, 0];
    const bandGainLin = [
      dbToLin(clamp(bandGainDb[0] || 0, -1, 1)),
      dbToLin(clamp(bandGainDb[1] || 0, -1, 1)),
      dbToLin(clamp(bandGainDb[2] || 0, -1, 1)),
    ];
    const kneeWidthDb = 8.0; // wider soft knee -- gentler transition into compression
    const n = left.length;

    // The reference thresholds below (-21.8/-23.2/-22.0 dB) were read off the Ableton
    // screenshot, calibrated for whatever internal gain-staging that session used.
    // Our pipeline runs considerably hotter by this point (headroom-normalize + the
    // earlier saturation/enhancer stages typically leave RMS around -11 to -15dB), so
    // reusing those absolute values verbatim meant compression was pinned near full
    // ratio on almost everything, not just the loud moments -- a +9dB recalibration
    // offset brings the effective trigger point back to "catches loud passages",
    // matching the original device's intent rather than its literal numbers.
    const CALIBRATION_OFFSET_DB = 12.0;
    const bands = [
      { name: 'low', splitLow: 0, splitHigh: 98.3, threshDb: -21.8 + CALIBRATION_OFFSET_DB + lowBandThreshAdjustDb, ratio: 1.5 * lowBandRatioMult, attackMs: 156, releaseMs: 364 },
      { name: 'mid', splitLow: 98.3, splitHigh: 1660, threshDb: -23.2 + CALIBRATION_OFFSET_DB, ratio: 1.5, attackMs: 102, releaseMs: 282 },
      { name: 'high', splitLow: 1660, splitHigh: Infinity, threshDb: -22.0 + CALIBRATION_OFFSET_DB, ratio: 1.5, attackMs: 79.5, releaseMs: 219 },
    ];
    const inputGainDb = 6.0;
    const inputGain = dbToLin(inputGainDb);

    function buildBandFilters(band) {
      const f = {};
      if (band.splitLow > 0) { f.hpL = makeCrossoverHP(band.splitLow, sampleRate); f.hpR = makeCrossoverHP(band.splitLow, sampleRate); }
      if (isFinite(band.splitHigh)) { f.lpL = makeCrossoverLP(band.splitHigh, sampleRate); f.lpR = makeCrossoverLP(band.splitHigh, sampleRate); }
      return f;
    }
    const bandFilters = bands.map(buildBandFilters);
    // Complementary split (levels only): low = LP(98), mid = LP(1660) - low, high = x - LP(1660).
    // The bands sum back to the input exactly, so the crossover itself no longer smears
    // the kick's attack against its body the way the summed LR4 allpass did.
    const comp = params.complementary ? {
      lpLoL: makeCrossoverLP(98.3, sampleRate), lpLoR: makeCrossoverLP(98.3, sampleRate),
      lpHiL: makeCrossoverLP(1660, sampleRate), lpHiR: makeCrossoverLP(1660, sampleRate),
    } : null;
    const bandEnvelopes = bands.map(function (b) { return makeEnvelope(sampleRate, b.attackMs, b.releaseMs); });

    const amountEnvelope = makeEnvelope(sampleRate, 10, 100);
    // reference Amount is 20% (per the Ableton screenshot); cut further per repeated
    // feedback that compression was still audible -- kept adaptive (+/-30% swing with
    // program level) rather than a flat value, per the earlier project decision
    const amountBase = 0.05 * intensityScale;
    const amountQuiet = amountBase * 0.7;
    const amountLoud = amountBase * 1.3;

    const outL = new Float32Array(n);
    const outR = new Float32Array(n);

    for (let i = 0; i < n; i++) {
      const dl = left[i], dr = right[i];

      const rectified = Math.max(Math.abs(dl), Math.abs(dr));
      const env = amountEnvelope(rectified);
      const envDb = linToDb(env);
      const t = clamp((envDb - (-24)) / ((-6) - (-24)), 0, 1);
      const amount = lerp(amountQuiet, amountLoud, t);

      let sumL = 0, sumR = 0;
      let cLoL, cLoR, cHiL, cHiR;
      if (comp) { cLoL = comp.lpLoL(dl); cLoR = comp.lpLoR(dr); cHiL = comp.lpHiL(dl); cHiR = comp.lpHiR(dr); }
      for (let b = 0; b < bands.length; b++) {
        const band = bands[b], f = bandFilters[b];
        let bl = dl, br = dr;
        if (comp) {
          if (b === 0) { bl = cLoL; br = cLoR; }
          else if (b === 1) { bl = cHiL - cLoL; br = cHiR - cLoR; }
          else { bl = dl - cHiL; br = dr - cHiR; }
        } else {
          if (f.hpL) { bl = f.hpL(bl); br = f.hpR(br); }
          if (f.lpL) { bl = f.lpL(bl); br = f.lpR(br); }
        }

        // inputGain drives the DETECTOR only (matches the reference device's
        // calibrated threshold/ratio, which assume a +6dB-hot sidechain) -- it must
        // not carry through to the output path, or even a tiny "amount" blend ends up
        // injecting a signal that's 6dB hotter than dry, which was quietly wrecking
        // crest factor far more than the "amount" percentage would suggest
        const gl = bl * inputGain, gr = br * inputGain;
        const rect = Math.max(Math.abs(gl), Math.abs(gr));
        const bEnv = bandEnvelopes[b](rect);
        const bEnvDb = linToDb(bEnv);
        const grDb = softKneeGrDb(bEnvDb, band.threshDb, band.ratio, kneeWidthDb);
        const g = dbToLin(-grDb);

        const cl = lerp(bl, bl * g, amount) * bandGainLin[b];
        const cr = lerp(br, br * g, amount) * bandGainLin[b];
        sumL += cl; sumR += cr;
      }
      outL[i] = sumL; outR[i] = sumR;
    }
    return { left: outL, right: outR };
  }

  // ---------------- stage 5: Kazrog MHB Green in AMP mode (tube warmth, NO compression) ----------------
  // Per Kazrog's own product description, the AMP position on the Limiter Switch is
  // "subtle tube saturation use on mixes and masters WITHOUT ADDING COMPRESSION" --
  // confirmed by the near-zero VU needle in the reference screenshot. So: no threshold,
  // no ratio, no envelope-follower gain reduction at all here -- just a static
  // (level-independent) tube-style coloration blended in via Wet/Dry, exactly like the
  // real device in this mode. Threshold knob is inert in this mode, matching what was
  // observed directly on the hardware/plugin.
  function kazrogWarmthStage(left, right, params) {
    const warmth = params.warmth != null ? params.warmth : 0.464; // ~46.4% from the plugin screenshot
    const wetDry = params.wetDry != null ? params.wetDry : 0.434; // ~43.4% from the plugin screenshot
    const warmthMult = params.warmthMult != null ? params.warmthMult : 1.0;
    const w = clamp(warmth * warmthMult, 0, 1);

    const n = left.length;
    const outL = new Float32Array(n), outR = new Float32Array(n);

    // gentle, level-independent tube-style saturation -- drive scales with Warmth,
    // small even-harmonic bias for tube character, bounded so it never adds gain
    const drive = 1.0 + w * 0.8; // gentler than before -- static saturation costs crest factor
                                  // even with zero gain-reduction, so keep the curve transparent
    const tanhDrive = params.unityGain ? drive : Math.tanh(drive); // see trueIronStage
    function tube(x) {
      const sat = Math.tanh(x * drive) / tanhDrive;
      const k = 0.04 * w;
      return (sat + k * sat * sat) / (1 + k);
    }

    const guardDepth = params.transientGuard || 0;
    const guard = guardDepth > 0 ? makeTransientGuard(params.sampleRate) : null;
    for (let i = 0; i < n; i++) {
      const dl = left[i], dr = right[i];
      const wl = tube(dl), wr = tube(dr);
      const m = guard ? wetDry * (1 - guardDepth * guard(Math.max(Math.abs(dl), Math.abs(dr)))) : wetDry;
      outL[i] = dl * (1 - m) + wl * m;
      outR[i] = dr * (1 - m) + wr * m;
    }

    return { left: outL, right: outR, makeupGainDb: 0 }; // no makeup needed -- nothing was reduced
  }

  // ============================================================
  //  VINYL EMULATION STAGE
  //  Models the character of playing audio through a vinyl record
  //  and turntable. All parameters tuned for "clearly audible"
  //  (user requested "выраженный" effect, not subtle).
  //
  //  What it does, in signal-chain order:
  //  1. RIAA-style tonal curve: soft cut ~100–300Hz (hollow muddy
  //     resonance of the cutting lathe), gentle presence lift
  //     ~3–6kHz (needle/cartridge resonance), roll off above 12kHz.
  //  2. Wow & flutter: two LFOs (slow wow 0.7Hz / faster flutter
  //     2.5Hz) that pitch-modulate via a short variable-delay line.
  //  3. Crackle & pops: band-limited noise bursts at random
  //     intervals, shaped to sound like dust/scratches.
  //  4. Soft saturation: gentle even-harmonic distortion that a
  //     cheap cartridge and phono preamp introduce.
  //  5. Stereo narrowing at low end (cutting limitation).
  //  6. Output trim to unity (vinyl is louder-feeling due to crackle
  //     but we don't want actual loudness change).
  // ============================================================
  function vinylStage(left, right, sampleRate) {
    const n = left.length;
    const outL = new Float32Array(n);
    const outR = new Float32Array(n);

    // 1. RIAA-ish tonal shaping (pre-emphasis for "vinyl" character)
    const loShelfL = makeBiquad('lowshelf', 180, sampleRate, 0.7, -2.8);
    const loShelfR = makeBiquad('lowshelf', 180, sampleRate, 0.7, -2.8);
    const presL = makeBiquad('peaking', 4200, sampleRate, 1.1, 2.2);
    const presR = makeBiquad('peaking', 4200, sampleRate, 1.1, 2.2);
    const hiCutL = makeBiquad('highshelf', 11000, sampleRate, 0.8, -5.5);
    const hiCutR = makeBiquad('highshelf', 11000, sampleRate, 0.8, -5.5);

    // 2. Wow & flutter via a short variable-delay interpolation
    //    Max delay corresponds to ±0.25% pitch deviation for wow,
    //    ±0.12% for flutter — "clearly audible" per the brief.
    const maxDelaySamples = Math.ceil(sampleRate * 0.005); // 5ms buffer
    const delayBufL = new Float32Array(maxDelaySamples + 2);
    const delayBufR = new Float32Array(maxDelaySamples + 2);
    let delayWrite = 0;
    const wowHz = 0.7, flutterHz = 2.5;
    const wowDepth = 0.0025 * sampleRate;   // samples of depth
    const flutterDepth = 0.0012 * sampleRate;
    let wowPhase = 0, flutterPhase = 0;
    const wowInc = 2 * Math.PI * wowHz / sampleRate;
    const flutterInc = 2 * Math.PI * flutterHz / sampleRate;

    // 3. Crackle state
    let crackleTimer = Math.floor(sampleRate * (0.3 + Math.random() * 0.8));
    let crackleDecay = 0, crackleAmpL = 0, crackleAmpR = 0;
    const crackleEnvCoef = Math.exp(-1 / (sampleRate * 0.004)); // 4ms decay
    // Band-limited crackle: two poles around 3-7kHz
    const crackBpL = makeBiquad('peaking', 5000, sampleRate, 1.5, 8);
    const crackBpR = makeBiquad('peaking', 5000, sampleRate, 1.5, 8);

    // 5. Low-end mono-izer (cutting limitation below 120Hz)
    const monoLpL = makeBiquad('lowpass', 120, sampleRate, 0.7);
    const monoLpR = makeBiquad('lowpass', 120, sampleRate, 0.7);

    for (let i = 0; i < n; i++) {
      let l = left[i], r = right[i];

      // 1. Tonal shaping
      l = hiCutL(presL(loShelfL(l)));
      r = hiCutR(presR(loShelfR(r)));

      // 2. Wow & flutter
      const wobble = Math.sin(wowPhase) * wowDepth + Math.sin(flutterPhase) * flutterDepth;
      wowPhase += wowInc; if (wowPhase > 2 * Math.PI) wowPhase -= 2 * Math.PI;
      flutterPhase += flutterInc; if (flutterPhase > 2 * Math.PI) flutterPhase -= 2 * Math.PI;
      delayBufL[delayWrite] = l;
      delayBufR[delayWrite] = r;
      const delaySamples = Math.max(0, wobble);
      const delayInt = Math.floor(delaySamples);
      const frac = delaySamples - delayInt;
      const rA = (delayWrite - delayInt + maxDelaySamples) % maxDelaySamples;
      const rB = (rA - 1 + maxDelaySamples) % maxDelaySamples;
      l = delayBufL[rA] * (1 - frac) + delayBufL[rB] * frac;
      r = delayBufR[rA] * (1 - frac) + delayBufR[rB] * frac;
      delayWrite = (delayWrite + 1) % maxDelaySamples;

      // 3. Crackle & pops
      crackleTimer--;
      if (crackleTimer <= 0) {
        // spawn a new crack — amplitude 0.06-0.18, duration 1-4ms
        crackleAmpL = (0.06 + Math.random() * 0.12) * (Math.random() > 0.5 ? 1 : -1);
        crackleAmpR = crackleAmpL * (0.7 + Math.random() * 0.3);
        crackleDecay = 1.0;
        crackleTimer = Math.floor(sampleRate * (0.2 + Math.random() * 0.9));
      }
      if (crackleDecay > 1e-4) {
        const cn = (Math.random() * 2 - 1);
        l += crackBpL(cn * crackleAmpL * crackleDecay);
        r += crackBpR(cn * crackleAmpR * crackleDecay);
        crackleDecay *= crackleEnvCoef;
      }

      // 4. Soft even-harmonic saturation (cartridge/preamp character)
      const drive = 1.35;
      l = Math.tanh(l * drive) / Math.tanh(drive);
      r = Math.tanh(r * drive) / Math.tanh(drive);

      // 5. Low-end mono (cutting limitation)
      const monoLow = (monoLpL(l) + monoLpR(r)) * 0.5;
      l = l - monoLpL(l) * 0.5 + monoLow * 0.5;
      r = r - monoLpR(r) * 0.5 + monoLow * 0.5;

      outL[i] = l;
      outR[i] = r;
    }
    return { left: outL, right: outR };
  }

  // ============================================================
  //  TAPE EMULATION STAGE — v2
  //  Revised per user feedback:
  //   - Hiss reduced significantly (~-48 dBFS, felt not heard)
  //   - Flutter much slower and quieter (~0.3Hz primary), more organic
  //   - Random modulation: flutter depth breathes up/down slowly
  //     with occasional organic "jumps" — cassette is never perfectly
  //     consistent, sometimes the speed drifts more at one moment
  //   - Warm tube-preamp saturation added (2nd-harmonic even saturation
  //     on top of tape sat — models the sound of a cheap cassette deck's
  //     preamp, the main reason cassette sounds "velvety")
  //   - Gentle program-dependent tape compression (loud moments are
  //     slightly compressed, quiet ones are left alone — tape's natural
  //     limiting behaviour from oxide saturation)
  //   - Overall: sounds warm and intimate, not gritty or noisy
  // ============================================================
  function tapeStage(left, right, sampleRate) {
    const n = left.length;
    const outL = new Float32Array(n);
    const outR = new Float32Array(n);

    // ---- tonal shaping ----
    // LF warmth hump: tape playback eq adds a gentle bass-warmth.
    // IMPORTANT: applied AFTER saturation so we don't overdrive the low end.
    const lfBoostL = makeBiquad('peaking', 80, sampleRate, 0.8, 1.8);
    const lfBoostR = makeBiquad('peaking', 80, sampleRate, 0.8, 1.8);
    // Upper-mid presence: the "cassette" 3-5kHz bump
    const presL = makeBiquad('peaking', 3800, sampleRate, 0.9, 1.8);
    const presR = makeBiquad('peaking', 3800, sampleRate, 0.9, 1.8);
    // HF rolloff: tape doesn't capture ultra-high freq well (~10kHz)
    const hfRollL = makeBiquad('highshelf', 10000, sampleRate, 0.75, -5.5);
    const hfRollR = makeBiquad('highshelf', 10000, sampleRate, 0.75, -5.5);

    // ---- tape saturation transfer function ----
    // Single-stage gentle saturation with tube-like even-harmonic character.
    // v2 had TWO cascaded tanh stages (oxide 1.8 + tube 1.4) which was too heavy
    // on bass — anything with energy below 150Hz hit both non-linearities and
    // came out crunchy/overloaded. Now: one moderate tanh + a small 2nd-harmonic
    // bias, gentler drive (1.35 instead of 1.8+1.4 cascaded).
    const satDrive = 1.35;
    const satTanh = Math.tanh(satDrive);
    function tapeSat(x) {
      const s = Math.tanh(x * satDrive) / satTanh;
      const even = 0.05 * s * s * Math.sign(s); // tube-like 2nd harmonic
      return s + even;
    }

    // ---- tape compression (program-dependent) ----
    const compAttCoef = Math.exp(-1 / (sampleRate * 0.005));  // 5ms attack
    const compRelCoef = Math.exp(-1 / (sampleRate * 0.18));   // 180ms release
    const compThresh = 0.42;
    const compRatio = 2.8;
    let compEnv = 0;

    // ---- flutter: ORGANIC and clearly audible ----
    // v2 was too subtle (depths halved too far, jumps too rare).
    // v3: moderate base depths, MORE FREQUENT random bursts (every 6-15s instead
    // of 20-50s), wider depth-mod range (0.3-1.2 instead of 0.2-0.8), and the
    // slow wow is slightly faster (0.4Hz) for more perceptible pitch drift.
    const maxFlutter = Math.ceil(sampleRate * 0.008); // 8ms max delay buffer
    const fBufL = new Float32Array(maxFlutter + 2);
    const fBufR = new Float32Array(maxFlutter + 2);
    let fWrite = 0;

    // LFOs
    let fPhase1 = Math.random() * 2 * Math.PI; // wow (0.4Hz — noticeable slow drift)
    let fPhase2 = Math.random() * 2 * Math.PI; // flutter (1.6Hz — gentle warble)
    const fInc1 = 2 * Math.PI * 0.4 / sampleRate;
    const fInc2 = 2 * Math.PI * 1.6 / sampleRate;

    // Random-walk depth modulator — breathes between "barely there" and "clearly heard"
    let depthMod = 0.6;
    let depthTarget = 0.6;
    const depthSlew = 0.00015;
    let depthUpdateCounter = 0;

    // Random bursts: capstan slip / pinch roller wobble.
    // Fires more often (every 6-15s) and with stronger amplitude.
    let jumpTimer = Math.floor(sampleRate * (6 + Math.random() * 9));
    let jumpEnv = 0;
    const jumpDecay = Math.exp(-1 / (sampleRate * 0.12)); // 120ms decay (longer, more noticeable)

    // Base flutter depths — audible but not extreme
    const baseWowDepth    = 0.0007 * sampleRate;  // ±0.07% (was 0.035%)
    const baseFlutDepth   = 0.0003 * sampleRate;  // ±0.03% (was 0.015%)

    // ---- hiss ----
    // Bias noise: felt as tape "breath/air", not heard as obvious hiss.
    // v1 was ~-35 dBFS (way too audible). v2: ~-52 dBFS — subliminal presence.
    // High-passed at 6kHz so it only adds air/texture in the top octave.
    const hissLevel = 0.0025; // ~-52 dBFS
    const hissHpL = makeBiquad('highpass', 6000, sampleRate, 0.5);
    const hissHpR = makeBiquad('highpass', 6000, sampleRate, 0.5);

    // ---- crosstalk: intimate stereo image ----
    const crosstalk = 0.035;

    for (let i = 0; i < n; i++) {
      let l = left[i], r = right[i];

      // tape saturation FIRST on the raw signal (not bass-boosted — avoids LF overload)
      l = tapeSat(l); r = tapeSat(r);

      // tonal shaping AFTER saturation: warmth + presence + HF roll
      l = hfRollL(presL(lfBoostL(l)));
      r = hfRollR(presR(lfBoostR(r)));

      // program-dependent tape compression
      const rect = Math.max(Math.abs(l), Math.abs(r));
      compEnv = rect > compEnv
        ? compEnv * compAttCoef + (1 - compAttCoef) * rect
        : compEnv * compRelCoef + (1 - compRelCoef) * rect;
      let compGain = 1.0;
      if (compEnv > compThresh) {
        const over = compEnv - compThresh;
        const grDb = over * (1 - 1 / compRatio);
        compGain = dbToLin(-grDb);
      }
      l *= compGain; r *= compGain;

      // flutter: update depth modulator periodically
      depthUpdateCounter++;
      if (depthUpdateCounter >= 512) {
        depthUpdateCounter = 0;
        // frequently pick a new random target depth — wider range for more life
        if (Math.random() < 0.15) depthTarget = 0.3 + Math.random() * 0.9; // 0.3..1.2 range
      }
      depthMod += (depthTarget - depthMod) * depthSlew * 512;
      depthMod = clamp(depthMod, 0.15, 1.3);

      // jump event
      jumpTimer--;
      if (jumpTimer <= 0) {
        jumpEnv = 0.8 + Math.random() * 0.5; // sudden jump depth
        jumpTimer = Math.floor(sampleRate * (20 + Math.random() * 30));
      }
      jumpEnv *= jumpDecay;

      // combine flutter sources
      const wow    = Math.sin(fPhase1) * baseWowDepth * depthMod;
      const flutter = Math.sin(fPhase2) * baseFlutDepth * depthMod;
      const jump   = jumpEnv * baseWowDepth * 1.5;
      const totalFlutter = wow + flutter + jump;
      fPhase1 += fInc1; if (fPhase1 > 2 * Math.PI) fPhase1 -= 2 * Math.PI;
      fPhase2 += fInc2; if (fPhase2 > 2 * Math.PI) fPhase2 -= 2 * Math.PI;

      fBufL[fWrite] = l; fBufR[fWrite] = r;
      const fDel = Math.max(0, totalFlutter);
      const fInt = Math.floor(fDel); const fFrac = fDel - fInt;
      const frA = (fWrite - fInt + maxFlutter) % maxFlutter;
      const frB = (frA - 1 + maxFlutter) % maxFlutter;
      l = fBufL[frA] * (1 - fFrac) + fBufL[frB] * fFrac;
      r = fBufR[frA] * (1 - fFrac) + fBufR[frB] * fFrac;
      fWrite = (fWrite + 1) % maxFlutter;

      // hiss (subtle, felt not heard)
      const noise = (Math.random() * 2 - 1) * hissLevel;
      const noiseR = (Math.random() * 2 - 1) * hissLevel;
      l += hissHpL(noise);
      r += hissHpR(noiseR);

      // crosstalk
      const lOld = l;
      l = l * (1 - crosstalk) + r * crosstalk;
      r = r * (1 - crosstalk) + lOld * crosstalk;

      outL[i] = l;
      outR[i] = r;
    }
    return { left: outL, right: outR };
  }


  function lookaheadTruePeakLimiter(left, right, targetDb, sampleRate, oversample) {
    oversample = oversample || 4;
    const n = left.length;
    const targetLin = dbToLin(targetDb);

    function truePeakAt(buf, i) {
      let peak = Math.abs(buf[i]);
      if (i < n - 1) {
        const a = buf[i], b = buf[i + 1];
        for (let k = 1; k < oversample; k++) {
          const av = Math.abs(a + (b - a) * (k / oversample));
          if (av > peak) peak = av;
        }
      }
      return peak;
    }

    const lookaheadMs = 5;
    const lookaheadSamples = Math.max(1, Math.round(sampleRate * lookaheadMs / 1000));
    const releaseMs = 80;
    const releaseCoef = Math.exp(-1 / (sampleRate * releaseMs / 1000));

    const rawGain = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const p = Math.max(truePeakAt(left, i), truePeakAt(right, i), 1e-9);
      rawGain[i] = Math.min(1, targetLin / p);
    }

    const lookaheadGain = new Float32Array(n);
    const idxDeque = [];
    let dqStart = 0;
    for (let i = n - 1; i >= 0; i--) {
      while (idxDeque.length > dqStart && rawGain[idxDeque[idxDeque.length - 1]] >= rawGain[i]) idxDeque.pop();
      idxDeque.push(i);
      const windowEnd = i + lookaheadSamples;
      while (idxDeque.length > dqStart && idxDeque[dqStart] > windowEnd) dqStart++;
      lookaheadGain[i] = rawGain[idxDeque[dqStart]];
    }

    let smoothGain = 1, minAppliedGain = 1;
    for (let i = 0; i < n; i++) {
      const g = lookaheadGain[i];
      if (g < smoothGain) smoothGain = g;
      else { smoothGain = g + (smoothGain - g) * releaseCoef; if (smoothGain > 1) smoothGain = 1; }
      left[i] *= smoothGain; right[i] *= smoothGain;
      if (smoothGain < minAppliedGain) minAppliedGain = smoothGain;
    }

    let finalPeak = 0;
    for (let i = 0; i < n; i++) { finalPeak = Math.max(finalPeak, truePeakAt(left, i), truePeakAt(right, i)); }
    let finalPeakDb = linToDb(finalPeak);
    if (finalPeakDb > targetDb + 0.02) {
      const safety = dbToLin(targetDb - finalPeakDb);
      for (let i = 0; i < n; i++) { left[i] *= safety; right[i] *= safety; }
      finalPeakDb = targetDb;
    }

    return { left, right, finalPeakDb: Math.min(finalPeakDb, targetDb), limiterGainReductionDb: linToDb(minAppliedGain) };
  }

  // ---------------- true-peak measurement (standalone, oversampled) ----------------
  function measureTruePeak(left, right, sampleRate, oversample) {
    oversample = oversample || 8; // independent, higher-res than the limiter's own 4x pass
    const n = left.length;
    let peak = 0;
    for (const buf of [left, right]) {
      for (let i = 0; i < n - 1; i++) {
        const a = buf[i], b = buf[i + 1];
        for (let k = 0; k < oversample; k++) {
          const av = Math.abs(a + (b - a) * (k / oversample));
          if (av > peak) peak = av;
        }
      }
      const last = Math.abs(buf[n - 1]);
      if (last > peak) peak = last;
    }
    return linToDb(peak);
  }

  // ---------------- stage 7: loudness targeting (LUFS) with true-peak ceiling ----------------
  // Measures integrated LUFS, applies the gain needed to reach the target, then runs
  // the lookahead true-peak limiter to enforce the ceiling; repeats a couple of times
  // to converge (limiting a hot peak can nudge the measured LUFS down slightly).
  // originalLufs is the UNPROCESSED input's loudness -- gain is never allowed to go
  // negative here, so processing cannot end up quieter than what was uploaded.
  // intensityScale scales HOW FAR we reach toward targetLUFS: a thin/quiet source
  // (high intensityScale) gets pushed close to the full target; a source that's
  // already dense/well-produced (low intensityScale) only gets nudged a little above
  // its own natural level, since aggressively closing that gap is exactly what forces
  // the limiter to eat into transients -- "minimal processing" has to include this
  // stage too, not just the coloration stages upstream.
  // Pre-limiter soft clipper (processing levels only). Shaves the top of the shortest
  // peaks so the limiter -- which ducks ~5 ms ahead and releases over 80 ms, turning down
  // the whole hit -- has less to do. Linear below CLIP_KNEE * ceiling, then a tanh knee
  // that never exceeds the clip level (slope 1 at the knee, so no kink).
  const CLIP_ABOVE_CEILING_DB = 1.5; // clip level relative to the true-peak ceiling
  const CLIP_KNEE = 0.7;
  function softClipStage(left, right, clipDb) {
    const c = dbToLin(clipDb), k = CLIP_KNEE * c, span = c - k;
    function clip(x) {
      const a = x < 0 ? -x : x;
      if (a <= k) return x;
      const y = k + span * Math.tanh((a - k) / span);
      return x < 0 ? -y : y;
    }
    for (let i = 0; i < left.length; i++) { left[i] = clip(left[i]); right[i] = clip(right[i]); }
  }

  function loudnessTargetStage(left, right, targetLUFS, targetTruePeakDb, sampleRate, originalLufs, intensityScale, allowBelowOriginal, preClip) {
    let totalGainDb = 0;
    let limiterGainReductionDb = 0;
    let lufsBefore = measureLUFS(left, right, sampleRate);
    let lufsNow = lufsBefore;

    let effectiveTargetLUFS;
    if (allowBelowOriginal) {
      // EDM/hot-master mode: the whole point is to end up AT or slightly BELOW the source
      // level (the reference chain lands ~0.5 LU under the original). So just aim straight
      // at targetLUFS with no "never below original" floor.
      effectiveTargetLUFS = targetLUFS;
    } else if (originalLufs != null && originalLufs > -50) {
      // Firm loudness normalization: always drive fully to the target loudness so the
      // output reliably hits the intended level (never comes out as quiet as -- or
      // quieter than -- the source). The ONLY exception is a source that's already
      // louder than the target, which we leave at its own level rather than turning
      // down. Dynamics are protected upstream (tamed transients, gentle multiband) and
      // by the true-peak limiter below, not by under-normalizing here.
      effectiveTargetLUFS = Math.max(targetLUFS, originalLufs);
    } else {
      effectiveTargetLUFS = targetLUFS;
    }

    // 2 passes converge within ~0.1-0.2 LU on lightly limited material. The processing
    // levels (clipper + harder limiting on loud sources) fell ~0.6-0.8 LU short of
    // target with 2, so they get 4.
    const maxIterations = preClip ? 4 : 2;
    for (let iter = 0; iter < maxIterations; iter++) {
      let neededGainDb;
      if (lufsNow < -50) {
        neededGainDb = 0; // too quiet/silent to normalize safely -- avoid boosting noise floor
      } else {
        // The mid-chain (headroom staging + each stage's own saturation/blend
        // behavior) can leave the signal considerably louder than the target even
        // before this stage runs -- so this needs to be able to pull gain DOWN, not
        // just add it. In normal mode the floor is the original upload's own loudness
        // (never end up quieter than uploaded); in allowBelowOriginal (EDM) mode that
        // floor is lifted so we can legitimately land slightly under the source.
        const rawGainDb = effectiveTargetLUFS - lufsNow;
        const minAllowedGainDb = (!allowBelowOriginal && originalLufs != null && originalLufs > -50)
          ? Math.max(originalLufs - lufsNow, -20)
          : -20;
        neededGainDb = clamp(rawGainDb, minAllowedGainDb, 20);
      }
      if (neededGainDb !== 0) {
        const g = dbToLin(neededGainDb);
        for (let i = 0; i < left.length; i++) { left[i] *= g; right[i] *= g; }
        totalGainDb += neededGainDb;
      }

      if (preClip) softClipStage(left, right, targetTruePeakDb + CLIP_ABOVE_CEILING_DB);
      const limited = lookaheadTruePeakLimiter(left, right, targetTruePeakDb, sampleRate, 4);
      left = limited.left; right = limited.right;
      limiterGainReductionDb = limited.limiterGainReductionDb;

      lufsNow = measureLUFS(left, right, sampleRate);
      if (Math.abs(neededGainDb) < 0.15 && Math.abs(limited.limiterGainReductionDb) < 0.15) break;
    }

    // Report what was actually measured on the final signal, not the configured
    // target -- for low-crest material, hitting the LUFS target can legitimately
    // land the true peak well under the ceiling, and that's correct, not a bug.
    const measuredTruePeakDb = measureTruePeak(left, right, sampleRate, 8);

    return {
      left, right,
      lufsBefore, lufsAfter: lufsNow,
      totalGainDb, limiterGainReductionDb,
      truePeakCeilingDb: targetTruePeakDb,
      truePeakAfterDb: measuredTruePeakDb,
      effectiveTargetLUFS,
    };
  }

  // ---------------- async main entry point (yields between stages) ----------------
  function nextTick() {
    return new Promise(function (resolve) {
      if (typeof setTimeout !== 'undefined') setTimeout(resolve, 0);
      else resolve();
    });
  }

  // ---------------- shared pipeline core ----------------
  // Both processAudioAsync and processAudio build the SAME ordered list of stages here,
  // then execute it (async-with-yields or sync). This guarantees the two entry points can
  // never drift apart. EDM mode is a genuinely different signal path (per the reference
  // analysis): it pre-attenuates a hot source by -3 dB, SKIPS the multiband compressor and
  // the Kazrog warmth stage entirely, blends the enhancer much lighter, applies no tonal
  // darkening, and does not push loudness up. Soul/funk & the other genres use the full chain.
  function buildPipeline(leftIn, rightIn, sampleRate, options) {
    options = options || {};
    const genreKey = options.genre || 'universal';
    const genre = getGenreProfile(genreKey);
    const isEDM = genreKey === 'edm';
    const isVinyl = genreKey === 'vinyl';
    const isTape = genreKey === 'tape';
    const isCharacterMode = isVinyl || isTape; // vinyl/tape: minimal standard chain, then character stage

    let left = Float32Array.from(leftIn);
    let right = Float32Array.from(rightIn);

    const metrics = analyzeSource(left, right, sampleRate);
    const originalLufs = measureLUFS(left, right, sampleRate); // on the UNTOUCHED input
    // Tonal style: when the caller passes options.tonalStyle (the UI always does), the
    // tonal EQ follows that choice -- one of TONAL_STYLES, or null/'off' for none --
    // independently of the processing level. Without the key, the legacy genre-tied
    // behaviour applies (soulfunk/hiphop reference, static nudge otherwise).
    const styleChosen = Object.prototype.hasOwnProperty.call(options, 'tonalStyle');
    const tonalStyle = styleChosen && TONAL_STYLES[options.tonalStyle] ? options.tonalStyle : null;
    const adaptiveRefKey = styleChosen
      ? (tonalStyle ? TONAL_STYLES[tonalStyle].reference : null)
      : (ADAPTIVE_REFERENCE[genreKey] ? genreKey : null);
    // The band balance is measured right before the tonal stage (not on the untouched
    // input): the multiband, enhancer and air stages already add ~+1 dB around 2 kHz, so
    // a correction computed from the raw source under-cuts a band that pokes out.
    const hasAdaptiveReference = !!adaptiveRefKey;
    const density = densityScore(metrics);
    const sourceClass = classifySource(metrics, options);
    const intensityScale = 1.0 - 0.85 * Math.pow(density, 0.55);
    // Colour stages on the three processing levels: strength comes from the level, and
    // density only softens it (0.6..1.0) instead of scaling it down to ~0.15-0.85 --
    // that double attenuation left the colour almost inaudible next to the loudness gain.
    const hasLevel = genre.colour != null;
    const colourScale = hasLevel ? genre.colour * (0.6 + 0.4 * intensityScale) : intensityScale;
    const sourceSideMidDb = hasLevel ? measureSideMidDb(left, right, sampleRate) : null;
    const stWidth = hasLevel ? widthForSource(genre.stWidth, sourceSideMidDb) : genre.stWidth;
    const headroomTargetDb = -2.0 - density * 1.0;

    // "already loud/wide" detection for EDM: a finished, hot master (near/above 0 dBFS,
    // loud integrated LUFS). When true, we pre-attenuate before processing so the chain
    // has clean headroom and the final limiter can re-establish a controlled ceiling.
    const isHotMaster = (originalLufs > -10) || (metrics.peakDb > -0.3);
    const edmPreAttenDb = (isEDM && isHotMaster) ? -3.0 : 0.0;

    // meta accumulators filled in as stages run
    const meta = {
      analysis: metrics, densityScore: density, sourceClass: sourceClass,
      genre: genreKey, genreLabel: genre.label, intensityScale: intensityScale,
      colourScale: colourScale, stWidth: stWidth, sourceSideMidDb: sourceSideMidDb,
      tonalStyle: tonalStyle, tonalStyleLabel: tonalStyle ? TONAL_STYLES[tonalStyle].label : null,
      headroomTargetDb: headroomTargetDb, mode: isEDM ? 'edm' : 'full',
      edmPreAttenDb: edmPreAttenDb, isHotMaster: isHotMaster,
      originalLufs: originalLufs, kazrogMakeupGainDb: 0,
    };

    // default loudness targets differ by mode/genre.
    //  - EDM/hot masters: land ~0.5 LU BELOW the (already very loud) source.
    //  - soul/funk: the user wants a genuinely loud result (~-11/-12 LUFS) so the
    //    output is clearly louder than a quiet source and never quieter than the
    //    original. -12 is a deliberate compromise: loud enough to satisfy the brief,
    //    but not so hot it re-introduces the brickwall pumping we fought earlier.
    //  - other genres: loud, streaming-plus targets that reliably normalize up.
    // EDM target: for a genuinely hot master (isHotMaster) land ~0.5 LU below the source
    // (declip + tame); for a NON-hot source loaded in EDM mode, normalize up to a loud
    // -10 like any other genre so quiet EDM material still gets louder.
    const edmTarget = isHotMaster ? (originalLufs - 0.5) : -10;
    // Firm loudness targets. Soul/Funk (Strong) aims for -11.5 LUFS: still the loudest
    // level, but at -11 the -1 dBTP ceiling left it ~1 dB less crest than Medium and it
    // read as less clear. The output is always driven fully to these unless the source
    // is already louder.
    const genreTargetLUFS = { soulfunk: -11.5, universal: -12, hiphop: -12, vinyl: -11, tape: -11 };
    const targetLUFS = options.targetLUFS != null ? options.targetLUFS
                       : (isEDM ? edmTarget : (genreTargetLUFS[genreKey] != null ? genreTargetLUFS[genreKey] : -12));
    // True-peak ceiling: -0.3 dBTP on the processing levels (as the user's own Pro-L 2
    // in Ableton) -- the extra 0.7 dB lets them reach target without costing punch.
    // The Tape / Vinyl effects keep -1.0.
    const targetTruePeakDb = options.finalTruePeakDb != null ? options.finalTruePeakDb
                       : ((isEDM || hasLevel) ? -0.3 : -1.0);

    // Each step: { pct, run(): void }.  Stages mutate left/right and meta via closures.
    const steps = [];

    steps.push({ pct: 8, run: function () {
      let hp = subsonicHighpassStage(left, right, sampleRate);
      left = hp.left; right = hp.right;
      if (edmPreAttenDb !== 0) {
        const g = dbToLin(edmPreAttenDb);
        for (let i = 0; i < left.length; i++) { left[i] *= g; right[i] *= g; }
        meta.headroomAppliedGainDb = edmPreAttenDb;
      } else {
        const hr = normalizeHeadroom(left, right, metrics.peakDb, headroomTargetDb);
        left = hr.left; right = hr.right;
        meta.headroomAppliedGainDb = hr.appliedGainDb;
      }
    }});

    steps.push({ pct: 20, run: function () {
      let r1 = trueIronStage(left, right, { sampleRate: sampleRate, strength: 5.14, mix: 0.20 * genre.trueIronMixMult * colourScale * (hasLevel ? LEVEL_IRON_MIX_BOOST : 1), transientGuard: hasLevel ? TRANSIENT_GUARD : 0, unityGain: hasLevel });
      left = r1.left; right = r1.right;
    }});

    // EDM: minimal-to-no transient emphasis (reference preserves the source's envelope).
    steps.push({ pct: 32, run: function () {
      const tAmt = (isEDM ? 0.15 : 1.0) * genre.transientAmount * intensityScale;
      let rt = transientEmphasisStage(left, right, sampleRate, tAmt);
      left = rt.left; right = rt.right;
    }});

    // EDM: much lighter enhancer blend (reference Mix ~29% vs ~67% for soul/funk).
    steps.push({ pct: 45, run: function () {
      const enhMix = (isEDM ? 0.13 : 0.28) * genre.enhancerMixMult * colourScale;
      let r2 = bxEnhancerStage(left, right, {
        sampleRate: sampleRate, sculptBasis: 0.03, sculptBoost: 0.09, colourBass: 0.06, colourExcite: 0.02,
        monoMkrHz: genre.monoMkrHz, stWidth: stWidth, widthSplit: hasLevel, compThresholdDb: -10.8, compReleaseMs: 132, compAttackMs: hasLevel ? ENHANCER_ATTACK_MS_LEVELS : 4,
        mix: enhMix, ratio: 1.4, intensityScale: intensityScale,
      });
      left = r2.left; right = r2.right;
    }});

    // multiband: FULL chain only. EDM and character modes skip it.
    if (!isEDM && !isCharacterMode) {
      steps.push({ pct: 62, run: function () {
        let r3 = multibandStage(left, right, {
          sampleRate: sampleRate, intensityScale: intensityScale,
          lowBandRatioMult: genre.lowBandRatioMult, lowBandThreshAdjustDb: genre.lowBandThreshAdjustDb,
          bandGainDb: genre.mbBandGainDb, complementary: hasLevel,
        });
        left = r3.left; right = r3.right;
      }});
    }

    // air exciter: skip for vinyl/tape (their own stages handle HF character)
    if (!isCharacterMode) {
      steps.push({ pct: 70, run: function () {
        let ra = airExciterStage(left, right, sampleRate, genre.airAmount * (0.5 + 0.5 * intensityScale));
        left = ra.left; right = ra.right;
      }});
    }

    // Kazrog warmth: FULL chain only. EDM and character modes skip it.
    if (!isEDM && !isCharacterMode) {
      steps.push({ pct: 76, run: function () {
        let r4 = kazrogWarmthStage(left, right, { warmth: 0.25, wetDry: 0.445, warmthMult: genre.warmthMult * colourScale * (hasLevel ? LEVEL_WARMTH_BOOST : 1),
          sampleRate: sampleRate, transientGuard: hasLevel ? TRANSIENT_GUARD : 0, unityGain: hasLevel });
        left = r4.left; right = r4.right;
        meta.kazrogMakeupGainDb = r4.makeupGainDb;
      }});
    }

    // character stages: vinyl and tape each replace the full standard chain tail
    if (isVinyl) {
      steps.push({ pct: 78, run: function () {
        let rv = vinylStage(left, right, sampleRate);
        left = rv.left; right = rv.right;
        meta.characterStage = 'vinyl';
      }});
    }
    if (isTape) {
      steps.push({ pct: 78, run: function () {
        let rt2 = tapeStage(left, right, sampleRate);
        left = rt2.left; right = rt2.right;
        meta.characterStage = 'tape';
      }});
    }

    // tonal shaping: never on the character effects. With a chosen tonal style it runs
    // on any processing level (Light included); with the style switched off it is skipped.
    // Legacy callers (no tonalStyle key): EDM gets none, soul/funk and hip-hop the
    // measured bidirectional stage, the rest the static nudge.
    const runTonal = !isCharacterMode && (styleChosen ? hasAdaptiveReference : !isEDM);
    if (runTonal) {
      steps.push({ pct: 85, run: function () {
        if (hasAdaptiveReference) {
          const balance = measureBandBalance(left, right, sampleRate);
          const moves = buildAdaptiveTonalMoves(adaptiveRefKey, balance);
          // Corrective EQ is gated more gently than the colour stages: a dense, loud source
          // with a harsh band still needs most of the cut (same gate as the air exciter).
          let rn = adaptiveTonalStage(left, right, sampleRate, moves, 0.5 + 0.5 * intensityScale);
          left = rn.left; right = rn.right;
          meta.tonalBalanceMeasuredDb = balance;
          meta.adaptiveTonalMoves = rn.applied;
        } else {
          let rn = tonalNudgeStage(left, right, sampleRate, genreKey, intensityScale);
          left = rn.left; right = rn.right;
        }
      }});
    }

    steps.push({ pct: 90, run: function () {
      // allowBelowOriginal only for genuinely hot masters (EDM declip case). A non-hot
      // source in EDM mode still normalizes up and is never pulled below its own level.
      let r5 = loudnessTargetStage(left, right, targetLUFS, targetTruePeakDb, sampleRate, originalLufs, intensityScale, isEDM && isHotMaster, hasLevel);
      left = r5.left; right = r5.right;
      meta.lufsBefore = r5.lufsBefore; meta.lufsAfter = r5.lufsAfter;
      meta.targetLUFS = targetLUFS; meta.loudnessGainDb = r5.totalGainDb;
      meta.limiterGainReductionDb = r5.limiterGainReductionDb;
      meta.truePeakCeilingDb = r5.truePeakCeilingDb; meta.truePeakAfterDb = r5.truePeakAfterDb;
    }});

    return {
      steps: steps,
      finalize: function () { return { left: left, right: right, meta: meta }; },
    };
  }

  async function processAudioAsync(leftIn, rightIn, sampleRate, options, onProgress) {
    const report = function (pct) { if (onProgress) onProgress(pct); };
    report(2); await nextTick();
    const pipe = buildPipeline(leftIn, rightIn, sampleRate, options);
    for (let i = 0; i < pipe.steps.length; i++) {
      report(pipe.steps[i].pct); await nextTick();
      pipe.steps[i].run();
    }
    report(100);
    return pipe.finalize();
  }

  function processAudio(leftIn, rightIn, sampleRate, options, onProgress) {
    const report = function (pct) { if (onProgress) onProgress(pct); };
    report(2);
    const pipe = buildPipeline(leftIn, rightIn, sampleRate, options);
    for (let i = 0; i < pipe.steps.length; i++) {
      report(pipe.steps[i].pct);
      pipe.steps[i].run();
    }
    report(100);
    return pipe.finalize();
  }

  return {
    processAudio, processAudioAsync,
    analyzeSource, classifySource, densityScore, measureLUFS,
    measureBandBalance, buildAdaptiveTonalMoves,
    GENRE_PROFILES, TONAL_STYLES, dbToLin, linToDb,
  };
});

