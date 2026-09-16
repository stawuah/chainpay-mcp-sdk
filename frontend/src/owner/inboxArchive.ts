export type InboxArchiveItem = {
  id: string;
  archivedAt?: string;
};

export function isInboxItemArchived(item: InboxArchiveItem): boolean {
  return typeof item.archivedAt === "string" && item.archivedAt.length > 0;
}

export function archiveInboxItem<T extends InboxArchiveItem>(items: T[], id: string): T[] {
  const stamp = new Date().toISOString();
  return items.map((item) => item.id === id ? { ...item, archivedAt: stamp } : item);
}

export function restoreInboxItem<T extends InboxArchiveItem>(items: T[], id: string): T[] {
  return items.map((item) => item.id === id ? { ...item, archivedAt: undefined } : item);
}
