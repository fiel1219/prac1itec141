import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './responsive.css'
import AuthGate from './AuthGate.jsx'

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js'))
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <AuthGate />
  </StrictMode>,
)
