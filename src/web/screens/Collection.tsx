import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import type { SourceCard, SourceCollectionDetail } from "../../shared/api-contract";
import { ApiCallError, api, errorText, isNotFound } from "../lib/api";
import { cardsText, formatDateTime, studentsText } from "../lib/format";
import { Link, navigate } from "../lib/router";
import { useQuery } from "../lib/useQuery";
import { ConfirmDialog } from "../ui/Dialog";
import { ErrorState, Loading, NotFoundBlock, PageTitle, TextField } from "../ui/kit";
import { TITLE_MAX, titleError } from "./Collections";
import { useFlash } from "./Shell";

export function CollectionNotFound() {
  return (
    <NotFoundBlock
      title="Подборка не найдена"
      text="Такой подборки нет в вашем списке: возможно, адрес неверный или подборку удалили."
      href="/collections"
      linkLabel="К списку подборок"
    />
  );
}

export function CollectionQueryError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  return isNotFound(error) ? <CollectionNotFound /> : <ErrorState error={error} onRetry={onRetry} />;
}

export function useCollection(id: number) {
  return useQuery((signal) => api("getCollection", { id, signal }), `collection-${id}`);
}

function RenameCollection({ collection, onDone }: { collection: SourceCollectionDetail; onDone: (detail?: SourceCollectionDetail) => void }) {
  const [title, setTitle] = useState(collection.title);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const problem = titleError(title);
    if (problem) {
      setFieldError(problem);
      return;
    }
    setFieldError(null);
    setError(null);
    setBusy(true);
    try {
      onDone(await api("renameCollection", { id: collection.id, body: { title } }));
    } catch (failure) {
      if (failure instanceof ApiCallError && failure.code === "bad_request") setFieldError(errorText(failure));
      else setError(failure);
      setBusy(false);
    }
  };

  return (
    <form
      className="form rename-form"
      onSubmit={(event) => void submit(event)}
      onKeyDown={(event) => {
        if (event.key === "Escape") onDone();
      }}
      noValidate
    >
      <TextField
        label="Новое название"
        hint="Копии, уже выданные ученикам, сохранят прежнее название."
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        error={fieldError}
        maxLength={TITLE_MAX}
        autoComplete="off"
        autoFocus
      />
      {error ? <ErrorState error={error} /> : null}
      <div className="actions">
        <button type="submit" className="btn btn-primary" disabled={busy} aria-busy={busy}>
          Сохранить название
        </button>
        <button type="button" className="btn" onClick={() => onDone()} disabled={busy}>
          Отмена
        </button>
      </div>
    </form>
  );
}

/** Пример, пояснение и варианты ответа одной ячейкой: в таблице им не нужны отдельные столбцы. */
export function CardExtras({ card }: { card: Pick<SourceCard, "example" | "explanation" | "acceptedRuEn" | "acceptedEnRu" | "allowOmitTo"> }) {
  const parts = [
    card.example ? { label: "Пример", value: card.example, lang: "en" } : null,
    card.explanation ? { label: "Пояснение", value: card.explanation } : null,
    card.acceptedRuEn.length > 0 ? { label: "Ещё ответы ru→en", value: card.acceptedRuEn.join("; "), lang: "en" } : null,
    card.acceptedEnRu.length > 0 ? { label: "Ещё ответы en→ru", value: card.acceptedEnRu.join("; ") } : null,
  ].filter((part) => part !== null);
  if (parts.length === 0 && !card.allowOmitTo) return <span className="muted">—</span>;
  return (
    <div className="card-extras">
      {parts.map((part) => (
        <p key={part.label}>
          <span className="muted">{part.label}: </span>
          <span lang={part.lang}>{part.value}</span>
        </p>
      ))}
      {card.allowOmitTo ? <p className="muted">Можно без «to»</p> : null}
    </div>
  );
}

function CardsTable({
  collection,
  onChange,
  onReload,
}: {
  collection: SourceCollectionDetail;
  onChange: (detail: SourceCollectionDetail) => void;
  onReload: () => void;
}) {
  const [deleting, setDeleting] = useState<SourceCard | null>(null);
  const [moveError, setMoveError] = useState<unknown>(null);
  const [moving, setMoving] = useState(false);
  const [status, setStatus] = useState("");
  const pendingFocus = useRef<string | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const tableRef = useRef<HTMLTableElement>(null);
  const cards = collection.cards;

  useLayoutEffect(() => {
    const target = pendingFocus.current;
    if (!target) return;
    pendingFocus.current = null;
    if (target === "heading") {
      headingRef.current?.focus();
      return;
    }
    const [id, direction] = target.split(":");
    const button = tableRef.current?.querySelector<HTMLButtonElement>(`[data-move="${id}:${direction}"]`);
    const other = tableRef.current?.querySelector<HTMLButtonElement>(`[data-move="${id}:${direction === "up" ? "down" : "up"}"]`);
    (button && !button.disabled ? button : other)?.focus();
  });

  const move = async (index: number, delta: -1 | 1) => {
    const target = index + delta;
    if (target < 0 || target >= cards.length || moving) return;
    const reordered = [...cards];
    const [card] = reordered.splice(index, 1);
    if (!card) return;
    reordered.splice(target, 0, card);
    pendingFocus.current = `${card.id}:${delta < 0 ? "up" : "down"}`;
    setMoveError(null);
    setMoving(true);
    onChange({ ...collection, cards: reordered.map((item, position) => ({ ...item, position })) });
    try {
      const detail = await api("reorderCollectionCards", { id: collection.id, body: { cardIds: reordered.map((item) => item.id) } });
      onChange(detail);
      setStatus(`«${card.english}» теперь на месте ${target + 1} из ${reordered.length}.`);
    } catch (error) {
      setMoveError(error);
      onChange(collection);
      if (error instanceof ApiCallError && error.code === "state_changed") onReload();
    } finally {
      setMoving(false);
    }
  };

  const remove = async () => {
    if (!deleting) return;
    await api("deleteSourceCard", { id: deleting.id });
    const rest = cards.filter((card) => card.id !== deleting.id).map((card, position) => ({ ...card, position }));
    onChange({ ...collection, cards: rest, cardCount: rest.length });
    setStatus(`Карточка «${deleting.english} — ${deleting.translation}» удалена.`);
    pendingFocus.current = "heading";
    setDeleting(null);
    onReload();
  };

  return (
    <section className="section" aria-labelledby="cards-heading">
      <h2 id="cards-heading" ref={headingRef} tabIndex={-1} className="section-heading">
        Карточки <span className="muted">({cards.length})</span>
      </h2>
      <p role="status" className="sr-status">
        {status}
      </p>
      {moveError ? <ErrorState error={moveError} /> : null}
      {cards.length === 0 ? (
        <div className="empty">
          <p className="empty-title">В подборке пока нет карточек</p>
          <p>Добавьте карточки по одной или вставьте сразу много строк из Google Таблиц, Excel или файла CSV.</p>
          <div className="actions">
            <Link className="btn btn-primary" href={`/collections/${collection.id}/cards/new`}>
              Добавить карточку
            </Link>
            <Link className="btn" href={`/collections/${collection.id}/import`}>
              Вставить из таблицы
            </Link>
          </div>
        </div>
      ) : (
        <table ref={tableRef} className="data-table cards-table" role="table" aria-label="Карточки подборки">
          <thead role="rowgroup">
            <tr role="row">
              <th role="columnheader" scope="col" className="numeric">
                №
              </th>
              <th role="columnheader" scope="col">
                Слово или фраза
              </th>
              <th role="columnheader" scope="col">
                Перевод
              </th>
              <th role="columnheader" scope="col">
                Пример, пояснение, ответы
              </th>
              <th role="columnheader" scope="col">
                Действия
              </th>
            </tr>
          </thead>
          <tbody role="rowgroup">
            {cards.map((card, index) => (
              <tr role="row" key={card.id}>
                <td role="cell" data-label="№" className="numeric card-number">
                  {index + 1}
                </td>
                <td role="cell" data-label="Слово" className="data-table-main" lang="en">
                  {card.english}
                </td>
                <td role="cell" data-label="Перевод">
                  {card.translation}
                </td>
                <td role="cell" data-label="Детали" className="card-extras-cell">
                  <CardExtras card={card} />
                </td>
                <td role="cell" data-label="Действия" className="row-actions-cell">
                  <div className="row-actions">
                    <button
                      type="button"
                      className="btn btn-small btn-icon"
                      data-move={`${card.id}:up`}
                      aria-label={`Выше: ${card.english}`}
                      title="Выше"
                      disabled={index === 0}
                      onClick={() => void move(index, -1)}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className="btn btn-small btn-icon"
                      data-move={`${card.id}:down`}
                      aria-label={`Ниже: ${card.english}`}
                      title="Ниже"
                      disabled={index === cards.length - 1}
                      onClick={() => void move(index, 1)}
                    >
                      ↓
                    </button>
                    <Link
                      className="btn btn-small"
                      href={`/collections/${collection.id}/cards/${card.id}`}
                      aria-label={`Изменить: ${card.english} — ${card.translation}`}
                    >
                      Изменить
                    </Link>
                    <button
                      type="button"
                      className="btn btn-small btn-danger-outline"
                      aria-label={`Удалить: ${card.english} — ${card.translation}`}
                      onClick={() => setDeleting(card)}
                    >
                      Удалить
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {deleting ? (
        <ConfirmDialog
          title={`Удалить карточку «${deleting.english} — ${deleting.translation}»?`}
          confirmLabel="Удалить карточку"
          cancelLabel="Оставить"
          danger
          onConfirm={remove}
          onClose={() => setDeleting(null)}
        >
          <ul>
            <li>Карточка исчезнет из этой подборки.</li>
            <li>Копии, которые ученики уже получили, не изменятся: там карточку удаляют отдельно, в копии ученика.</li>
          </ul>
        </ConfirmDialog>
      ) : null}
    </section>
  );
}

function DeleteCollection({ collection }: { collection: SourceCollectionDetail }) {
  const [open, setOpen] = useState(false);
  const flash = useFlash();

  const remove = async () => {
    await api("deleteCollection", { id: collection.id });
    flash({ path: "/collections", text: `Подборка «${collection.title}» удалена.`, tone: "success" });
    navigate("/collections", { replace: true });
  };

  return (
    <section className="section" aria-labelledby="delete-heading">
      <h2 id="delete-heading">Удаление</h2>
      <button type="button" className="btn btn-danger-outline" onClick={() => setOpen(true)}>
        Удалить подборку
      </button>
      {open ? (
        <ConfirmDialog
          title={`Удалить подборку «${collection.title}»?`}
          confirmLabel="Удалить подборку"
          cancelLabel="Оставить"
          danger
          onConfirm={remove}
          onClose={() => setOpen(false)}
        >
          <ul>
            <li>Подборка исчезнет из вашего списка, выдавать её больше будет нельзя.</li>
            {collection.issuedCount > 0 ? (
              <li>
                Копии останутся у учеников ({studentsText(collection.issuedCount)}): они продолжат заниматься, прогресс сохранится.
                Забрать копию можно в карточке ученика.
              </li>
            ) : (
              <li>Подборка никому не выдана, у учеников ничего не изменится.</li>
            )}
            <li>Вернуть удалённую подборку нельзя.</li>
          </ul>
        </ConfirmDialog>
      ) : null}
    </section>
  );
}

export function CollectionScreen({ id }: { id: number }) {
  const query = useCollection(id);
  const collection = query.data;
  const [renaming, setRenaming] = useState(false);
  const renameButton = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);

  useEffect(() => {
    if (!renaming && restoreFocus.current) {
      restoreFocus.current = false;
      renameButton.current?.focus();
    }
  }, [renaming]);

  const finishRename = (detail?: SourceCollectionDetail) => {
    if (detail) query.setData(detail);
    restoreFocus.current = true;
    setRenaming(false);
  };

  return (
    <>
      <p className="breadcrumb">
        <Link href="/collections">← Все подборки</Link>
      </p>
      <PageTitle documentTitle={collection?.title ?? "Подборка"}>{collection?.title ?? "Подборка"}</PageTitle>
      {query.error ? <CollectionQueryError error={query.error} onRetry={query.reload} /> : null}
      {query.loading && !collection ? <Loading /> : null}
      {collection ? (
        <>
          <div className="card-summary">
            <span className="muted">
              {cardsText(collection.cards.length)} ·{" "}
              {collection.issuedCount > 0 ? `выдана: ${studentsText(collection.issuedCount)}` : "ещё никому не выдана"} · изменена{" "}
              {formatDateTime(collection.updatedAt)}
            </span>
            {renaming ? (
              <RenameCollection collection={collection} onDone={finishRename} />
            ) : (
              <button ref={renameButton} type="button" className="btn btn-small" onClick={() => setRenaming(true)}>
                Переименовать
              </button>
            )}
          </div>

          <div className="actions toolbar">
            <Link className="btn" href={`/collections/${collection.id}/cards/new`}>
              Добавить карточку
            </Link>
            <Link className="btn" href={`/collections/${collection.id}/import`}>
              Импорт из таблицы
            </Link>
            <Link className="btn btn-primary" href={`/collections/${collection.id}/issue`}>
              Выдать ученикам
            </Link>
            {collection.issuedCount > 0 ? (
              <Link className="btn" href={`/collections/${collection.id}/results`}>
                Результаты по подборке
              </Link>
            ) : null}
          </div>

          {collection.issuedCount > 0 ? (
            <p className="notice">
              Правки здесь не меняют копии, которые ученики уже получили. Чтобы изменить слова у конкретного ученика, откройте его
              копию в карточке ученика.
            </p>
          ) : null}

          <CardsTable collection={collection} onChange={query.setData} onReload={query.reload} />
          <DeleteCollection collection={collection} />
        </>
      ) : null}
    </>
  );
}
