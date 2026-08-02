import { render } from 'preact';
import { App } from './app.js';
import { ErrorBoundary } from './error-boundary.js';
import './fonts.css';
import './styles.css';

render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
  document.getElementById('app')!,
);
