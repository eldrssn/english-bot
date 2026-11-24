import { useId, useState } from "react";
import type { InvitationResponse, StudentDetail } from "../../shared/api-contract";
import { ApiCallError, api } from "../lib/api";
import { OUTCOME_LABEL, formatDateTime } from "../lib/format";
import { ConfirmDialog } from "../ui/Dialog";
import { CopyButton, ErrorState } from "../ui/kit";

type LinkSectionProps = {
  studentId: number;
  invitation: StudentDetail["invitation"];
  /** Адрес, только что полученный при создании ученика. */
  initialFresh?: InvitationResponse;
  /** detail есть, когда сервер вернул новую карточку; иначе родитель перечитывает её сам. */
  onChange: (detail?: StudentDetail) => void;
};

/**
 * Ссылка для записи «Ожидает подключения». Адрес живёт только в состоянии этого компонента:
 * сервер хранит хэш, поэтому после ухода со страницы показать его снова нельзя.
 */
export function LinkSection({ studentId, invitation, initialFresh, onChange }: LinkSectionProps) {
  const [fresh, setFresh] = useState<InvitationResponse | null>(initialFresh ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [confirmingRevoke, setConfirmingRevoke] = useState(false);
  const warningId = useId();

  const issue = async () => {
    setBusy(true);
    setError(null);
    try {
      setFresh(await api("issueInvitation", { id: studentId }));
      onChange();
    } catch (failure) {
      setError(failure);
      // Например, ученик успел подтвердить ссылку: экран должен показать новое состояние.
      if (failure instanceof ApiCallError && failure.code === "link_not_pending") onChange();
    } finally {
      setBusy(false);
    }
  };

  const revoke = async () => {
    try {
      const detail = await api("revokeInvitation", { id: studentId });
      setFresh(null);
      setConfirmingRevoke(false);
      onChange(detail);
    } catch (failure) {
      if (failure instanceof ApiCallError && (failure.code === "no_live_invitation" || failure.code === "link_not_pending")) {
        setConfirmingRevoke(false);
        setFresh(null);
        setError(failure);
        onChange();
        return;
      }
      throw failure;
    }
  };

  const hasLiveLink = fresh !== null || invitation.live;

  return (
    <section className="section panel" aria-labelledby="link-heading">
      <h2 id="link-heading">Ссылка для ученика</h2>

      {fresh ? (
        <>
          <p className="link-value" data-testid="invite-url">
            {fresh.url}
          </p>
          <CopyButton text={fresh.url} label="Скопировать ссылку" describedBy={warningId} />
          <p>
            Действует до <strong>{formatDateTime(fresh.expiresAt)}</strong>. Отправьте её ученику там, где вы обычно общаетесь. Имени
            ученика в ссылке нет.
          </p>
          <p id={warningId} className="notice notice-warn">
            Скопируйте ссылку сейчас. После ухода с этой страницы показать её снова нельзя, можно только выдать новую.
          </p>
        </>
      ) : invitation.live && invitation.expiresAt ? (
        <p>
          Ссылка выдана и действует до <strong>{formatDateTime(invitation.expiresAt)}</strong>. Показать её снова нельзя: сервер хранит
          только зашифрованный отпечаток. Если ссылка потерялась, выдайте новую.
        </p>
      ) : (
        <p>
          {invitation.lastOutcome ? `${OUTCOME_LABEL[invitation.lastOutcome]} ` : null}
          Действующей ссылки нет. Чтобы подключить ученика, выдайте новую.
        </p>
      )}

      {error ? <ErrorState error={error} /> : null}

      <div className="actions">
        <button
          type="button"
          className={hasLiveLink ? "btn" : "btn btn-primary"}
          onClick={() => void issue()}
          disabled={busy}
          aria-busy={busy}
        >
          Выдать новую ссылку
        </button>
        {hasLiveLink ? (
          <button type="button" className="btn" onClick={() => setConfirmingRevoke(true)} disabled={busy}>
            Отменить ссылку
          </button>
        ) : null}
      </div>
      {hasLiveLink ? <p className="field-hint">Прежняя ссылка перестанет работать, как только вы выдадите новую.</p> : null}

      {confirmingRevoke ? (
        <ConfirmDialog
          title="Отменить ссылку?"
          confirmLabel="Отменить ссылку"
          cancelLabel="Не отменять"
          danger
          onConfirm={revoke}
          onClose={() => setConfirmingRevoke(false)}
        >
          <p>Ученик больше не сможет подключиться по этой ссылке. Запись останется в списке, новую ссылку можно выдать в любой момент.</p>
        </ConfirmDialog>
      ) : null}
    </section>
  );
}
