// Форма карточки: ручное добавление и правка в исходной подборке и в копии ученика.
import { useDeferredValue, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { CardInput } from "../../shared/api-contract";
import { CARD_LIMITS } from "../../shared/card-import/index.js";
import { ApiCallError, errorDetails, errorText } from "../lib/api";
import {
  EMPTY_CARD,
  findDuplicate,
  groupErrors,
  hasErrors,
  inputFromFields,
  prepareFields,
  validateFields,
  type CardFieldName,
  type CardFields,
  type FieldErrors,
} from "../lib/cards";
import type { PreviewCard } from "../lib/bot-preview";
import { CardPreview } from "./CardPreview";
import { CheckboxField, TextAreaField, TextField } from "./kit";

const FIELD_ORDER: CardFieldName[] = ["english", "translation", "example", "explanation", "acceptedRuEn", "acceptedEnRu", "allowOmitTo"];

export type ExistingCard = { id: number; english: string; translation: string };

type CardFormProps = {
  initial?: CardFields;
  /** Карточки, среди которых ищется дубль (та же пара слово — перевод). */
  existing: readonly ExistingCard[];
  /** ID правимой карточки: с собой она не сравнивается. */
  editingId?: number;
  /** Другие карточки для предпросмотра вопросов. */
  previewPool: readonly PreviewCard[];
  previewPosition: { number: number; total: number };
  /** add: после сохранения форма очищается и фокус возвращается в первое поле. */
  mode: "add" | "edit";
  submitLabel: string;
  /** Где ищется дубль: «в подборке» или «в копии». */
  duplicatePlace: string;
  /** Сохранение. Отказ сервера показывается в форме. */
  onSubmit: (input: CardInput) => Promise<void>;
  /** Сообщение после добавления (только mode = add). */
  addedText?: (fields: CardFields) => string;
  cancel?: ReactNode;
  /** Пояснение перед кнопкой: уведомление ученику, новая версия. */
  notice?: ReactNode;
  /** Карточка не изменилась: сохранять нечего. */
  unchanged?: (fields: CardFields) => boolean;
};

export function CardForm({
  initial = EMPTY_CARD,
  existing,
  editingId,
  previewPool,
  previewPosition,
  mode,
  submitLabel,
  duplicatePlace,
  onSubmit,
  addedText,
  cancel,
  notice,
  unchanged,
}: CardFormProps) {
  const [fields, setFields] = useState<CardFields>(initial);
  const [touched, setTouched] = useState<Partial<Record<CardFieldName, boolean>>>({});
  const [submitted, setSubmitted] = useState(false);
  const [serverErrors, setServerErrors] = useState<FieldErrors>({});
  const [failure, setFailure] = useState<unknown>(null);
  const [duplicateFromServer, setDuplicateFromServer] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const formRef = useRef<HTMLFormElement>(null);

  const clientErrors = validateFields(fields);
  const duplicate = findDuplicate(fields, existing, editingId);
  const deferred = useDeferredValue(fields);
  const preview = prepareFields(deferred);

  const visible = (field: CardFieldName): string[] => {
    const own = touched[field] || submitted ? (clientErrors[field] ?? []) : [];
    return [...own, ...(serverErrors[field] ?? [])];
  };

  const duplicateText = duplicate
    ? `${duplicatePlace[0]!.toUpperCase()}${duplicatePlace.slice(1)} уже есть карточка «${duplicate.english} — ${duplicate.translation}». Измените слово или перевод: одинаковая пара не добавляется.`
    : duplicateFromServer
      ? `${duplicatePlace[0]!.toUpperCase()}${duplicatePlace.slice(1)} уже есть карточка с тем же словом и переводом.`
      : null;

  const update = <K extends CardFieldName>(field: K, value: CardFields[K]) => {
    setFields((current) => ({ ...current, [field]: value }));
    setStatus("");
    setFailure(null);
    if (field === "english" || field === "translation") setDuplicateFromServer(false);
    setServerErrors((current) => {
      if (!current[field] && !current.other) return current;
      const next = { ...current };
      delete next[field];
      delete next.other;
      return next;
    });
  };

  const touch = (field: CardFieldName) => setTouched((current) => (current[field] ? current : { ...current, [field]: true }));

  const focusField = (field: CardFieldName) => {
    formRef.current?.querySelector<HTMLElement>(`[name="${field}"]`)?.focus();
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitted(true);
    setStatus("");
    if (hasErrors(clientErrors) || duplicate) {
      const first = FIELD_ORDER.find((field) => (clientErrors[field]?.length ?? 0) > 0) ?? (duplicate ? "english" : undefined);
      if (first) focusField(first);
      return;
    }
    if (unchanged?.(fields)) {
      setStatus("Изменений нет: карточка осталась прежней.");
      return;
    }
    setBusy(true);
    setFailure(null);
    setServerErrors({});
    try {
      await onSubmit(inputFromFields(fields));
      if (mode === "add") {
        setStatus(addedText ? addedText(fields) : "Карточка добавлена.");
        setFields(EMPTY_CARD);
        setTouched({});
        setSubmitted(false);
        focusField("english");
      }
    } catch (error) {
      if (error instanceof ApiCallError && error.code === "invalid_card" && errorDetails(error).length > 0) {
        const grouped = groupErrors(errorDetails(error));
        setServerErrors(grouped);
        const first = FIELD_ORDER.find((field) => (grouped[field]?.length ?? 0) > 0);
        if (first) focusField(first);
      } else if (error instanceof ApiCallError && error.code === "duplicate_card") {
        setDuplicateFromServer(true);
        focusField("english");
      } else {
        setFailure(error);
      }
    } finally {
      setBusy(false);
    }
  };

  const commonErrors = [...(serverErrors.other ?? []), ...(submitted ? (clientErrors.other ?? []) : [])];

  return (
    <>
      <form ref={formRef} className="form panel card-form" onSubmit={(event) => void submit(event)} noValidate>
        <div className="card-form-grid">
          <TextField
            name="english"
            label="Слово или фраза по-английски"
            hint="Так ученик увидит слово. Глагол можно записать с to: «to go»."
            value={fields.english}
            onChange={(event) => update("english", event.target.value)}
            onBlur={() => touch("english")}
            error={visible("english").join(" ") || null}
            quietError
            required
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            lang="en"
            maxLength={CARD_LIMITS.english * 2}
            autoFocus={mode === "add"}
          />
          <TextField
            name="translation"
            label="Основной перевод"
            hint="Главный перевод по-русски. Другой перевод того же слова — отдельная карточка: bank — банк и bank — берег."
            value={fields.translation}
            onChange={(event) => update("translation", event.target.value)}
            onBlur={() => touch("translation")}
            error={visible("translation").join(" ") || null}
            quietError
            required
            autoComplete="off"
            maxLength={CARD_LIMITS.translation * 2}
          />
          {duplicateText ? (
            <p className="notice notice-warn card-form-wide" role={submitted || duplicateFromServer ? "alert" : undefined}>
              {duplicateText}
            </p>
          ) : null}
          <TextAreaField
            name="example"
            label="Пример (необязательно)"
            hint="Предложение со словом. Бот показывает его под переводом."
            value={fields.example}
            onChange={(event) => update("example", event.target.value)}
            onBlur={() => touch("example")}
            error={visible("example")}
            rows={2}
            lang="en"
            maxLength={CARD_LIMITS.example * 2}
          />
          <TextAreaField
            name="explanation"
            label="Пояснение (необязательно)"
            hint="Оттенок значения, управление, где употребляется. Бот показывает его после примера."
            value={fields.explanation}
            onChange={(event) => update("explanation", event.target.value)}
            onBlur={() => touch("explanation")}
            error={visible("explanation")}
            rows={2}
            maxLength={CARD_LIMITS.explanation * 2}
          />
          <TextField
            name="acceptedRuEn"
            label="Другие верные ответы по-английски (ru→en)"
            hint={
              <>
                Бот показывает перевод, ученик печатает слово по-английски: кроме основного слова засчитаются эти варианты. Через
                точку с запятой: <span lang="en">travel; journey</span>.
              </>
            }
            value={fields.acceptedRuEn}
            onChange={(event) => update("acceptedRuEn", event.target.value)}
            onBlur={() => touch("acceptedRuEn")}
            error={visible("acceptedRuEn").join(" ") || null}
            quietError
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            lang="en"
          />
          <TextField
            name="acceptedEnRu"
            label="Другие верные ответы по-русски (en→ru)"
            hint="Бот показывает английское слово, ученик печатает перевод: кроме основного перевода засчитаются эти варианты. Через точку с запятой: поездка; путешествие."
            value={fields.acceptedEnRu}
            onChange={(event) => update("acceptedEnRu", event.target.value)}
            onBlur={() => touch("acceptedEnRu")}
            error={visible("acceptedEnRu").join(" ") || null}
            quietError
            autoComplete="off"
          />
          <CheckboxField
            name="allowOmitTo"
            className="card-form-wide"
            label="Можно отвечать без «to»"
            hint="Включайте для глаголов вида «to go»: ответ «go» тоже засчитается. Для слов без «to» в начале не подходит."
            checked={fields.allowOmitTo}
            onChange={(event) => {
              update("allowOmitTo", event.target.checked);
              touch("allowOmitTo");
            }}
            error={visible("allowOmitTo")}
          />
        </div>
        {commonErrors.length > 0 ? (
          <p className="field-error" role="alert">
            {commonErrors.join(" ")}
          </p>
        ) : null}
        {failure ? (
          <p className="notice notice-danger" role="alert">
            {errorText(failure)}
          </p>
        ) : null}
        {notice}
        <div className="actions">
          <button type="submit" className="btn btn-primary" disabled={busy} aria-busy={busy}>
            {submitLabel}
          </button>
          {cancel}
        </div>
        <p role="status" className="form-status">
          {status}
        </p>
      </form>
      <CardPreview card={preview} others={previewPool} position={previewPosition} />
    </>
  );
}
