// Общие элементы интерфейса: заголовок страницы, состояния, поля, копирование, статус.
import {
  useEffect,
  useId,
  useRef,
  useState,
  type InputHTMLAttributes,
  type ReactNode,
  type Ref,
  type TextareaHTMLAttributes,
} from "react";
import type { StudentStatus } from "../../shared/api-contract";
import { errorText, isNotFound } from "../lib/api";
import { STATUS_LABEL } from "../lib/format";
import { Link, consumeTitleFocus } from "../lib/router";

/** Заголовок страницы: после перехода получает фокус, чтобы клавиатура и чтение с экрана начинались отсюда. */
export function PageTitle({ children, documentTitle }: { children: ReactNode; documentTitle?: string }) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    // Если страница сама поставила фокус в поле ввода, он остаётся там.
    if (consumeTitleFocus() && !(document.activeElement instanceof HTMLInputElement)) ref.current?.focus({ preventScroll: true });
  }, []);
  const text = documentTitle ?? (typeof children === "string" ? children : null);
  useEffect(() => {
    document.title = text && text !== "Кабинет преподавателя" ? `${text} · Кабинет преподавателя` : "Кабинет преподавателя";
  }, [text]);
  return (
    <h1 ref={ref} tabIndex={-1} className="page-title">
      {children}
    </h1>
  );
}

export function Loading({ label = "Загрузка…" }: { label?: string }) {
  return (
    <p className="state-line" role="status">
      <span className="spinner" aria-hidden="true" />
      {label}
    </p>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <div className="notice notice-danger" role="alert">
      <p>{errorText(error)}</p>
      {onRetry ? (
        <button type="button" className="btn" onClick={onRetry}>
          Повторить
        </button>
      ) : null}
    </div>
  );
}

/** Запись не существует, завершена или чужая: для интерфейса это одно и то же. */
export function StudentNotFound() {
  return (
    <div className="empty" role="alert">
      <p className="empty-title">Ученик не найден</p>
      <p>Такой записи нет в вашем списке: возможно, адрес неверный или ученика убрали из списка.</p>
      <Link className="btn" href="/students">
        К списку учеников
      </Link>
    </div>
  );
}

/** Объект не найден: адрес неверный, запись удалена или чужая. */
export function NotFoundBlock({ title, text, href, linkLabel }: { title: string; text: string; href: string; linkLabel: string }) {
  return (
    <div className="empty" role="alert">
      <p className="empty-title">{title}</p>
      <p>{text}</p>
      <Link className="btn" href={href}>
        {linkLabel}
      </Link>
    </div>
  );
}

export function QueryError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  return isNotFound(error) ? <StudentNotFound /> : <ErrorState error={error} onRetry={onRetry} />;
}

type TextFieldProps = InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  hint?: ReactNode;
  error?: string | null | undefined;
  inputRef?: Ref<HTMLInputElement>;
  /** Ошибка появляется по мере ввода: не объявлять её как тревогу на каждое нажатие. */
  quietError?: boolean;
};

export function TextField({ label, hint, error, inputRef, className, quietError, ...input }: TextFieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(" ") || undefined;
  return (
    <div className={`field ${className ?? ""}`}>
      <label htmlFor={id}>{label}</label>
      {hint ? (
        <p id={hintId} className="field-hint">
          {hint}
        </p>
      ) : null}
      <input
        id={id}
        ref={inputRef}
        className="input"
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        {...input}
      />
      {error ? (
        <p id={errorId} className="field-error" role={quietError ? undefined : "alert"}>
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function CopyButton({ text, label, describedBy }: { text: string; label: string; describedBy?: string }) {
  const [result, setResult] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const copy = async () => {
    window.clearTimeout(timer.current);
    try {
      await navigator.clipboard.writeText(text);
      setResult("copied");
      timer.current = window.setTimeout(() => setResult("idle"), 4000);
    } catch {
      setResult("failed");
    }
  };

  return (
    <span className="copy">
      <button type="button" className="btn btn-primary" onClick={() => void copy()} aria-describedby={describedBy}>
        {label}
      </button>
      <span className="copy-result" role="status">
        {result === "copied" ? "Скопировано" : result === "failed" ? "Не удалось скопировать. Выделите текст вручную." : ""}
      </span>
    </span>
  );
}

const STATUS_TONE: Record<StudentStatus, string> = {
  pending_connection: "badge-neutral",
  pending_confirmation: "badge-warn",
  active: "badge-success",
};

export function StatusBadge({ status }: { status: StudentStatus }) {
  return <span className={`badge ${STATUS_TONE[status]}`}>{STATUS_LABEL[status]}</span>;
}

/** Telegram-имя и username в одну строку; пока аккаунта нет, прочерк. */
export function TelegramIdentity({ name, username }: { name: string | null; username: string | null }) {
  if (!name && !username) return <span className="muted">—</span>;
  return (
    <span className="telegram-identity">
      {name ? <span>{name}</span> : null}
      {username ? <span className="muted">@{username}</span> : null}
    </span>
  );
}

/** Ошибки поля: строка или несколько. */
function FieldErrorText({ id, error }: { id: string; error: string | readonly string[] | null | undefined }) {
  const list = error === null || error === undefined ? [] : typeof error === "string" ? [error] : error;
  if (list.length === 0) return null;
  return (
    <p id={id} className="field-error">
      {list.join(" ")}
    </p>
  );
}

type TextAreaFieldProps = TextareaHTMLAttributes<HTMLTextAreaElement> & {
  label: string;
  hint?: ReactNode;
  error?: string | readonly string[] | null | undefined;
  textareaRef?: Ref<HTMLTextAreaElement>;
};

export function TextAreaField({ label, hint, error, textareaRef, className, ...textarea }: TextAreaFieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const hasError = error !== null && error !== undefined && error.length > 0;
  const describedBy = [hint ? hintId : null, hasError ? errorId : null].filter(Boolean).join(" ") || undefined;
  return (
    <div className={`field ${className ?? ""}`}>
      <label htmlFor={id}>{label}</label>
      {hint ? (
        <p id={hintId} className="field-hint">
          {hint}
        </p>
      ) : null}
      <textarea
        id={id}
        ref={textareaRef}
        className="input textarea"
        aria-invalid={hasError ? true : undefined}
        aria-describedby={describedBy}
        {...textarea}
      />
      <FieldErrorText id={errorId} error={error} />
    </div>
  );
}

type CheckboxFieldProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & {
  label: string;
  hint?: ReactNode;
  error?: string | readonly string[] | null | undefined;
};

export function CheckboxField({ label, hint, error, className, ...input }: CheckboxFieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const hasError = error !== null && error !== undefined && error.length > 0;
  const describedBy = [hint ? hintId : null, hasError ? errorId : null].filter(Boolean).join(" ") || undefined;
  return (
    <div className={`field checkbox-field ${className ?? ""}`}>
      <div className="checkbox-line">
        <input id={id} type="checkbox" className="checkbox" aria-invalid={hasError ? true : undefined} aria-describedby={describedBy} {...input} />
        <label htmlFor={id}>{label}</label>
      </div>
      {hint ? (
        <p id={hintId} className="field-hint">
          {hint}
        </p>
      ) : null}
      <FieldErrorText id={errorId} error={error} />
    </div>
  );
}
