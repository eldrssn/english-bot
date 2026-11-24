// Публичный API логики обучения этапа 3.
export { checkAnswer, type AnswerCheck } from "./answer-check.js";
export { buildChoiceOptions, type ChoiceOptions, type ChoiceOptionsInput } from "./choice-options.js";
export {
  computeCollectionStatus,
  type CollectionCardProgress,
  type CollectionStatus,
} from "./collection-status.js";
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
