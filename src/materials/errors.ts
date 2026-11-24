// Отказы редактора и выдачи. Коды совпадают с кодами API, сервер переводит их без потерь.
export type MaterialsErrorCode = "not_found" | "invalid_card" | "duplicate_card" | "import_too_large" | "state_changed";

export class MaterialsError extends Error {
  override name = "MaterialsError";
  constructor(
    readonly code: MaterialsErrorCode,
    readonly details?: string[],
  ) {
    super(code);
  }
}
