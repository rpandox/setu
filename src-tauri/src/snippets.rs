//! Plain-TOML persistence for snippets (F6).
//!
//! Snippets live in `~/.config/setu/snippets.toml`, inside the same
//! human-diffable sync unit as `hosts.toml` (`PLAN.md` §4). A snippet is a
//! command template: `{{var}}` tokens in the command prompt at run time,
//! with optional defaults and fixed choice lists declared per variable.
//!
//! The module mirrors [`crate::store`]'s safety properties exactly:
//!
//! 1. **Writes are atomic** — temp file in the same directory, then `rename`.
//! 2. **A corrupt file is never overwritten** — parse failures surface as
//!    errors on every operation until the user fixes the file by hand.
//!
//! Beyond CRUD, the store imports and exports **snippet packs**: the same
//! `[[snippet]]` TOML shape as the store file, passed over IPC as text (the
//! file dialogs live in the frontend). Imports are atomic — a pack with any
//! invalid snippet imports nothing.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

/// Header written at the top of every `snippets.toml` Setu saves.
const SNIPPETS_HEADER: &str = "# Setu snippets — managed by the app (canonical formatting; comments are\n# rewritten on save). Schema: PLAN.md §4. This file must never hold secrets.\n\n";

/// Header written at the top of exported snippet packs.
const PACK_HEADER: &str = "# Setu snippet pack — import via Snippets → Import pack.\n\n";

/// One `{{var}}` declaration on a snippet.
///
/// `default` pre-fills the run prompt; `choices` turns it into a select.
/// When both are present the default must be one of the choices.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SnippetVariable {
    /// The token name as it appears inside `{{…}}` — `[A-Za-z_][A-Za-z0-9_]*`.
    pub name: String,
    /// Pre-filled value for the run prompt; `None` means an empty input.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default: Option<String>,
    /// Fixed values rendered as a select instead of a free text input.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub choices: Option<Vec<String>>,
}

/// One snippet record — the `PLAN.md` §4 `[[snippet]]` schema.
///
/// Fields serialize with the same names in `snippets.toml` and over IPC
/// (the frontend `Snippet` type mirrors this struct verbatim; see
/// `src/ipc/contract.ts`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Snippet {
    /// Stable UUID. Empty on a create draft; assigned by
    /// [`SnippetsStore::upsert`] (and by import for pack rows without one).
    #[serde(default)]
    pub id: String,
    /// Display label, the row's identity in the drawer and palette.
    #[serde(default)]
    pub label: String,
    /// The command template; may contain `{{var}}` tokens.
    #[serde(default)]
    pub command: String,
    /// Free-form tag chips (searchable in the drawer and palette).
    #[serde(default)]
    pub tags: Vec<String>,
    /// Variable declarations — one per distinct `{{var}}` token.
    #[serde(default)]
    pub variables: Vec<SnippetVariable>,
}

/// Outcome of [`SnippetsStore::upsert`]: saved, or rejected with field
/// errors (mirrors [`crate::store::UpsertOutcome`]).
#[derive(Debug)]
pub enum SnippetUpsertOutcome {
    /// The snippet passed validation and was written to disk.
    Saved(Box<Snippet>),
    /// Validation failed; nothing was written.
    Invalid(Vec<crate::store::FieldError>),
}

/// Counters returned by [`SnippetsStore::import`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportOutcome {
    /// Rows written (created or overwritten, per the merge strategy).
    pub imported: usize,
    /// Rows skipped because their id already existed (strategy `keep`).
    pub skipped: usize,
}

/// Wrapper matching the `[[snippet]]` array-of-tables layout — shared by
/// the store file and by import/export packs.
#[derive(Debug, Default, Serialize, Deserialize)]
struct SnippetsFile {
    /// The snippet records, in file order (which is also drawer order).
    #[serde(default)]
    snippet: Vec<Snippet>,
}

/// Owns `snippets.toml`: lazy loading, validation, atomic writes, and pack
/// import/export.
///
/// One instance lives in Tauri managed state, exactly like
/// [`crate::store::HostsStore`].
///
/// # Examples
///
/// ```
/// use setu_lib::snippets::{Snippet, SnippetsStore, SnippetUpsertOutcome};
///
/// let dir = std::env::temp_dir().join(format!("setu-doc-{}", uuid::Uuid::new_v4()));
/// let store = SnippetsStore::new(dir.join("snippets.toml"));
/// assert_eq!(store.list().unwrap().len(), 0);
///
/// let outcome = store
///     .upsert(Snippet {
///         label: "follow service logs".into(),
///         command: "journalctl -u {{service}} -f".into(),
///         variables: vec![setu_lib::snippets::SnippetVariable {
///             name: "service".into(),
///             default: Some("sshd".into()),
///             choices: None,
///         }],
///         ..Snippet::default()
///     })
///     .unwrap();
/// assert!(matches!(outcome, SnippetUpsertOutcome::Saved(_)));
/// assert_eq!(store.list().unwrap().len(), 1);
/// # std::fs::remove_dir_all(&dir).ok();
/// ```
pub struct SnippetsStore {
    /// Absolute path of `snippets.toml`.
    path: PathBuf,
    /// Parsed snippets once loaded; `None` until the first read.
    cache: Mutex<Option<Vec<Snippet>>>,
}

impl SnippetsStore {
    /// Creates a store over `path`. Nothing is read until first use.
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            cache: Mutex::new(None),
        }
    }

    /// The canonical location: `~/.config/setu/snippets.toml` (`PLAN.md` §4).
    ///
    /// # Errors
    ///
    /// Fails when the home directory cannot be determined.
    pub fn default_path() -> Result<PathBuf, String> {
        dirs::home_dir()
            .map(|home| home.join(".config/setu/snippets.toml"))
            .ok_or_else(|| "cannot determine home directory".to_string())
    }

    /// Returns all persisted snippets (loading the file on first call).
    ///
    /// A missing file is an empty list, not an error.
    ///
    /// # Errors
    ///
    /// Fails when the file exists but cannot be read or parsed.
    pub fn list(&self) -> Result<Vec<Snippet>, String> {
        let mut cache = self.cache.lock().expect("snippets cache poisoned");
        self.ensure_loaded(&mut cache)?;
        Ok(cache.as_ref().expect("loaded above").clone())
    }

    /// Validates `snippet` and creates it (empty `id` → fresh UUID) or
    /// updates the record with the same `id`, then atomically saves.
    ///
    /// # Errors
    ///
    /// Fails when the file cannot be read/parsed, the save fails, or a
    /// non-empty `id` matches no record. Validation failures are the
    /// `Ok(SnippetUpsertOutcome::Invalid)` case — expected editor outcomes,
    /// and nothing is written.
    pub fn upsert(&self, mut snippet: Snippet) -> Result<SnippetUpsertOutcome, String> {
        let errors = validate_snippet(&snippet);
        if !errors.is_empty() {
            return Ok(SnippetUpsertOutcome::Invalid(errors));
        }
        let mut cache = self.cache.lock().expect("snippets cache poisoned");
        self.ensure_loaded(&mut cache)?;
        let snippets = cache.as_mut().expect("loaded above");
        if snippet.id.is_empty() {
            snippet.id = uuid::Uuid::new_v4().to_string();
            snippets.push(snippet.clone());
        } else if let Some(existing) = snippets.iter_mut().find(|s| s.id == snippet.id) {
            *existing = snippet.clone();
        } else {
            return Err(format!("unknown snippet: {}", snippet.id));
        }
        save_atomic(&self.path, snippets)?;
        Ok(SnippetUpsertOutcome::Saved(Box::new(snippet)))
    }

    /// Deletes a snippet by id and atomically saves. Unknown ids are a
    /// no-op (idempotent delete).
    ///
    /// # Errors
    ///
    /// Fails when the file cannot be read/parsed or the save fails.
    pub fn delete(&self, id: &str) -> Result<(), String> {
        let mut cache = self.cache.lock().expect("snippets cache poisoned");
        self.ensure_loaded(&mut cache)?;
        let snippets = cache.as_mut().expect("loaded above");
        let before = snippets.len();
        snippets.retain(|s| s.id != id);
        if snippets.len() != before {
            save_atomic(&self.path, snippets)?;
        }
        Ok(())
    }

    /// Imports a snippet pack (the same `[[snippet]]` TOML shape as the
    /// store file), merging by id: `replace = true` overwrites existing
    /// records, `replace = false` keeps them and skips the incoming row.
    /// Pack rows without an id get a fresh UUID and always import.
    ///
    /// The import is atomic: a pack that fails to parse, or contains any
    /// invalid snippet, imports nothing.
    ///
    /// # Errors
    ///
    /// Fails when the pack cannot be parsed, any pack snippet fails
    /// validation (the message names it), the store cannot be read/parsed,
    /// or the save fails.
    pub fn import(&self, toml_text: &str, replace: bool) -> Result<ImportOutcome, String> {
        let pack = toml::from_str::<SnippetsFile>(toml_text)
            .map_err(|e| format!("failed to parse snippet pack: {e}"))?;
        if pack.snippet.is_empty() {
            return Err("the pack contains no snippets".to_string());
        }
        for (index, snippet) in pack.snippet.iter().enumerate() {
            let errors = validate_snippet(snippet);
            if let Some(first) = errors.first() {
                let who = if snippet.label.trim().is_empty() {
                    format!("snippet #{}", index + 1)
                } else {
                    format!("\"{}\"", snippet.label)
                };
                return Err(format!(
                    "invalid {who} in pack — {}: {}",
                    first.field, first.message
                ));
            }
        }
        let mut cache = self.cache.lock().expect("snippets cache poisoned");
        self.ensure_loaded(&mut cache)?;
        let snippets = cache.as_mut().expect("loaded above");
        let mut outcome = ImportOutcome {
            imported: 0,
            skipped: 0,
        };
        for mut incoming in pack.snippet {
            if incoming.id.is_empty() {
                incoming.id = uuid::Uuid::new_v4().to_string();
                snippets.push(incoming);
                outcome.imported += 1;
            } else if let Some(existing) = snippets.iter_mut().find(|s| s.id == incoming.id) {
                if replace {
                    *existing = incoming;
                    outcome.imported += 1;
                } else {
                    outcome.skipped += 1;
                }
            } else {
                snippets.push(incoming);
                outcome.imported += 1;
            }
        }
        if outcome.imported > 0 {
            save_atomic(&self.path, snippets)?;
        }
        Ok(outcome)
    }

    /// Exports the snippets with the given ids as pack TOML, in store
    /// order. Ids that match no record are ignored.
    ///
    /// # Errors
    ///
    /// Fails when the store cannot be read/parsed, no id matches (there is
    /// nothing to export), or serialization fails.
    pub fn export(&self, ids: &[String]) -> Result<String, String> {
        let selected: Vec<Snippet> = self
            .list()?
            .into_iter()
            .filter(|s| ids.contains(&s.id))
            .collect();
        if selected.is_empty() {
            return Err("no matching snippets to export".to_string());
        }
        let body = toml::to_string_pretty(&SnippetsFile { snippet: selected })
            .map_err(|e| format!("failed to serialize snippet pack: {e}"))?;
        Ok(format!("{PACK_HEADER}{body}"))
    }

    /// Loads the file into `cache` if it has not been loaded yet.
    fn ensure_loaded(&self, cache: &mut Option<Vec<Snippet>>) -> Result<(), String> {
        if cache.is_some() {
            return Ok(());
        }
        let snippets = match fs::read_to_string(&self.path) {
            Ok(text) => {
                toml::from_str::<SnippetsFile>(&text)
                    .map_err(|e| format!("failed to parse {}: {e}", self.path.display()))?
                    .snippet
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(e) => return Err(format!("failed to read {}: {e}", self.path.display())),
        };
        *cache = Some(snippets);
        Ok(())
    }
}

/// Extracts the `{{var}}` token names from a command, in order of first
/// appearance, deduplicated. Returns an error for a malformed token — an
/// unclosed `{{`, or an empty `{{}}`.
///
/// There is no escaping: a literal `{{` cannot appear in a snippet command
/// (documented limitation, `PLAN.md` §5).
///
/// # Errors
///
/// Fails with a human-readable message when the command contains `{{`
/// without a matching `}}`, or a token with no name.
pub fn extract_tokens(command: &str) -> Result<Vec<String>, String> {
    let mut tokens: Vec<String> = Vec::new();
    let mut rest = command;
    while let Some(open) = rest.find("{{") {
        let after = &rest[open + 2..];
        let Some(close) = after.find("}}") else {
            return Err("`{{` without a matching `}}`".to_string());
        };
        let name = &after[..close];
        if name.trim().is_empty() {
            return Err("empty `{{}}` token".to_string());
        }
        if !tokens.iter().any(|t| t == name) {
            tokens.push(name.to_string());
        }
        rest = &after[close + 2..];
    }
    Ok(tokens)
}

/// Whether `name` is a valid variable name: `[A-Za-z_][A-Za-z0-9_]*`.
fn is_valid_variable_name(name: &str) -> bool {
    let mut chars = name.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() || c == '_' => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// Validates a snippet draft for saving; an empty result means valid.
///
/// Rules (F6): label and command non-empty; every `{{token}}` in the
/// command is declared in `variables` and vice versa; variable names are
/// `[A-Za-z_][A-Za-z0-9_]*` with no duplicates; a `choices` list is
/// non-empty with no blank entries; a `default` with `choices` present must
/// be one of them.
pub fn validate_snippet(snippet: &Snippet) -> Vec<crate::store::FieldError> {
    use crate::store::FieldError;
    let mut errors = Vec::new();
    if snippet.label.trim().is_empty() {
        errors.push(FieldError::new("label", "Label is required"));
    }
    if snippet.command.trim().is_empty() {
        errors.push(FieldError::new("command", "Command is required"));
    }
    let tokens = match extract_tokens(&snippet.command) {
        Ok(tokens) => tokens,
        Err(message) => {
            errors.push(FieldError::new("command", &message));
            return errors;
        }
    };
    for token in &tokens {
        if !is_valid_variable_name(token) {
            errors.push(FieldError::new(
                "command",
                &format!(
                    "Invalid token {{{{{token}}}}} — names are letters, digits, and _ (not starting with a digit)"
                ),
            ));
        }
    }
    let mut seen: Vec<&str> = Vec::new();
    for variable in &snippet.variables {
        let name = variable.name.as_str();
        if !is_valid_variable_name(name) {
            errors.push(FieldError::new(
                "variables",
                &format!(
                    "Invalid variable name \"{name}\" — letters, digits, and _ (not starting with a digit)"
                ),
            ));
            continue;
        }
        if seen.contains(&name) {
            errors.push(FieldError::new(
                "variables",
                &format!("Duplicate variable \"{name}\""),
            ));
            continue;
        }
        seen.push(name);
        if !tokens.iter().any(|t| t == name) {
            errors.push(FieldError::new(
                "variables",
                &format!("Variable \"{name}\" never appears as {{{{{name}}}}} in the command"),
            ));
        }
        if let Some(choices) = &variable.choices {
            if choices.is_empty() {
                errors.push(FieldError::new(
                    "variables",
                    &format!("Variable \"{name}\" has an empty choices list"),
                ));
            } else if choices.iter().any(|c| c.trim().is_empty()) {
                errors.push(FieldError::new(
                    "variables",
                    &format!("Variable \"{name}\" has a blank choice"),
                ));
            } else if let Some(default) = &variable.default {
                if !choices.contains(default) {
                    errors.push(FieldError::new(
                        "variables",
                        &format!("Variable \"{name}\"'s default is not one of its choices"),
                    ));
                }
            }
        }
    }
    for token in &tokens {
        if is_valid_variable_name(token) && !seen.contains(&token.as_str()) {
            errors.push(FieldError::new(
                "variables",
                &format!("{{{{{token}}}}} in the command has no variable declaration"),
            ));
        }
    }
    errors
}

/// Serializes `snippets` and writes the file atomically: temp file in the
/// same directory, then `rename` into place.
fn save_atomic(path: &Path, snippets: &[Snippet]) -> Result<(), String> {
    let file = SnippetsFile {
        snippet: snippets.to_vec(),
    };
    let body =
        toml::to_string_pretty(&file).map_err(|e| format!("failed to serialize snippets: {e}"))?;
    let parent = path
        .parent()
        .ok_or_else(|| format!("no parent directory for {}", path.display()))?;
    fs::create_dir_all(parent)
        .map_err(|e| format!("failed to create {}: {e}", parent.display()))?;
    let tmp = parent.join(format!(
        ".{}.tmp-{}",
        path.file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("snippets.toml"),
        std::process::id()
    ));
    fs::write(&tmp, format!("{SNIPPETS_HEADER}{body}"))
        .map_err(|e| format!("failed to write {}: {e}", tmp.display()))?;
    fs::rename(&tmp, path).map_err(|e| {
        // Best-effort cleanup; the temp file is harmless if this fails too.
        let _ = fs::remove_file(&tmp);
        format!("failed to move {} into place: {e}", tmp.display())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A store over a fresh temp directory (removed by `TempStore::drop`).
    struct TempStore {
        dir: PathBuf,
        store: SnippetsStore,
    }

    impl TempStore {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!("setu-snippets-{}", uuid::Uuid::new_v4()));
            let store = SnippetsStore::new(dir.join("snippets.toml"));
            Self { dir, store }
        }

        fn path(&self) -> PathBuf {
            self.dir.join("snippets.toml")
        }
    }

    impl Drop for TempStore {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.dir);
        }
    }

    fn journalctl_snippet() -> Snippet {
        Snippet {
            label: "follow service logs".into(),
            command: "journalctl -u {{service}} -f".into(),
            tags: vec!["logs".into()],
            variables: vec![SnippetVariable {
                name: "service".into(),
                default: Some("sshd".into()),
                choices: None,
            }],
            ..Snippet::default()
        }
    }

    fn saved(outcome: SnippetUpsertOutcome) -> Snippet {
        match outcome {
            SnippetUpsertOutcome::Saved(snippet) => *snippet,
            SnippetUpsertOutcome::Invalid(errors) => {
                panic!("unexpected validation errors: {errors:?}")
            }
        }
    }

    #[test]
    fn missing_file_is_an_empty_list() {
        let t = TempStore::new();
        assert_eq!(t.store.list().expect("list"), Vec::new());
    }

    #[test]
    fn upsert_assigns_id_persists_and_survives_reload() {
        let t = TempStore::new();
        let mut snippet = journalctl_snippet();
        snippet.variables.push(SnippetVariable {
            name: "lines".into(),
            default: Some("100".into()),
            choices: Some(vec!["100".into(), "1000".into()]),
        });
        snippet.command = "journalctl -u {{service}} -n {{lines}} -f".into();
        let saved_snippet = saved(t.store.upsert(snippet).expect("upsert"));
        assert!(!saved_snippet.id.is_empty(), "id must be assigned");

        // A brand-new store over the same file sees the identical record —
        // defaults and choices round-trip.
        let reloaded = SnippetsStore::new(t.path()).list().expect("reload");
        assert_eq!(reloaded, vec![saved_snippet]);
    }

    #[test]
    fn upsert_with_id_updates_in_place() {
        let t = TempStore::new();
        let mut snippet = saved(t.store.upsert(journalctl_snippet()).expect("create"));
        snippet.label = "tail service".into();
        let updated = saved(t.store.upsert(snippet).expect("update"));
        assert_eq!(updated.label, "tail service");
        let all = t.store.list().expect("list");
        assert_eq!(all.len(), 1, "update must not duplicate");
    }

    #[test]
    fn upsert_unknown_id_is_an_error() {
        let t = TempStore::new();
        let mut snippet = journalctl_snippet();
        snippet.id = "no-such-id".into();
        assert!(t.store.upsert(snippet).is_err());
    }

    #[test]
    fn extract_tokens_orders_and_dedupes() {
        let tokens = extract_tokens("a {{x}} b {{y}} c {{x}}").expect("tokens");
        assert_eq!(tokens, vec!["x", "y"]);
        assert_eq!(
            extract_tokens("no tokens").expect("tokens"),
            Vec::<String>::new()
        );
    }

    #[test]
    fn extract_tokens_rejects_malformed() {
        assert!(extract_tokens("oops {{name").is_err());
        assert!(extract_tokens("oops {{}}").is_err());
    }

    #[test]
    fn validation_rejects_bad_drafts_and_writes_nothing() {
        let t = TempStore::new();
        let snippet = Snippet {
            label: "  ".into(),
            command: String::new(),
            ..Snippet::default()
        };
        let outcome = t.store.upsert(snippet).expect("upsert runs");
        let SnippetUpsertOutcome::Invalid(errors) = outcome else {
            panic!("expected validation failure");
        };
        let fields: Vec<&str> = errors.iter().map(|e| e.field.as_str()).collect();
        assert_eq!(fields, vec!["label", "command"]);
        assert!(!t.path().exists(), "invalid draft must not create the file");
    }

    #[test]
    fn validation_matches_tokens_and_variables_both_ways() {
        // {{host}} undeclared, "extra" never used.
        let snippet = Snippet {
            label: "x".into(),
            command: "ping {{host}}".into(),
            variables: vec![SnippetVariable {
                name: "extra".into(),
                default: None,
                choices: None,
            }],
            ..Snippet::default()
        };
        let fields: Vec<String> = validate_snippet(&snippet)
            .into_iter()
            .map(|e| e.field)
            .collect();
        assert_eq!(fields, vec!["variables", "variables"]);
    }

    #[test]
    fn validation_rejects_bad_names_duplicates_and_choice_rules() {
        let snippet = Snippet {
            label: "x".into(),
            command: "echo {{ok}} {{9bad}}".into(),
            variables: vec![
                SnippetVariable {
                    name: "ok".into(),
                    default: Some("c".into()),
                    choices: Some(vec!["a".into(), "b".into()]),
                },
                SnippetVariable {
                    name: "ok".into(),
                    default: None,
                    choices: None,
                },
                SnippetVariable {
                    name: "9bad".into(),
                    default: None,
                    choices: None,
                },
            ],
            ..Snippet::default()
        };
        let messages: Vec<String> = validate_snippet(&snippet)
            .into_iter()
            .map(|e| format!("{}: {}", e.field, e.message))
            .collect();
        // Invalid token name in the command, default outside choices,
        // duplicate declaration, and the invalid variable name.
        assert_eq!(messages.len(), 4, "got: {messages:?}");
        assert!(messages.iter().any(|m| m.contains("Invalid token")));
        assert!(messages
            .iter()
            .any(|m| m.contains("not one of its choices")));
        assert!(messages.iter().any(|m| m.contains("Duplicate variable")));
        assert!(messages.iter().any(|m| m.contains("Invalid variable name")));
    }

    #[test]
    fn delete_removes_and_is_idempotent() {
        let t = TempStore::new();
        let snippet = saved(t.store.upsert(journalctl_snippet()).expect("create"));
        t.store.delete(&snippet.id).expect("delete");
        assert_eq!(t.store.list().expect("list"), Vec::new());
        t.store.delete(&snippet.id).expect("re-delete");
    }

    #[test]
    fn corrupt_file_errors_and_is_never_overwritten() {
        let t = TempStore::new();
        fs::create_dir_all(&t.dir).expect("mkdir");
        let garbage = "[[snippet]\nthis is not toml";
        fs::write(t.path(), garbage).expect("write garbage");

        assert!(t.store.list().is_err());
        assert!(t.store.upsert(journalctl_snippet()).is_err());
        assert!(t.store.delete("any").is_err());
        assert!(t
            .store
            .import("[[snippet]]\nlabel = \"x\"\ncommand = \"y\"\n", true)
            .is_err());
        let on_disk = fs::read_to_string(t.path()).expect("read back");
        assert_eq!(on_disk, garbage, "corrupt file must be left untouched");
    }

    #[test]
    fn import_merges_by_id_with_both_strategies() {
        let t = TempStore::new();
        let existing = saved(t.store.upsert(journalctl_snippet()).expect("create"));

        let pack = format!(
            "[[snippet]]\nid = \"{}\"\nlabel = \"replaced\"\ncommand = \"true\"\n\n[[snippet]]\nlabel = \"fresh\"\ncommand = \"uptime\"\n",
            existing.id
        );
        // keep: the collision is skipped, the fresh row imports.
        let kept = t.store.import(&pack, false).expect("import keep");
        assert_eq!((kept.imported, kept.skipped), (1, 1));
        assert_eq!(t.store.list().expect("list").len(), 2);
        assert_eq!(
            t.store.list().expect("list")[0].label,
            "follow service logs"
        );

        // replace: the collision is overwritten (fresh row gets a new id
        // each import — packs without ids always append).
        let replaced = t.store.import(&pack, true).expect("import replace");
        assert_eq!((replaced.imported, replaced.skipped), (2, 0));
        let all = t.store.list().expect("list");
        assert_eq!(all[0].label, "replaced");
        assert_eq!(all.len(), 3);
    }

    #[test]
    fn import_is_atomic_on_any_invalid_snippet() {
        let t = TempStore::new();
        let pack = "[[snippet]]\nlabel = \"good\"\ncommand = \"uptime\"\n\n[[snippet]]\nlabel = \"bad\"\ncommand = \"echo {{oops\"\n";
        let err = t.store.import(pack, true).expect_err("must fail");
        assert!(err.contains("\"bad\""), "error names the snippet: {err}");
        assert_eq!(
            t.store.list().expect("list"),
            Vec::new(),
            "nothing imported"
        );
    }

    #[test]
    fn import_rejects_unparseable_and_empty_packs() {
        let t = TempStore::new();
        assert!(t.store.import("not toml [", true).is_err());
        assert!(t.store.import("", true).is_err());
    }

    #[test]
    fn export_selects_by_id_in_store_order() {
        let t = TempStore::new();
        let first = saved(t.store.upsert(journalctl_snippet()).expect("one"));
        let second = saved(
            t.store
                .upsert(Snippet {
                    label: "uptime".into(),
                    command: "uptime".into(),
                    ..Snippet::default()
                })
                .expect("two"),
        );
        let toml_text = t
            .store
            .export(&[second.id.clone(), first.id.clone(), "ghost".into()])
            .expect("export");
        // Store order, not request order; unknown ids ignored.
        let reimported: SnippetsFile = toml::from_str(&toml_text).expect("parse export");
        let labels: Vec<&str> = reimported
            .snippet
            .iter()
            .map(|s| s.label.as_str())
            .collect();
        assert_eq!(labels, vec!["follow service logs", "uptime"]);

        assert!(
            t.store.export(&["ghost".into()]).is_err(),
            "nothing matched"
        );
    }

    #[test]
    fn unknown_fields_are_tolerated_on_load() {
        let t = TempStore::new();
        fs::create_dir_all(&t.dir).expect("mkdir");
        fs::write(
            t.path(),
            "[[snippet]]\nid = \"x\"\nlabel = \"s\"\ncommand = \"true\"\nfrom_the_future = 1\n",
        )
        .expect("write");
        let snippets = t.store.list().expect("list");
        assert_eq!(snippets.len(), 1);
        assert_eq!(snippets[0].label, "s");
    }
}
