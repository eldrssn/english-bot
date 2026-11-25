// Результаты по исходной подборке: кто получил, начал и завершил; какие слова вызвали затруднение.
import { api } from "../lib/api";
import { COLLECTION_STATUS_LABEL, STATUS_LABEL, formatDateTime, scoreText } from "../lib/format";
import { Link } from "../lib/router";
import { useQuery } from "../lib/useQuery";
import { Loading, PageTitle } from "../ui/kit";
import { CollectionQueryError } from "./Collection";
import { TableScroll } from "./StudentResults";

export function CollectionResultsScreen({ id }: { id: number }) {
  const query = useQuery((signal) => api("collectionResults", { id, signal }), `collection-results-${id}`);
  const data = query.data;
  const started = data?.recipients.filter((recipient) => recipient.status !== "assigned").length ?? 0;
  const completed = data?.recipients.filter((recipient) => recipient.status === "completed").length ?? 0;
  const difficult = data?.words.filter((word) => word.firstAttempt.correct < word.firstAttempt.total || word.hardNow > 0) ?? [];

  return (
    <>
      <p className="breadcrumb">
        <Link href={`/collections/${id}`}>← {data?.title ?? "Подборка"}</Link>
      </p>
      <PageTitle documentTitle={data ? `Результаты: ${data.title}` : "Результаты подборки"}>
        {data ? `Результаты: ${data.title}` : "Результаты подборки"}
      </PageTitle>
      {query.error ? <CollectionQueryError error={query.error} onRetry={query.reload} /> : null}
      {query.loading && !data ? <Loading /> : null}
      {data ? (
        <>
          <p className="muted">
            Копии учеников объединены по этой подборке и её карточкам. Учитываются только ученики из вашего списка и ответы в рамках
            текущей связи.
          </p>
          <dl className="stats">
            <div className="stat">
              <dt>Получили</dt>
              <dd>{data.recipients.length}</dd>
            </div>
            <div className="stat">
              <dt>Начали</dt>
              <dd>{started}</dd>
            </div>
            <div className="stat">
              <dt>Завершили</dt>
              <dd>{completed}</dd>
            </div>
          </dl>

          <section className="section" aria-labelledby="collection-recipients">
            <h2 id="collection-recipients">Ученики</h2>
            {data.recipients.length === 0 ? (
              <p className="muted">
                Подборка пока никому не выдана. <Link href={`/collections/${id}/issue`}>Выдать ученикам</Link>
              </p>
            ) : (
              <TableScroll label="Ученики, получившие подборку">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th scope="col">Ученик</th>
                      <th scope="col">Статус подборки</th>
                      <th scope="col">С первой попытки</th>
                      <th scope="col">После повтора</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.recipients.map((recipient) => (
                      <tr key={recipient.copyId}>
                        <td className="data-table-main">
                          <Link href={`/students/${recipient.studentId}/results`}>{recipient.displayName}</Link>
                          <span className="muted small block">
                            {recipient.studentStatus === "active" ? `выдана ${formatDateTime(recipient.publishedAt)}` : STATUS_LABEL[recipient.studentStatus]}
                          </span>
                        </td>
                        <td>
                          <span className="badge badge-neutral">
                            {recipient.studentStatus === "active" ? COLLECTION_STATUS_LABEL[recipient.status] : "Не подключён"}
                          </span>
                        </td>
                        <td className="numeric nowrap">{scoreText(recipient.firstAttempt)}</td>
                        <td className="numeric nowrap">{scoreText(recipient.afterRepeat)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableScroll>
            )}
          </section>

          <section className="section" aria-labelledby="collection-difficult">
            <h2 id="collection-difficult">Трудные слова</h2>
            <p className="muted small">Слова с ошибками с первой попытки или в «Сложных» у кого-то из учеников, сначала самые трудные.</p>
            {difficult.length === 0 ? (
              <p className="muted">{data.words.length === 0 ? "Ответов по этой подборке пока нет." : "Затруднений пока нет: все ответы верные с первой попытки."}</p>
            ) : (
              <TableScroll label="Трудные слова подборки">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th scope="col">Слово</th>
                      <th scope="col" className="numeric">
                        Учеников
                      </th>
                      <th scope="col">С первой попытки</th>
                      <th scope="col" className="numeric">
                        Стало сложным
                      </th>
                      <th scope="col" className="numeric">
                        Сложное сейчас
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {difficult.map((word) => (
                      <tr key={`${word.sourceCardId ?? "copy"}-${word.english}-${word.translation}`}>
                        <td className="data-table-main">
                          {word.english} — {word.translation}
                          {word.sourceCardId === null ? <span className="muted small block">добавлено прямо в копию</span> : null}
                        </td>
                        <td className="numeric">{word.students}</td>
                        <td className="numeric nowrap">{scoreText(word.firstAttempt)}</td>
                        <td className="numeric">{word.becameHard}</td>
                        <td className="numeric">{word.hardNow}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableScroll>
            )}
          </section>
        </>
      ) : null}
    </>
  );
}
