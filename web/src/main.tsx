import { render } from 'preact';
import { App } from './app.js';
import './fonts.css';
import './styles.css';

render(<App />, document.getElementById('app')!);
