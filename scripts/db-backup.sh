#!/usr/bin/env bash
# Резервная копия базы в формате pg_dump custom (сжатый, восстанавливается pg_restore выборочно или целиком).
# Дополняет встроенные копии тома Railway: файл лежит вне Railway и переживает удаление проекта или тома.
#
# Использование:
#   DATABASE_URL=postgres://... scripts/db-backup.sh [папка]       по умолчанию папка backups/
#   BACKUP_KEEP=30 — сколько последних файлов оставить в папке (0 — не удалять).
# pg_dump должен быть той же основной версии, что и сервер, или новее (PG_BIN — папка с pg_dump, если не в PATH).
#
# Восстановление в ПУСТУЮ базу (сначала проверьте на копии, а не на рабочей базе):
#   pg_restore --no-owner --no-privileges --exit-on-error --dbname="$TARGET_URL" файл.dump
set -euo pipefail

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "Задайте DATABASE_URL: строка подключения к базе, копию которой нужно снять." >&2
  exit 2
fi

find_tool() {
  local name="$1"
  if [[ -n "${PG_BIN:-}" && -x "$PG_BIN/$name" ]]; then echo "$PG_BIN/$name"; return 0; fi
  if command -v "$name" >/dev/null 2>&1; then command -v "$name"; return 0; fi
  for dir in /opt/homebrew/opt/postgresql@17/bin /opt/homebrew/opt/postgresql@16/bin /usr/local/opt/postgresql@16/bin; do
    if [[ -x "$dir/$name" ]]; then echo "$dir/$name"; return 0; fi
  done
  echo "Не найден $name. Установите клиент PostgreSQL или укажите папку в PG_BIN." >&2
  return 1
}

PG_DUMP="$(find_tool pg_dump)"
PG_RESTORE="$(find_tool pg_restore)"
DIR="${1:-backups}"
KEEP="${BACKUP_KEEP:-30}"

# Копия содержит персональные данные учеников: папка доступна только владельцу.
mkdir -p "$DIR"
chmod 700 "$DIR"
umask 077

FILE="$DIR/english-bot-$(date -u +%Y%m%dT%H%M%SZ).dump"
TMP="$FILE.partial"
trap 'rm -f "$TMP"' EXIT

"$PG_DUMP" --format=custom --compress=6 --no-owner --no-privileges --dbname="$DATABASE_URL" --file="$TMP"
# Файл читается: оглавление восстанавливается без ошибок. Недописанный файл под итоговым именем не останется.
"$PG_RESTORE" --list "$TMP" >/dev/null
mv "$TMP" "$FILE"
echo "Копия сохранена: $FILE ($(du -h "$FILE" | cut -f1))"

if [[ "$KEEP" =~ ^[0-9]+$ && "$KEEP" -gt 0 ]]; then
  # Имена с датой UTC сортируются по времени. Удаляются только файлы этого скрипта.
  # head -n с отрицательным числом нет в macOS, поэтому считаем сами.
  files=()
  while IFS= read -r line; do files+=("$line"); done < <(ls -1 "$DIR"/english-bot-*.dump 2>/dev/null | sort)
  excess=$(( ${#files[@]} - KEEP ))
  for (( i = 0; i < excess; i++ )); do
    rm -f "${files[$i]}"
    echo "Удалена старая копия: ${files[$i]}"
  done
fi
