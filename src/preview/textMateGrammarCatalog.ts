import { createHash } from 'crypto';
import * as vscode from 'vscode';

export const PREVIEW_TEXT_MATE_GRAMMAR_PROTOCOL_VERSION = 1 as const;
export const DEFAULT_PREVIEW_TEXT_MATE_GRAMMAR_MAX_ASSET_BYTES = 5 * 1024 * 1024;

const MAX_CONTRIBUTIONS_PER_EXTENSION = 4_096;
const MAX_TOTAL_LANGUAGE_CONTRIBUTIONS = 8_192;
const MAX_TOTAL_GRAMMAR_CONTRIBUTIONS = 8_192;
const MAX_TOTAL_INJECTION_LINKS = 32_768;
const MAX_INJECTION_TARGETS_PER_GRAMMAR = 256;
const MAX_LANGUAGE_METADATA_VALUES = 1_024;
const MAX_CONFIGURATION_ENTRIES = 1_024;
const MAX_CONTRIBUTION_PATH_LENGTH = 16_384;
const MAX_MANIFEST_STRING_LENGTH = 16_384;
const MAX_SCOPE_NAME_LENGTH = 2_048;
const MAX_LANGUAGE_ID_LENGTH = 256;
const MAX_LANGUAGE_METADATA_STRING_LENGTH = 4_096;

export type PreviewTextMateTokenType = 'string' | 'comment' | 'other' | 'regex';

export interface PreviewTextMateLanguageMetadata {
  aliases: string[];
  extensions: string[];
  filenames: string[];
  firstLine?: string;
}

export interface PreviewTextMateGrammarConfiguration {
  embeddedLanguages: Record<string, string>;
  tokenTypes: Record<string, PreviewTextMateTokenType>;
  balancedBracketScopes: string[];
  unbalancedBracketScopes: string[];
}

/**
 * A metadata-only catalog. Raw grammar bodies are deliberately omitted and
 * can only be requested later through their opaque asset IDs.
 */
export interface PreviewTextMateGrammarCatalog {
  protocolVersion: typeof PREVIEW_TEXT_MATE_GRAMMAR_PROTOCOL_VERSION;
  generation: number;
  fingerprint: string;
  languageId: string;
  rootScopeName: string;
  rootAssetId: string;
  scopeAssets: Record<string, string>;
  injections: Record<string, string[]>;
  language: PreviewTextMateLanguageMetadata;
  configuration: PreviewTextMateGrammarConfiguration;
}

export interface PreviewTextMateGrammarAsset {
  generation: number;
  assetId: string;
  bytes: Uint8Array;
  sha256: string;
  /** A synthetic name that only communicates JSON versus plist parsing. */
  pathHint: 'grammar.json' | 'grammar.plist';
}

export type TextMateGrammarAssetErrorCode =
  | 'stale-generation'
  | 'unknown-asset'
  | 'asset-too-large'
  | 'asset-unreadable';

export class TextMateGrammarAssetError extends Error {
  constructor(
    readonly code: TextMateGrammarAssetErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'TextMateGrammarAssetError';
  }
}

interface GrammarAssetDescriptor {
  readonly assetId: string;
  readonly uri: vscode.Uri;
  readonly pathHint: PreviewTextMateGrammarAsset['pathHint'];
}

interface LanguageRootDescriptor {
  readonly scopeName: string;
  readonly configuration: PreviewTextMateGrammarConfiguration;
}

interface CatalogIndex {
  readonly generation: number;
  readonly fingerprint: string;
  readonly registeredLanguages: ReadonlySet<string>;
  readonly languages: ReadonlyMap<string, PreviewTextMateLanguageMetadata>;
  readonly roots: ReadonlyMap<string, LanguageRootDescriptor>;
  readonly scopeAssets: ReadonlyMap<string, string>;
  readonly injections: ReadonlyMap<string, readonly string[]>;
  readonly assets: ReadonlyMap<string, GrammarAssetDescriptor>;
}

interface CatalogBuildState {
  languages: Map<string, PreviewTextMateLanguageMetadata>;
  roots: Map<string, LanguageRootDescriptor>;
  scopeAssets: Map<string, string>;
  injections: Map<string, string[]>;
  assets: Map<string, GrammarAssetDescriptor>;
}

/**
 * Validates a package.json contribution path and returns URI-safe relative
 * path segments. A leading `./` is accepted because it is conventional in
 * VS Code extension manifests.
 */
export function splitTextMateContributionPath(value: unknown): string[] | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_CONTRIBUTION_PATH_LENGTH) {
    return undefined;
  }
  if (value.includes('\0') || value.startsWith('/') || value.startsWith('\\')) {
    return undefined;
  }
  // Reject URI schemes as well as Windows drive-qualified paths.
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)) {
    return undefined;
  }

  const result: string[] = [];
  for (const segment of value.split(/[\\/]/)) {
    if (segment.length === 0 || segment === '.') {
      continue;
    }
    if (segment === '..' || isEncodedTraversalSegment(segment)) {
      return undefined;
    }
    result.push(segment);
  }
  return result.length > 0 ? result : undefined;
}

/**
 * Resolves injection scope names using VS Code's TextMate prefix semantics.
 * For `source.lang.embedded`, entries registered for `source`,
 * `source.lang`, and `source.lang.embedded` are concatenated in that order.
 */
export function resolveTextMateGrammarInjections(
  injections: Readonly<Record<string, readonly string[]>>,
  scopeName: string,
): string[] {
  if (!scopeName) {
    return [];
  }
  const result: string[] = [];
  const parts = scopeName.split('.');
  for (let length = 1; length <= parts.length; length += 1) {
    const values = injections[parts.slice(0, length).join('.')];
    if (Array.isArray(values)) {
      result.push(...values);
    }
  }
  return result;
}

/**
 * Discovers TextMate grammar contributions without activating their owning
 * extensions. It subscribes to extension-set changes and invalidates all
 * previously issued asset generations when the installed/enabled set changes.
 */
export class TextMateGrammarCatalog implements vscode.Disposable {
  private generation = 1;
  private indexPromise: Promise<CatalogIndex> | undefined;
  private readonly assetReads = new Map<string, Promise<PreviewTextMateGrammarAsset>>();
  private readonly extensionChangeSubscription: vscode.Disposable;
  private readonly invalidateEmitter = new vscode.EventEmitter<void>();
  readonly onDidInvalidate = this.invalidateEmitter.event;

  constructor(
    private readonly maxAssetBytes = DEFAULT_PREVIEW_TEXT_MATE_GRAMMAR_MAX_ASSET_BYTES,
  ) {
    if (!Number.isSafeInteger(maxAssetBytes) || maxAssetBytes <= 0) {
      throw new RangeError('TextMate grammar asset size limit must be a positive safe integer.');
    }
    this.extensionChangeSubscription = vscode.extensions.onDidChange(() => this.invalidate());
  }

  async getCatalog(languageId: string): Promise<PreviewTextMateGrammarCatalog | undefined> {
    if (typeof languageId !== 'string' || languageId.length === 0) {
      return undefined;
    }
    const index = await this.getCurrentIndex();
    if (!index.registeredLanguages.has(languageId)) {
      return undefined;
    }
    const root = index.roots.get(languageId);
    if (!root) {
      return undefined;
    }
    const rootAssetId = index.scopeAssets.get(root.scopeName);
    if (!rootAssetId) {
      return undefined;
    }

    return {
      protocolVersion: PREVIEW_TEXT_MATE_GRAMMAR_PROTOCOL_VERSION,
      generation: index.generation,
      fingerprint: index.fingerprint,
      languageId,
      rootScopeName: root.scopeName,
      rootAssetId,
      scopeAssets: recordFromStringMap(index.scopeAssets),
      injections: recordFromArrayMap(index.injections),
      language: cloneLanguageMetadata(index.languages.get(languageId)),
      configuration: cloneGrammarConfiguration(root.configuration),
    };
  }

  async getAsset(generation: number, assetId: string): Promise<PreviewTextMateGrammarAsset> {
    this.assertCurrentGeneration(generation);
    const index = await this.getCurrentIndex();
    this.assertCurrentGeneration(generation);
    if (index.generation !== generation) {
      throw staleGenerationError();
    }
    const descriptor = index.assets.get(assetId);
    if (!descriptor) {
      throw new TextMateGrammarAssetError('unknown-asset', 'Unknown TextMate grammar asset.');
    }

    const cacheKey = `${generation}:${assetId}`;
    let read = this.assetReads.get(cacheKey);
    if (!read) {
      read = this.readAsset(index, descriptor);
      this.assetReads.set(cacheKey, read);
      void read.catch(() => {
        if (this.assetReads.get(cacheKey) === read) {
          this.assetReads.delete(cacheKey);
        }
      });
    }
    const asset = await read;
    this.assertCurrentGeneration(generation);
    return { ...asset, bytes: asset.bytes.slice() };
  }

  invalidate(): void {
    this.generation += 1;
    this.indexPromise = undefined;
    this.assetReads.clear();
    this.invalidateEmitter.fire();
  }

  dispose(): void {
    this.extensionChangeSubscription.dispose();
    this.generation += 1;
    this.indexPromise = undefined;
    this.assetReads.clear();
    this.invalidateEmitter.dispose();
  }

  private async getCurrentIndex(): Promise<CatalogIndex> {
    for (;;) {
      const generation = this.generation;
      let promise = this.indexPromise;
      if (!promise) {
        promise = this.buildIndex(generation);
        this.indexPromise = promise;
      }
      let index: CatalogIndex;
      try {
        index = await promise;
      } catch (error) {
        if (this.indexPromise === promise) {
          this.indexPromise = undefined;
        }
        throw error;
      }
      if (generation === this.generation && index.generation === generation) {
        return index;
      }
    }
  }

  private async buildIndex(generation: number): Promise<CatalogIndex> {
    const registeredLanguages = new Set(await vscode.languages.getLanguages());
    const state: CatalogBuildState = {
      languages: new Map(),
      roots: new Map(),
      scopeAssets: new Map(),
      injections: new Map(),
      assets: new Map(),
    };
    const fingerprint = createHash('sha256');
    let languageContributionCount = 0;
    let grammarContributionCount = 0;
    let injectionLinkCount = 0;
    fingerprint.update(JSON.stringify([
      'preview-textmate-catalog',
      PREVIEW_TEXT_MATE_GRAMMAR_PROTOCOL_VERSION,
      vscode.version,
    ])).update('\0');

    for (const extension of vscode.extensions.all) {
      const packageJson = asRecord(extension.packageJSON);
      const contributes = asRecord(packageJson?.contributes);
      fingerprint.update(JSON.stringify([
        extension.id,
        manifestString(packageJson?.version) ?? '',
        extension.extensionUri.toString(),
      ])).update('\0');

      const languages = Array.isArray(contributes?.languages) &&
        languageContributionCount < MAX_TOTAL_LANGUAGE_CONTRIBUTIONS
        ? contributes.languages.slice(0, Math.min(
          MAX_CONTRIBUTIONS_PER_EXTENSION,
          MAX_TOTAL_LANGUAGE_CONTRIBUTIONS - languageContributionCount,
        ))
        : [];
      for (const value of languages) {
        languageContributionCount += 1;
        const contribution = asRecord(value);
        const id = manifestString(contribution?.id, MAX_LANGUAGE_ID_LENGTH);
        if (!contribution || !id || !registeredLanguages.has(id)) {
          continue;
        }
        const metadata = sanitizeLanguageMetadata(contribution);
        state.languages.set(id, metadata);
        fingerprint.update(JSON.stringify(['language', extension.id, id, metadata])).update('\0');
      }

      const grammars = Array.isArray(contributes?.grammars) &&
        grammarContributionCount < MAX_TOTAL_GRAMMAR_CONTRIBUTIONS
        ? contributes.grammars.slice(0, Math.min(
          MAX_CONTRIBUTIONS_PER_EXTENSION,
          MAX_TOTAL_GRAMMAR_CONTRIBUTIONS - grammarContributionCount,
        ))
        : [];
      for (const value of grammars) {
        grammarContributionCount += 1;
        const contribution = asRecord(value);
        const scopeName = manifestString(contribution?.scopeName, MAX_SCOPE_NAME_LENGTH);
        const pathSegments = splitTextMateContributionPath(contribution?.path);
        if (!contribution || !scopeName || !pathSegments) {
          continue;
        }

        const assetId = grammarAssetId(extension.id, pathSegments);
        const uri = vscode.Uri.joinPath(extension.extensionUri, ...pathSegments);
        const pathHint = pathSegments[pathSegments.length - 1].toLowerCase().endsWith('.json')
          ? 'grammar.json' as const
          : 'grammar.plist' as const;
        state.assets.set(assetId, { assetId, uri, pathHint });
        // Map.set intentionally implements VS Code's encounter-order, last-wins
        // behavior for duplicate scope names.
        state.scopeAssets.set(scopeName, assetId);

        const remainingInjectionLinks = Math.max(0, MAX_TOTAL_INJECTION_LINKS - injectionLinkCount);
        const injectTo = manifestStringArray(
          contribution?.injectTo,
          Math.min(MAX_INJECTION_TARGETS_PER_GRAMMAR, remainingInjectionLinks),
          MAX_SCOPE_NAME_LENGTH,
        );
        injectionLinkCount += injectTo.length;
        for (const targetScope of injectTo) {
          let injectionScopes = state.injections.get(targetScope);
          if (!injectionScopes) {
            injectionScopes = [];
            state.injections.set(targetScope, injectionScopes);
          }
          // Injection registration order affects TextMate selector precedence.
          injectionScopes.push(scopeName);
        }

        const languageId = manifestString(contribution?.language, MAX_LANGUAGE_ID_LENGTH);
        const configuration = sanitizeGrammarConfiguration(contribution, registeredLanguages);
        if (languageId && registeredLanguages.has(languageId)) {
          state.roots.set(languageId, { scopeName, configuration });
        }
        fingerprint.update(JSON.stringify([
          'grammar', extension.id, scopeName, assetId, injectTo,
          languageId ?? '', configuration,
        ])).update('\0');
      }
    }

    // Assets shadowed by a later contribution cannot be reached through the
    // catalog and must not remain requestable by a guessed identifier.
    const reachableAssetIds = new Set(state.scopeAssets.values());
    const assets = new Map(
      Array.from(state.assets).filter(([assetId]) => reachableAssetIds.has(assetId)),
    );

    return {
      generation,
      fingerprint: fingerprint.digest('hex'),
      registeredLanguages,
      languages: state.languages,
      roots: state.roots,
      scopeAssets: state.scopeAssets,
      injections: state.injections,
      assets,
    };
  }

  private async readAsset(
    index: CatalogIndex,
    descriptor: GrammarAssetDescriptor,
  ): Promise<PreviewTextMateGrammarAsset> {
    this.assertCurrentGeneration(index.generation);
    try {
      const stat = await vscode.workspace.fs.stat(descriptor.uri);
      this.assertCurrentGeneration(index.generation);
      if (stat.size > this.maxAssetBytes) {
        throw new TextMateGrammarAssetError(
          'asset-too-large',
          `TextMate grammar asset exceeds the ${this.maxAssetBytes} byte limit.`,
        );
      }
      const bytes = await vscode.workspace.fs.readFile(descriptor.uri);
      this.assertCurrentGeneration(index.generation);
      if (bytes.byteLength > this.maxAssetBytes) {
        throw new TextMateGrammarAssetError(
          'asset-too-large',
          `TextMate grammar asset exceeds the ${this.maxAssetBytes} byte limit.`,
        );
      }
      return {
        generation: index.generation,
        assetId: descriptor.assetId,
        bytes: bytes.slice(),
        sha256: createHash('sha256').update(bytes).digest('hex'),
        pathHint: descriptor.pathHint,
      };
    } catch (error) {
      if (error instanceof TextMateGrammarAssetError) {
        throw error;
      }
      throw new TextMateGrammarAssetError('asset-unreadable', 'Unable to read TextMate grammar asset.');
    }
  }

  private assertCurrentGeneration(generation: number): void {
    if (generation !== this.generation) {
      throw staleGenerationError();
    }
  }
}

function isEncodedTraversalSegment(segment: string): boolean {
  if (!segment.includes('%')) {
    return false;
  }
  try {
    const decoded = decodeURIComponent(segment);
    return decoded === '.' || decoded === '..' || decoded.includes('/') || decoded.includes('\\');
  } catch {
    return true;
  }
}

function staleGenerationError(): TextMateGrammarAssetError {
  return new TextMateGrammarAssetError(
    'stale-generation',
    'TextMate grammar catalog generation is stale.',
  );
}

function grammarAssetId(extensionId: string, pathSegments: readonly string[]): string {
  const digest = createHash('sha256')
    .update(extensionId)
    .update('\0')
    .update(pathSegments.join('/'))
    .digest('hex');
  return `tm-${digest}`;
}

function sanitizeLanguageMetadata(value: Record<string, unknown>): PreviewTextMateLanguageMetadata {
  const firstLine = manifestString(value.firstLine);
  return {
    aliases: manifestStringArray(value.aliases, MAX_LANGUAGE_METADATA_VALUES, MAX_LANGUAGE_METADATA_STRING_LENGTH),
    extensions: manifestStringArray(value.extensions, MAX_LANGUAGE_METADATA_VALUES, MAX_LANGUAGE_METADATA_STRING_LENGTH),
    filenames: manifestStringArray(value.filenames, MAX_LANGUAGE_METADATA_VALUES, MAX_LANGUAGE_METADATA_STRING_LENGTH),
    ...(firstLine ? { firstLine } : {}),
  };
}

function sanitizeGrammarConfiguration(
  contribution: Record<string, unknown>,
  registeredLanguages: ReadonlySet<string>,
): PreviewTextMateGrammarConfiguration {
  const embeddedLanguages = new Map<string, string>();
  const rawEmbeddedLanguages = asRecord(contribution.embeddedLanguages);
  if (rawEmbeddedLanguages) {
    for (const [scope, value] of Object.entries(rawEmbeddedLanguages).slice(0, MAX_CONFIGURATION_ENTRIES)) {
      const languageId = manifestString(value, MAX_LANGUAGE_ID_LENGTH);
      if (manifestString(scope, MAX_SCOPE_NAME_LENGTH) && languageId && registeredLanguages.has(languageId)) {
        embeddedLanguages.set(scope, languageId);
      }
    }
  }

  const tokenTypes = new Map<string, PreviewTextMateTokenType>();
  const rawTokenTypes = asRecord(contribution.tokenTypes);
  if (rawTokenTypes) {
    for (const [scope, value] of Object.entries(rawTokenTypes).slice(0, MAX_CONFIGURATION_ENTRIES)) {
      if (manifestString(scope, MAX_SCOPE_NAME_LENGTH) && isTokenType(value)) {
        tokenTypes.set(scope, value);
      }
    }
  }

  return {
    embeddedLanguages: Object.fromEntries(embeddedLanguages),
    tokenTypes: Object.fromEntries(tokenTypes),
    balancedBracketScopes: contribution.balancedBracketScopes === undefined
      ? ['*']
      : manifestStringArray(contribution.balancedBracketScopes, MAX_CONFIGURATION_ENTRIES),
    unbalancedBracketScopes: manifestStringArray(
      contribution.unbalancedBracketScopes,
      MAX_CONFIGURATION_ENTRIES,
    ),
  };
}

function manifestString(value: unknown, maximum = MAX_MANIFEST_STRING_LENGTH): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
    && !value.includes('\0')
    ? value
    : undefined;
}

function manifestStringArray(value: unknown, maximum: number, maximumStringLength = MAX_MANIFEST_STRING_LENGTH): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const result: string[] = [];
  for (const entry of value.slice(0, maximum)) {
    const string = manifestString(entry, maximumStringLength);
    if (string !== undefined) {
      result.push(string);
    }
  }
  return result;
}

function isTokenType(value: unknown): value is PreviewTextMateTokenType {
  return value === 'string' || value === 'comment' || value === 'other' || value === 'regex';
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function recordFromStringMap(values: ReadonlyMap<string, string>): Record<string, string> {
  return Object.fromEntries(values);
}

function recordFromArrayMap(
  values: ReadonlyMap<string, readonly string[]>,
): Record<string, string[]> {
  return Object.fromEntries(Array.from(values, ([key, value]) => [key, [...value]]));
}

function cloneLanguageMetadata(
  value: PreviewTextMateLanguageMetadata | undefined,
): PreviewTextMateLanguageMetadata {
  return {
    aliases: value ? [...value.aliases] : [],
    extensions: value ? [...value.extensions] : [],
    filenames: value ? [...value.filenames] : [],
    ...(value?.firstLine ? { firstLine: value.firstLine } : {}),
  };
}

function cloneGrammarConfiguration(
  value: PreviewTextMateGrammarConfiguration,
): PreviewTextMateGrammarConfiguration {
  return {
    embeddedLanguages: { ...value.embeddedLanguages },
    tokenTypes: { ...value.tokenTypes },
    balancedBracketScopes: [...value.balancedBracketScopes],
    unbalancedBracketScopes: [...value.unbalancedBracketScopes],
  };
}
