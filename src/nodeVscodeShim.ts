import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

export enum FileType {
  Unknown = 0,
  File = 1,
  Directory = 2,
  SymbolicLink = 64,
}

export class Uri {
  readonly scheme: string;
  readonly fsPath: string;

  private constructor(fsPath: string, scheme = 'file') {
    this.scheme = scheme;
    this.fsPath = path.resolve(fsPath);
  }

  static file(fsPath: string): Uri {
    return new Uri(fsPath);
  }

  static parse(value: string): Uri {
    if (value.startsWith('file:')) {
      return new Uri(fileURLToPath(value));
    }
    return new Uri(value);
  }

  static joinPath(base: Uri, ...segments: string[]): Uri {
    return new Uri(path.join(base.fsPath, ...segments));
  }

  toString(): string {
    return pathToFileURL(this.fsPath).toString();
  }
}

export class Position {
  constructor(
    readonly line: number,
    readonly character: number,
  ) {}
}

export class Range {
  constructor(
    readonly start: Position,
    readonly end: Position,
  ) {}

  contains(position: Position): boolean {
    return (
      position.line > this.start.line ||
      (position.line === this.start.line && position.character >= this.start.character)
    ) && (
      position.line < this.end.line ||
      (position.line === this.end.line && position.character <= this.end.character)
    );
  }
}

export class EventEmitter<T> {
  readonly event = () => ({ dispose() {} });
  fire(_value?: T): void {}
  dispose(): void {}
}

export const workspace = {
  workspaceFolders: [] as Array<{ uri: Uri }>,
  textDocuments: [] as Array<{ uri: Uri }>,
  fs: {
    async stat(uri: Uri): Promise<{ type: FileType; size: number; mtime: number }> {
      const stat = await fs.promises.stat(uri.fsPath);
      return {
        type: stat.isDirectory() ? FileType.Directory : FileType.File,
        size: stat.size,
        mtime: Math.trunc(stat.mtimeMs),
      };
    },
    async readFile(uri: Uri): Promise<Uint8Array> {
      return fs.promises.readFile(uri.fsPath);
    },
    async writeFile(uri: Uri, content: Uint8Array): Promise<void> {
      await fs.promises.mkdir(path.dirname(uri.fsPath), { recursive: true });
      await fs.promises.writeFile(uri.fsPath, content);
    },
    async createDirectory(uri: Uri): Promise<void> {
      await fs.promises.mkdir(uri.fsPath, { recursive: true });
    },
    async delete(uri: Uri, options?: { recursive?: boolean }): Promise<void> {
      await fs.promises.rm(uri.fsPath, { recursive: !!options?.recursive, force: true });
    },
  },
  asRelativePath(uri: Uri): string {
    return path.relative(process.cwd(), uri.fsPath);
  },
  getConfiguration() {
    return {
      get<T>(_key: string, defaultValue?: T): T | undefined {
        return defaultValue;
      },
    };
  },
  getWorkspaceFolder() {
    return undefined;
  },
  createFileSystemWatcher() {
    return { dispose() {}, onDidCreate() { return { dispose() {} }; }, onDidChange() { return { dispose() {} }; }, onDidDelete() { return { dispose() {} }; } };
  },
  onDidCreateFiles() { return { dispose() {} }; },
  onDidDeleteFiles() { return { dispose() {} }; },
  onDidRenameFiles() { return { dispose() {} }; },
  onDidSaveTextDocument() { return { dispose() {} }; },
};

export const window = {
  createStatusBarItem() {
    return { text: '', show() {}, dispose() {} };
  },
  showInformationMessage() {},
  showWarningMessage() {},
  showErrorMessage() {},
  withProgress() {},
};

export enum StatusBarAlignment {
  Left = 1,
  Right = 2,
}

export enum ProgressLocation {
  Notification = 15,
}

export const commands = {
  registerCommand() { return { dispose() {} }; },
  executeCommand() { return undefined; },
};

export interface Disposable {
  dispose(): void;
}
