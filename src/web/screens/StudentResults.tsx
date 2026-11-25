// Результаты ученика в рамках текущей связи: сводка, подборки, занятия, ответы с обеими попытками, слова и просмотры.
import { useId, useState, type ReactNode } from "react";
import { apiRoutes, type ResultAnswer, type StudentResults as Results, type WordState } from "../../shared/api-contract";
import { api } from "../lib/api";
import {
  COLLECTION_STATUS_LABEL,
  DIRECTION_LABEL,
  SESSION_KIND_LABEL,
  SESSION_STATUS_LABEL,
  WORD_STATE_LABEL,
  formatDateTime,
  scoreText,
  sessionTitle,
} from "../lib/format";
import { Link } from "../lib/router";
import { useQuery } from "../lib/useQuery";
import { Loading, PageTitle, QueryError } from "../ui/kit";

const ANSWERS_PAGE = 50;

/** Широкая таблица прокручивается сама, а не вся страница. Область доступна с клавиатуры. */
export function TableScroll({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="table-scroll" role="region" aria-label={label} tabIndex={0}>
      {children}
    </div>
  );
}

function Progress({ results }: { results: Results }) {
  const { progress, totals } = results;
  return (
    <dl className="stats">
      <div className="stat">
        <dt>Изучено слов</dt>
        <dd>
          {progress.studied} <span className="stat-of">из {progress.available}</span>
        </dd>
      </div>
      <div className="stat">
        <dt>Сложные слова</dt>
        <dd>{progress.hard}</dd>
      </div>
      <div className="stat">
        <dt>Освоено</dt>
        <dd>{progress.mastered}</dd>
      </div>
      <div className="stat">
        <dt>Подборок завершено</dt>
        <dd>
          {progress.completedCollections} <span className="stat-of">из {progress.totalCollections}</span>
        </dd>
      </div>
      <div className="stat">
        <dt>Верно с первой попытки</dt>
        <dd className="stat-text">{scoreText(totals.firstAttempt)}</dd>
      </div>
      <div className="stat">
        <dt>Итог после повтора</dt>
        <dd className="stat-text">{scoreText(totals.afterRepeat)}</dd>
      </div>
      <div className="stat">
        <dt>Квестов пройдено</dt>
        <dd>
          {progress.questsCompleted} <span className="stat-of">серия {progress.questStreak}</span>
        </dd>
      </div>
      <div className="stat">
        <dt>Экзаменов</dt>
        <dd>{progress.examsCompleted}</dd>
      </div>
    </dl>
  );
}

function Collections({ results }: { results: Results }) {
  return (
    <section className="section" aria-labelledby="results-collections">
      <h2 id="results-collections">Подборки</h2>
      {results.collections.length === 0 ? (
        <p className="muted">В рамках текущей связи подборки не выдавались.</p>
      ) : (
        <TableScroll label="Подборки ученика">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">Подборка</th>
                <th scope="col">Статус</th>
                <th scope="col" className="numeric">
                  Карточек открыто
                </th>
                <th scope="col" className="numeric">
                  Слов с ответом
                </th>
                <th scope="col">С первой попытки</th>
              </tr>
            </thead>
            <tbody>
              {results.collections.map((collection) => (
                <tr key={collection.id}>
                  <td className="data-table-main">
                    <Link href={`/copies/${collection.id}`}>{collection.title}</Link>
                    <span className="muted small block">выдана {formatDateTime(collection.publishedAt)}</span>
                  </td>
                  <td>
                    <span className="badge badge-neutral">{COLLECTION_STATUS_LABEL[collection.status]}</span>
                  </td>
                  <td className="numeric">
                    {collection.viewedCards} из {collection.wordCount}
                  </td>
                  <td className="numeric">
                    {collection.answeredWords} из {collection.wordCount}
                  </td>
                  <td className="numeric nowrap">{scoreText(collection.firstAttempt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      )}
    </section>
  );
}

function Sessions({ results }: { results: Results }) {
  return (
    <section className="section" aria-labelledby="results-sessions">
      <h2 id="results-sessions">Занятия</h2>
      <p className="muted small">
        Тесты, «Переведи меня», практика сложных слов, ежедневные квесты и экзамены. «С первой попытки» — без подсказки; «после
        повтора» — с учётом повтора в конце серии.
      </p>
      {results.sessions.length === 0 ? (
        <p className="muted">Занятий пока не было.</p>
      ) : (
        <TableScroll label="Занятия ученика">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">Занятие</th>
                <th scope="col">Статус</th>
                <th scope="col" className="numeric">
                  Отвечено
                </th>
                <th scope="col">С первой попытки</th>
                <th scope="col">После повтора</th>
                <th scope="col" className="numeric">
                  Стали сложными
                </th>
              </tr>
            </thead>
            <tbody>
              {results.sessions.map((session) => (
                <tr key={session.id}>
                  <td className="data-table-main">
                    {sessionTitle(session.type, session.title)}
                    <span className="muted small block">
                      {session.questLocalDate ? `за ${session.questLocalDate}, ` : ""}
                      начато {formatDateTime(session.startedAt)}
                    </span>
                  </td>
                  <td>{SESSION_STATUS_LABEL[session.status]}</td>
                  <td className="numeric">
                    {session.answeredCount} из {session.plannedCount}
                  </td>
                  <td className="numeric nowrap">{scoreText(session.firstAttempt)}</td>
                  <td className="numeric nowrap">{scoreText(session.afterRepeat)}</td>
                  <td className="numeric">{session.becameHard}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      )}
    </section>
  );
}

function attemptCell(attempt: ResultAnswer["first"] | null) {
  if (!attempt) return <span className="muted">—</span>;
  return (
    <>
      <span className={attempt.correct ? "answer-ok" : "answer-wrong"}>{attempt.correct ? "Верно" : "Неверно"}</span>
      <span className="block small">{attempt.answer}</span>
    </>
  );
}

function Answers({ results }: { results: Results }) {
  const [sessionId, setSessionId] = useState<string>("all");
  const [showAll, setShowAll] = useState(false);
  const filterId = useId();
  const filtered = sessionId === "all" ? results.answers : results.answers.filter((answer) => String(answer.sessionId) === sessionId);
  const visible = showAll ? filtered : filtered.slice(0, ANSWERS_PAGE);

  return (
    <section className="section" aria-labelledby="results-answers">
      <h2 id="results-answers">Ответы</h2>
      {results.answers.length === 0 ? (
        <p className="muted">Ответов пока нет.</p>
      ) : (
        <>
          <div className="field field-inline">
            <label htmlFor={filterId}>Занятие</label>
            <select
              id={filterId}
              className="input"
              value={sessionId}
              onChange={(event) => {
                setSessionId(event.target.value);
                setShowAll(false);
              }}
            >
              <option value="all">Все занятия</option>
              {results.sessions
                .filter((session) => session.answeredCount > 0)
                .map((session) => (
                  <option key={session.id} value={String(session.id)}>
                    {sessionTitle(session.type, session.title)}, {formatDateTime(session.startedAt)}
                  </option>
                ))}
            </select>
          </div>
          <TableScroll label="Ответы ученика">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Слово</th>
                  <th scope="col">Первая попытка</th>
                  <th scope="col">Повтор</th>
                  <th scope="col">Занятие</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((answer) => (
                  <tr key={answer.questionId}>
                    <td className="data-table-main">
                      {answer.english} — {answer.translation}
                      <span className="muted small block">
                        {DIRECTION_LABEL[answer.direction]}, {answer.format === "choice" ? "кнопки" : "ввод"}
                        {answer.becameHard ? ", стало сложным" : ""}
                        {answer.becameMastered ? ", освоено" : ""}
                      </span>
                    </td>
                    <td>{attemptCell(answer.first)}</td>
                    <td>{attemptCell(answer.second)}</td>
                    <td>
                      {SESSION_KIND_LABEL[answer.sessionType]}
                      <span className="muted small block">{formatDateTime(answer.first.answeredAt)}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
          {filtered.length > visible.length ? (
            <button type="button" className="btn" onClick={() => setShowAll(true)}>
              Показать все ответы ({filtered.length})
            </button>
          ) : null}
        </>
      )}
    </section>
  );
}

const WORD_FILTERS: { value: WordState | "all"; label: string }[] = [
  { value: "all", label: "Все" },
  { value: "hard", label: "Сложные" },
  { value: "learning", label: "Изучаются" },
  { value: "mastered", label: "Освоены" },
];

function Words({ results }: { results: Results }) {
  const [filter, setFilter] = useState<WordState | "all">("all");
  const filterId = useId();
  const words = filter === "all" ? results.words : results.words.filter((word) => word.status === filter);
  return (
    <section className="section" aria-labelledby="results-words">
      <h2 id="results-words">Слова</h2>
      <p className="muted small">Текущее состояние слов из подборок этой связи и слов, на которые ученик отвечал: серия «5 из 5», сложные и освоенные.</p>
      {results.words.length === 0 ? (
        <p className="muted">Слов пока нет.</p>
      ) : (
        <>
          <div className="field field-inline">
            <label htmlFor={filterId}>Показать</label>
            <select id={filterId} className="input" value={filter} onChange={(event) => setFilter(event.target.value as WordState | "all")}>
              {WORD_FILTERS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label} ({option.value === "all" ? results.words.length : results.words.filter((word) => word.status === option.value).length})
                </option>
              ))}
            </select>
          </div>
          {words.length === 0 ? (
            <p className="muted">Таких слов нет.</p>
          ) : (
            <TableScroll label="Слова ученика">
              <table className="data-table">
                <thead>
                  <tr>
                    <th scope="col">Слово</th>
                    <th scope="col">Состояние</th>
                    <th scope="col" className="numeric">
                      Серия
                    </th>
                    <th scope="col">С первой попытки</th>
                    <th scope="col">Подборки</th>
                  </tr>
                </thead>
                <tbody>
                  {words.map((word) => (
                    <tr key={word.studentWordId}>
                      <td className="data-table-main">
                        {word.english} — {word.translation}
                      </td>
                      <td>
                        <span className={`badge ${word.status === "hard" ? "badge-warn" : word.status === "mastered" ? "badge-success" : "badge-neutral"}`}>
                          {WORD_STATE_LABEL[word.status]}
                        </span>
                      </td>
                      <td className="numeric nowrap">{word.correctStreak} из 5</td>
                      <td className="numeric nowrap">{scoreText(word.firstAttempt)}</td>
                      <td className="small">{word.sources.join(", ") || <span className="muted">нет действующих карточек</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableScroll>
          )}
        </>
      )}
    </section>
  );
}

function Views({ results }: { results: Results }) {
  return (
    <section className="section" aria-labelledby="results-views">
      <h2 id="results-views">Просмотренные карточки</h2>
      {results.views.length === 0 ? (
        <p className="muted">Ученик ещё не открывал карточки.</p>
      ) : (
        <TableScroll label="Просмотренные карточки">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">Карточка</th>
                <th scope="col">Подборка</th>
                <th scope="col" className="numeric">
                  Просмотров
                </th>
                <th scope="col">Последний раз</th>
              </tr>
            </thead>
            <tbody>
              {results.views.map((view, index) => (
                <tr key={`${view.collectionTitle}-${view.english}-${index}`}>
                  <td className="data-table-main">
                    {view.english} — {view.translation}
                  </td>
                  <td>{view.collectionTitle}</td>
                  <td className="numeric">{view.views}</td>
                  <td className="nowrap">{formatDateTime(view.lastViewedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      )}
    </section>
  );
}

export const resultsCsvUrl = (studentId: number) => apiRoutes.studentResultsCsv.path.replace(":id", String(studentId));

export function StudentResultsScreen({ id }: { id: number }) {
  const query = useQuery((signal) => api("studentResults", { id, signal }), `student-results-${id}`);
  const results = query.data;
  const name = results?.student.displayName;

  return (
    <>
      <p className="breadcrumb">
        <Link href={`/students/${id}`}>← {name ?? "Карточка ученика"}</Link>
      </p>
      <PageTitle documentTitle={name ? `Результаты: ${name}` : "Результаты ученика"}>
        {name ? `Результаты: ${name}` : "Результаты ученика"}
      </PageTitle>
      {query.error ? <QueryError error={query.error} onRetry={query.reload} /> : null}
      {query.loading && !results ? <Loading /> : null}
      {results ? (
        <>
          <p className="muted">
            {results.student.startedAt
              ? `Показано только то, что появилось после подключения ${formatDateTime(results.student.startedAt)}. Прежние связи с этим учеником сюда не входят.`
              : "Ученик ещё не подключён: ответов пока нет."}
          </p>
          <div className="actions toolbar">
            <a className="btn" href={resultsCsvUrl(id)} download>
              Скачать CSV
            </a>
            <span className="muted small">Файл для Excel и Google Таблиц: все занятия, ответы обеих попыток и слова.</span>
          </div>
          <Progress results={results} />
          <Collections results={results} />
          <Sessions results={results} />
          <Answers results={results} />
          <Words results={results} />
          <Views results={results} />
        </>
      ) : null}
    </>
  );
}
