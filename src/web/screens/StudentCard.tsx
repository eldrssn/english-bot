import { useEffect, useRef, useState, type FormEvent } from "react";
import { renameStudentBody, type StudentDetail } from "../../shared/api-contract";
import { api } from "../lib/api";
import { COLLECTION_STATUS_LABEL, formatDateTime, wordsText } from "../lib/format";
import { Link, navigate } from "../lib/router";
import { useQuery } from "../lib/useQuery";
import { ConfirmDialog } from "../ui/Dialog";
import { ErrorState, Loading, PageTitle, QueryError, StatusBadge, TelegramIdentity, TextField } from "../ui/kit";
import { LinkSection } from "./LinkSection";
import { useFlash } from "./Shell";
import { resultsCsvUrl } from "./StudentResults";

function RenameForm({ student, onDone }: { student: StudentDetail; onDone: (detail?: StudentDetail) => void }) {
  const [name, setName] = useState(student.displayName);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const parsed = renameStudentBody.safeParse({ displayName: name });
    if (!parsed.success) {
      setFieldError(name.trim() === "" ? "Введите имя ученика." : "Имя должно быть не длиннее 100 символов.");
      return;
    }
    setFieldError(null);
    setError(null);
    setBusy(true);
    try {
      onDone(await api("renameStudent", { id: student.id, body: parsed.data }));
    } catch (failure) {
      setError(failure);
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
        label="Новое имя"
        hint="Привязка и история ученика не изменятся."
        value={name}
        onChange={(event) => setName(event.target.value)}
        error={fieldError}
        maxLength={100}
        autoComplete="off"
        autoFocus
      />
      {error ? <ErrorState error={error} /> : null}
      <div className="actions">
        <button type="submit" className="btn btn-primary" disabled={busy} aria-busy={busy}>
          Сохранить имя
        </button>
        <button type="button" className="btn" onClick={() => onDone()} disabled={busy}>
          Отмена
        </button>
      </div>
    </form>
  );
}

function UnlinkSection({ student }: { student: StudentDetail }) {
  const [open, setOpen] = useState(false);
  const flash = useFlash();

  if (student.status === "pending_confirmation") {
    return (
      <section className="section" aria-labelledby="unlink-heading">
        <h2 id="unlink-heading">Убрать из моих учеников</h2>
        <p className="muted">
          Сейчас убрать нельзя: сначала подтвердите или отклоните <Link href={`/students/${student.id}/request`}>заявку</Link>.
        </p>
      </section>
    );
  }

  const unlink = async () => {
    await api("unlinkStudent", { id: student.id });
    flash({ path: "/students", text: `«${student.displayName}» больше нет в вашем списке.`, tone: "success" });
    navigate("/students", { replace: true });
  };

  return (
    <section className="section" aria-labelledby="unlink-heading">
      <h2 id="unlink-heading">Убрать из списка</h2>
      <button type="button" className="btn btn-danger-outline" onClick={() => setOpen(true)}>
        Убрать из моих учеников
      </button>
      {open ? (
        <ConfirmDialog
          title={`Убрать «${student.displayName}» из моих учеников?`}
          confirmLabel="Убрать из моих учеников"
          cancelLabel="Оставить"
          danger
          onConfirm={unlink}
          onClose={() => setOpen(false)}
        >
          {student.status === "active" ? (
            <ul>
              <li>Ваш доступ к занятиям и результатам этого ученика прекратится.</li>
              <li>Ученик сохранит прогресс и свои копии подборок и сможет заниматься по ним.</li>
              <li>Новых материалов от вас он не получит. Бот сообщит ему, что вы больше не ведёте занятия.</li>
              <li>Подключить его снова можно только по новой ссылке, и вы увидите только то, что появится после этого.</li>
            </ul>
          ) : (
            <ul>
              <li>Ученик ещё не подключён, данных по нему нет.</li>
              <li>Запись исчезнет из списка, а действующая ссылка перестанет работать.</li>
            </ul>
          )}
        </ConfirmDialog>
      ) : null}
    </section>
  );
}

function RequestSummary({ student }: { student: StudentDetail }) {
  return (
    <section className="section panel panel-attention" aria-labelledby="request-heading">
      <h2 id="request-heading">Заявка ждёт проверки</h2>
      <p>
        Кто-то открыл ссылку и подтвердил вход. Получите у ученика код и подтвердите заявку или отклоните её, если это не ваш ученик.
      </p>
      <Link className="btn btn-primary" href={`/students/${student.id}/request`}>
        Проверить заявку
      </Link>
    </section>
  );
}

export function StudentCard({ id }: { id: number }) {
  const query = useQuery((signal) => api("getStudent", { id, signal }), `student-${id}`);
  const student = query.data;
  const [renaming, setRenaming] = useState(false);
  const renameButton = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);

  useEffect(() => {
    if (!renaming && restoreFocus.current) {
      restoreFocus.current = false;
      renameButton.current?.focus();
    }
  }, [renaming]);

  const finishRename = (detail?: StudentDetail) => {
    if (detail) query.setData(detail);
    restoreFocus.current = true;
    setRenaming(false);
  };

  return (
    <>
      <p className="breadcrumb">
        <Link href="/students">← Все ученики</Link>
      </p>
      <PageTitle documentTitle={student?.displayName ?? "Карточка ученика"}>{student?.displayName ?? "Карточка ученика"}</PageTitle>
      {query.error ? <QueryError error={query.error} onRetry={query.reload} /> : null}
      {query.loading && !student ? <Loading /> : null}
      {student ? (
        <>
          <div className="card-summary">
            <StatusBadge status={student.status} />
            {renaming ? (
              <RenameForm student={student} onDone={finishRename} />
            ) : (
              <button ref={renameButton} type="button" className="btn btn-small" onClick={() => setRenaming(true)}>
                Изменить имя
              </button>
            )}
          </div>

          <dl className="facts">
            <div>
              <dt>Telegram</dt>
              <dd>
                <TelegramIdentity name={student.telegramName} username={student.telegramUsername} />
              </dd>
            </div>
            <div>
              <dt>Дата подключения</dt>
              <dd>{student.startedAt ? formatDateTime(student.startedAt) : <span className="muted">Ещё нет</span>}</dd>
            </div>
            <div>
              <dt>Последняя активность</dt>
              <dd>{student.lastActivityAt ? formatDateTime(student.lastActivityAt) : <span className="muted">Пока нет</span>}</dd>
            </div>
          </dl>

          {student.status === "pending_connection" ? (
            <LinkSection
              studentId={student.id}
              invitation={student.invitation}
              onChange={(detail) => (detail ? query.setData(detail) : query.reload())}
            />
          ) : null}
          {student.status === "pending_confirmation" ? <RequestSummary student={student} /> : null}

          <section className="section" aria-labelledby="collections-heading">
            <h2 id="collections-heading">Выданные подборки</h2>
            {student.collections.length > 0 ? (
              <p className="muted small">У ученика личные копии: откройте подборку, чтобы добавить, исправить или забрать слова.</p>
            ) : null}
            {student.collections.length === 0 ? (
              <p className="muted">
                Подборки этому ученику пока не выданы. Выдать подборку можно в разделе <Link href="/collections">«Подборки»</Link>.
              </p>
            ) : (
              <ul className="collection-list">
                {student.collections.map((collection) => (
                  <li key={collection.id} className="collection-row">
                    <Link className="strong" href={`/copies/${collection.id}`}>
                      {collection.title}
                    </Link>
                    <span className="muted small">
                      {wordsText(collection.wordCount)}, выдана {formatDateTime(collection.publishedAt)}
                    </span>
                    <span className="badge badge-neutral">{COLLECTION_STATUS_LABEL[collection.status]}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="section" aria-labelledby="results-heading">
            <h2 id="results-heading">Результаты</h2>
            <p className="muted">
              {student.status === "active"
                ? "Занятия, ответы с первой попытки и после повтора, сложные и освоенные слова, квесты и экзамены — только за время текущей связи."
                : "Ученик ещё не подключён: результаты появятся, когда он начнёт заниматься."}
            </p>
            <div className="actions">
              <Link className="btn btn-primary" href={`/students/${student.id}/results`}>
                Открыть результаты
              </Link>
              <a className="btn" href={resultsCsvUrl(student.id)} download>
                Скачать CSV
              </a>
            </div>
          </section>

          <UnlinkSection student={student} />
        </>
      ) : null}
    </>
  );
}
