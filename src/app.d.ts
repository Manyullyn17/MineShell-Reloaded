declare global {
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
