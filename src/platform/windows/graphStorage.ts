// Windows v17/v9 stored Node-style or malformed drive/UNC URIs. Keep those
// identities out of the new indexes without invalidating macOS caches.
export const WINDOWS_GRAPH_STORAGE_VERSIONS = { cache: 18, native: 10 } as const;
