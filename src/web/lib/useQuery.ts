import { useCallback, useEffect, useRef, useState } from "react";
import { isNotFound } from "./api";

export type QueryState<T> = {
  /** Данные остаются на экране, пока идёт фоновое обновление. */
  data: T | undefined;
  /** Ошибка показывается, только если данных нет (или запись исчезла). */
  error: unknown;
  loading: boolean;
  reload: () => void;
  setData: (data: T) => void;
};

/**
 * Загрузка данных экрана. При возврате на вкладку данные обновляются молча:
 * ученик действует в боте, и преподаватель должен увидеть заявку без перезагрузки.
 */
export function useQuery<T>(fetcher: (signal: AbortSignal) => Promise<T>, key: string): QueryState<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<unknown>();
  const [loading, setLoading] = useState(true);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const controllerRef = useRef<AbortController | null>(null);

  const run = useCallback((silent: boolean) => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    if (!silent) {
      setLoading(true);
      setError(undefined);
    }
    fetcherRef.current(controller.signal).then(
      (result) => {
        if (controller.signal.aborted) return;
        setData(result);
        setError(undefined);
        setLoading(false);
      },
      (failure: unknown) => {
        if (controller.signal.aborted) return;
        setLoading(false);
        // Сбой фонового обновления не должен прятать уже показанные данные.
        if (!silent || isNotFound(failure)) {
          setData(undefined);
          setError(failure);
        }
      },
    );
  }, []);

  useEffect(() => {
    setData(undefined);
    run(false);
    return () => controllerRef.current?.abort();
  }, [key, run]);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") run(true);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [run]);

  const reload = useCallback(() => run(true), [run]);
  const retry = useCallback(() => run(false), [run]);
  return { data, error, loading, reload: error ? retry : reload, setData };
}
