import { useId, useRef, useState, useEffect } from "react";
import type { IssuePreviewResponse, IssueResponse, SourceCollectionDetail, StudentListItem } from "../../shared/api-contract";
import { api, isNotFound } from "../lib/api";
import { ISSUE_OUTCOME_LABEL, cardsText, studentsText } from "../lib/format";
import { Link } from "../lib/router";
import { useQuery } from "../lib/useQuery";
import { ErrorState, Loading, PageTitle, StatusBadge } from "../ui/kit";
import { CollectionQueryError } from "./Collection";

type Data = { collection: SourceCollectionDetail; students: StudentListItem[] };

const OUTCOME_TONE = { now: "badge-success", after_connection: "badge-warn", already_issued: "badge-neutral" } as const;

const STALE_SELECTION = "Кого-то из выбранных учеников уже нет в вашем списке. Список обновлён, проверьте выбор.";

export function IssueScreen({ collectionId }: { collectionId: number }) {
  const query = useQuery(
    async (signal): Promise<Data> => {
      const [collection, list] = await Promise.all([
        api("getCollection", { id: collectionId, signal }),
        api("listStudents", { signal }),
      ]);
      return { collection, students: list.students };
    },
    `issue-${collectionId}`,
  );
  const data = query.data;
  const back = `/collections/${collectionId}`;
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [preview, setPreview] = useState<IssuePreviewResponse | null>(null);
  const [done, setDone] = useState<IssueResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const [failureText, setFailureText] = useState<string | null>(null);
  const stepRef = useRef<HTMLHeadingElement>(null);
  const ids = useId();

  useEffect(() => {
    stepRef.current?.focus();
  }, [preview, done]);

  // Учеников могли убрать из списка: выбор не должен ссылаться на исчезнувшие записи.
  useEffect(() => {
    if (!data) return;
    setSelected((current) => {
      const alive = new Set(data.students.map((student) => student.id));
      const next = new Set([...current].filter((id) => alive.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [data]);

  const handleFailure = (error: unknown) => {
    if (isNotFound(error) && data) {
      setFailure(null);
      setFailureText(STALE_SELECTION);
      setPreview(null);
      query.reload();
    } else {
      setFailureText(null);
      setFailure(error);
    }
  };

  const toggle = (id: number) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const runPreview = async () => {
    setBusy(true);
    setFailure(null);
    setFailureText(null);
    try {
      setPreview(await api("issuePreview", { id: collectionId, body: { studentIds: [...selected] } }));
    } catch (error) {
      handleFailure(error);
    } finally {
      setBusy(false);
    }
  };

  const issue = async () => {
    if (!preview) return;
    setBusy(true);
    setFailure(null);
    setFailureText(null);
    try {
      setDone(await api("issueCollection", { id: collectionId, body: { studentIds: preview.recipients.map((item) => item.studentId) } }));
      setPreview(null);
      setSelected(new Set());
      query.reload();
    } catch (error) {
      handleFailure(error);
    } finally {
      setBusy(false);
    }
  };

  const errors = (
    <>
      {failureText ? (
        <p className="notice notice-danger" role="alert">
          {failureText}
        </p>
      ) : null}
      {failure ? <ErrorState error={failure} /> : null}
    </>
  );

  const renderSelection = (collection: SourceCollectionDetail, students: StudentListItem[]) => {
    if (students.length === 0) {
      return (
        <div className="empty">
          <p className="empty-title">Выдавать пока некому</p>
          <p>Сначала добавьте ученика: подборку можно выдать и до того, как он подключится.</p>
          <Link className="btn btn-primary" href="/students/new">
            Добавить ученика
          </Link>
        </div>
      );
    }
    const allSelected = selected.size === students.length;
    return (
      <form
        className="form panel"
        onSubmit={(event) => {
          event.preventDefault();
          if (selected.size > 0) void runPreview();
        }}
      >
        <fieldset className="fieldset">
          <legend>
            <h2 ref={stepRef} tabIndex={-1} className="section-heading">
              Шаг 1. Кому выдать
            </h2>
          </legend>
          <p className="field-hint" id={`${ids}-hint`}>
            Каждый получит свою копию: дальше её можно менять отдельно, не затрагивая других. Не подключённые получат подборку после
            подтверждения связи.
          </p>
          <button
            type="button"
            className="btn btn-small select-all"
            onClick={() => setSelected(allSelected ? new Set() : new Set(students.map((student) => student.id)))}
          >
            {allSelected ? "Снять выбор" : "Выбрать всех"}
          </button>
          <ul className="choice-list">
            {students.map((student) => (
              <li key={student.id}>
                <label className="choice">
                  <input
                    type="checkbox"
                    className="checkbox"
                    checked={selected.has(student.id)}
                    onChange={() => toggle(student.id)}
                    aria-describedby={`${ids}-status-${student.id}`}
                  />
                  <span className="choice-name">{student.displayName}</span>
                  <span id={`${ids}-status-${student.id}`}>
                    <StatusBadge status={student.status} />
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </fieldset>
        {errors}
        <div className="actions">
          <button type="submit" className="btn btn-primary" disabled={selected.size === 0 || busy || collection.cards.length === 0} aria-busy={busy}>
            {selected.size === 0 ? "Выберите учеников" : `Проверить, что получат: ${studentsText(selected.size)}`}
          </button>
          <Link className="btn" href={back}>
            Отмена
          </Link>
        </div>
      </form>
    );
  };

  const renderPreview = (current: IssuePreviewResponse) => {
    const toIssue = current.recipients.filter((item) => item.outcome !== "already_issued").length;
    return (
      <section className="section panel" aria-labelledby={`${ids}-preview`}>
        <h2 id={`${ids}-preview`} ref={stepRef} tabIndex={-1} className="section-heading">
          Шаг 2. Проверьте, кто и что получит
        </h2>
        <ul className="recipient-list">
          {current.recipients.map((item) => (
            <li key={item.studentId} className="recipient">
              <div className="recipient-head">
                <span className="strong">{item.displayName}</span>
                <span className={`badge ${OUTCOME_TONE[item.outcome]}`}>{ISSUE_OUTCOME_LABEL[item.outcome].preview}</span>
              </div>
              {item.message ? (
                <figure className="message-preview">
                  <figcaption className="muted small">
                    {item.outcome === "now" ? "Сообщение в Telegram сразу после выдачи:" : "Сообщение в Telegram после подключения:"}
                  </figcaption>
                  <blockquote className="tg-message tg-text">{item.message}</blockquote>
                  <p className="muted small">Под сообщением кнопка «Посмотреть».</p>
                </figure>
              ) : (
                <p className="muted small">Копия этой подборки у ученика уже есть. Добавить слова можно в его копии.</p>
              )}
            </li>
          ))}
        </ul>
        {errors}
        <div className="actions">
          <button type="button" className="btn btn-primary" onClick={() => void issue()} disabled={busy || toIssue === 0} aria-busy={busy}>
            {toIssue === 0 ? "Выдавать некому" : `Выдать: ${studentsText(toIssue)}`}
          </button>
          <button type="button" className="btn" onClick={() => setPreview(null)} disabled={busy}>
            Изменить выбор
          </button>
        </div>
      </section>
    );
  };

  const renderDone = (result: IssueResponse) => (
    <section className="section panel" aria-labelledby={`${ids}-done`}>
      <h2 id={`${ids}-done`} ref={stepRef} tabIndex={-1} className="section-heading">
        Готово
      </h2>
      <ul className="recipient-list">
        {result.results.map((item) => (
          <li key={item.studentId} className="recipient">
            <div className="recipient-head">
              <span className="strong">{item.displayName}</span>
              <span className={`badge ${OUTCOME_TONE[item.outcome]}`}>{ISSUE_OUTCOME_LABEL[item.outcome].done}</span>
              <Link href={`/copies/${item.copyId}`} aria-label={`Копия ученика ${item.displayName}`}>
                Открыть копию
              </Link>
            </div>
          </li>
        ))}
      </ul>
      <div className="actions">
        <Link className="btn" href={back}>
          К подборке
        </Link>
        <button type="button" className="btn" onClick={() => setDone(null)}>
          Выдать ещё кому-то
        </button>
      </div>
    </section>
  );

  return (
    <>
      <p className="breadcrumb">
        <Link href={back}>← {data?.collection.title ?? "Подборка"}</Link>
      </p>
      <PageTitle documentTitle="Выдача подборки">{data ? `Выдать «${data.collection.title}»` : "Выдача подборки"}</PageTitle>
      {query.error ? <CollectionQueryError error={query.error} onRetry={query.reload} /> : null}
      {query.loading && !data ? <Loading /> : null}
      {data ? (
        <>
          <p className="muted">
            В подборке {cardsText(data.collection.cards.length)}. Перед выдачей вы увидите, какое сообщение получит каждый ученик.
          </p>
          {data.collection.cards.length === 0 ? (
            <p className="notice notice-warn">
              В подборке нет карточек, выдавать пока нечего. <Link href={`/collections/${collectionId}/cards/new`}>Добавьте карточки</Link>.
            </p>
          ) : null}
          {done ? renderDone(done) : preview ? renderPreview(preview) : renderSelection(data.collection, data.students)}
        </>
      ) : null}
    </>
  );
}
