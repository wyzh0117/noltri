import { ApiClient } from '@noltri/api-client';

export type WorkbenchApi = Pick<
  ApiClient,
  | 'health'
  | 'tree'
  | 'selectGraph'
  | 'resolveChapter'
  | 'graphNote'
  | 'listGraphNotes'
  | 'saveGraphNote'
  | 'createChapter'
  | 'connectChapter'
  | 'disconnectChapter'
  | 'nodeDetail'
  | 'search'
  | 'patchNode'
  | 'moveNode'
  | 'listItems'
  | 'createItem'
  | 'patchItem'
  | 'archiveItem'
  | 'restoreItem'
  | 'listItemRelations'
  | 'createItemRelation'
  | 'deleteItemRelation'
  | 'vaultSnapshot'
  | 'vaultSettings'
  | 'updateVaultSettings'
  | 'createVaultFolder'
  | 'openVault'
  | 'vaultFile'
  | 'getVaultAsset'
  | 'deletePreview'
  | 'saveVaultFile'
  | 'renameVaultFile'
  | 'renameVaultBlock'
  | 'deleteVaultFile'
  | 'vaultDiagnostics'
  | 'vaultMetadata'
  | 'vaultSubpath'
  | 'vaultLinks'
  | 'vaultBacklinks'
  | 'resolveVaultLink'
  | 'vaultGraph'
  | 'vaultChanges'
  | 'searchVault'
  | 'switcherVault'
  | 'vaultMatch'
  | 'vaultMentions'
  | 'vaultHistory'
  | 'vaultHistoryVersion'
  | 'restoreVaultHistory'
  | 'legacyNotePath'
>;

export interface WorkbenchEndpoint {
  readonly apiBaseUrl: string;
  readonly apiToken: string;
}

export function createWorkbenchApi(endpoint: WorkbenchEndpoint): WorkbenchApi {
  return new ApiClient({
    baseUrl: endpoint.apiBaseUrl,
    ...(endpoint.apiToken.trim() === '' ? {} : { token: endpoint.apiToken.trim() }),
    clientHint: 'desktop',
  });
}

export function describeError(error: unknown): string {
  if (typeof error === 'string' && error.trim() !== '') return error;
  if (error instanceof Error && error.message.trim() !== '') return error.message;
  return '发生未知错误。';
}
