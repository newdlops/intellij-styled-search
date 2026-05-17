import * as vscode from 'vscode';

export type CaptureDiagnosticOptions = {
  allowForceOpen?: boolean;
  forceOpenUri?: vscode.Uri;
  holdForceOpenedTab?: boolean;
  reason?: string;
};

export type MonacoCaptureRuntime = {
  resolveTargetWorkbenchWindowId(preferredWindowId?: number): Promise<number | undefined>;
  evalInWindow(winId: number, expr: string): Promise<string>;
  isMonacoReadyInWindow(winId: number): Promise<boolean>;
  log(message: string): void;
  setLastCaptureDiagnosticOpenUri(uri: string): void;
  holdPreviewCaptureTabs(tabs: vscode.Tab[]): void;
};
