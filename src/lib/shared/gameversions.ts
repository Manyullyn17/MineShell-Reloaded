/**
 * The Minecraft releases a loader has builds for, newest first, fetched in the browser for a
 * version picker (`/api/loaders/versions?kind=game`). null when the lookup failed or found
 * none: the picker then offers Mojang's whole list, and the loader version field still says
 * when the picked version has no build. Each loader is asked once per page; a failed lookup
 * is asked again the next time.
 */
const lists = new Map<string, Promise<string[] | null>>();

export function loaderGameVersions(loader: string): Promise<string[] | null> {
	let list = lists.get(loader);
	if (!list) {
		list = fetch(`/api/loaders/versions?${new URLSearchParams({ kind: 'game', loader })}`)
			.then((r) => (r.ok ? r.json() : null))
			.then((body) => (Array.isArray(body?.versions) && body.versions.length ? (body.versions as string[]) : null))
			.catch(() => null);
		lists.set(loader, list);
		void list.then((versions) => versions || lists.delete(loader));
	}
	return list;
}
