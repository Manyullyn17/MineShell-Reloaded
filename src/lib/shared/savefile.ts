/**
 * Saves what `url` answers without leaving the page. `location.assign` looks the same for an
 * attachment, but it starts a navigation: Firefox then ends the page's running requests, and a
 * reload of its data that gets cut off replaces the page with Kit's error page. The empty
 * `download` keeps the name the response gives.
 */
export function saveFile(url: string) {
	const link = document.createElement('a');
	link.href = url;
	link.download = '';
	link.click();
}
