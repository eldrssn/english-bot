/** Ограничение частоты с фиксированным окном. Хранится в памяти: для одного сервиса пилота этого достаточно. */
export class RateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Возвращает число секунд до конца окна, если лимит исчерпан, иначе null. */
  hit(key: string): number | null {
    const now = this.now();
    if (this.hits.size > 10_000) {
      for (const [stored, entry] of this.hits) if (entry.resetAt <= now) this.hits.delete(stored);
    }
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      return null;
    }
    entry.count += 1;
    return entry.count > this.max ? Math.max(1, Math.ceil((entry.resetAt - now) / 1000)) : null;
  }
}
