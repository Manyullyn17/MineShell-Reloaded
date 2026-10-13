declare global {
	/** package.json's version, set by vite.config.ts. */
	const __MINESHELL_VERSION__: string;

	namespace App {
		interface Locals {
			authenticated: boolean;
			authRequired: boolean;
			/** The signed-in account; null when signed out, and with MINESHELL_AUTH=off. */
			user: import('#lib/server/auth.js').SessionUser | null;
		}
		interface PageData {
			flash?: { type: 'success' | 'error' | 'info' | 'warning'; message: string } | null;
		}
	}
}

export {};
