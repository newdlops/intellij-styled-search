use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FileChangeKind {
    Create,
    Modify,
    Rename,
    Delete,
}

#[derive(Clone, Debug)]
pub struct FileChange {
    pub kind: FileChangeKind,
    pub rel_path: String,
    pub new_rel_path: Option<String>,
}

#[derive(Clone, Debug, Default)]
pub struct ChangeBatch {
    pub generation: u64,
    pub committed_unix_secs: u64,
    pub changes: Vec<FileChange>,
}

impl ChangeBatch {
    pub fn is_empty(&self) -> bool {
        self.changes.is_empty()
    }
}

pub fn build_change_batch(
    current_generation: u64,
    changed_paths: &[String],
    deleted_paths: &[String],
    renamed_paths: &[(String, String)],
) -> ChangeBatch {
    let mut changes = Vec::new();
    for rel_path in changed_paths {
        changes.push(FileChange {
            kind: FileChangeKind::Modify,
            rel_path: normalize_rel_path(rel_path),
            new_rel_path: None,
        });
    }
    for rel_path in deleted_paths {
        changes.push(FileChange {
            kind: FileChangeKind::Delete,
            rel_path: normalize_rel_path(rel_path),
            new_rel_path: None,
        });
    }
    for (old_path, new_path) in renamed_paths {
        changes.push(FileChange {
            kind: FileChangeKind::Rename,
            rel_path: normalize_rel_path(old_path),
            new_rel_path: Some(normalize_rel_path(new_path)),
        });
    }

    ChangeBatch {
        generation: current_generation.saturating_add(1),
        committed_unix_secs: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|value| value.as_secs())
            .unwrap_or(0),
        changes,
    }
}

pub fn normalize_rel_path(path: &str) -> String {
    let mut out = Vec::new();
    let normalized = path.replace('\\', "/");
    for part in normalized.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                out.pop();
            }
            value => out.push(value),
        }
    }
    out.join("/")
}

#[cfg(test)]
mod tests {
    use super::{build_change_batch, normalize_rel_path, FileChangeKind};

    #[test]
    fn normalizes_paths_and_generates_next_generation() {
        let batch = build_change_batch(
            4,
            &[String::from("./src\\a.rs")],
            &[String::from("src/old.rs")],
            &[(
                String::from("src/before.rs"),
                String::from("./src/after.rs"),
            )],
        );
        assert_eq!(batch.generation, 5);
        assert_eq!(batch.changes[0].kind, FileChangeKind::Modify);
        assert_eq!(batch.changes[0].rel_path, "src/a.rs");
        assert_eq!(
            batch.changes[2].new_rel_path.as_deref(),
            Some("src/after.rs")
        );
        assert_eq!(normalize_rel_path("src/foo/../bar.rs"), "src/bar.rs");
    }
}
