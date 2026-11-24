import { Component, StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles/tokens.css";
import "./styles/app.css";

/** Сбой отрисовки не должен оставлять пустой экран. */
class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="center-page">
        <div className="center-card" role="alert">
          <h1 className="page-title">Что-то пошло не так</h1>
          <p>Страница перестала работать. Обновите её: данные на сервере не пострадали.</p>
          <button type="button" className="btn" onClick={() => window.location.reload()}>
            Обновить страницу
          </button>
        </div>
      </main>
    );
  }
}

const root = document.getElementById("root");
if (!root) throw new Error("Нет элемента #root");

createRoot(root).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
