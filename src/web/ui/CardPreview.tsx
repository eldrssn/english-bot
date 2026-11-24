// Карточка глазами ученика: сообщения бота с теми же текстами и кнопками, что в Telegram.
import { useId } from "react";
import { questionPreviews, cardScreen, correctFeedback, type BotScreen, type PreviewCard } from "../lib/bot-preview";

function BotMessage({ screen, label }: { screen: { text: string; buttons?: string[][] }; label: string }) {
  return (
    <div className="tg-message">
      <p className="tg-text">{screen.text}</p>
      {screen.buttons && screen.buttons.length > 0 ? (
        <ul className="tg-buttons" aria-label={`Кнопки: ${label}`}>
          {screen.buttons.map((row, rowIndex) => (
            <li key={rowIndex} className="tg-row">
              {row.map((button, index) => (
                <span key={index} className="tg-button">
                  {button}
                </span>
              ))}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

const DIRECTION_TITLE = { ru_en: "Вопрос ru→en", en_ru: "Вопрос en→ru" } as const;

export function CardPreview({
  card,
  others,
  position,
}: {
  card: PreviewCard;
  /** Другие карточки подборки: из них в предпросмотре берутся неверные варианты. */
  others: readonly PreviewCard[];
  position: { number: number; total: number };
}) {
  const headingId = useId();
  const empty = card.english.trim() === "" || card.translation.trim() === "";
  const questions = empty ? [] : questionPreviews(card, others, position);
  const cardMessage: BotScreen = cardScreen(card, { previous: position.number > 1, next: position.number < position.total });

  return (
    <section className="section preview" aria-labelledby={headingId}>
      <h2 id={headingId}>Как увидит ученик</h2>
      {empty ? (
        <p className="muted">Заполните слово и перевод, и здесь появятся карточка и вопросы так, как их покажет бот.</p>
      ) : (
        <>
          <div className="preview-grid">
            <div className="preview-item">
              <h3 className="preview-title">Карточка в подборке</h3>
              <BotMessage screen={cardMessage} label="карточка" />
            </div>
            {questions.map((question) => (
              <div className="preview-item" key={question.direction}>
                <h3 className="preview-title">{DIRECTION_TITLE[question.direction]}</h3>
                {question.available ? (
                  <BotMessage screen={question.screen} label={DIRECTION_TITLE[question.direction]} />
                ) : (
                  <>
                    <p className="small">
                      В подборке пока нет других слов для неверных вариантов. Если их не окажется и среди остальных слов ученика, бот
                      напишет:
                    </p>
                    <BotMessage screen={{ text: question.text }} label={DIRECTION_TITLE[question.direction]} />
                  </>
                )}
              </div>
            ))}
            <div className="preview-item">
              <h3 className="preview-title">После верного ответа</h3>
              <BotMessage screen={{ text: correctFeedback(card) }} label="ответ" />
            </div>
          </div>
          <p className="muted small">
            Неверные варианты бот подбирает из всех слов ученика, поэтому в Telegram они будут другими. Здесь они взяты из
            этой подборки.
          </p>
          <dl className="facts accepted-facts">
            <div>
              <dt>Ученик печатает по-английски: засчитается</dt>
              <dd>
                {[card.english, ...card.acceptedRuEn].join("; ")}
                {card.allowOmitTo ? <span className="muted"> (и без «to» в начале)</span> : null}
              </dd>
            </div>
            <div>
              <dt>Ученик печатает по-русски: засчитается</dt>
              <dd>{[card.translation, ...card.acceptedEnRu].join("; ")}</dd>
            </div>
          </dl>
        </>
      )}
    </section>
  );
}
