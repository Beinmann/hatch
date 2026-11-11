// Pure helpers for the rain effect: no canvas, no globals, `rand` is injected where randomness is needed, so they are unit-tested.
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const num = (v, d = 0) => (Number.isFinite(v) ? v : d);

/** Radius after two drops merge: area is conserved (r^2 adds up). */
export const mergeRadius = (a, b) => Math.hypot(num(a), num(b));

/** A resting drop slowly collects mist: radius grows by `rate` px per second. */
export const growRadius = (r, dt, rate) => num(r) + Math.max(0, num(rate)) * Math.max(0, num(dt));

/** A sliding drop leaves water behind: it loses `k` px of radius per px travelled, never below 0. */
export const shedRadius = (r, dist, k) => Math.max(0, num(r) - Math.max(0, num(k)) * Math.abs(num(dist)));

/** Does drop `d` reach small droplet `b` (the drop swallows it)? `reach` < 1 shrinks the droplet's share of the contact distance. */
export function touches(d, b, reach = 0.6) {
  const dx = b.x - d.x, dy = b.y - d.y, s = d.r + b.r * reach;
  return dx * dx + dy * dy < s * s;
}

/** Wet trail fade by age: alpha and width multipliers (1 fresh, 0 gone) and whether the point is dead. The trail narrows as it dries. */
export function trailFade(age, life) {
  const t = life > 0 ? clamp(num(age) / life, 0, 1) : 1;
  return { alpha: Math.pow(1 - t, 1.5), width: 1 - 0.7 * t, dead: t >= 1 };
}

/** Speed (px/s) a drop aims for while it moves: bigger drops are heavier and faster; streak drops are quicker still. */
export const slideTarget = (r, fast = false, speed = 1) => (18 + 13 * Math.max(0, num(r))) * (fast ? 2.6 : 1) * speed;

/** Eases the current speed toward the target (a drop never jumps to its speed). */
export const approachSpeed = (v, target, dt) => num(v) + (num(target) - num(v)) * clamp(num(dt) * 8, 0, 1);

/** Stop-and-go: returns the burst state after dt. `b` = { moving, t } (seconds left in this phase); `spec` = { go: [min,max], stop: [min,max] }. */
export function stepBurst(b, dt, rand, spec) {
  const t = b.t - dt;
  if (t > 0) return { moving: b.moving, t };
  const moving = !b.moving, [lo, hi] = moving ? spec.go : spec.stop;
  return { moving, t: lo + rand() * (hi - lo) };
}

/** How many small droplets / large drops a canvas of this size should carry (finite, never negative, for any size including 0). */
export const beadCount = (W, H, density, max) => clamp(Math.floor(Math.max(0, num(W)) * Math.max(0, num(H)) / density), 0, max);
export const dropCount = (W, H, density, min, max) => clamp(Math.round(Math.max(0, num(W)) * Math.max(0, num(H)) / density), min, max);

/** A short streak of fast drops entering from above near one x position. */
export function streakSpecs(W, count, rand) {
  const w = Math.max(1, num(W, 1)), base = rand() * w, n = Math.max(1, Math.round(count[0] + rand() * (count[1] - count[0])));
  return Array.from({ length: n }, () => ({ x: clamp(base + (rand() - 0.5) * 70, 0, w), y: -rand() * 50, r: 1.5 + rand() * 1.0, fast: true }));
}

/** Intensity 0..100 as { alpha, count }: a multiplier on every alpha and one on how many droplets and drops there are (both 1 at the default 50). */
export const rainLevel = (n) => { const f = Number.isFinite(n) ? clamp(n / 50, 0, 2) : 1; return { alpha: f, count: f }; };
