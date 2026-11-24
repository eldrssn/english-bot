// Все значения логики обучения в одном месте. Раздел 2.5 плана: значения легко меняются.

export type LearningSettings = {
  /** Новых вопросов в короткой серии, после них идут повторы ошибок этой серии. */
  seriesSize: number;
  /** Кнопок в тесте: один верный вариант и остальные неверные. */
  choiceOptionCount: number;
  /** Верных ответов подряд с первой попытки, после которых сложное слово становится освоенным. */
  masteryStreak: number;
  /** Ошибок подряд, после которых освоенное слово снова становится сложным. */
  masteredErrorsToHard: number;
};

export const LEARNING_SETTINGS: Readonly<LearningSettings> = Object.freeze({
  seriesSize: 5,
  choiceOptionCount: 4,
  masteryStreak: 5,
  masteredErrorsToHard: 2,
});
