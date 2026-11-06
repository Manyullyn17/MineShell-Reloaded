import { unchangedAnswer } from '#lib/shared/keeppage.js';

// Kit reads the page's data through window.fetch so that it can be wrapped like this.
export function init() {
	const browserFetch = window.fetch;
	window.fetch = (input, options) =>
		browserFetch(input, options).catch((err) => {
			const answer = typeof input === 'string' ? unchangedAnswer(input, location.href) : null;
			if (answer) return answer;
			throw err;
		});
}
