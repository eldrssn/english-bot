import { api } from "../lib/api";
import { cardsText } from "../lib/format";
import { Link } from "../lib/router";
import { Loading, PageTitle } from "../ui/kit";
import { TablePaste, addedSummary } from "../ui/TablePaste";
import { CollectionQueryError, useCollection } from "./Collection";

export function ImportScreen({ collectionId }: { collectionId: number }) {
  const query = useCollection(collectionId);
  const collection = query.data;
  const back = `/collections/${collectionId}`;

  return (
    <>
      <p className="breadcrumb">
        <Link href={back}>← {collection?.title ?? "Подборка"}</Link>
      </p>
      <PageTitle documentTitle="Импорт из таблицы">Импорт из таблицы</PageTitle>
      {query.error ? <CollectionQueryError error={query.error} onRetry={query.reload} /> : null}
      {query.loading && !collection ? <Loading /> : null}
      {collection ? (
        <>
          <p className="muted">
            Подборка «{collection.title}», сейчас {cardsText(collection.cards.length)}. Новые карточки встанут в конец. Пока вы не нажмёте
            «Добавить», ничего не сохраняется.
          </p>
          <TablePaste
            existing={collection.cards}
            place="в подборке"
            saveLabel={(count) => `Добавить ${cardsText(count)}`}
            onSave={async (text) => {
              const response = await api("importCards", { id: collectionId, body: { text } });
              query.setData(response.collection);
              return (
                <>
                  <p>{addedSummary(response.added, response.skippedInvalid, response.skippedDuplicates)}</p>
                  <Link className="btn btn-small" href={back}>
                    Открыть подборку
                  </Link>
                </>
              );
            }}
          />
        </>
      ) : null}
    </>
  );
}
