// Shared by every effect: the intensity setting (0..100, 50 = the effect's default look) as a factor 0..2 (1 at 50).
// Anything that is not a finite number counts as the default, so a bad value never reaches the maths.
export const DEFAULT_INTENSITY = 50;
export const factor = (n) => (Number.isFinite(n) ? Math.min(2, Math.max(0, n / 50)) : 1);
