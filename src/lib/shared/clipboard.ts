/**
 * Puts text on the clipboard; false when the browser would not. The Clipboard
 * API only exists on secure pages (https, localhost): MineShell reached over
 * plain http by its LAN address has none, so the fallback selects the text in
 * a hidden textarea and copies it the old way. Callers say "Copied" only on true.
 */
export async function copyText(text: string): Promise<boolean> {
	try {
		await navigator.clipboard.writeText(text);
		return true;
	} catch {
		const scratch = document.createElement('textarea');
		scratch.value = text;
		scratch.setAttribute('readonly', '');
		scratch.style.position = 'fixed';
		scratch.style.opacity = '0';
		document.body.appendChild(scratch);
		scratch.select();
		try {
			return document.execCommand('copy');
		} catch {
			return false;
		} finally {
			document.body.removeChild(scratch);
		}
	}
}
