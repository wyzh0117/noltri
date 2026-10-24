export interface NoteIdentity {
  topicId: string;
  chapterId: string | null;
}

export interface NoteDraft extends NoteIdentity {
  /** Root which owned the loaded legacy note; absent only on drafts written before Vault scoping. */
  vaultRoot?: string;
  content: string;
  updatedAt: string;
}

const STORAGE_PREFIX = 'noltri:note-draft:v1:';

function identityKey(identity: NoteIdentity, vaultRoot?: string): string {
  const key = vaultRoot === undefined
    ? [identity.topicId, identity.chapterId]
    : [identity.topicId, identity.chapterId, vaultRoot];
  return `${STORAGE_PREFIX}${encodeURIComponent(JSON.stringify(key))}`;
}

function isNoteDraft(value: unknown): value is NoteDraft {
  if (value === null || typeof value !== 'object') return false;
  const draft = value as Partial<NoteDraft>;
  return typeof draft.topicId === 'string'
    && draft.topicId.length > 0
    && (draft.chapterId === null || (typeof draft.chapterId === 'string' && draft.chapterId.length > 0))
    && (draft.vaultRoot === undefined || (typeof draft.vaultRoot === 'string' && draft.vaultRoot.length > 0))
    && typeof draft.content === 'string'
    && typeof draft.updatedAt === 'string';
}

function readStoredDraft(key: string): NoteDraft | null {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(key) ?? 'null');
    return isNoteDraft(value) && identityKey(value, value.vaultRoot) === key ? value : null;
  } catch {
    return null;
  }
}

export function readNoteDraft(identity: NoteIdentity, vaultRoot?: string): NoteDraft | null {
  return readStoredDraft(identityKey(identity, vaultRoot));
}

export function listNoteDrafts(): NoteDraft[] {
  try {
    const drafts: NoteDraft[] = [];
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (key?.startsWith(STORAGE_PREFIX)) {
        const draft = readStoredDraft(key);
        if (draft !== null) drafts.push(draft);
      }
    }
    return drafts;
  } catch {
    return [];
  }
}

export function writeNoteDraft(draft: NoteDraft): boolean {
  try {
    window.localStorage.setItem(identityKey(draft, draft.vaultRoot), JSON.stringify(draft));
    return true;
  } catch {
    return false;
  }
}

/** Remove only the version the server accepted; newer typing may have replaced it in flight. */
export function clearNoteDraft(identity: NoteIdentity, savedContent: string, vaultRoot?: string): boolean {
  const key = identityKey(identity, vaultRoot);
  if (readStoredDraft(key)?.content !== savedContent) return true;
  try {
    window.localStorage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}
