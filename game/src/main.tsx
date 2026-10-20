import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import { registerPwa } from './features/offline-sync/register-pwa';

registerPwa();

// Nhung trong tab Tro choi cua AIV Bank (iframe cung origin): thu vung choi ve
// cung co chu voi trang chu (game-learning.css, `.jelly-embedded`). Gan TRUOC
// render de khong nhay co. Mo thang /game/ thi giu ti le 1.
try {
  if (window.self !== window.top) document.documentElement.classList.add('jelly-embedded');
} catch {
  // Khac origin thi truy cap window.top nem loi - van la dang bi nhung.
  document.documentElement.classList.add('jelly-embedded');
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
