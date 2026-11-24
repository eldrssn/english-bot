// Добавление и правка карточки исходной подборки.
import { useState } from "react";
import type { SourceCard as SourceCardData } from "../../shared/api-contract";
import { api } from "../lib/api";
import { fieldsFromCard, prepareFields, type CardFields } from "../lib/cards";
import { cardsText } from "../lib/format";
import { Link, navigate } from "../lib/router";
import { CardForm } from "../ui/CardForm";
import { Loading, NotFoundBlock, PageTitle } from "../ui/kit";
import { CollectionQueryError, useCollection } from "./Collection";
import { useFlash } from "./Shell";

const sameCard = (a: CardFields, b: CardFields) => JSON.stringify(prepareFields(a)) === JSON.stringify(prepareFields(b));

export function SourceCardNew({ collectionId }: { collectionId: number }) {
  const query = useCollection(collectionId);
  const collection = query.data;
  const [added, setAdded] = useState<SourceCardData[]>([]);
  const cards = collection ? [...collection.cards, ...added.filter((card) => !collection.cards.some((item) => item.id === card.id))] : [];
  const back = `/collections/${collectionId}`;

  return (
    <>
      <p className="breadcrumb">
        <Link href={back}>← {collection?.title ?? "Подборка"}</Link>
      </p>
      <PageTitle documentTitle="Новая карточка">Новая карточка</PageTitle>
      {query.error ? <CollectionQueryError error={query.error} onRetry={query.reload} /> : null}
      {query.loading && !collection ? <Loading /> : null}
      {collection ? (
        <>
          <p className="muted">
            Подборка «{collection.title}», сейчас {cardsText(cards.length)}. Карточка встанет в конец. После сохранения форма очистится —
            можно сразу вводить следующую.
          </p>
          <CardForm
            mode="add"
            existing={cards}
            previewPool={cards}
            previewPosition={{ number: cards.length + 1, total: cards.length + 1 }}
            submitLabel="Добавить карточку"
            duplicatePlace="в подборке"
            onSubmit={async (input) => {
              const { card } = await api("addCollectionCard", { id: collectionId, body: input });
              setAdded((current) => [...current, card]);
            }}
            addedText={(fields) => `Карточка «${fields.english.trim()} — ${fields.translation.trim()}» добавлена. Вводите следующую.`}
            cancel={
              <Link className="btn" href={back}>
                Готово, к подборке
              </Link>
            }
          />
          {added.length > 0 ? (
            <section className="section" aria-labelledby="added-heading">
              <h2 id="added-heading">Добавлено сейчас: {added.length}</h2>
              <ol className="added-list">
                {added.map((card) => (
                  <li key={card.id}>
                    <span lang="en">{card.english}</span> — {card.translation}
                  </li>
                ))}
              </ol>
            </section>
          ) : null}
        </>
      ) : null}
    </>
  );
}

export function SourceCardEdit({ collectionId, cardId }: { collectionId: number; cardId: number }) {
  const query = useCollection(collectionId);
  const collection = query.data;
  const card = collection?.cards.find((item) => item.id === cardId);
  const flash = useFlash();
  const back = `/collections/${collectionId}`;

  return (
    <>
      <p className="breadcrumb">
        <Link href={back}>← {collection?.title ?? "Подборка"}</Link>
      </p>
      <PageTitle documentTitle="Карточка">{card ? `Карточка «${card.english}»` : "Карточка"}</PageTitle>
      {query.error ? <CollectionQueryError error={query.error} onRetry={query.reload} /> : null}
      {query.loading && !collection ? <Loading /> : null}
      {collection && !card ? (
        <NotFoundBlock
          title="Карточка не найдена"
          text="В подборке нет такой карточки: возможно, её удалили."
          href={back}
          linkLabel="К подборке"
        />
      ) : null}
      {collection && card ? (
        <CardForm
          key={card.id}
          mode="edit"
          initial={fieldsFromCard(card)}
          editingId={card.id}
          existing={collection.cards}
          previewPool={collection.cards.filter((item) => item.id !== card.id)}
          previewPosition={{ number: collection.cards.indexOf(card) + 1, total: collection.cards.length }}
          submitLabel="Сохранить карточку"
          duplicatePlace="в подборке"
          unchanged={(fields) => sameCard(fields, fieldsFromCard(card))}
          notice={
            collection.issuedCount > 0 ? (
              <p className="notice">Правка меняет только эту подборку. Копии, которые ученики уже получили, останутся прежними.</p>
            ) : null
          }
          onSubmit={async (input) => {
            const { card: saved } = await api("editSourceCard", { id: card.id, body: input });
            flash({ path: back, text: `Карточка «${saved.english} — ${saved.translation}» сохранена.`, tone: "success" });
            navigate(back);
          }}
          cancel={
            <Link className="btn" href={back}>
              Отмена
            </Link>
          }
        />
      ) : null}
    </>
  );
}

