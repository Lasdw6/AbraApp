import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles.css';

// The macOS title bar is hidden, so the header leaves room for the traffic lights.
if (navigator.userAgent.includes('Macintosh')) document.documentElement.classList.add('mac');

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode><App /></React.StrictMode>,
);
