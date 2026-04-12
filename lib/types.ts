import type HTTPServer from './servers/http.ts';
import type { Browser, Page } from 'playwright-core';
import type { ChildProcess } from 'node:child_process';
import type { Buffer } from 'node:buffer';

export interface Counter {
  testCount: number;
  failCount: number;
  skipCount: number;
  passCount: number;
  errorCount: number;
}

export type FSTree = Record<string, null>;

export interface CachedContent {
  allTestCode: Buffer | string | null;
  filteredTestCode?: Buffer | string;
  assets: Set<string>;
  htmlPathsToRunTests: string[];
  mainHTML: { filePath: string | null; html: string | null };
  staticHTMLs: Record<string, string>;
  dynamicContentHTMLs: Record<string, string>;
}

export interface Config {
  output: string;
  timeout: number;
  failFast: boolean;
  port: number;
  portExplicit?: boolean;
  extensions: string[];
  browser: 'chromium' | 'firefox' | 'webkit';
  projectRoot: string;
  inputs: string[];
  htmlPaths: string[];
  testFileLookupPaths: string[];
  fsTree: FSTree;
  before?: string | false;
  after?: string | false;
  watch?: boolean;
  open?: boolean | string;
  debug?: boolean;
  COUNTER: Counter;
  lastFailedTestFiles: string[] | null;
  lastRanTestFiles: string[] | null;
  _testRunDone: (() => void) | null;
  _resetTestTimeout: (() => void) | null;
  _onWsOpen: (() => void) | null;
  _onTestsJsServed: (() => void) | null;
  _groupMode?: boolean;
  _phase?: 'bundling' | 'connecting' | 'loading' | 'running' | 'done';
  _building?: boolean;
  _pendingBuildTrigger?: (() => void) | null;
  _justAddedFiles?: Set<string>;
  _lastBuildEndMs?: number;
  expressApp?: unknown;
}

export interface Connections {
  server: HTTPServer;
  browser: Browser;
  page: Page;
}

export interface EarlyChrome {
  proc: ChildProcess;
  cdpEndpoint: string;
  /** Kills Chrome and awaits async temp-dir cleanup. Call before process.exit(). */
  shutdown: () => Promise<void>;
}
