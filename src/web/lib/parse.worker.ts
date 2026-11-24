// Разбор вставки в отдельном потоке: таблица на сотни тысяч символов не подвешивает страницу.
import { parseCardTable } from "../../shared/card-import/index.js";

export type ParseRequest = { id: number; text: string; existing: { english: string; translation: string }[]; maxRows: number };

self.onmessage = (event: MessageEvent<ParseRequest>) => {
  const { id, text, existing, maxRows } = event.data;
  self.postMessage({ id, result: parseCardTable(text, { existing, maxRows }) });
};
