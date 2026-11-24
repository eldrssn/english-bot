import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { apiRoutes, loginErrorCodes, type LoginErrorCode, type MeResponse } from "../../shared/api-contract";
import { api, fetchMe, onSessionLost } from "./api";

type TeacherMe = Extract<MeResponse, { status: "teacher" }>;
type AnonymousMe = Extract<MeResponse, { status: "anonymous" }>;

export type SessionState =
  | { kind: "loading" }
  | { kind: "error"; error: unknown }
  | { kind: "anonymous"; me: AnonymousMe; expired: boolean; loginError: LoginErrorCode | "unknown" | null }
  | { kind: "no_access"; telegramId: number }
  | { kind: "teacher"; user: TeacherMe["user"] };

type SessionContextValue = {
  state: SessionState;
  refresh: () => void;
  logout: () => Promise<void>;
};

const SessionContext = createContext<SessionContextValue | null>(null);

function readLoginError(): LoginErrorCode | "unknown" | null {
  const raw = new URLSearchParams(window.location.search).get("login_error");
  if (raw === null) return null;
  return loginErrorCodes.find((code) => code === raw) ?? "unknown";
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SessionState>({ kind: "loading" });
  // Читается один раз при открытии: дальше параметра в адресе уже нет.
  const [initialLoginError] = useState(readLoginError);

  const load = useCallback(async (options: { expired?: boolean; loginError?: LoginErrorCode | "unknown" | null } = {}) => {
    try {
      const me = await fetchMe();
      if (me.status === "teacher") setState({ kind: "teacher", user: me.user });
      else if (me.status === "no_access") setState({ kind: "no_access", telegramId: me.telegramId });
      else setState({ kind: "anonymous", me, expired: options.expired ?? false, loginError: options.loginError ?? null });
    } catch (error) {
      setState({ kind: "error", error });
    }
  }, []);

  useEffect(() => {
    if (initialLoginError) {
      // Ошибка показывается один раз: после перезагрузки страницы её быть не должно.
      const url = new URL(window.location.href);
      url.searchParams.delete("login_error");
      window.history.replaceState(null, "", url.pathname + url.search);
    }
    void load({ loginError: initialLoginError });
    return onSessionLost((reason) => void load({ expired: reason === "expired" }));
  }, [load, initialLoginError]);

  const value = useMemo<SessionContextValue>(
    () => ({
      state,
      refresh: () => {
        setState({ kind: "loading" });
        void load();
      },
      logout: async () => {
        await api("logout", {});
        await load();
      },
    }),
    [state, load],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error("useSession вне SessionProvider");
  return value;
}

export const loginPaths = { telegram: apiRoutes.telegramLoginStart.path, dev: apiRoutes.devLogin.path };
