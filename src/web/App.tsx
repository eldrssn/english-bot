import { usePathname } from "./lib/router";
import { SessionProvider, useSession } from "./lib/session";
import { Dashboard } from "./screens/Dashboard";
import { Login, NoAccess } from "./screens/Login";
import { RequestScreen } from "./screens/Request";
import { Shell } from "./screens/Shell";
import { StudentCard } from "./screens/StudentCard";
import { StudentNew, Students } from "./screens/Students";
import { CollectionNew, Collections } from "./screens/Collections";
import { CollectionScreen } from "./screens/Collection";
import { SourceCardEdit, SourceCardNew } from "./screens/SourceCard";
import { ImportScreen } from "./screens/Import";
import { IssueScreen } from "./screens/Issue";
import { CopyAdd, CopyCardEdit, CopyScreen } from "./screens/Copy";
import { StudentResultsScreen } from "./screens/StudentResults";
import { CollectionResultsScreen } from "./screens/CollectionResults";
import { ErrorState, Loading, PageTitle } from "./ui/kit";
import { Link } from "./lib/router";

function NotFoundPage() {
  return (
    <>
      <PageTitle>Страница не найдена</PageTitle>
      <p>Такого адреса в кабинете нет.</p>
      <Link className="btn" href="/">
        На главную
      </Link>
    </>
  );
}

function Screen() {
  const path = usePathname();
  if (path === "/") return <Dashboard />;
  if (path === "/students") return <Students />;
  if (path === "/students/new") return <StudentNew />;
  const match = /^\/students\/(\d{1,15})(?:\/(request|results))?$/.exec(path);
  if (match) {
    const id = Number(match[1]);
    if (match[2] === "request") return <RequestScreen key={id} id={id} />;
    if (match[2] === "results") return <StudentResultsScreen key={id} id={id} />;
    return <StudentCard key={id} id={id} />;
  }
  if (path === "/collections") return <Collections />;
  if (path === "/collections/new") return <CollectionNew />;
  const collection = /^\/collections\/(\d{1,15})(?:\/(cards\/new|cards\/(\d{1,15})|import|issue|results))?$/.exec(path);
  if (collection) {
    const id = Number(collection[1]);
    const sub = collection[2];
    if (sub === undefined) return <CollectionScreen key={id} id={id} />;
    if (sub === "results") return <CollectionResultsScreen key={id} id={id} />;
    if (sub === "cards/new") return <SourceCardNew key={id} collectionId={id} />;
    if (sub === "import") return <ImportScreen key={id} collectionId={id} />;
    if (sub === "issue") return <IssueScreen key={id} collectionId={id} />;
    const cardId = Number(collection[3]);
    return <SourceCardEdit key={`${id}-${cardId}`} collectionId={id} cardId={cardId} />;
  }
  const copy = /^\/copies\/(\d{1,15})(?:\/(add|cards\/(\d{1,15})))?$/.exec(path);
  if (copy) {
    const id = Number(copy[1]);
    if (copy[2] === undefined) return <CopyScreen key={id} id={id} />;
    if (copy[2] === "add") return <CopyAdd key={id} id={id} />;
    const cardId = Number(copy[3]);
    return <CopyCardEdit key={`${id}-${cardId}`} copyId={id} cardId={cardId} />;
  }
  return <NotFoundPage />;
}

function Gate() {
  const { state, refresh } = useSession();
  switch (state.kind) {
    case "loading":
      return (
        <main className="center-page" id="main">
          <Loading label="Открываем кабинет…" />
        </main>
      );
    case "error":
      return (
        <main className="center-page" id="main">
          <div className="center-card">
            <PageTitle>Кабинет не открылся</PageTitle>
            <ErrorState error={state.error} onRetry={refresh} />
          </div>
        </main>
      );
    case "anonymous":
      return <Login state={state} />;
    case "no_access":
      return <NoAccess telegramId={state.telegramId} />;
    case "teacher":
      return (
        <Shell user={state.user}>
          <Screen />
        </Shell>
      );
  }
}

export function App() {
  return (
    <SessionProvider>
      <Gate />
    </SessionProvider>
  );
}
