declare global {
	/** package.json's version, set by vite.config.ts. */
	const __MINESHELL_VERSION__: string;

	namespace App {
		interface Locals {
			authenticated: boolean;
			authRequired: boolean;
		}
		interface PageData {
			flash?: { type: 'success' | 'error' | 'info' | 'warning'; message: string } | null;
		}
	}
}

export {};
