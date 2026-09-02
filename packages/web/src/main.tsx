import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

/**
 * Trivial Vite entry point for the R1 repo skeleton. The real chat/approvals/tasks/connections
 * SPA (design doc §7.6) lands starting with S1.
 */
function App() {
  return <p>NextTime AI web — skeleton placeholder (design doc §7.6).</p>;
}

const container = document.getElementById('root');
if (container !== null) {
  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
