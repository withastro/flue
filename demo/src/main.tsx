import { FlueProvider } from '@flue/react'
import { RouterProvider } from '@tanstack/react-router'
import { StrictMode, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { router } from './router'
import { ConversationsProvider } from './state/conversations'
import { PreferencesProvider } from './state/preferences'
import { SettingsProvider, useSettings } from './state/settings'

// The shadcn chat components are styled by the Luma `cn-*` classes, which are
// scoped under `.style-luma`. Apply it once at the document root.
document.documentElement.classList.add('style-luma')

// Follow the OS colour scheme (no manual toggle in v1).
function applyTheme() {
  const dark = window.matchMedia('(prefers-color-scheme: dark)').matches
  document.documentElement.classList.toggle('dark', dark)
}
applyTheme()
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme)

function FlueClientBridge({ children }: { children: ReactNode }) {
  const { client } = useSettings()
  return <FlueProvider client={client}>{children}</FlueProvider>
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <SettingsProvider>
      <FlueClientBridge>
        <ConversationsProvider>
          <PreferencesProvider>
            <RouterProvider router={router} />
          </PreferencesProvider>
        </ConversationsProvider>
      </FlueClientBridge>
    </SettingsProvider>
  </StrictMode>,
)
