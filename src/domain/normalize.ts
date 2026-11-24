// Чистые функции без Telegram и базы. Правила: раздел 2.4 плана и раздел 6 сценария.

const APOSTROPHES = /['’‘ʼ`´]/g;

/**
 * Нормализация текста для сравнения слов: регистр, пробелы, ё = е.
 * Знаки препинания и `to` не трогает: `to go` и `go` остаются разными словами.
 * Приведение Unicode убирает различия в записи одной буквы, невидимые символы и знаки ударения.
 */
export function normalizeWordText(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/\p{Cf}/gu, "")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/\s+/g, " ")
    .trim();
}

export type NormalizeAnswerOptions = {
  /** Разрешено ли в карточке не писать `to` перед английским глаголом. */
  allowOmitTo?: boolean;
};

/**
 * Нормализация ответа ученика и допустимых вариантов: к правилам слова добавляет пунктуацию
 * и необязательный начальный `to`. Апострофы удаляются (don't = dont), остальные знаки
 * и дефисы заменяются пробелом (well-known = well known). Допуска к опечаткам нет.
 * Сравнивать можно только строки, нормализованные с одинаковыми настройками.
 */
export function normalizeAnswerText(text: string, options: NormalizeAnswerOptions = {}): string {
  const normalized = normalizeWordText(text.replace(APOSTROPHES, ""))
    .replace(/[\p{P}\p{S}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  // Пропуск проверяет следующий символ: само слово `to` не превращается в пустую строку.
  return options.allowOmitTo ? normalized.replace(/^to (?=\S)/, "") : normalized;
}
