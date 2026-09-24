import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { LangProvider } from './lib/i18n.js';
import './styles.css';

/** Vite entry point — the chat/approvals/tasks/connections SPA (design doc §7.6). S1.8 ships
 *  login + chat; approvals/tasks/connections land with their respective S2 tasks. `LangProvider`
 *  (S8 W1-A9) wraps everything, including the pre-session pages, so the language choice applies
 *  before a session even exists. */
const container = document.getElementById('root');
if (container !== null) {
  createRoot(container).render(
    <StrictMode>
      <LangProvider>
        <App />
      </LangProvider>
    </StrictMode>,
  );
}
