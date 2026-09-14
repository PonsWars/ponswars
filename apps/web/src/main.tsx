import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
// The faces the tokens name, served from this origin (§36.12). The tokens
// always named them and nothing loaded them, so every headline in the product
// fell back to Arial Narrow and every paragraph to the system face. Latin only
// for the display and data faces, and only the weights the product sets:
// they are the bytes a first visit waits on.
import '@fontsource/barlow-condensed/latin-500.css';
import '@fontsource/barlow-condensed/latin-600.css';
import '@fontsource/barlow-condensed/latin-700.css';
import '@fontsource-variable/inter/wght.css';
import '@fontsource/ibm-plex-mono/latin-400.css';
import '@fontsource/ibm-plex-mono/latin-500.css';
import './styles.css';

const container = document.querySelector('#root');
if (container === null) {
  throw new Error('Root container is missing from index.html');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
