// Публичный API логики обучения этапов 3, 5 и 6.
export { checkAnswer, isBlankAnswer, type AnswerCheck } from "./answer-check.js";
export { buildChoiceOptions, type ChoiceOptions, type ChoiceOptionsInput } from "./choice-options.js";
export {
  computeCollectionStatus,
  type CollectionCardProgress,
  type CollectionStatus,
} from "./collection-status.js";
export { buildExamPlan, selectExamWords, type ExamCandidate, type ExamOptions } from "./exam.js";
export { addDays, formatClock, isValidTimeZone, localDate, localMinutes, parseClock, utcOffsetLabel } from "./local-time.js";
export {
  buildQuestPlan,
  isQuestStale,
  questStreak,
  selectQuestWords,
  type QuestCandidate,
  type QuestOptions,
  type QuestSettings,
} from "./quest.js";
export {
  reminderDecision,
  selectReminderRecipients,
  type ReminderCandidate,
  type ReminderDecision,
  type ReminderSkipReason,
} from "./reminders.js";
export { createSeededRng, type Rng } from "./rng.js";
export {
  buildSessionPlan,
  createSessionState,
  nextStep,
  recordAnswer,
  removeWordsFromPlan,
  summarizeSession,
  type BuildPlanOptions,
  type DirectionMode,
  type ItemAnswers,
  type PlanFormat,
  type PlanItem,
  type PlanWord,
  type RecordAnswerInput,
  type RecordAnswerResult,
  type SessionState,
  type SessionStep,
  type SessionSummary,
} from "./session.js";
export { LEARNING_SETTINGS, type LearningSettings } from "./settings.js";
export {
  oppositeDirection,
  primaryAnswerText,
  promptText,
  type AnswerCard,
  type AttemptNumber,
  type Direction,
  type QuestionFormat,
} from "./types.js";
export {
  applyAnswer,
  INITIAL_WORD_STATE,
  mergeWordStates,
  type AppliedAnswer,
  type ApplyAnswerResult,
  type WordLearningState,
  type WordStatus,
  type WordTransition,
} from "./word-state.js";
