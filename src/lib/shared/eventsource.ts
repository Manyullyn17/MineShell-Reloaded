/**
 * Runs `then` when an EventSource has stopped for good. It retries by itself
 * after a dropped connection, but not after a refusal (MineShell closes a
 * stream when the account loses access, and refuses the reconnect): pages
 * then reload their data, and the guard sends them to sign-in or "No access".
 */
export function whenClosedForGood(source: EventSource, then: () => void): void {
	source.addEventListener('error', () => {
		if (source.readyState === EventSource.CLOSED) then();
	});
}
