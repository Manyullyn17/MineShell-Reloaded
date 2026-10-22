/** Backup copies of snapshots (lib/server/backups.ts), as the forms see them. */
export type BackupCopy = 'all' | 'scheduled';

export const BACKUP_COPY_CHOICES: { value: BackupCopy; label: string }[] = [
	{ value: 'all', label: 'Every full snapshot' },
	{ value: 'scheduled', label: 'Scheduled ones and ones taken by hand' }
];
