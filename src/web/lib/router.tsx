// Маршрутов мало и они простые, поэтому отдельная библиотека не нужна.
import { useSyncExternalStore, type AnchorHTMLAttributes, type MouseEvent } from "react";

const CHANGE_EVENT = "cabinet:navigate";

/** Заголовок новой страницы получает фокус только после перехода, а не при первой загрузке. */
let focusTitleAfterNavigation = false;

function subscribe(onChange: () => void) {
  const onPopState = () => {
    focusTitleAfterNavigation = true;
    onChange();
  };
  window.addEventListener("popstate", onPopState);
  window.addEventListener(CHANGE_EVENT, onChange);
  return () => {
    window.removeEventListener("popstate", onPopState);
    window.removeEventListener(CHANGE_EVENT, onChange);
  };
}

export function usePathname(): string {
  return useSyncExternalStore(subscribe, () => window.location.pathname);
}

export function navigate(to: string, options: { replace?: boolean } = {}) {
  if (options.replace) window.history.replaceState(null, "", to);
  else window.history.pushState(null, "", to);
  focusTitleAfterNavigation = true;
  window.scrollTo(0, 0);
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function consumeTitleFocus(): boolean {
  const pending = focusTitleAfterNavigation;
  focusTitleAfterNavigation = false;
  return pending;
}

export function Link({ href, onClick, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event);
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigate(href);
  };
  return <a href={href} onClick={handleClick} {...rest} />;
}
