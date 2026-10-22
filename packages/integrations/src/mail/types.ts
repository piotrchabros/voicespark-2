/** YYYY-MM-DD; `from` is inclusive, `to` is inclusive (providers query up to the day after `to`). */
export interface DateRange {
  from?: string | null;
  to?: string | null;
}

/** Where an unfinished initial/resync enumeration of one folder resumes. */
export type InitialCheckpoint = { pageToken: string } | { nextLink: string } | { uidNext: number };

/** Incremental sync position of one folder. */
export type FolderCursor = { historyId: string } | { deltaLink: string } | { uidValidity: string; lastUid: number };

export interface FolderState {
  folderKey: string;
  initialCheckpoint: InitialCheckpoint | null;
  cursor: FolderCursor | null;
  initialComplete: boolean;
}

export interface MailFolder {
  folderKey: string;
  name: string;
  /** Messages in this folder were written by the mailbox owner (Sent). */
  authored: boolean;
}

export interface MailRef {
  providerRef: string;
  folderKey: string;
}

export interface MailPageResult {
  refs: MailRef[];
  state: FolderState;
  folderDone: boolean;
  totalEstimate?: number;
}

export interface FetchedMessage {
  raw: Buffer;
  folders: string[];
  isSent: boolean;
}

export type ImportMode = 'initial' | 'incremental' | 'resync';

export interface MailFetcher {
  readonly provider: 'gmail' | 'microsoft' | 'imap';
  getAddress(): Promise<string>;
  listFolders(): Promise<MailFolder[]>;
  /**
   * `initial`/`resync` enumerate the date range from `initialCheckpoint` (null = start); when the folder is exhausted the
   * result has `folderDone`, `state.initialComplete` and `state.cursor` set. `incremental` reads from `cursor` and
   * returns the advanced cursor.
   */
  listPage(folder: FolderState, opts: { mode: ImportMode; dateRange: DateRange; limit: number }): Promise<MailPageResult>;
  /** Keyed by providerRef. Auth and rate-limit errors reject the whole call; other per-message failures are values. */
  fetchMessages(refs: MailRef[]): Promise<Map<string, FetchedMessage | Error>>;
  close(): Promise<void>;
}

export interface OAuthTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  scopes: string[];
}

export interface TokenProvider {
  get(): Promise<string>;
  /** Throws MailAuthError on invalid_grant. */
  refresh(): Promise<string>;
}
