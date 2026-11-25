// Локальное время ученика. Часы передаются параметром: функции не читают системное время.
// Локальная дата — строка YYYY-MM-DD, как столбец sessions.quest_local_date.

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let cached = formatters.get(timeZone);
  if (!cached) {
    cached = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    formatters.set(timeZone, cached);
  }
  return cached;
}

/** Часовой пояс IANA, который понимает среда выполнения. */
export function isValidTimeZone(timeZone: string): boolean {
  if (timeZone.trim() === "") return false;
  try {
    formatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

function localParts(now: Date, timeZone: string) {
  const parts = Object.fromEntries(formatter(timeZone).formatToParts(now).map((part) => [part.type, part.value]));
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

/** Локальная дата в часовом поясе: YYYY-MM-DD. */
export function localDate(now: Date, timeZone: string): string {
  return localParts(now, timeZone).date;
}

/** Минуты от локальной полуночи. */
export function localMinutes(now: Date, timeZone: string): number {
  return localParts(now, timeZone).minutes;
}

/** Время «ЧЧ:ММ» или «ЧЧ:ММ:СС» (так его возвращает PostgreSQL) в минуты от полуночи. null: не время. */
export function parseClock(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/** Минуты от полуночи в «ЧЧ:ММ». */
export function formatClock(minutes: number): string {
  if (!Number.isInteger(minutes) || minutes < 0 || minutes >= 24 * 60) {
    throw new RangeError(`Ожидаются минуты от 0 до 1439, получено ${minutes}`);
  }
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

const LOCAL_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Сдвиг локальной даты на целое число дней. Календарная арифметика, часовой пояс не нужен. */
export function addDays(date: string, days: number): string {
  const match = LOCAL_DATE_PATTERN.exec(date);
  if (!match) throw new RangeError(`Ожидается дата YYYY-MM-DD, получено ${date}`);
  const shifted = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + days));
  return shifted.toISOString().slice(0, 10);
}

/** Смещение пояса в этот момент: «UTC+3», «UTC+5:30», «UTC−3», «UTC». Учитывает летнее время. */
export function utcOffsetLabel(now: Date, timeZone: string): string {
  const name = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "shortOffset" })
    .formatToParts(now)
    .find((part) => part.type === "timeZoneName")?.value;
  const offset = name?.replace(/^GMT/, "") ?? "";
  if (offset === "" || offset === "+0" || offset === "-0") return "UTC";
  return `UTC${offset.replace("-", "−")}`;
}
