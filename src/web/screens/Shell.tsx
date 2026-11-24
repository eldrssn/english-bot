import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { errorText } from "../lib/api";
import { Link, navigate, usePathname } from "../lib/router";
import { useSession, type SessionState } from "../lib/session";

type Flash = { path: string; text: string; tone: "success" | "danger" };

const FlashContext = createContext<(flash: Flash) => void>(() => {});

/** Сообщение о результате, которое показывается на странице, куда ведёт переход. */
export const useFlash = () => useContext(FlashContext);

const NAV = [
  { href: "/", label: "Главная", current: (path: string) => path === "/" },
  { href: "/students", label: "Ученики", current: (path: string) => path.startsWith("/students") || path.startsWith("/copies") },
  { href: "/collections", label: "Подборки", current: (path: string) => path.startsWith("/collections") },
];

export function Shell({ user, children }: { user: Extract<SessionState, { kind: "teacher" }>["user"]; children: ReactNode }) {
  const path = usePathname();
  const { logout } = useSession();
  const [flash, setFlash] = useState<Flash | null>(null);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    setFlash((current) => (current && current.path !== path ? null : current));
  }, [path]);

  const signOut = useCallback(async () => {
    setLeaving(true);
    try {
      await logout();
      navigate("/", { replace: true });
    } catch (error) {
      setLeaving(false);
      setFlash({ path: window.location.pathname, text: `Выйти не удалось. ${errorText(error)}`, tone: "danger" });
    }
  }, [logout]);

  const who = user.name ?? (user.username ? `@${user.username}` : `Telegram ID ${user.telegramId}`);
  const visible = flash?.path === path ? flash : null;

  return (
    <FlashContext.Provider value={setFlash}>
      <a className="skip-link" href="#main">
        К содержимому
      </a>
      <header className="app-header">
        <div className="app-header-inner">
          <Link className="brand" href="/">
            Кабинет преподавателя
          </Link>
          <nav aria-label="Основное" className="app-nav">
            {NAV.map((item) => (
              <Link key={item.href} href={item.href} aria-current={item.current(path) ? "page" : undefined}>
                {item.label}
              </Link>
            ))}
          </nav>
          <div className="app-user">
            <span className="app-user-name">{who}</span>
            <button type="button" className="btn btn-small" onClick={() => void signOut()} disabled={leaving}>
              Выйти
            </button>
          </div>
        </div>
      </header>
      <main id="main" className="page">
        <div role="status" aria-label="Сообщение о результате" className="flash-region">
          {visible ? <p className={`notice notice-${visible.tone}`}>{visible.text}</p> : null}
        </div>
        {children}
      </main>
    </FlashContext.Provider>
  );
}
