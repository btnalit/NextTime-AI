import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './styles.css';

/** Vite entry point — the chat/approvals/tasks/connections SPA (design doc §7.6). S1.8 ships
 *  login + chat; approvals/tasks/connections land with their respective S2 tasks. */
const container = document.getElementById('root');
if (container !== null) {
  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
