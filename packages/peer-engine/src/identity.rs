//! Device identity keypair custody via protected files (0700/0600).
//!
//! No OS keystore is required. The peer engine never stores MESH credentials
//! here — only the iroh device `SecretKey`.

use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use iroh::SecretKey;

const IDENTITY_DIR: &str = "identity";
const DEVICE_KEY_FILE: &str = "device.key";

/// Loaded or freshly generated device identity for an iroh endpoint.
#[derive(Clone, Debug)]
pub struct DeviceIdentity {
    secret: SecretKey,
    path: PathBuf,
}

impl DeviceIdentity {
    /// Load an existing key from `state_dir/identity/device.key`, or create one.
    ///
    /// Ensures `state_dir` and `identity/` are mode `0700`, and the key file is
    /// mode `0600`. Rejects an existing key file with group/other permissions.
    pub fn load_or_create(state_dir: impl AsRef<Path>) -> Result<Self> {
        let state_dir = state_dir.as_ref();
        ensure_dir_private(state_dir).with_context(|| {
            format!("create/validate state dir {}", state_dir.display())
        })?;

        let identity_dir = state_dir.join(IDENTITY_DIR);
        ensure_dir_private(&identity_dir).with_context(|| {
            format!("create/validate identity dir {}", identity_dir.display())
        })?;

        let path = identity_dir.join(DEVICE_KEY_FILE);
        if path.exists() {
            let secret = load_key(&path)?;
            Ok(Self { secret, path })
        } else {
            let secret = SecretKey::generate();
            store_key(&path, &secret)?;
            Ok(Self { secret, path })
        }
    }

    /// Endpoint device secret key (iroh TLS identity).
    pub fn secret_key(&self) -> &SecretKey {
        &self.secret
    }

    /// Public endpoint id as a lowercase hex string.
    pub fn endpoint_id_hex(&self) -> String {
        self.secret.public().to_string()
    }

    /// Absolute path of the protected key file.
    pub fn key_path(&self) -> &Path {
        &self.path
    }
}

fn ensure_dir_private(path: &Path) -> Result<()> {
    if !path.exists() {
        fs::create_dir_all(path)?;
    }
    let meta = fs::metadata(path)?;
    if !meta.is_dir() {
        bail!("{} is not a directory", path.display());
    }
    let mut perms = meta.permissions();
    perms.set_mode(0o700);
    fs::set_permissions(path, perms)?;
    Ok(())
}

fn store_key(path: &Path, secret: &SecretKey) -> Result<()> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
        .with_context(|| format!("create identity key {}", path.display()))?;
    file.write_all(&secret.to_bytes())?;
    file.sync_all()?;
    // Reinforce mode in case umask interfered on create_new platforms.
    let mut perms = file.metadata()?.permissions();
    perms.set_mode(0o600);
    fs::set_permissions(path, perms)?;
    Ok(())
}

fn load_key(path: &Path) -> Result<SecretKey> {
    let meta = fs::metadata(path)?;
    let mode = meta.permissions().mode() & 0o777;
    if mode & 0o077 != 0 {
        bail!(
            "refusing to load identity key {}: mode {:04o} allows group/other access (need 0600)",
            path.display(),
            mode
        );
    }
    let mut file = File::open(path).with_context(|| format!("open {}", path.display()))?;
    let mut buf = [0u8; 32];
    file.read_exact(&mut buf)
        .with_context(|| format!("read 32-byte key from {}", path.display()))?;
    // Ensure no trailing garbage.
    let mut extra = [0u8; 1];
    match file.read(&mut extra)? {
        0 => {}
        n => bail!(
            "identity key {} has unexpected trailing bytes ({n})",
            path.display()
        ),
    }
    Ok(SecretKey::from_bytes(&buf))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn persists_and_reloads_same_endpoint_id() {
        let dir = tempdir().unwrap();
        let first = DeviceIdentity::load_or_create(dir.path()).unwrap();
        let id = first.endpoint_id_hex();
        let mode = fs::metadata(first.key_path()).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        let state_mode = fs::metadata(dir.path()).unwrap().permissions().mode() & 0o777;
        assert_eq!(state_mode, 0o700);

        let second = DeviceIdentity::load_or_create(dir.path()).unwrap();
        assert_eq!(second.endpoint_id_hex(), id);
    }

    #[test]
    fn rejects_world_readable_key() {
        let dir = tempdir().unwrap();
        let id = DeviceIdentity::load_or_create(dir.path()).unwrap();
        let mut perms = fs::metadata(id.key_path()).unwrap().permissions();
        perms.set_mode(0o644);
        fs::set_permissions(id.key_path(), perms).unwrap();
        let err = DeviceIdentity::load_or_create(dir.path()).unwrap_err();
        assert!(err.to_string().contains("group/other"));
    }
}
