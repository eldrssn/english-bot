import { useState, type FormEvent } from "react";
import { collectionTitleBody } from "../../shared/api-contract";
import { ApiCallError, api, errorText } from "../lib/api";
import { formatDateTime } from "../lib/format";
import { Link, navigate } from "../lib/router";
import { useQuery } from "../lib/useQuery";
import { ErrorState, Loading, PageTitle, TextField } from "../ui/kit";
import { useFlash } from "./Shell";

export const TITLE_MAX = 200;

export function titleError(title: string): string | null {
  if (collectionTitleBody.safeParse({ title }).success) return null;
  return title.trim() === "" ? "Введите название подборки." : `Название должно быть не длиннее ${TITLE_MAX} символов.`;
}

export function Collections() {
  const query = useQuery((signal) => api("listCollections", { signal }), "collections");
  const collections = query.data?.collections;

  return (
    <>
      <div className="page-head">
        <PageTitle>Подборки</PageTitle>
        {collections && collections.length > 0 ? (
          <Link className="btn btn-primary" href="/collections/new">
            Новая подборка
          </Link>
        ) : null}
      </div>
      {query.error ? <ErrorState error={query.error} onRetry={query.reload} /> : null}
      {query.loading && !collections ? <Loading /> : null}
      {collections?.length === 0 ? (
        <div className="empty">
          <p className="empty-title">Подборок пока нет</p>
          <p>
            Первый шаг: создайте подборку и добавьте в неё карточки вручную или вставкой из таблицы. Затем выдайте её ученикам:
            каждый получит свою копию.
          </p>
          <Link className="btn btn-primary" href="/collections/new">
            Создать первую подборку
          </Link>
        </div>
      ) : null}
      {collections && collections.length > 0 ? (
        <table className="data-table" role="table" aria-label="Подборки">
          <thead role="rowgroup">
            <tr role="row">
              <th role="columnheader" scope="col">
                Подборка
              </th>
              <th role="columnheader" scope="col">
                Карточек
              </th>
              <th role="columnheader" scope="col">
                Выдана ученикам
              </th>
              <th role="columnheader" scope="col">
                Изменена
              </th>
            </tr>
          </thead>
          <tbody role="rowgroup">
            {collections.map((collection) => (
              <tr role="row" key={collection.id}>
                <td role="cell" data-label="Подборка" className="data-table-main">
                  <Link href={`/collections/${collection.id}`}>{collection.title}</Link>
                </td>
                <td role="cell" data-label="Карточек" className="numeric">
                  {collection.cardCount}
                </td>
                <td role="cell" data-label="Выдана ученикам" className="numeric">
                  {collection.issuedCount === 0 ? <span className="muted">Никому</span> : collection.issuedCount}
                </td>
                <td role="cell" data-label="Изменена">
                  {formatDateTime(collection.updatedAt)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </>
  );
}

export function CollectionNew() {
  const [title, setTitle] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const flash = useFlash();

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
      const created = await api("createCollection", { body: { title } });
      const path = `/collections/${created.id}`;
      flash({ path, text: `Подборка «${created.title}» создана. Добавьте в неё карточки.`, tone: "success" });
      navigate(path, { replace: true });
    } catch (failure) {
      if (failure instanceof ApiCallError && failure.code === "bad_request") setFieldError(errorText(failure));
      else setError(failure);
      setBusy(false);
    }
  };

  return (
    <>
      <p className="breadcrumb">
        <Link href="/collections">← Все подборки</Link>
      </p>
      <PageTitle>Новая подборка</PageTitle>
      <form className="form panel" onSubmit={(event) => void submit(event)} noValidate>
        <TextField
          label="Название подборки"
          hint="Ученик увидит его в боте, в разделе «Подборки» и в уведомлении. Например: «Путешествие», «Глаголы движения»."
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          error={fieldError}
          maxLength={TITLE_MAX}
          autoComplete="off"
          required
          autoFocus
        />
        {error ? <ErrorState error={error} /> : null}
        <div className="actions">
          <button type="submit" className="btn btn-primary" disabled={busy} aria-busy={busy}>
            Создать подборку
          </button>
          <Link className="btn" href="/collections">
            Отмена
          </Link>
        </div>
      </form>
    </>
  );
}
