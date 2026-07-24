/**
 * The default provider set: every pi-ai built-in. Split from `providers.ts`
 * so the `providers/all` catalog import only enters a build that actually
 * uses the default — generated entries with a configured `providers` list
 * import the listed factories instead and never reference this module.
 */

import { builtinProviders } from '@earendil-works/pi-ai/providers/all';
import { hasProvider, setProvider } from './providers.ts';

/**
 * Register every pi-ai built-in provider, skipping IDs that are already
 * registered so user `setProvider()` calls win regardless of ordering.
 */
export function registerDefaultProviders(): void {
	for (const provider of builtinProviders()) {
		if (!hasProvider(provider.id)) setProvider(provider);
	}
}
