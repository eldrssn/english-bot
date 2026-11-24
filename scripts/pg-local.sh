#!/usr/bin/env bash
# Отдельный кластер PostgreSQL для проекта: данные в .pgdata, порт 54329, только 127.0.0.1.
# Существующие службы и кластеры не затрагиваются.
# Использование: scripts/pg-local.sh start|stop|status|psql [база]|destroy
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGDATA_DIR="$ROOT/.pgdata"
PORT="${PG_LOCAL_PORT:-54329}"
PGUSER_NAME="english_bot"
DEV_DB="english_bot_dev"
TEST_DB="english_bot_test"

find_bin() {
  local candidate
  for candidate in \
    "${PG_BIN:-}" \
    "/opt/homebrew/opt/postgresql@16/bin" \
    "/usr/local/opt/postgresql@16/bin" \
    "/Library/PostgreSQL/16/bin" \
    "/usr/lib/postgresql/16/bin"; do
    if [[ -n "$candidate" && -x "$candidate/pg_ctl" ]]; then
      echo "$candidate"
      return 0
    fi
  done
  if command -v pg_ctl >/dev/null 2>&1; then
    dirname "$(command -v pg_ctl)"
    return 0
  fi
  echo "Не найден PostgreSQL. Укажите папку с pg_ctl в PG_BIN или используйте docker compose up -d." >&2
  return 1
}

BIN="$(find_bin)"

is_running() {
  [[ -d "$PGDATA_DIR" ]] && "$BIN/pg_ctl" -D "$PGDATA_DIR" status >/dev/null 2>&1
}

ensure_db() {
  local name="$1" exists
  exists="$("$BIN/psql" -h 127.0.0.1 -p "$PORT" -U "$PGUSER_NAME" -d postgres -tAc \
    "SELECT 1 FROM pg_database WHERE datname = '$name'")"
  if [[ "$exists" != "1" ]]; then
    "$BIN/createdb" -h 127.0.0.1 -p "$PORT" -U "$PGUSER_NAME" "$name"
    echo "Создана база $name"
  fi
}

start() {
  if [[ ! -f "$PGDATA_DIR/PG_VERSION" ]]; then
    # trust допустим: кластер слушает только 127.0.0.1 и содержит только данные разработки.
    "$BIN/initdb" -D "$PGDATA_DIR" -U "$PGUSER_NAME" --auth=trust -E UTF8 --locale=C >/dev/null
    echo "Кластер создан в .pgdata"
  fi
  if is_running; then
    echo "Кластер уже запущен на порту $PORT"
  else
    # Без unix-сокета: подключение только по TCP, общий каталог сокетов не используется.
    # LC_ALL: на macOS без него postgres падает с "postmaster became multithreaded during startup".
    LC_ALL=C "$BIN/pg_ctl" -D "$PGDATA_DIR" -w -l "$PGDATA_DIR/server.log" \
      -o "-p $PORT -c listen_addresses=127.0.0.1 -c unix_socket_directories=''" start >/dev/null
    echo "Кластер запущен на порту $PORT"
  fi
  ensure_db "$DEV_DB"
  ensure_db "$TEST_DB"
  if [[ ! -f "$ROOT/.env.local" ]]; then
    echo "DATABASE_URL=postgres://$PGUSER_NAME@127.0.0.1:$PORT/$DEV_DB" > "$ROOT/.env.local"
    echo "Записан .env.local с DATABASE_URL"
  fi
}

case "${1:-}" in
  start) start ;;
  stop)
    if is_running; then "$BIN/pg_ctl" -D "$PGDATA_DIR" -m fast -w stop >/dev/null; echo "Кластер остановлен"; else echo "Кластер не запущен"; fi
    ;;
  status)
    if is_running; then echo "Запущен на порту $PORT"; else echo "Не запущен"; exit 3; fi
    ;;
  psql)
    exec "$BIN/psql" -h 127.0.0.1 -p "$PORT" -U "$PGUSER_NAME" -d "${2:-$DEV_DB}"
    ;;
  destroy)
    if is_running; then "$BIN/pg_ctl" -D "$PGDATA_DIR" -m fast -w stop >/dev/null; fi
    rm -rf "$PGDATA_DIR"
    echo "Папка .pgdata удалена"
    ;;
  *)
    echo "Использование: $0 start|stop|status|psql [база]|destroy" >&2
    exit 2
    ;;
esac
