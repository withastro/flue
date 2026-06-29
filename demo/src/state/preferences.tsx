import { createContext, type ReactNode, useContext, useMemo, useState } from 'react'
import { loadJSON, saveJSON, STORAGE_KEYS } from '@/lib/storage'

/** Local-only display preferences (not tied to a connection). */
interface Preferences {
  /**
   * Show the model's reasoning. Off by default: reasoning is hidden and only a
   * transient "Thinking…" indicator appears while the agent works.
   */
  showThinking: boolean
}

const DEFAULTS: Preferences = { showThinking: false }

interface PreferencesContextValue extends Preferences {
  setShowThinking: (value: boolean) => void
}

const PreferencesContext = createContext<PreferencesContextValue | undefined>(undefined)

export function PreferencesProvider({ children }: { children: ReactNode }) {
  const [prefs, setPrefs] = useState<Preferences>(() =>
    loadJSON<Preferences>(STORAGE_KEYS.preferences, DEFAULTS),
  )

  const value = useMemo<PreferencesContextValue>(
    () => ({
      ...prefs,
      setShowThinking: (showThinking) => {
        const next = { ...prefs, showThinking }
        setPrefs(next)
        saveJSON(STORAGE_KEYS.preferences, next)
      },
    }),
    [prefs],
  )

  return <PreferencesContext.Provider value={value}>{children}</PreferencesContext.Provider>
}

export function usePreferences(): PreferencesContextValue {
  const value = useContext(PreferencesContext)
  if (!value) throw new Error('usePreferences() must be used within a PreferencesProvider')
  return value
}
