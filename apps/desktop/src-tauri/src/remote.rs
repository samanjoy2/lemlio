//! Where project backups are stored. The sync logic above this layer (heads,
//! parents, project identity, conflicts, receipts) is identical for both stores.
use serde_json::Value;
use std::path::{Path, PathBuf};

use crate::backup_store;
use crate::dropbox::Dropbox;

#[derive(Clone)]
pub enum Remote {
    /// A folder on this computer, usually inside a synced Dropbox folder.
    Folder(PathBuf),
    /// Dropbox through its API, using the app folder.
    Dropbox { client: Dropbox, account: String },
}

fn blocked<T>(joined: Result<Result<T, String>, tokio::task::JoinError>) -> Result<T, String> {
    joined.map_err(|_| "The backup storage task failed".to_string())?
}

impl Remote {
    /// The identity receipts remember: the folder path, or `dropbox:<account id>`.
    pub fn id(&self) -> String {
        match self {
            Remote::Folder(root) => backup_store::root_id(root),
            Remote::Dropbox { account, .. } => format!("dropbox:{account}"),
        }
    }

    pub fn is_dropbox(&self) -> bool {
        matches!(self, Remote::Dropbox { .. })
    }

    /// Complete revisions, newest first.
    pub async fn list(&self) -> Result<Vec<Value>, String> {
        match self {
            Remote::Folder(root) => {
                let root = root.clone();
                blocked(tokio::task::spawn_blocking(move || backup_store::list(&root)).await)
            }
            Remote::Dropbox { client, .. } => client.list(&self.id()).await,
        }
    }

    /// Store a new immutable revision.
    pub async fn put(
        &self,
        name: &str,
        source: &Path,
        project_key: &str,
        properties: &Value,
    ) -> Result<Value, String> {
        match self {
            Remote::Folder(root) => {
                let (root, name, source, key, properties) = (
                    root.clone(),
                    name.to_string(),
                    source.to_path_buf(),
                    project_key.to_string(),
                    properties.clone(),
                );
                blocked(
                    tokio::task::spawn_blocking(move || {
                        backup_store::put(&root, &name, &source, &key, &properties)
                    })
                    .await,
                )
            }
            Remote::Dropbox { client, .. } => {
                client
                    .put(&self.id(), name, source, project_key, properties)
                    .await
            }
        }
    }

    /// Copy a revision out of the store, verifying its checksum.
    pub async fn fetch(
        &self,
        id: &str,
        destination: &Path,
        expected: &str,
        cap: u64,
    ) -> Result<(), String> {
        match self {
            Remote::Folder(root) => {
                let source = backup_store::archive_path(root, id)?;
                let (destination, expected) = (destination.to_path_buf(), expected.to_string());
                blocked(
                    tokio::task::spawn_blocking(move || {
                        backup_store::copy_verified(&source, &destination, &expected, cap)
                    })
                    .await,
                )
            }
            Remote::Dropbox { client, .. } => client.fetch(id, destination, expected, cap).await,
        }
    }

    /// A whole revision in memory, up to `cap` bytes.
    pub async fn read(&self, id: &str, cap: u64) -> Result<Vec<u8>, String> {
        match self {
            Remote::Folder(root) => {
                let (root, id) = (root.clone(), id.to_string());
                blocked(
                    tokio::task::spawn_blocking(move || {
                        backup_store::read_archive(&root, &id, cap)
                    })
                    .await,
                )
            }
            Remote::Dropbox { client, .. } => client.read(id, cap).await,
        }
    }
}
