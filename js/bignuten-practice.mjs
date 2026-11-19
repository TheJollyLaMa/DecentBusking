// Adapted from BigNuten_Vanilla at f33c487 (Apache-2.0); see img/BigNuten.NOTICE.txt.
export const PRACTICES = Object.freeze({
  even: { family: 'heart', activity: 'breathwork', title: 'Easy breath', symbol: '',
    hint: 'Follow the circle, gently. No holds.',
    phases: [{ key: 'inhale', label: 'Breathe in', seconds: 4 }, { key: 'exhale', label: 'Breathe out', seconds: 4 }] },
  extended: { family: 'heart', activity: 'breathwork', title: 'Long exhale', symbol: '',
    hint: 'An easy breath in. A soft, longer breath out.',
    phases: [{ key: 'inhale', label: 'Breathe in', seconds: 4 }, { key: 'exhale', label: 'Breathe out', seconds: 6 }] },
  hum: { family: 'throat', activity: 'vocal', title: 'Gentle hum', symbol: 'mmm',
    hint: 'Lips together. Hum softly on a comfortable note.',
    phases: [{ key: 'inhale', label: 'Easy breath in', seconds: 4 }, { key: 'sound', label: 'Mmm...', seconds: 4 }, { key: 'rest', label: 'Breathe naturally', seconds: 4 }] },
  trill: { family: 'throat', activity: 'vocal', title: 'Lip trill', symbol: 'brr',
    hint: 'Relax your lips. Let them flutter with a little air.',
    phases: [{ key: 'inhale', label: 'Easy breath in', seconds: 4 }, { key: 'sound', label: 'Brr...', seconds: 4 }, { key: 'rest', label: 'Breathe naturally', seconds: 4 }] },
  chant: { family: 'throat', activity: 'chanting', title: 'Aum / Om', symbol: 'om',
    hint: 'An easy ah-oh-mmm. Let the sound soften away.',
    phases: [{ key: 'inhale', label: 'Easy breath in', seconds: 4 }, { key: 'sound', label: 'Ah - oh - mmm', seconds: 4 }, { key: 'rest', label: 'Breathe naturally', seconds: 4 }] },
});

export function practicePhase(method, seconds) {
  const practice = PRACTICES[method];
  if (!practice || !Number.isFinite(seconds) || seconds < 0) throw new Error('Invalid practice or elapsed time.');
  const cycle = practice.phases.reduce((sum, phase) => sum + phase.seconds, 0);
  let within = seconds % cycle;
  for (const phase of practice.phases) {
    if (within < phase.seconds) return { ...phase, progress: within / phase.seconds, remaining: Math.ceil(phase.seconds - within) };
    within -= phase.seconds;
  }
}

export function createPracticeTimer({ tick, complete, now = () => performance.now(), schedule = setInterval, clear = clearInterval }) {
  let interval = null, elapsed = 0, started = 0, target = 0, active = false;
  const stop = () => { if (interval !== null) clear(interval); interval = null; };
  const preciseSeconds = () => Math.min(target, (elapsed + (interval !== null ? now() - started : 0)) / 1000);
  const seconds = () => Math.floor(preciseSeconds());
  function update() {
    const precise = preciseSeconds();
    tick(Math.floor(precise), precise);
    if (precise >= target) { stop(); active = false; elapsed = target * 1000; complete(target); }
  }
  return {
    start(targetSeconds) { stop(); elapsed = 0; target = targetSeconds; active = true; started = now(); interval = schedule(update, 200); update(); },
    pause() { if (interval === null) return; elapsed += now() - started; stop(); tick(seconds(), preciseSeconds()); },
    resume() { if (!active || interval !== null) return; started = now(); interval = schedule(update, 200); update(); },
    end() { const value = seconds(); stop(); active = false; elapsed = value * 1000; return value; },
    cancel() { stop(); active = false; elapsed = 0; tick(0, 0); },
  };
}
