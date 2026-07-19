use crate::config::{ripgrep_executable, EngineConfig};
use std::collections::HashSet;
use std::io;
use std::path::Path;
use std::process::Command;

const TARGETED_SCOPE_PATH_LIMIT: usize = 512;
const TARGETED_SCOPE_ARG_BYTES_LIMIT: usize = 48 * 1024;
const VERSION_CONTROL_METADATA_GLOBS: &[&str] = &[
    "!**/.git",
    "!**/.git/**",
    "!**/.hg",
    "!**/.hg/**",
    "!**/.svn",
    "!**/.svn/**",
    "!**/.jj",
    "!**/.jj/**",
];

pub fn append_file_listing_args(command: &mut Command, config: &EngineConfig) {
    append_file_listing_args_for_scope(command, config.include_ignored_files);
}

fn append_file_listing_args_for_scope(command: &mut Command, include_ignored_files: bool) {
    command.args(["--files", "--hidden", "--no-ignore-parent"]);
    if include_ignored_files {
        command.arg("--no-ignore");
    } else {
        for glob in VERSION_CONTROL_METADATA_GLOBS {
            command.arg("--glob").arg(*glob);
        }
    }
}

/// Return the existing paths that belong to the persistent workspace scope.
/// `None` means ripgrep was unavailable or could not enumerate the workspace;
/// callers conservatively keep paths in that case so an infrastructure issue
/// cannot create false-negative search results.
pub fn workspace_scope_paths(
    workspace_root: &Path,
    rel_paths: &[String],
) -> io::Result<Option<HashSet<String>>> {
    let normalized = rel_paths
        .iter()
        .map(|path| normalize_relative_path(path))
        .filter(|path| !path.is_empty())
        .collect::<HashSet<_>>();
    if normalized.is_empty() {
        return Ok(Some(HashSet::new()));
    }

    let targeted_arg_bytes = normalized.iter().map(String::len).sum::<usize>();
    let targeted = normalized.len() <= TARGETED_SCOPE_PATH_LIMIT
        && targeted_arg_bytes <= TARGETED_SCOPE_ARG_BYTES_LIMIT;
    let mut command = Command::new(ripgrep_executable());
    command.current_dir(workspace_root);
    append_file_listing_args_for_scope(&mut command, false);
    if targeted {
        let mut paths = normalized.iter().collect::<Vec<_>>();
        paths.sort();
        for path in paths {
            command.arg("--glob").arg(rooted_literal_glob(path));
        }
    }
    command.arg(".");

    let output = match command.output() {
        Ok(output) => output,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Ok(None),
    };
    if !output.status.success() && output.status.code() != Some(1) {
        return Ok(None);
    }
    let stdout = match String::from_utf8(output.stdout) {
        Ok(stdout) => stdout,
        Err(_) => return Ok(None),
    };
    let included = stdout
        .lines()
        .map(normalize_relative_path)
        .filter(|path| normalized.contains(path))
        .collect::<HashSet<_>>();
    Ok(Some(included))
}

/// Return whether a changed workspace-relative path can alter ripgrep's file
/// enumeration. Such changes require a scope reconciliation: updating only the
/// ignore file itself would miss existing files that have just become visible.
pub fn controls_workspace_scope(rel_path: &str) -> bool {
    let normalized = normalize_relative_path(rel_path);
    let file_name = normalized.rsplit('/').next().unwrap_or_default();
    matches!(file_name, ".gitignore" | ".ignore" | ".rgignore")
        || normalized == ".git/info/exclude"
        || normalized.ends_with("/.git/info/exclude")
}

fn normalize_relative_path(value: &str) -> String {
    let normalized = value.replace('\\', "/");
    let mut parts = Vec::new();
    for part in normalized.trim_start_matches('/').split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            value => parts.push(value),
        }
    }
    parts.join("/")
}

fn rooted_literal_glob(path: &str) -> String {
    let mut glob = String::with_capacity(path.len() + 1);
    glob.push('/');
    for ch in path.chars() {
        if matches!(ch, '\\' | '*' | '?' | '[' | ']' | '{' | '}') {
            glob.push('\\');
        }
        glob.push(ch);
    }
    glob
}

#[cfg(test)]
mod tests {
    use super::{controls_workspace_scope, normalize_relative_path, rooted_literal_glob};

    #[test]
    fn exact_scope_globs_escape_metacharacters_and_anchor_at_root() {
        assert_eq!(
            rooted_literal_glob("src/[draft]*.rs"),
            "/src/\\[draft\\]\\*.rs"
        );
        assert_eq!(
            normalize_relative_path("./src\\nested/../unit.rs"),
            "src/unit.rs"
        );
    }

    #[test]
    fn ignore_control_files_are_detected_by_structure() {
        for path in [
            ".gitignore",
            "packages/unit/.gitignore",
            ".ignore",
            "nested/.rgignore",
            ".git/info/exclude",
            "vendor/module/.git/info/exclude",
        ] {
            assert!(
                controls_workspace_scope(path),
                "expected scope control: {path}"
            );
        }
        assert!(!controls_workspace_scope("source/ignore.rs"));
        assert!(!controls_workspace_scope("source/gitignore"));
    }
}
