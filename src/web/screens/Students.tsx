import { useState, type FormEvent } from "react";
import { createStudentBody, type StudentDetail, type InvitationResponse, type StudentListItem } from "../../shared/api-contract";
import { ApiCallError, api, errorText } from "../lib/api";
import { PENDING_ACTION_LABEL, formatDateTime } from "../lib/format";
import { Link } from "../lib/router";
import { useQuery } from "../lib/useQuery";
import { ErrorState, Loading, PageTitle, StatusBadge, TelegramIdentity, TextField } from "../ui/kit";
import { LinkSection } from "./LinkSection";

function PendingActionCell({ student }: { student: StudentListItem }) {
  const action = student.pendingAction;
  if (action === null) return <span className="muted">Нет</span>;
  if (action === "wait_for_student") return <span className="muted">{PENDING_ACTION_LABEL[action]}</span>;
  const href = action === "confirm_request" ? `/students/${student.id}/request` : `/students/${student.id}`;
  return (
    <Link className="strong" href={href} aria-label={`${PENDING_ACTION_LABEL[action]}: ${student.displayName}`}>
      {PENDING_ACTION_LABEL[action]}
    </Link>
  );
}

export function Students() {
  const query = useQuery((signal) => api("listStudents", { signal }), "students");
  const students = query.data?.students;

  return (
    <>
      <div className="page-head">
        <PageTitle>Ученики</PageTitle>
        {students && students.length > 0 ? (
          <Link className="btn btn-primary" href="/students/new">
            Добавить ученика
          </Link>
        ) : null}
      </div>
      {query.error ? <ErrorState error={query.error} onRetry={query.reload} /> : null}
      {query.loading && !students ? <Loading /> : null}
      {students?.length === 0 ? (
        <div className="empty">
          <p className="empty-title">В списке пока никого нет</p>
          <p>
            Первый шаг: создайте запись ученика. Кабинет выдаст личную ссылку в бот, вы отправите её ученику, а затем подтвердите
            подключение кодом.
          </p>
          <Link className="btn btn-primary" href="/students/new">
            Добавить первого ученика
          </Link>
        </div>
      ) : null}
      {students && students.length > 0 ? (
        // Роли заданы явно: на телефоне строки перестраиваются в карточки, и браузер иначе потерял бы смысл таблицы.
        <table className="students" role="table" aria-label="Ученики">
          <thead role="rowgroup">
            <tr role="row">
              <th role="columnheader" scope="col">Ученик</th>
              <th role="columnheader" scope="col">Telegram</th>
              <th role="columnheader" scope="col">Статус</th>
              <th role="columnheader" scope="col">Активность</th>
              <th role="columnheader" scope="col">Что нужно сделать</th>
            </tr>
          </thead>
          <tbody role="rowgroup">
            {students.map((student) => (
              <tr role="row" key={student.id}>
                <td role="cell" data-label="Ученик" className="students-name">
                  <Link href={`/students/${student.id}`}>{student.displayName}</Link>
                </td>
                <td role="cell" data-label="Telegram">
                  <TelegramIdentity name={student.telegramName} username={student.telegramUsername} />
                </td>
                <td role="cell" data-label="Статус">
                  <StatusBadge status={student.status} />
                </td>
                <td role="cell" data-label="Активность">
                  {student.lastActivityAt ? formatDateTime(student.lastActivityAt) : <span className="muted">Пока нет</span>}
                </td>
                <td role="cell" data-label="Что нужно сделать">
                  <PendingActionCell student={student} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </>
  );
}

export function StudentNew() {
  const [name, setName] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [created, setCreated] = useState<{ student: StudentDetail; invitation: InvitationResponse } | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const parsed = createStudentBody.safeParse({ displayName: name });
    if (!parsed.success) {
      setFieldError(name.trim() === "" ? "Введите имя ученика." : "Имя должно быть не длиннее 100 символов.");
      return;
    }
    setFieldError(null);
    setError(null);
    setBusy(true);
    try {
      setCreated(await api("createStudent", { body: parsed.data }));
    } catch (failure) {
      if (failure instanceof ApiCallError && failure.code === "bad_request") setFieldError(errorText(failure));
      else setError(failure);
    } finally {
      setBusy(false);
    }
  };

  if (created) {
    const { student, invitation } = created;
    return (
      <>
        <PageTitle documentTitle="Ссылка для ученика">Ученик «{student.displayName}» создан</PageTitle>
        <LinkSection
          key={student.id}
          studentId={student.id}
          invitation={student.invitation}
          initialFresh={invitation}
          onChange={(detail) => {
            if (detail) setCreated({ student: detail, invitation });
          }}
        />
        <div className="actions">
          <Link className="btn" href={`/students/${student.id}`}>
            Открыть карточку ученика
          </Link>
          <Link className="btn" href="/students">
            К списку учеников
          </Link>
        </div>
      </>
    );
  }

  return (
    <>
      <PageTitle>Новый ученик</PageTitle>
      <form className="form panel" onSubmit={(event) => void submit(event)} noValidate>
        <TextField
          label="Имя ученика"
          hint="Это имя видите только вы. Ученику оно не показывается, и в ссылку не попадает."
          value={name}
          onChange={(event) => setName(event.target.value)}
          error={fieldError}
          maxLength={100}
          autoComplete="off"
          required
          autoFocus
        />
        {error ? <ErrorState error={error} /> : null}
        <div className="actions">
          <button type="submit" className="btn btn-primary" disabled={busy} aria-busy={busy}>
            Создать и получить ссылку
          </button>
          <Link className="btn" href="/students">
            Отмена
          </Link>
        </div>
      </form>
    </>
  );
}
