// Копия подборки у конкретного ученика: карточки с версиями, добавление, правка, удаление, «Забрать у ученика».
import { useLayoutEffect, useRef, useState } from "react";
import type { CopyCard, CopyDetail } from "../../shared/api-contract";
import { ApiCallError, api, isNotFound } from "../lib/api";
import { collectionExtendedMessage } from "../lib/bot-preview";
import { fieldsFromCard, prepareFields, type CardFields } from "../lib/cards";
import { COLLECTION_STATUS_LABEL, cardsText, formatDateTime } from "../lib/format";
import { Link, navigate } from "../lib/router";
import { useQuery } from "../lib/useQuery";
import { CardForm } from "../ui/CardForm";
import { ConfirmDialog } from "../ui/Dialog";
import { ErrorState, Loading, NotFoundBlock, PageTitle, StatusBadge } from "../ui/kit";
import { TablePaste, addedSummary } from "../ui/TablePaste";
import { CardExtras } from "./Collection";
import { useFlash } from "./Shell";

function CopyNotFound() {
  return (
    <NotFoundBlock
      title="Копия не найдена"
      text="Такой копии нет: возможно, адрес неверный, копию забрали у ученика или ученика убрали из списка."
      href="/students"
      linkLabel="К списку учеников"
    />
  );
}

function CopyQueryError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  return isNotFound(error) ? <CopyNotFound /> : <ErrorState error={error} onRetry={onRetry} />;
}

const useCopy = (id: number) => useQuery((signal) => api("getCopy", { id, signal }), `copy-${id}`);

function CopyHeader({ copy }: { copy: CopyDetail }) {
  return (
    <dl className="facts">
      <div>
        <dt>Ученик</dt>
        <dd className="inline-badges">
          <Link href={`/students/${copy.studentId}`}>{copy.studentDisplayName}</Link>
          <StatusBadge status={copy.studentStatus} />
        </dd>
      </div>
      <div>
        <dt>Статус подборки</dt>
        <dd>{copy.studentStatus === "active" ? COLLECTION_STATUS_LABEL[copy.status] : "Не подключён"}</dd>
      </div>
      <div>
        <dt>Выдана</dt>
        <dd>{formatDateTime(copy.publishedAt)}</dd>
      </div>
      <div>
        <dt>Карточек</dt>
        <dd>{copy.cards.length}</dd>
      </div>
    </dl>
  );
}

/** Что увидит ученик при добавлении карточек. */
function AddNotice({ copy, count }: { copy: CopyDetail; count: number }) {
  if (copy.studentStatus !== "active") {
    return (
      <p className="notice">
        Ученик ещё не подключён, отдельного уведомления о новых словах не будет: после подключения он получит «Новая подборка» со всеми
        карточками.
      </p>
    );
  }
  return (
    <div className="notice notice-warn">
      <p>
        Ученик сразу получит уведомление «В подборку добавлены слова» с кнопкой «Посмотреть»:
      </p>
      <blockquote className="tg-message tg-text">{collectionExtendedMessage(copy.title, count)}</blockquote>
      <p className="small">Каждое сохранение — отдельное уведомление. Чтобы ученик получил одно сообщение, добавляйте много слов одной вставкой.</p>
    </div>
  );
}

function WithdrawSection({ copy }: { copy: CopyDetail }) {
  const [open, setOpen] = useState(false);
  const flash = useFlash();
  const studentPath = `/students/${copy.studentId}`;

  const withdraw = async () => {
    await api("withdrawCopy", { id: copy.id });
    flash({ path: studentPath, text: `Подборка «${copy.title}» забрана у ученика.`, tone: "success" });
    navigate(studentPath, { replace: true });
  };

  return (
    <section className="section" aria-labelledby="withdraw-heading">
      <h2 id="withdraw-heading">Забрать у ученика</h2>
      <button type="button" className="btn btn-danger-outline" onClick={() => setOpen(true)}>
        Забрать у ученика
      </button>
      {open ? (
        <ConfirmDialog
          title={`Забрать «${copy.title}» у ученика «${copy.studentDisplayName}»?`}
          confirmLabel="Забрать у ученика"
          cancelLabel="Оставить"
          danger
          onConfirm={withdraw}
          onClose={() => setOpen(false)}
        >
          <ul>
            <li>Подборка исчезнет из бота ученика вместе со словами, которых нет в других его подборках.</li>
            <li>Начатое занятие по ней завершится, а неотправленное уведомление о ней не уйдёт.</li>
            <li>История ответов сохранится.</li>
            <li>
              Вернуть эту копию нельзя. Подборку можно выдать снова, тогда ученик получит новую копию из текущего оригинала — правки этой копии
              в неё не попадут.
            </li>
          </ul>
        </ConfirmDialog>
      ) : null}
    </section>
  );
}

function CopyCards({ copy, onChange }: { copy: CopyDetail; onChange: (copy: CopyDetail) => void }) {
  const [deleting, setDeleting] = useState<CopyCard | null>(null);
  const [status, setStatus] = useState("");
  const headingRef = useRef<HTMLHeadingElement>(null);
  const focusHeading = useRef(false);

  useLayoutEffect(() => {
    if (focusHeading.current) {
      focusHeading.current = false;
      headingRef.current?.focus();
    }
  });

  const remove = async () => {
    if (!deleting) return;
    const detail = await api("deleteCopyCard", { id: deleting.id });
    onChange(detail);
    setStatus(`Карточка «${deleting.english} — ${deleting.translation}» удалена из копии.`);
    focusHeading.current = true;
    setDeleting(null);
  };

  return (
    <section className="section" aria-labelledby="copy-cards-heading">
      <h2 id="copy-cards-heading" ref={headingRef} tabIndex={-1} className="section-heading">
        Карточки <span className="muted">({copy.cards.length})</span>
      </h2>
      <p role="status" className="sr-status">
        {status}
      </p>
      {copy.cards.length === 0 ? (
        <div className="empty">
          <p className="empty-title">В копии нет карточек</p>
          <p>Добавьте карточки: они появятся только у этого ученика.</p>
          <Link className="btn btn-primary" href={`/copies/${copy.id}/add`}>
            Добавить карточки
          </Link>
        </div>
      ) : (
        <table className="data-table cards-table" role="table" aria-label="Карточки копии">
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
                Версия
              </th>
              <th role="columnheader" scope="col">
                Действия
              </th>
            </tr>
          </thead>
          <tbody role="rowgroup">
            {copy.cards.map((card, index) => (
              <tr role="row" key={card.id}>
                <td role="cell" data-label="№" className="numeric card-number">
                  {index + 1}
                </td>
                <td role="cell" data-label="Слово" className="data-table-main">
                  <span lang="en">{card.english}</span>
                  {card.isNew ? (
                    <span className="badge badge-success badge-inline" title={`Добавлена ${formatDateTime(card.addedAt)}`}>
                      новая
                    </span>
                  ) : null}
                </td>
                <td role="cell" data-label="Перевод">
                  {card.translation}
                </td>
                <td role="cell" data-label="Детали" className="card-extras-cell">
                  <CardExtras card={card} />
                </td>
                <td role="cell" data-label="Версия">
                  <span className="nowrap">{card.versionNumber}</span>
                  {card.isNew ? <span className="muted small block">добавлена {formatDateTime(card.addedAt)}</span> : null}
                </td>
                <td role="cell" data-label="Действия" className="row-actions-cell">
                  <div className="row-actions">
                    <Link
                      className="btn btn-small"
                      href={`/copies/${copy.id}/cards/${card.id}`}
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
          title={`Удалить «${deleting.english} — ${deleting.translation}» из копии?`}
          confirmLabel="Удалить карточку"
          cancelLabel="Оставить"
          danger
          onConfirm={remove}
          onClose={() => setDeleting(null)}
        >
          <ul>
            <li>Карточка исчезнет из словаря ученика, «Сложных слов» и будущих вопросов.</li>
            <li>Если вопрос по ней уже задан, он завершится по прежней версии. История ответов сохранится.</li>
            <li>Другие ученики и исходная подборка не изменятся.</li>
          </ul>
        </ConfirmDialog>
      ) : null}
    </section>
  );
}

export function CopyScreen({ id }: { id: number }) {
  const query = useCopy(id);
  const copy = query.data;

  return (
    <>
      <p className="breadcrumb">
        {copy ? <Link href={`/students/${copy.studentId}`}>← {copy.studentDisplayName}</Link> : <Link href="/students">← Ученики</Link>}
      </p>
      <PageTitle documentTitle={copy ? `${copy.title} · ${copy.studentDisplayName}` : "Копия подборки"}>
        {copy ? copy.title : "Копия подборки"}
      </PageTitle>
      {query.error ? <CopyQueryError error={query.error} onRetry={query.reload} /> : null}
      {query.loading && !copy ? <Loading /> : null}
      {copy ? (
        <>
          <p className="muted">Личная копия ученика. Изменения здесь касаются только его: исходная подборка и копии других учеников не меняются.</p>
          <CopyHeader copy={copy} />
          {copy.studentStatus !== "active" ? (
            <p className="notice">Ученик ещё не подключён: копия ждёт его, уведомление «Новая подборка» придёт после подтверждения связи.</p>
          ) : null}
          <div className="actions toolbar">
            <Link className="btn btn-primary" href={`/copies/${copy.id}/add`}>
              Добавить карточки
            </Link>
          </div>
          <CopyCards copy={copy} onChange={query.setData} />
          <WithdrawSection copy={copy} />
        </>
      ) : null}
    </>
  );
}

export function CopyAdd({ id }: { id: number }) {
  const query = useCopy(id);
  const copy = query.data;
  const [mode, setMode] = useState<"form" | "paste">("form");
  const lastNotification = useRef<"now" | "none">("none");
  const back = `/copies/${id}`;

  return (
    <>
      <p className="breadcrumb">
        <Link href={back}>← {copy ? `${copy.title} · ${copy.studentDisplayName}` : "Копия подборки"}</Link>
      </p>
      <PageTitle documentTitle="Добавить карточки в копию">Добавить карточки в копию</PageTitle>
      {query.error ? <CopyQueryError error={query.error} onRetry={query.reload} /> : null}
      {query.loading && !copy ? <Loading /> : null}
      {copy ? (
        <>
          <p className="muted">
            Ученик «{copy.studentDisplayName}», подборка «{copy.title}», сейчас {cardsText(copy.cards.length)}. Новые карточки появятся только
            у этого ученика и будут помечены в боте как новые.
          </p>
          <div className="segmented" role="group" aria-label="Способ добавления">
            <button type="button" className="btn btn-small" aria-pressed={mode === "form"} onClick={() => setMode("form")}>
              Одна карточка
            </button>
            <button type="button" className="btn btn-small" aria-pressed={mode === "paste"} onClick={() => setMode("paste")}>
              Вставить из таблицы
            </button>
          </div>
          {mode === "form" ? (
            <CardForm
              mode="add"
              existing={copy.cards}
              previewPool={copy.cards}
              previewPosition={{ number: copy.cards.length + 1, total: copy.cards.length + 1 }}
              submitLabel="Добавить в копию"
              duplicatePlace="в копии"
              notice={<AddNotice copy={copy} count={1} />}
              onSubmit={async (input) => {
                const response = await api("addCopyCards", { id, body: { cards: [input] } });
                if (response.added === 0) throw new ApiCallError("duplicate_card", "В копии уже есть такая карточка.");
                lastNotification.current = response.notification;
                query.setData(response.copy);
              }}
              addedText={(fields) =>
                `Карточка «${fields.english.trim()} — ${fields.translation.trim()}» добавлена.` +
                (lastNotification.current === "now" ? " Ученик получит уведомление." : "")
              }
              cancel={
                <Link className="btn" href={back}>
                  Готово, к копии
                </Link>
              }
            />
          ) : (
            <TablePaste
              existing={copy.cards}
              place="в копии"
              saveLabel={(count) => `Добавить в копию: ${cardsText(count)}`}
              notice={(count) => <AddNotice copy={copy} count={count} />}
              onSave={async (_text, result) => {
                const cards = result.rows.flatMap((row) => (row.card && !row.duplicate ? [row.card] : []));
                const invalid = result.rows.filter((row) => !row.card).length;
                const duplicates = result.rows.length - invalid - cards.length;
                const response = await api("addCopyCards", { id, body: { cards } });
                query.setData(response.copy);
                return (
                  <>
                    <p>
                      {addedSummary(response.added, invalid, duplicates + response.duplicates.length)}
                      {response.notification === "now" ? " Ученик получит уведомление «В подборку добавлены слова»." : ""}
                    </p>
                    <Link className="btn btn-small" href={back}>
                      Открыть копию
                    </Link>
                  </>
                );
              }}
            />
          )}
        </>
      ) : null}
    </>
  );
}

const sameCard = (a: CardFields, b: CardFields) => JSON.stringify(prepareFields(a)) === JSON.stringify(prepareFields(b));

export function CopyCardEdit({ copyId, cardId }: { copyId: number; cardId: number }) {
  const query = useCopy(copyId);
  const copy = query.data;
  const card = copy?.cards.find((item) => item.id === cardId);
  const flash = useFlash();
  const back = `/copies/${copyId}`;

  return (
    <>
      <p className="breadcrumb">
        <Link href={back}>← {copy ? `${copy.title} · ${copy.studentDisplayName}` : "Копия подборки"}</Link>
      </p>
      <PageTitle documentTitle="Карточка в копии">{card ? `Карточка «${card.english}»` : "Карточка в копии"}</PageTitle>
      {query.error ? <CopyQueryError error={query.error} onRetry={query.reload} /> : null}
      {query.loading && !copy ? <Loading /> : null}
      {copy && !card ? (
        <NotFoundBlock title="Карточка не найдена" text="В копии нет такой карточки: возможно, её удалили." href={back} linkLabel="К копии" />
      ) : null}
      {copy && card ? (
        <>
          <p className="muted">
            Копия ученика «{copy.studentDisplayName}». Сейчас версия {card.versionNumber}.
          </p>
          <CardForm
            key={card.id}
            mode="edit"
            initial={fieldsFromCard(card)}
            editingId={card.id}
            existing={copy.cards}
            previewPool={copy.cards.filter((item) => item.id !== card.id)}
            previewPosition={{ number: copy.cards.indexOf(card) + 1, total: copy.cards.length }}
            submitLabel="Сохранить новую версию"
            duplicatePlace="в копии"
            unchanged={(fields) => sameCard(fields, fieldsFromCard(card))}
            notice={
              <div className="notice">
                <p>
                  Сохранение создаст версию {card.versionNumber + 1}. Новые вопросы пойдут по ней, а уже заданный вопрос проверится по прежней.
                </p>
                <p>Сохранённые ответы не пересчитываются, серия «5 из 5» не сбрасывается. Уведомления ученику не будет.</p>
              </div>
            }
            onSubmit={async (input) => {
              const detail = await api("editCopyCard", { id: card.id, body: input });
              const saved = detail.cards.find((item) => item.id === card.id);
              flash({
                path: back,
                text: `Карточка «${saved?.english ?? card.english}» сохранена, версия ${saved?.versionNumber ?? card.versionNumber + 1}.`,
                tone: "success",
              });
              navigate(back);
            }}
            cancel={
              <Link className="btn" href={back}>
                Отмена
              </Link>
            }
          />
        </>
      ) : null}
    </>
  );
}
