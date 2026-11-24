// Вставка строк из таблицы или файла CSV с предпросмотром по строкам. Ничего не сохраняется до нажатия кнопки.
import { startTransition, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { DEFAULT_MAX_ROWS, IMPORT_COLUMNS, parseCardTable, type ImportResult, type ImportRow } from "../../shared/card-import/index.js";
import { sentence } from "../lib/api";
import { looksBinary, readCsvFile } from "../lib/cards";
import { cardsText } from "../lib/format";
import { CopyButton, ErrorState } from "./kit";

/** Как в контракте importBody: больше сервер не примет. */
const MAX_TEXT_LENGTH = 1_000_000;

export const IMPORT_EXAMPLE = [
  "Слово,Перевод,Пример,Пояснение,Ответы ru→en,Ответы en→ru,Можно без to",
  'to travel,путешествовать,I love to travel.,,"journey; trip",ездить,да',
  "bank,банк,I keep money in the bank.,,,,",
  "bank,берег,We sat on the river bank.,берег реки,,,",
].join("\n");

const DELIMITER_LABEL = { tab: "табуляция (вставка из таблицы)", comma: "запятая", semicolon: "точка с запятой" } as const;

export type PasteSummary = { toAdd: number; invalid: number; duplicates: number; tooManyRows: boolean };

export function summarize(result: ImportResult): PasteSummary {
  let toAdd = 0;
  let invalid = 0;
  let duplicates = 0;
  for (const row of result.rows) {
    if (!row.card) invalid += 1;
    else if (row.duplicate) duplicates += 1;
    else toAdd += 1;
  }
  return { toAdd, invalid, duplicates, tooManyRows: result.tooManyRows };
}

function RowOutcome({ row, place }: { row: ImportRow; place: string }) {
  if (!row.card) {
    return (
      <div className="row-outcome">
        <span className="badge badge-danger">Ошибка</span>
        <ul className="row-errors">
          {row.errors.map((error) => (
            <li key={error}>{sentence(error.replace(/^Строка \d+: /, ""))}</li>
          ))}
        </ul>
      </div>
    );
  }
  if (row.duplicate) {
    return (
      <div className="row-outcome">
        <span className="badge badge-warn">Дубль</span>
        <span className="small">
          {row.duplicate.kind === "in_import" ? `Повтор строки ${row.duplicate.line}` : `Такая карточка уже есть ${place}`}. Не будет
          добавлена.
        </span>
      </div>
    );
  }
  return (
    <div className="row-outcome">
      <span className="badge badge-success">Будет добавлена</span>
    </div>
  );
}

type TablePasteProps = {
  /** Карточки, уже лежащие в подборке или копии: совпадения помечаются как дубли. */
  existing: readonly { english: string; translation: string }[];
  /** «в подборке» / «в копии». */
  place: string;
  /** Сохранение; возвращает текст результата. Ошибка показывается здесь же. */
  onSave: (text: string, result: ImportResult) => Promise<ReactNode>;
  saveLabel: (count: number) => string;
  /** Пояснение перед кнопкой; получает число карточек, которые будут добавлены. */
  notice?: (toAdd: number) => ReactNode;
};

export function TablePaste({ existing, place, onSave, saveLabel, notice }: TablePasteProps) {
  const [text, setText] = useState("");
  const [result, setResult] = useState<ImportResult | null>(null);
  const [parsedText, setParsedText] = useState("");
  const [fileInfo, setFileInfo] = useState<{ tone: "success" | "warn" | "danger"; text: string } | null>(null);
  const [onlyProblems, setOnlyProblems] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const [saved, setSaved] = useState<ReactNode>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const resultRef = useRef<HTMLDivElement>(null);
  const ids = useId();
  const existingRef = useRef(existing);
  existingRef.current = existing;

  // Разбор после паузы в наборе и в отдельном потоке: большая вставка не тормозит ввод и страницу.
  const workerRef = useRef<Worker | null>(null);
  const requestRef = useRef(0);
  useEffect(() => () => workerRef.current?.terminate(), []);

  useEffect(() => {
    if (text.trim() === "" || text.length > MAX_TEXT_LENGTH) {
      requestRef.current += 1;
      setResult(null);
      setParsedText(text);
      return;
    }
    const timer = window.setTimeout(() => {
      const id = ++requestRef.current;
      const apply = (parsed: ImportResult) => {
        if (id !== requestRef.current) return;
        startTransition(() => {
          setResult(parsed);
          setParsedText(text);
        });
      };
      const existing = existingRef.current.map(({ english, translation }) => ({ english, translation }));
      try {
        workerRef.current ??= new Worker(new URL("../lib/parse.worker.ts", import.meta.url), { type: "module" });
        workerRef.current.onmessage = (event: MessageEvent<{ id: number; result: ImportResult }>) => {
          if (event.data.id === requestRef.current) apply(event.data.result);
        };
        workerRef.current.postMessage({ id, text, existing, maxRows: DEFAULT_MAX_ROWS });
      } catch {
        // Без поддержки потоков разбираем здесь же: строк не больше лимита, это быстро.
        apply(parseCardTable(text, { existing, maxRows: DEFAULT_MAX_ROWS }));
      }
    }, 250);
    return () => window.clearTimeout(timer);
  }, [text]);

  const pending = text !== parsedText;
  const summary = result ? summarize(result) : null;
  const rows = result ? (onlyProblems ? result.rows.filter((row) => !row.card || row.duplicate) : result.rows) : [];

  const changeText = (value: string) => {
    setText(value);
    setSaved(null);
    setFailure(null);
  };

  const pickFile = async (file: File | undefined) => {
    if (!file) return;
    setFileInfo(null);
    try {
      const decoded = await readCsvFile(file);
      if (looksBinary(decoded.text)) {
        setFileInfo({
          tone: "danger",
          text: `«${file.name}» не похож на CSV. В Excel или Google Таблицах сохраните таблицу как «CSV UTF-8» и выберите этот файл.`,
        });
        return;
      }
      changeText(decoded.text);
      setFileInfo(
        decoded.encoding === "windows-1251"
          ? {
              tone: "warn",
              text: `Файл «${file.name}» сохранён не в UTF-8, прочитали его как Windows-1251. Проверьте русские буквы в предпросмотре; если они искажены, сохраните таблицу как «CSV UTF-8».`,
            }
          : { tone: "success", text: `Файл «${file.name}» прочитан. Проверьте строки ниже.` },
      );
    } catch {
      setFileInfo({ tone: "danger", text: `Не удалось прочитать «${file.name}». Выберите файл ещё раз.` });
    }
  };

  const save = async () => {
    if (!result || !summary || pending) return;
    setBusy(true);
    setFailure(null);
    try {
      const outcome = await onSave(text, result);
      setSaved(outcome);
      setText("");
      setParsedText("");
      setResult(null);
      setFileInfo(null);
      window.setTimeout(() => resultRef.current?.focus(), 0);
    } catch (error) {
      setFailure(error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="paste">
      <details className="panel import-help">
        <summary>Порядок столбцов и пример</summary>
        <ol className="column-list">
          {IMPORT_COLUMNS.map((column) => (
            <li key={column.key}>
              {column.title}
              {column.required ? <span className="badge badge-neutral">обязательно</span> : null}
            </li>
          ))}
        </ol>
        <p className="small muted">
          Порядок столбцов постоянный. Строку с названиями столбцов можно оставить: она распознаётся и пропускается. Несколько
          ответов в одной ячейке разделяйте точкой с запятой. В последнем столбце — «да» или пусто.
        </p>
        {/* На телефоне пример прокручивается вбок: с клавиатуры до него тоже можно дойти. */}
        <pre className="example-block" id={`${ids}-example`} tabIndex={0} role="region" aria-label="Пример таблицы для импорта">
          {IMPORT_EXAMPLE}
        </pre>
        <CopyButton text={IMPORT_EXAMPLE} label="Скопировать пример" describedBy={`${ids}-example`} />
      </details>

      <div className="field">
        <label htmlFor={`${ids}-text`}>Строки из таблицы</label>
        <p id={`${ids}-hint`} className="field-hint">
          Выделите строки в Google Таблицах или Excel, скопируйте и вставьте сюда. Подойдёт и текст CSV. За один раз — до{" "}
          {DEFAULT_MAX_ROWS} строк.
        </p>
        <textarea
          id={`${ids}-text`}
          ref={textareaRef}
          className="input textarea paste-area"
          value={text}
          onChange={(event) => changeText(event.target.value)}
          aria-describedby={`${ids}-hint`}
          rows={8}
          spellCheck={false}
          wrap="off"
        />
      </div>

      <div className="field">
        <label htmlFor={`${ids}-file`}>Или файл CSV</label>
        <input
          id={`${ids}-file`}
          type="file"
          className="file-input"
          accept=".csv,.tsv,.txt,text/csv,text/plain,text/tab-separated-values"
          onChange={(event) => {
            void pickFile(event.target.files?.[0]);
            event.target.value = "";
          }}
        />
      </div>
      {fileInfo ? (
        <p className={`notice notice-${fileInfo.tone}`} role={fileInfo.tone === "danger" ? "alert" : "status"}>
          {fileInfo.text}
        </p>
      ) : null}

      <div ref={resultRef} tabIndex={-1} className="paste-result" role="status">
        {saved ? <div className="notice notice-success">{saved}</div> : null}
      </div>

      {text.length > MAX_TEXT_LENGTH ? (
        <p className="notice notice-danger" role="alert">
          Текст слишком большой: больше миллиона символов. Разделите таблицу на части по {DEFAULT_MAX_ROWS} строк.
        </p>
      ) : null}
      {text.trim() !== "" && text.length <= MAX_TEXT_LENGTH ? (
        <section className="section" aria-labelledby={`${ids}-preview`} aria-busy={pending}>
          <h2 id={`${ids}-preview`}>Предпросмотр</h2>
          {pending && !result ? <p className="muted">Проверяем строки…</p> : null}
          {result && summary ? (
            <>
              <dl className="stats import-stats" aria-live="polite">
                <div className="stat stat-success">
                  <dt>Будет добавлено</dt>
                  <dd>{summary.toAdd}</dd>
                </div>
                <div className="stat stat-danger">
                  <dt>С ошибками</dt>
                  <dd>{summary.invalid}</dd>
                </div>
                <div className="stat stat-warn">
                  <dt>Дубли</dt>
                  <dd>{summary.duplicates}</dd>
                </div>
              </dl>
              <p className="muted small">
                Разделитель: {DELIMITER_LABEL[result.delimiter]}.{" "}
                {result.hasHeader ? "Первая строка — названия столбцов, она пропущена." : null}
                {pending ? " Обновляем…" : null}
              </p>
              {summary.tooManyRows ? (
                <p className="notice notice-danger" role="alert">
                  Строк больше {DEFAULT_MAX_ROWS}. Ничего не будет сохранено: разделите вставку на части по {DEFAULT_MAX_ROWS} строк.
                </p>
              ) : null}
              {summary.invalid + summary.duplicates > 0 ? (
                <label className="checkbox-line small">
                  <input type="checkbox" className="checkbox" checked={onlyProblems} onChange={(event) => setOnlyProblems(event.target.checked)} />
                  Показывать только строки с ошибками и дубли
                </label>
              ) : null}
              {rows.length > 0 ? (
                <table className="data-table import-table" role="table" aria-label="Строки вставки">
                  <thead role="rowgroup">
                    <tr role="row">
                      <th role="columnheader" scope="col" className="numeric">
                        Строка
                      </th>
                      <th role="columnheader" scope="col">
                        Слово
                      </th>
                      <th role="columnheader" scope="col">
                        Перевод
                      </th>
                      <th role="columnheader" scope="col">
                        Итог
                      </th>
                    </tr>
                  </thead>
                  <tbody role="rowgroup">
                    {rows.map((row) => (
                      <tr role="row" key={row.line} className={!row.card ? "row-invalid" : row.duplicate ? "row-duplicate" : undefined}>
                        <td role="cell" data-label="Строка" className="numeric">
                          {row.line}
                        </td>
                        <td role="cell" data-label="Слово" lang="en">
                          {row.card?.english ?? <span className="muted">—</span>}
                        </td>
                        <td role="cell" data-label="Перевод">
                          {row.card?.translation ?? <span className="muted">—</span>}
                        </td>
                        <td role="cell" data-label="Итог">
                          <RowOutcome row={row} place={place} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : result.rows.length === 0 ? (
                <p className="muted">Строк с данными не нашлось.</p>
              ) : null}
              {notice && summary.toAdd > 0 ? notice(summary.toAdd) : null}
              {failure ? <ErrorState error={failure} /> : null}
              <div className="actions">
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => void save()}
                  disabled={busy || pending || summary.toAdd === 0 || summary.tooManyRows}
                  aria-busy={busy}
                >
                  {summary.toAdd === 0 ? "Добавлять нечего" : saveLabel(summary.toAdd)}
                </button>
                <button type="button" className="btn" onClick={() => changeText("")} disabled={busy}>
                  Очистить
                </button>
              </div>
              {summary.invalid + summary.duplicates > 0 && summary.toAdd > 0 ? (
                <p className="muted small">
                  Строки с ошибками и дубли будут пропущены. Можно исправить их в поле выше — предпросмотр обновится.
                </p>
              ) : null}
            </>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

export const addedSummary = (added: number, invalid: number, duplicates: number) =>
  [
    `Добавлено: ${cardsText(added)}.`,
    invalid + duplicates > 0 ? `Пропущено: с ошибками — ${invalid}, дублей — ${duplicates}.` : null,
  ]
    .filter(Boolean)
    .join(" ");
