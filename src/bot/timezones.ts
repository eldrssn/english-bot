// Часовые пояса для выбора в боте. Telegram пояс пользователя не сообщает, поэтому ученик выбирает его сам.
// Ученики и в РФ, и за её пределами (раздел 2.1 плана): города России, частые страны и запасной вариант — смещение от UTC.

export type TimezoneOption = { zone: string; label: string };
export type TimezonePage = { title: string; options: TimezoneOption[]; showOffset: boolean };

const RUSSIA: TimezoneOption[] = [
  { zone: "Europe/Kaliningrad", label: "Калининград" },
  { zone: "Europe/Moscow", label: "Москва" },
  { zone: "Europe/Samara", label: "Самара" },
  { zone: "Asia/Yekaterinburg", label: "Екатеринбург" },
  { zone: "Asia/Omsk", label: "Омск" },
  { zone: "Asia/Novosibirsk", label: "Новосибирск" },
  { zone: "Asia/Krasnoyarsk", label: "Красноярск" },
  { zone: "Asia/Irkutsk", label: "Иркутск" },
  { zone: "Asia/Yakutsk", label: "Якутск" },
  { zone: "Asia/Vladivostok", label: "Владивосток" },
  { zone: "Asia/Magadan", label: "Магадан" },
  { zone: "Asia/Kamchatka", label: "Камчатка" },
];

const ABROAD: TimezoneOption[] = [
  { zone: "Europe/London", label: "Лондон" },
  { zone: "Europe/Berlin", label: "Берлин, Париж" },
  { zone: "Europe/Belgrade", label: "Белград" },
  { zone: "Europe/Helsinki", label: "Хельсинки" },
  { zone: "Europe/Kyiv", label: "Киев" },
  { zone: "Europe/Minsk", label: "Минск" },
  { zone: "Asia/Nicosia", label: "Кипр" },
  { zone: "Asia/Jerusalem", label: "Израиль" },
  { zone: "Europe/Istanbul", label: "Стамбул" },
  { zone: "Asia/Tbilisi", label: "Тбилиси" },
  { zone: "Asia/Yerevan", label: "Ереван" },
  { zone: "Asia/Baku", label: "Баку" },
  { zone: "Asia/Dubai", label: "Дубай" },
  { zone: "Asia/Tashkent", label: "Ташкент" },
  { zone: "Asia/Almaty", label: "Алматы" },
  { zone: "Asia/Bishkek", label: "Бишкек" },
  { zone: "Asia/Bangkok", label: "Бангкок" },
  { zone: "Asia/Makassar", label: "Бали" },
  { zone: "America/New_York", label: "Нью-Йорк" },
  { zone: "America/Los_Angeles", label: "Лос-Анджелес" },
];

/** Etc/GMT-3 — это UTC+3: в именах Etc знак обратный. Летнего времени у них нет. */
const BY_OFFSET: TimezoneOption[] = Array.from({ length: 27 }, (_, index) => {
  const offset = index - 12;
  if (offset === 0) return { zone: "Etc/UTC", label: "UTC" };
  return { zone: `Etc/GMT${offset > 0 ? "-" : "+"}${Math.abs(offset)}`, label: `UTC${offset > 0 ? "+" : "−"}${Math.abs(offset)}` };
});

export const TIMEZONE_PAGES: readonly TimezonePage[] = [
  { title: "Россия", options: RUSSIA, showOffset: true },
  { title: "Другие страны", options: ABROAD, showOffset: true },
  { title: "Смещение от UTC", options: BY_OFFSET, showOffset: false },
];

const ALL = TIMEZONE_PAGES.flatMap((page) => page.options);

/** Название пояса для ученика: город из списка или имя IANA, если пояс задан иначе. */
export function timezoneLabel(zone: string): string {
  return ALL.find((option) => option.zone === zone)?.label ?? zone;
}
