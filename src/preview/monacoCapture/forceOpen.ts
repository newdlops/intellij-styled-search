import * as vscode from 'vscode';
import { findWorkspaceFilesDirect } from '../../fileDiscovery';
import type { MonacoCaptureRuntime } from './types';

export type ForceOpenCapturePhase = {
  startedAt: number;
  findFilesMs: number;
  showTextDocumentMs: number;
  pollMs: number;
  closeMs: number;
  pollIters: number;
  pollPeekMaxMs: number;
  forceOpenedCloseTargets: vscode.Tab[];
};

export async function forceOpenEditorForCapture(
  runtime: MonacoCaptureRuntime,
  forceOpenUri: vscode.Uri | undefined,
  peekAll: (stage: string, silent?: boolean) => Promise<Map<number, string>>,
  shouldContinue: () => boolean = () => true,
): Promise<ForceOpenCapturePhase> {
  const startedAt = Date.now();
  let findFilesMs = 0;
  let showTextDocumentMs = 0;
  let pollMs = 0;
  let closeMs = 0;
  let pollIters = 0;
  let pollPeekMaxMs = 0;
  const forceOpenedCloseTargets: vscode.Tab[] = [];
  let preExistingUris = new Set<string>();
  let captureUriStr: string | undefined;

  try {
    if (!shouldContinue()) {
      return emptyForceOpenCapturePhase(startedAt);
    }
    const tFind0 = Date.now();
    preExistingUris = collectOpenTabUris();
    const fileUri = forceOpenUri ?? await findCaptureCandidateUri(preExistingUris);
    findFilesMs = Date.now() - tFind0;

    let captureDoc: vscode.TextDocument | undefined;
    if (fileUri && shouldContinue()) {
      const userAlreadyHadThisTab = preExistingUris.has(fileUri.toString());
      captureDoc = userAlreadyHadThisTab
        ? await vscode.workspace.openTextDocument({
          language: 'typescript',
          content: '// IntelliJ Styled Search capture buffer\n',
        })
        : await vscode.workspace.openTextDocument(fileUri);
      captureUriStr = captureDoc.uri.toString();
      runtime.setLastCaptureDiagnosticOpenUri(captureUriStr);
      runtime.log(
        `Capture diagnostic: opening ${captureUriStr}` +
        (userAlreadyHadThisTab ? ` (capture-only fallback; requested ${fileUri.toString()} is already open)` : ''),
      );

      if (!shouldContinue()) {
        return emptyForceOpenCapturePhase(startedAt, { findFilesMs });
      }
      const tShow0 = Date.now();
      await vscode.window.showTextDocument(captureDoc, {
        viewColumn: vscode.ViewColumn.Beside,
        preserveFocus: true,
        preview: true,
      });
      showTextDocumentMs = Date.now() - tShow0;

      const tPoll0 = Date.now();
      let sawCaptures = false;
      for (let i = 0; i < 20; i++) {
        if (!shouldContinue()) { break; }
        await new Promise((resolve) => setTimeout(resolve, 100));
        if (!shouldContinue()) { break; }
        const tPeek0 = Date.now();
        const peeked = await peekAll('poll', true);
        const peekMs = Date.now() - tPeek0;
        if (peekMs > pollPeekMaxMs) { pollPeekMaxMs = peekMs; }
        pollIters = i + 1;
        for (const value of peeked.values()) {
          const match = /widgets=(\d+)/.exec(value);
          if (match && parseInt(match[1], 10) >= 5) {
            sawCaptures = true;
            break;
          }
        }
        if (sawCaptures) { break; }
      }
      pollMs = Date.now() - tPoll0;

    } else {
      runtime.log('Capture diagnostic: no files found to open');
    }
  } catch (err) {
    runtime.log(`Capture trigger failed: ${err instanceof Error ? err.message : err}`);
  }

  // Collect introduced tabs even when showTextDocument/polling throws or the
  // request is cancelled midway, so the caller can always close what we added.
  if (captureUriStr) {
    const tCollectClose0 = Date.now();
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        const input = tab.input as unknown as { uri?: vscode.Uri };
        if (input?.uri && typeof input.uri.toString === 'function' &&
            input.uri.toString() === captureUriStr && !preExistingUris.has(input.uri.toString()) &&
            !forceOpenedCloseTargets.includes(tab)) {
          forceOpenedCloseTargets.push(tab);
        }
      }
    }
    closeMs += Date.now() - tCollectClose0;
  }

  return {
    startedAt,
    findFilesMs,
    showTextDocumentMs,
    pollMs,
    closeMs,
    pollIters,
    pollPeekMaxMs,
    forceOpenedCloseTargets,
  };
}

function emptyForceOpenCapturePhase(
  startedAt: number,
  timings: Partial<Pick<ForceOpenCapturePhase, 'findFilesMs' | 'showTextDocumentMs' | 'pollMs' | 'closeMs'>> = {},
): ForceOpenCapturePhase {
  return {
    startedAt,
    findFilesMs: timings.findFilesMs ?? 0,
    showTextDocumentMs: timings.showTextDocumentMs ?? 0,
    pollMs: timings.pollMs ?? 0,
    closeMs: timings.closeMs ?? 0,
    pollIters: 0,
    pollPeekMaxMs: 0,
    forceOpenedCloseTargets: [],
  };
}

export function pickBestWindowAfterForceOpen(
  peeked: Map<number, string>,
  preferredWindowId?: number,
): { id: number | null; score: number } {
  let bestWin: number | null = null;
  let bestScore = 0;
  for (const [id, peekStr] of peeked) {
    const widgetMatch = /widgets=(\d+)/.exec(peekStr);
    const serviceMatch = /services=(\d+)/.exec(peekStr);
    const ctorMatch = /ctors=(\d+)/.exec(peekStr);
    const widgetCount = widgetMatch ? parseInt(widgetMatch[1], 10) : 0;
    const svcCount = serviceMatch ? parseInt(serviceMatch[1], 10) : 0;
    const ctorCount = ctorMatch ? parseInt(ctorMatch[1], 10) : 0;
    const score = widgetCount + svcCount + ctorCount;
    if (preferredWindowId !== undefined && id === preferredWindowId && widgetCount > 0 && svcCount > 0) {
      return { id, score };
    }
    if (widgetCount > 0 && svcCount > 0 && score > bestScore) {
      bestScore = score;
      bestWin = id;
    }
  }
  return { id: bestWin, score: bestScore };
}

function collectOpenTabUris(): Set<string> {
  const preExistingUris = new Set<string>();
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const input = tab.input as unknown as { uri?: vscode.Uri };
      if (input && input.uri && typeof input.uri.toString === 'function') {
        preExistingUris.add(input.uri.toString());
      }
    }
  }
  return preExistingUris;
}

async function findCaptureCandidateUri(preExistingUris: Set<string>): Promise<vscode.Uri | undefined> {
  const candidates = await findWorkspaceFilesDirect({
    excludeGlobs: [
      '**/node_modules/**',
      '**/.git/**',
      '**/out/**',
      '**/dist/**',
      '**/build/**',
      '**/.vscode/.auto-import-cache/**',
      '**/*.vsix',
    ],
    extensions: new Set(['.json', '.md', '.txt', '.ts', '.js', '.py']),
    maxResults: 128,
  });
  return candidates.find((candidate) => !preExistingUris.has(candidate.toString()));
}
