/** What each kind of server port is for, as the Ports tab and its messages name it. */
export const PORT_KIND_LABELS = {
	game: 'Minecraft',
	rcon: 'RCON',
	query: 'Query',
	voice: 'Voice chat',
	map: 'Map mod'
} as const;

export type PortKind = keyof typeof PORT_KIND_LABELS;
