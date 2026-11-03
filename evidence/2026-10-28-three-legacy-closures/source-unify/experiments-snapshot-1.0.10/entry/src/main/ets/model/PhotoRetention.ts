export interface PrivatePhotoEntry {
  fileName: string;
  mtimeSeconds: number;
}

const PRIVATE_PHOTO_PATTERN: RegExp = /^eldercare-[0-9]{1,16}\.jpg$/;

export function isPrivatePhotoName(fileName: string): boolean {
  return PRIVATE_PHOTO_PATTERN.test(fileName);
}

export function selectPrivatePhotosToDelete(entries: PrivatePhotoEntry[], protectedName: string,
  maxCount: number = 100): string[] {
  const validEntries: PrivatePhotoEntry[] = entries.filter((entry: PrivatePhotoEntry): boolean =>
    isPrivatePhotoName(entry.fileName));
  const survivors: PrivatePhotoEntry[] = validEntries.filter((entry: PrivatePhotoEntry): boolean =>
    entry.fileName !== protectedName);
  survivors.sort((left: PrivatePhotoEntry, right: PrivatePhotoEntry): number => {
    if (left.mtimeSeconds !== right.mtimeSeconds) {
      return right.mtimeSeconds - left.mtimeSeconds;
    }
    return right.fileName.localeCompare(left.fileName);
  });

  const protectedExists: boolean = validEntries.some((entry: PrivatePhotoEntry): boolean =>
    entry.fileName === protectedName);
  const availableSlots: number = Math.max(0, maxCount - (protectedExists ? 1 : 0));
  const deletions: string[] = [];
  survivors.slice(availableSlots).forEach((entry: PrivatePhotoEntry): void => {
    deletions.push(entry.fileName);
  });
  return deletions.sort();
}
