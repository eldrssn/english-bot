/** Генератор случайных чисел в диапазоне [0, 1). Передаётся параметром, глобальный Math.random не используется. */
export type Rng = () => number;

/** Детерминированный генератор (mulberry32): один seed даёт одну последовательность. */
export function createSeededRng(seed: number): Rng {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Случайный индекс в [0, size). Значение генератора вне [0, 1) — ошибка вызывающего кода. */
export function randomIndex(size: number, rng: Rng): number {
  const value = rng();
  if (!(value >= 0 && value < 1)) {
    throw new RangeError(`Генератор должен возвращать число в диапазоне [0, 1), получено ${value}`);
  }
  return Math.floor(value * size);
}

/** Перемешивание Фишера — Йетса. Исходный массив не меняется. */
export function shuffled<T>(items: readonly T[], rng: Rng): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = randomIndex(i + 1, rng);
    [result[i], result[j]] = [result[j]!, result[i]!];
  }
  return result;
}
