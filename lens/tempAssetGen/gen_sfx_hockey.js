// Neon cyber air-hockey SFX set — one-shot generator
const fs = require('fs');
const path = require('path');

const ENGINE = '/Users/pavlotkachenko/.claude/plugins/cache/ls-extensions/ls-clad/1.0.0/skills/build-sfx/tools';
const audio = require(ENGINE);

const PROJECT_ASSETS_SFX = '/Users/pavlotkachenko/Dropbox (Personal)/Snapchat/Spectacles/Projects/10. Vector/robo-hockey/Assets/GeneratedSFX';
fs.mkdirSync(PROJECT_ASSETS_SFX, { recursive: true });

const SR = audio.SAMPLE_RATE;

function writeSfx(name, buf) {
  audio.mix_bus.masterChain(buf, { normalize: 'peak' });
  audio.WavBuilder.write(buf, path.join(PROJECT_ASSETS_SFX, name + '.wav'));
  console.log('wrote', name);
}

// 1. hit_paddle — short bright synthetic zap-tick (attack + zappy body)
function hitPaddle() {
  const imp = audio.transient_designer.designImpact({
    attack: { kind: 'click', durationMs: 6, lpHz: 9000, hpHz: 900, gain: 0.7 },
    body: { kind: 'tonal', freq: 1150, partials: 3, decay: 0.09, hpHz: 500, lpHz: 8000, gain: 0.55 },
  });
  const zap = audio.sweep(2600, 900, 0.07, 'sawtooth', 'exponential');
  audio.adsrExp(zap, 0.001, 0.02, 0.2, 0.04, 3);
  const out = new Float32Array(Math.floor(0.2 * SR));
  audio.addInto(out, imp, 0, 0.9);
  audio.addInto(out, zap, 0, 0.35);
  audio.fadeOut(out, 0.006);
  return audio.mix_bus.applyFx(out, { hpf: 200, gain: 0.85 });
}

// 2. bounce_wall — softer electronic blip
function bounceWall() {
  const b = audio.osc_models.fmOperator(620, 0.1, 2.5, 3, (t) => Math.exp(-18 * t));
  audio.adsrExp(b, 0.001, 0.03, 0.1, 0.06, 3);
  audio.fadeOut(b, 0.006);
  return audio.mix_bus.applyFx(b, { hpf: 180, lpf: 5200, gain: 0.6 });
}

// 3. goal_score — rising celebratory arp sweep (player scores)
function goalScore() {
  const notes = [72, 76, 79, 84]; // C5 E5 G5 C6
  const out = new Float32Array(Math.floor(1.1 * SR));
  notes.forEach((midi, i) => {
    const bell = audio.synth_voices.bell(midi, 0.5, 100, 220);
    audio.addInto(out, bell, Math.floor(i * 0.09 * SR), 0.6 - i * 0.06);
  });
  const riser = audio.sweep(300, 1400, 0.5, 'sawtooth', 'exponential');
  audio.adsrExp(riser, 0.01, 0.1, 0.5, 0.35, 2);
  audio.addInto(out, riser, 0, 0.18);
  audio.fadeOut(out, 0.05);
  return audio.mix_bus.applyFx(out, { hpf: 150, reverb: 'plate', gain: 0.8 });
}

// 4. goal_concede — descending sad glide (Vector scores on player... or vice versa)
function goalConcede() {
  const g = audio.sweep(520, 130, 0.7, 'triangle', 'exponential');
  audio.adsrExp(g, 0.005, 0.15, 0.5, 0.4, 2);
  const low = audio.sweep(260, 65, 0.7, 'sine', 'exponential');
  audio.adsrExp(low, 0.005, 0.15, 0.5, 0.4, 2);
  const out = audio.mix([g, low], [0.6, 0.4]);
  audio.fadeOut(out, 0.05);
  return audio.mix_bus.applyFx(out, { hpf: 90, lpf: 2600, reverb: 'mediumRoom', gain: 0.65 });
}

// 5. countdown_blip — clean UI beep
function countdownBlip() {
  const b = audio.sine(1046, 0.09, 0.8); // C6
  audio.adsrExp(b, 0.001, 0.02, 0.5, 0.05, 3);
  audio.fadeOut(b, 0.006);
  return audio.mix_bus.applyFx(b, { hpf: 250, gain: 0.55 });
}

// 6. game_win — triumphant synth stinger
function gameWin() {
  const chords = [
    [60, 64, 67],       // C major
    [65, 69, 72],       // F major
    [67, 71, 74, 79],   // G major + high D
  ];
  const out = new Float32Array(Math.floor(1.8 * SR));
  chords.forEach((chord, ci) => {
    chord.forEach((midi) => {
      const freq = 440 * Math.pow(2, (midi - 69) / 12);
      const v = audio.sawtooth(freq, 0.5, 0.25);
      audio.adsrExp(v, 0.01, 0.1, 0.5, 0.3, 2);
      audio.addInto(out, v, Math.floor(ci * 0.22 * SR), 0.3 / chord.length * 3);
    });
  });
  const sparkle = audio.synth_voices.bell(88, 0.9, 90, 260);
  audio.addInto(out, sparkle, Math.floor(0.44 * SR), 0.4);
  audio.humanize.ampWobble(out, 0.3, 0.06);
  audio.fadeOut(out, 0.12);
  return audio.mix_bus.applyFx(out, { hpf: 120, lpf: 7000, reverb: 'largeHall', gain: 0.75 });
}

writeSfx('hit_paddle', hitPaddle());
writeSfx('bounce_wall', bounceWall());
writeSfx('goal_score', goalScore());
writeSfx('goal_concede', goalConcede());
writeSfx('countdown_blip', countdownBlip());
writeSfx('game_win', gameWin());
console.log('ALL DONE');
