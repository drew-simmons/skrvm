use std::path::{Path, PathBuf};

/// Sanitizes an issue identifier to be safe for directory names.
/// Only allows alphanumeric characters, dots, underscores, and dashes.
/// All other characters are replaced with underscores.
pub fn sanitize_workspace_key(identifier: &str) -> String {
    identifier
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

/// Formats and sanitizes a workspace directory name using the issue identifier and title.
/// Creates a lowercase, alphanumeric-and-hyphen-only slug (e.g., "11-fix-local-directory-names").
pub fn get_workspace_dir_name(identifier: &str, title: &str) -> String {
    let combined = format!("{}-{}", identifier, title);
    let mut slug = String::new();
    let mut last_char_was_separator = false;

    for c in combined.chars() {
        if c.is_ascii_alphanumeric() {
            slug.push(c.to_ascii_lowercase());
            last_char_was_separator = false;
        } else if (c.is_ascii_whitespace()
            || c == '-'
            || c == '_'
            || c == '/'
            || c == '\\'
            || c == '.')
            && !last_char_was_separator
            && !slug.is_empty()
        {
            slug.push('-');
            last_char_was_separator = true;
        }
    }

    let mut trimmed = slug.trim_end_matches('-').to_string();
    if trimmed.is_empty() {
        trimmed = sanitize_workspace_key(identifier);
    }
    trimmed
}

/// Validates that the given workspace directory is safely situated inside the workspace root
/// and returns its canonicalized absolute path.
pub fn validate_workspace_cwd(workspace: &Path, workspace_root: &Path) -> Result<PathBuf, String> {
    let canonical_root = workspace_root
        .canonicalize()
        .map_err(|e| format!("Failed to canonicalize workspace root: {}", e))?;

    // Create directory if it does not exist to allow canonicalization
    if !workspace.exists() {
        std::fs::create_dir_all(workspace)
            .map_err(|e| format!("Failed to create workspace directory: {}", e))?;
    }

    let canonical_workspace = workspace
        .canonicalize()
        .map_err(|e| format!("Failed to canonicalize workspace: {}", e))?;

    if canonical_workspace == canonical_root {
        return Err(format!(
            "Workspace path cannot be identical to the root path: {:?}",
            canonical_workspace
        ));
    }

    if canonical_workspace.starts_with(&canonical_root) {
        Ok(canonical_workspace)
    } else {
        Err(format!(
            "Workspace path {:?} is outside the workspace root {:?}",
            canonical_workspace, canonical_root
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sanitize_key() {
        assert_eq!(sanitize_workspace_key("ABC-123"), "ABC-123");
        assert_eq!(
            sanitize_workspace_key("feature/cool-stuff"),
            "feature_cool-stuff"
        );
        assert_eq!(sanitize_workspace_key("issues..123?"), "issues..123_");
    }

    #[test]
    fn test_get_workspace_dir_name() {
        assert_eq!(
            get_workspace_dir_name("11", "Test Ticket"),
            "11-test-ticket"
        );
        assert_eq!(
            get_workspace_dir_name("PROJ-12", "Fix local directory names!"),
            "proj-12-fix-local-directory-names"
        );
        assert_eq!(
            get_workspace_dir_name("13", "Bug (fix) #123: emoji 🚀 !!"),
            "13-bug-fix-123-emoji"
        );
        assert_eq!(get_workspace_dir_name("14", "..."), "14");
    }

    #[test]
    fn test_validate_workspace_cwd_safe() {
        let temp_root = std::env::temp_dir().join(format!(
            "skrvm_root_safe_{}",
            chrono::Utc::now().timestamp_millis()
        ));
        std::fs::create_dir_all(&temp_root).unwrap();

        let safe_workspace = temp_root.join("PROJ-123");
        let res = validate_workspace_cwd(&safe_workspace, &temp_root);
        assert!(res.is_ok());
        let canonical_workspace = res.unwrap();
        assert!(canonical_workspace.exists());
        assert!(canonical_workspace.starts_with(&temp_root.canonicalize().unwrap()));

        std::fs::remove_dir_all(&temp_root).ok();
    }

    #[test]
    fn test_validate_workspace_cwd_unsafe_traversal() {
        let temp_root = std::env::temp_dir().join(format!(
            "skrvm_root_unsafe_{}",
            chrono::Utc::now().timestamp_millis()
        ));
        std::fs::create_dir_all(&temp_root).unwrap();

        // Create an outside path
        let outside_workspace = temp_root.parent().unwrap().join("malicious_escape");
        let res = validate_workspace_cwd(&outside_workspace, &temp_root);
        assert!(res.is_err());
        assert!(res.err().unwrap().contains("outside the workspace root"));

        std::fs::remove_dir_all(&temp_root).ok();
    }

    #[test]
    fn test_validate_workspace_cwd_identical_to_root() {
        let temp_root = std::env::temp_dir().join(format!(
            "skrvm_root_identical_{}",
            chrono::Utc::now().timestamp_millis()
        ));
        std::fs::create_dir_all(&temp_root).unwrap();

        let res = validate_workspace_cwd(&temp_root, &temp_root);
        assert!(res.is_err());
        assert!(res
            .err()
            .unwrap()
            .contains("cannot be identical to the root path"));

        std::fs::remove_dir_all(&temp_root).ok();
    }
}
