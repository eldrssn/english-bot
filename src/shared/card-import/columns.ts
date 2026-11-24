// Столбцы импорта и распознавание строки заголовка.
import { normalizeWordText } from "../../domain/normalize.js";

export type ImportColumnKey =
  | "english"
  | "translation"
  | "example"
  | "explanation"
  | "acceptedRuEn"
  | "acceptedEnRu"
  | "allowOmitTo";

export type ImportColumn = { key: ImportColumnKey; title: string; required: boolean };

/** Порядок столбцов фиксирован; заголовок его не меняет. */
export const IMPORT_COLUMNS: readonly ImportColumn[] = [
  { key: "english", title: "Слово или фраза по-английски", required: true },
  { key: "translation", title: "Основной перевод", required: true },
  { key: "example", title: "Пример", required: false },
  { key: "explanation", title: "Пояснение", required: false },
  { key: "acceptedRuEn", title: "Ответы ru→en", required: false },
  { key: "acceptedEnRu", title: "Ответы en→ru", required: false },
  { key: "allowOmitTo", title: "Можно без to", required: false },
] as const;

/**
 * Признаки названий столбцов. Английские — целые слова, русские — начала слов («перев» —
 * «перевод», «переводы»). Заголовок распознаётся, только если первая ячейка похожа на название
 * столбца слова, а вторая — перевода: строка данных `word, слово` заголовком не считается.
 */
const HEADER_WORDS: Record<"english" | "translation", { exact: string[]; prefixes: string[] }> = {
  english: {
    exact: ["english", "word", "words", "phrase", "term", "en", "eng"],
    prefixes: ["англ", "слов", "фраз", "термин"],
  },
  translation: {
    exact: ["translation", "translations", "russian", "meaning", "ru", "rus"],
    prefixes: ["перев", "русск", "значен"],
  },
};

function looksLike(cell: string, column: "english" | "translation"): boolean {
  const tokens = normalizeWordText(cell).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const { exact, prefixes } = HEADER_WORDS[column];
  return tokens.some((token) => exact.includes(token) || prefixes.some((prefix) => token.startsWith(prefix)));
}

export function looksLikeHeader(fields: readonly string[]): boolean {
  return looksLike(fields[0] ?? "", "english") && looksLike(fields[1] ?? "", "translation");
}
