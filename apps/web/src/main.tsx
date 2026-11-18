import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import './index.css';
import { isFramed } from './lib/origin.ts';
import { initTheme } from './lib/theme.ts';

// Theme first, before anything renders: the CSP forbids an inline <script>, and this module runs
// before the first React commit, so there is no light-mode flash for people who chose dark.
initTheme();

// Clickjacking guard (lib/origin.ts isFramed): people paste API tokens here, so the app refuses
// to render inside someone else's frame wherever the frame-ancestors header cannot be relied on.
const root = document.getElementById('root')!;
if (import.meta.env.PROD && isFramed()) {
  root.textContent = 'This app cannot run inside a frame. Open it directly in a browser tab.';
} else {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
