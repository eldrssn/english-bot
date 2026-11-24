import { api } from "../lib/api";
import { formatDateTime } from "../lib/format";
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
        </>
      ) : null}
    </>
  );
}
