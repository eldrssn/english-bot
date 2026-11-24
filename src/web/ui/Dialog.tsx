import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { errorText } from "../lib/api";

type ConfirmDialogProps = {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  /** Необратимое действие: кнопка красная. */
  danger?: boolean;
  /** Ошибка остаётся внутри диалога, чтобы её было видно и можно было повторить. */
  onConfirm: () => Promise<void>;
  onClose: () => void;
};

/**
 * Диалог подтверждения на нативном dialog: браузер сам держит фокус внутри, делает остальную страницу
 * недоступной, закрывает по Esc и возвращает фокус на кнопку, которая его открыла.
 */
export function ConfirmDialog({ title, children, confirmLabel, cancelLabel = "Отмена", danger, onConfirm, onClose }: ConfirmDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const bodyId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    dialog.showModal();
    // Первым получает фокус безопасный вариант.
    dialog.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    return () => dialog.close();
  }, []);

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
    } catch (failure) {
      setError(failure);
      setBusy(false);
    }
  };

  return (
    <dialog
      ref={ref}
      className="dialog"
      aria-labelledby={titleId}
      aria-describedby={bodyId}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <h2 id={titleId} className="dialog-title">
        {title}
      </h2>
      <div id={bodyId} className="dialog-body">
        {children}
      </div>
      {error ? (
        <p className="field-error" role="alert">
          {errorText(error)}
        </p>
      ) : null}
      <div className="actions dialog-actions">
        <button type="button" className="btn" data-autofocus onClick={onClose} disabled={busy}>
          {cancelLabel}
        </button>
        <button
          type="button"
          className={`btn ${danger ? "btn-danger" : "btn-primary"}`}
          onClick={() => void confirm()}
          disabled={busy}
          aria-busy={busy}
        >
          {confirmLabel}
        </button>
      </div>
    </dialog>
  );
}
