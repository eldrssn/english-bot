import type { SessionState } from "../lib/session";
import { loginPaths, useSession } from "../lib/session";
import { LOGIN_ERROR_TEXT } from "../lib/format";
import { CopyButton, PageTitle } from "../ui/kit";
import { useState } from "react";
import { errorText } from "../lib/api";

const UNKNOWN_LOGIN_ERROR = "Войти не удалось. Попробуйте ещё раз.";

export function Login({ state }: { state: Extract<SessionState, { kind: "anonymous" }> }) {
  const { me, expired, loginError } = state;
  return (
    <main className="center-page" id="main">
      <div className="center-card">
        <PageTitle>Кабинет преподавателя</PageTitle>
        <p>Войдите через Telegram. Доступ есть только у аккаунтов с ролью преподавателя.</p>
        {loginError ? (
          <p className="notice notice-danger" role="alert">
            {loginError === "unknown" ? UNKNOWN_LOGIN_ERROR : LOGIN_ERROR_TEXT[loginError]}
          </p>
        ) : null}
        {expired ? (
          <p className="notice notice-warn" role="alert">
            Сессия закончилась. Войдите снова, чтобы продолжить.
          </p>
        ) : null}
        {me.loginAvailable ? (
          <a className="btn btn-primary btn-block" href={loginPaths.telegram}>
            Войти через Telegram
          </a>
        ) : (
          <>
            <button type="button" className="btn btn-primary btn-block" disabled aria-describedby="login-unavailable">
              Войти через Telegram
            </button>
            <p id="login-unavailable" className="field-hint">
              Вход через Telegram на этом сервере не настроен.
            </p>
          </>
        )}
        {me.devLoginAvailable ? (
          <div className="dev-login">
            <p>
              <strong>Сервер разработки.</strong> Вход без Telegram под тестовым аккаунтом. В рабочей версии этой кнопки нет.
            </p>
            <a className="btn btn-dev btn-block" href={loginPaths.dev}>
              Вход для разработки
            </a>
          </div>
        ) : null}
      </div>
    </main>
  );
}

export function NoAccess({ telegramId }: { telegramId: number }) {
  const { logout } = useSession();
  const [error, setError] = useState<unknown>(null);
  return (
    <main className="center-page" id="main">
      <div className="center-card">
        <PageTitle>Нет доступа к кабинету</PageTitle>
        <p>
          Вы вошли через Telegram, но у этого аккаунта нет роли преподавателя. Роль выдаёт администратор: сообщите ему свой
          Telegram ID.
        </p>
        <div className="id-box">
          <span className="id-box-label">Ваш Telegram ID</span>
          <code className="id-box-value">{telegramId}</code>
        </div>
        <CopyButton text={String(telegramId)} label="Скопировать Telegram ID" />
        <p className="field-hint">Если вы занимаетесь как ученик, кабинет не нужен: всё работает в боте.</p>
        {error ? (
          <p className="field-error" role="alert">
            {errorText(error)}
          </p>
        ) : null}
        <button type="button" className="btn" onClick={() => logout().catch(setError)}>
          Войти другим аккаунтом
        </button>
      </div>
    </main>
  );
}
