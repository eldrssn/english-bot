import { useEffect, useRef, useState, type FormEvent } from "react";
import { approveRequestBody, type JoinRequest } from "../../shared/api-contract";
import { ApiCallError, api, errorText } from "../lib/api";
import { attemptsText, formatDateTime } from "../lib/format";
import { Link, navigate } from "../lib/router";
import { useQuery } from "../lib/useQuery";
import { ConfirmDialog } from "../ui/Dialog";
import { Loading, PageTitle, QueryError, TextField } from "../ui/kit";
import { useFlash } from "./Shell";

const INACTIVE_TEXT =
  "Код больше не действует: истекли 24 часа или закончились 5 попыток. Попросите ученика запросить новый код в боте, затем нажмите «Обновить».";

function RequestForm({ id, request, displayName, onChanged }: { id: number; request: JoinRequest; displayName: string; onChanged: () => void }) {
  const [code, setCode] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmingReject, setConfirmingReject] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const flash = useFlash();
  const inactive = request.codeState === "inactive";

  // После ошибки код выделен: следующий ввод заменяет его.
  const [focusRequests, setFocusRequests] = useState(0);
  const focusCode = () => setFocusRequests((count) => count + 1);
  useEffect(() => {
    if (focusRequests === 0) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusRequests]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (inactive) return;
    const parsed = approveRequestBody.safeParse({ code: code.replace(/\s/g, "") });
    if (!parsed.success) {
      setFieldError("Введите код из 6 цифр. Попытка не засчитана.");
      focusCode();
      return;
    }
    setFieldError(null);
    setBusy(true);
    try {
      await api("approveRequest", { id, body: parsed.data });
      flash({ path: `/students/${id}`, text: `Заявка подтверждена: «${displayName}» подключён. Бот сообщит об этом ученику.`, tone: "success" });
      navigate(`/students/${id}`, { replace: true });
    } catch (failure) {
      setBusy(false);
      if (failure instanceof ApiCallError && failure.code === "wrong_code") {
        setFieldError(`Неверный код. ${attemptsText(failure.extra.attemptsLeft ?? 0)}.`);
        onChanged();
        focusCode();
        return;
      }
      if (failure instanceof ApiCallError && failure.code === "code_inactive") {
        setFieldError(null);
        setCode("");
        onChanged();
        return;
      }
      setFieldError(errorText(failure));
      if (failure instanceof ApiCallError && (failure.code === "no_request" || failure.code === "state_changed")) onChanged();
      focusCode();
    }
  };

  const reject = async () => {
    await api("rejectRequest", { id });
    flash({ path: `/students/${id}`, text: "Заявка отклонена. Если это ваш ученик, выдайте ему новую ссылку.", tone: "success" });
    navigate(`/students/${id}`, { replace: true });
  };

  return (
    <>
      <section className="section panel" aria-labelledby="applicant-heading">
        <h2 id="applicant-heading">Кто подал заявку</h2>
        <dl className="facts">
          <div>
            <dt>Имя из Telegram</dt>
            <dd data-testid="request-name">{request.telegramName ?? <span className="muted">Не указано</span>}</dd>
          </div>
          <div>
            <dt>Username</dt>
            <dd data-testid="request-username">
              {request.telegramUsername ? `@${request.telegramUsername}` : <span className="muted">Не указан</span>}
            </dd>
          </div>
          <div>
            <dt>Заявка отправлена</dt>
            <dd>{formatDateTime(request.requestedAt)}</dd>
          </div>
          <div>
            <dt>Заявка действует до</dt>
            <dd>{formatDateTime(request.expiresAt)}</dd>
          </div>
        </dl>
        <p className="notice notice-warn">
          Имя и username не доказывают личность: их может указать кто угодно. Подтверждайте заявку только с верным кодом.
        </p>
      </section>

      <section className="section panel" aria-labelledby="code-heading">
        <h2 id="code-heading">Код от ученика</h2>
        {inactive ? (
          <div className="notice notice-danger" role="alert">
            <p>{INACTIVE_TEXT}</p>
            <button type="button" className="btn" onClick={onChanged}>
              Обновить
            </button>
          </div>
        ) : null}
        <form className="form" onSubmit={(event) => void submit(event)} noValidate>
          <TextField
            label="Код из 6 цифр"
            hint="Бот показал код ученику. Получите его у ученика в привычном канале: лично или там, где вы уже переписываетесь."
            value={code}
            onChange={(event) => setCode(event.target.value)}
            error={fieldError}
            inputRef={inputRef}
            inputMode="numeric"
            autoComplete="off"
            maxLength={7}
            className="code-field"
            disabled={inactive}
            readOnly={busy}
          />
          {!inactive && !fieldError ? (
            <p className="muted small" data-testid="attempts-left">
              {attemptsText(request.attemptsLeft)}
            </p>
          ) : null}
          <div className="actions">
            <button type="submit" className="btn btn-primary" disabled={inactive || busy} aria-busy={busy}>
              Подтвердить заявку
            </button>
            <button type="button" className="btn btn-danger-outline" onClick={() => setConfirmingReject(true)} disabled={busy}>
              Отклонить заявку
            </button>
          </div>
        </form>
      </section>

      {confirmingReject ? (
        <ConfirmDialog
          title="Отклонить заявку?"
          confirmLabel="Отклонить заявку"
          cancelLabel="Не отклонять"
          danger
          onConfirm={reject}
          onClose={() => setConfirmingReject(false)}
        >
          <p>Этот аккаунт не получит доступ к материалам, а ссылка перестанет работать. Запись останется в списке: если это ваш ученик, выдайте новую ссылку.</p>
        </ConfirmDialog>
      ) : null}
    </>
  );
}

export function RequestScreen({ id }: { id: number }) {
  const query = useQuery((signal) => api("getStudent", { id, signal }), `request-${id}`);
  const student = query.data;

  return (
    <>
      <p className="breadcrumb">
        <Link href={`/students/${id}`}>← Карточка ученика</Link>
      </p>
      <PageTitle documentTitle="Заявка ученика">{student ? `Заявка: ${student.displayName}` : "Заявка ученика"}</PageTitle>
      {query.error ? <QueryError error={query.error} onRetry={query.reload} /> : null}
      {query.loading && !student ? <Loading /> : null}
      {student && student.request ? (
        <RequestForm id={id} request={student.request} displayName={student.displayName} onChanged={query.reload} />
      ) : null}
      {student && !student.request ? (
        <div className="empty">
          <p className="empty-title">Заявки нет</p>
          <p>Заявка уже обработана, отменена учеником или её срок истёк.</p>
          <Link className="btn" href={`/students/${id}`}>
            К карточке ученика
          </Link>
        </div>
      ) : null}
    </>
  );
}
