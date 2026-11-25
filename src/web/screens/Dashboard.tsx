import { api } from "../lib/api";
import { COLLECTION_STATUS_LABEL, formatDateTime, scoreText, sessionTitle } from "../lib/format";
import { Link } from "../lib/router";
import { useQuery } from "../lib/useQuery";
import { ErrorState, Loading, PageTitle, TelegramIdentity } from "../ui/kit";

export function Dashboard() {
  const query = useQuery((signal) => api("dashboard", { signal }), "dashboard");
  const data = query.data;

  return (
    <>
      <PageTitle>Главная</PageTitle>
      {query.error ? <ErrorState error={query.error} onRetry={query.reload} /> : null}
      {query.loading && !data ? <Loading /> : null}
      {data ? (
        <>
          <dl className="stats">
            <div className="stat">
              <dt>Учеников в списке</dt>
              <dd>{data.studentCount}</dd>
            </div>
            <div className="stat">
              <dt>Подключены</dt>
              <dd>{data.activeStudentCount}</dd>
            </div>
            <div className="stat">
              <dt>Заявки на подтверждение</dt>
              <dd>{data.pendingRequests.length}</dd>
            </div>
          </dl>

          <section className="section" aria-labelledby="requests-heading">
            <h2 id="requests-heading">Заявки на подтверждение</h2>
            {data.pendingRequests.length === 0 ? (
              data.studentCount === 0 ? (
                <div className="empty">
                  <p className="empty-title">Учеников пока нет</p>
                  <p>Начните с записи ученика: кабинет выдаст личную ссылку в бот, которую нужно отправить ему.</p>
                  <Link className="btn btn-primary" href="/students/new">
                    Добавить ученика
                  </Link>
                </div>
              ) : (
                <p className="muted">Заявок нет. Когда ученик подтвердит вход по ссылке, заявка появится здесь.</p>
              )
            ) : (
              <ul className="request-list">
                {data.pendingRequests.map((request) => (
                  <li key={request.studentId} className="request-row">
                    <div className="request-row-main">
                      <span className="strong">{request.displayName}</span>
                      <TelegramIdentity name={request.telegramName} username={request.telegramUsername} />
                      <span className="muted small">
                        Заявка от {formatDateTime(request.requestedAt)}, действует до {formatDateTime(request.expiresAt)}
                      </span>
                    </div>
                    <Link
                      className="btn btn-primary"
                      href={`/students/${request.studentId}/request`}
                      aria-label={`Проверить заявку: ${request.displayName}`}
                    >
                      Проверить заявку
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="section" aria-labelledby="recent-results-heading">
            <h2 id="recent-results-heading">Последние результаты</h2>
            {data.recentResults.length === 0 ? (
              <p className="muted">Завершённых занятий пока нет. Когда ученик пройдёт тест, квест или экзамен, итог появится здесь.</p>
            ) : (
              <ul className="request-list">
                {data.recentResults.map((result) => (
                  <li key={result.sessionId} className="request-row">
                    <div className="request-row-main">
                      <span className="strong">{result.displayName}</span>
                      <span>
                        {sessionTitle(result.type, result.title)} — с первой попытки {scoreText(result.firstAttempt)}
                      </span>
                      <span className="muted small">{formatDateTime(result.finishedAt)}</span>
                    </div>
                    <Link className="btn" href={`/students/${result.studentId}/results`} aria-label={`Результаты: ${result.displayName}`}>
                      Результаты
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="section" aria-labelledby="recent-collections-heading">
            <h2 id="recent-collections-heading">Недавно выданные подборки</h2>
            {data.recentCollections.length === 0 ? (
              <p className="muted">
                Подборки ещё не выдавались. Создайте подборку в разделе <Link href="/collections">«Подборки»</Link> и выдайте её ученикам.
              </p>
            ) : (
              <ul className="collection-list">
                {data.recentCollections.map((copy) => (
                  <li key={copy.copyId} className="collection-row">
                    <Link className="strong" href={`/copies/${copy.copyId}`}>
                      {copy.title}
                    </Link>
                    <span className="muted small">
                      {copy.displayName}, выдана {formatDateTime(copy.publishedAt)}
                    </span>
                    <span className="badge badge-neutral">{COLLECTION_STATUS_LABEL[copy.status]}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      ) : null}
    </>
  );
}
