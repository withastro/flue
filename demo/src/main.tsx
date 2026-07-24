import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import { router } from './router';
import { ConversationsProvider } from './state/conversations';
import { PreferencesProvider } from './state/preferences';
import { SettingsProvider } from './state/settings';

// The shadcn chat components are styled by the Luma `cn-*` classes, which are
// scoped under `.style-luma`. Apply it once at the document root.
document.documentElement.classList.add('style-luma');

// Follow the OS colour scheme (no manual toggle in v1).
function applyTheme() {
	const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
	document.documentElement.classList.toggle('dark', dark);
}
applyTheme();
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

createRoot(document.getElementById('root')!).render(
	<StrictMode>
		<SettingsProvider>
			<ConversationsProvider>
				<PreferencesProvider>
					<RouterProvider router={router} />
				</PreferencesProvider>
			</ConversationsProvider>
		</SettingsProvider>
	</StrictMode>,
);
