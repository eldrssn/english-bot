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
  /** Вопросов в ежедневном квесте. */
  questSize: number;
  /** Не больше стольких сложных слов в квесте. */
  questMaxHard: number;
  /** Не больше стольких недавно добавленных слов в квесте. */
  questMaxRecent: number;
  /** Слово считается недавно добавленным столько дней после появления первой его карточки. */
  questRecentDays: number;
  /** Вопросов в экзамене. Если слов меньше, в экзамен входят все. */
  examSize: number;
  /** Время напоминания по умолчанию, по часовому поясу ученика. */
  defaultReminderTime: string;
};

export const LEARNING_SETTINGS: Readonly<LearningSettings> = Object.freeze({
  seriesSize: 5,
  choiceOptionCount: 4,
  masteryStreak: 5,
  masteredErrorsToHard: 2,
  questSize: 10,
  questMaxHard: 5,
  questMaxRecent: 3,
  questRecentDays: 7,
  examSize: 20,
  defaultReminderTime: "19:00",
});
