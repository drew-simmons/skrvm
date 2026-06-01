use crate::config::Settings;
use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};
use std::time::SystemTime;

#[derive(Debug, Clone)]
pub struct Workflow {
    pub config: Settings,
    pub prompt_template: String,
}

pub struct WorkflowStore {
    path: PathBuf,
    last_mtime: Option<SystemTime>,
    last_size: u64,
    last_hash: u64,
    current: Arc<RwLock<Option<Workflow>>>,
}

impl WorkflowStore {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            last_mtime: None,
            last_size: 0,
            last_hash: 0,
            current: Arc::new(RwLock::new(None)),
        }
    }

    /// Returns the absolute path of the targeted workflow file
    #[allow(dead_code)]
    pub fn file_path(&self) -> &Path {
        &self.path
    }

    /// Forces a reload of the workflow config. If successful, updates the cache.
    pub fn force_reload(&mut self) -> Result<Workflow, String> {
        let content = fs::read_to_string(&self.path)
            .map_err(|e| format!("Failed to read workflow file {:?}: {}", self.path, e))?;

        let mtime = fs::metadata(&self.path)
            .and_then(|meta| meta.modified())
            .unwrap_or_else(|_| SystemTime::now());

        let size = content.len() as u64;

        let mut hasher = DefaultHasher::new();
        content.hash(&mut hasher);
        let hash = hasher.finish();

        let parsed = parse_workflow(&content, &self.path)?;

        let mut current_guard = self.current.write().map_err(|e| e.to_string())?;
        *current_guard = Some(parsed.clone());

        self.last_mtime = Some(mtime);
        self.last_size = size;
        self.last_hash = hash;

        Ok(parsed)
    }

    /// Checks if the file has changed on disk, and reloads it if necessary.
    /// Keeps operating with the last known good configuration if validation fails.
    pub fn poll_and_reload(&mut self) -> Result<Option<Workflow>, String> {
        if !self.path.exists() {
            return Err(format!("Workflow file {:?} does not exist", self.path));
        }

        let meta = fs::metadata(&self.path)
            .map_err(|e| format!("Failed to read metadata for {:?}: {}", self.path, e))?;
        let mtime = meta.modified().unwrap_or_else(|_| SystemTime::now());
        let size = meta.len();

        let should_reload = match (self.last_mtime, self.last_size) {
            (Some(last_mtime), last_size) => mtime != last_mtime || size != last_size,
            _ => true,
        };

        if should_reload {
            let content = fs::read_to_string(&self.path)
                .map_err(|e| format!("Failed to read workflow file {:?}: {}", self.path, e))?;

            let mut hasher = DefaultHasher::new();
            content.hash(&mut hasher);
            let hash = hasher.finish();

            if hash == self.last_hash && self.last_hash != 0 {
                self.last_mtime = Some(mtime);
                self.last_size = size;
                return Ok(None);
            }

            match parse_workflow(&content, &self.path) {
                Ok(parsed) => {
                    let mut current_guard = self.current.write().map_err(|e| e.to_string())?;
                    *current_guard = Some(parsed.clone());

                    self.last_mtime = Some(mtime);
                    self.last_size = size;
                    self.last_hash = hash;

                    println!("Successfully reloaded workflow file: {:?}", self.path);
                    Ok(Some(parsed))
                }
                Err(e) => {
                    // Log reload error but keep last known good
                    eprintln!(
                        "Failed to reload workflow file {:?}: {}. Keeping last known good config.",
                        self.path, e
                    );
                    Err(e)
                }
            }
        } else {
            Ok(None)
        }
    }

    /// Gets a thread-safe read reference to the current parsed workflow
    pub fn get_current(&self) -> Option<Workflow> {
        if let Ok(guard) = self.current.read() {
            guard.clone()
        } else {
            None
        }
    }
}

/// Parses the contents of WORKFLOW.md into a Workflow struct
pub fn parse_workflow(content: &str, file_path: &Path) -> Result<Workflow, String> {
    let (front_matter_str, prompt_template) = split_front_matter(content);

    let mut settings = if front_matter_str.trim().is_empty() {
        Settings::default()
    } else {
        serde_yaml::from_str(&front_matter_str)
            .map_err(|e| format!("Failed to parse YAML front matter: {}", e))?
    };

    let workflow_dir = file_path.parent().unwrap_or_else(|| Path::new("."));
    settings.finalize(workflow_dir);
    settings.validate()?;

    let default_prompt = "You are working on a Linear issue.\n\nIdentifier: {{ issue.identifier }}\nTitle: {{ issue.title }}\nBody:\n{{ issue.description }}";
    let prompt_template = if prompt_template.trim().is_empty() {
        default_prompt.to_string()
    } else {
        prompt_template.trim().to_string()
    };

    Ok(Workflow {
        config: settings,
        prompt_template,
    })
}

/// Splits the front matter (between --- blocks) and the prompt template
fn split_front_matter(content: &str) -> (String, String) {
    let lines: Vec<&str> = content.lines().collect();

    if lines.first().map(|l| l.trim()) == Some("---") {
        let mut front_matter_lines = Vec::new();
        let mut prompt_lines = Vec::new();
        let mut inside_front_matter = true;

        for line in lines.iter().skip(1) {
            if inside_front_matter {
                if line.trim() == "---" {
                    inside_front_matter = false;
                } else {
                    front_matter_lines.push(*line);
                }
            } else {
                prompt_lines.push(*line);
            }
        }

        (front_matter_lines.join("\n"), prompt_lines.join("\n"))
    } else {
        (String::new(), content.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_split_front_matter_valid() {
        let content = r#"---
tracker:
  kind: "memory"
---
This is the prompt template content
Line 2"#;
        let (front, prompt) = split_front_matter(content);
        assert_eq!(front.trim(), "tracker:\n  kind: \"memory\"");
        assert_eq!(prompt.trim(), "This is the prompt template content\nLine 2");
    }

    #[test]
    fn test_split_front_matter_none() {
        let content = "Only prompt template content";
        let (front, prompt) = split_front_matter(content);
        assert!(front.is_empty());
        assert_eq!(prompt, content);
    }

    #[test]
    fn test_parse_workflow_valid() {
        let content = r#"---
tracker:
  kind: "memory"
  project_slug: "TEST"
---
Elite agent: {{ issue.title }}"#;

        let path = Path::new("dummy/WORKFLOW.md");
        let workflow = parse_workflow(content, path).unwrap();

        assert_eq!(workflow.config.tracker.kind, "memory");
        assert_eq!(workflow.config.tracker.project_slug, "TEST");
        assert_eq!(workflow.prompt_template, "Elite agent: {{ issue.title }}");
    }

    #[test]
    fn test_parse_workflow_aliases() {
        let content_agy = r#"---
tracker:
  kind: "memory"
  project_slug: "TEST"
agy:
  command: "agy run"
  thread_sandbox: "custom-sandbox"
---
Prompt"#;
        let workflow_agy = parse_workflow(content_agy, Path::new("dummy/WORKFLOW.md")).unwrap();
        assert_eq!(workflow_agy.config.codex.command, "agy run");
        assert_eq!(workflow_agy.config.codex.thread_sandbox, "custom-sandbox");

        let content_kiro = r#"---
tracker:
  kind: "memory"
  project_slug: "TEST"
kiro:
  command: "kiro run"
---
Prompt"#;
        let workflow_kiro = parse_workflow(content_kiro, Path::new("dummy/WORKFLOW.md")).unwrap();
        assert_eq!(workflow_kiro.config.codex.command, "kiro run");

        let content_antigravity = r#"---
tracker:
  kind: "memory"
  project_slug: "TEST"
antigravity:
  command: "agy run"
---
Prompt"#;
        let workflow_antigravity =
            parse_workflow(content_antigravity, Path::new("dummy/WORKFLOW.md")).unwrap();
        assert_eq!(workflow_antigravity.config.codex.command, "agy run");
    }

    #[test]
    fn test_parse_workflow_relative_command_resolution() {
        // Create a temporary directory structure to mock a workflow file and script
        let temp_dir = std::env::temp_dir().join(format!(
            "skrvm_workflow_test_{}",
            chrono::Utc::now().timestamp_millis()
        ));
        std::fs::create_dir_all(&temp_dir).unwrap();

        let scratch_dir = temp_dir.join("scratch");
        std::fs::create_dir_all(&scratch_dir).unwrap();

        let script_file = scratch_dir.join("mock_agent.sh");
        std::fs::write(&script_file, "#!/bin/bash\n").unwrap();

        let workflow_file = temp_dir.join("WORKFLOW.md");
        let content = r#"---
tracker:
  kind: "memory"
  project_slug: "TEST"
agy:
  command: "./scratch/mock_agent.sh"
---
Prompt"#;

        let workflow = parse_workflow(content, &workflow_file).unwrap();

        // Assert that the relative command was resolved to an absolute path pointing to the existing script file
        let resolved_canonical = PathBuf::from(&workflow.config.codex.command)
            .canonicalize()
            .unwrap();
        let expected_canonical = script_file.canonicalize().unwrap();
        assert_eq!(resolved_canonical, expected_canonical);

        // Cleanup
        std::fs::remove_dir_all(&temp_dir).ok();
    }
}
