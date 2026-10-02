//! PATH detection, and the line it must not cross.
//!
//! Every test here asserts about *data*. There is deliberately no test that a
//! detection makes an agent runnable, because it must not: the only thing a hit
//! produces is an installed-map entry the user can choose to write.

use std::collections::HashMap;
use std::ffi::OsString;
use std::path::Path;

use atlas_acp_thread::AgentId;
use atlas_agent_store::detection::{detect_on_path, find_on_path};
use atlas_agent_store::registry::{
    current_platform_key, RegistryAgent, RegistryAgentMetadata, RegistryBinaryAgent,
    RegistryNpxAgent, RegistryTargetConfig,
};
use atlas_agent_store::settings::AgentServerSettings;

fn metadata(id: &str) -> RegistryAgentMetadata {
    RegistryAgentMetadata {
        id: AgentId::new(id),
        name: format!("{id} CLI"),
        description: String::new(),
        version: "1.0.0".to_string(),
        repository: None,
        website: None,
        icon_path: None,
    }
}

fn binary_agent(id: &str, cmd: &str) -> RegistryAgent {
    RegistryAgent::Binary(RegistryBinaryAgent {
        metadata: metadata(id),
        targets: HashMap::from([(
            current_platform_key().unwrap().to_string(),
            RegistryTargetConfig {
                archive: "https://example.com/a.tar.gz".to_string(),
                cmd: cmd.to_string(),
                args: vec!["--acp".to_string()],
                sha256: None,
                env: HashMap::new(),
            },
        )]),
        supports_current_platform: true,
    })
}

fn npx_agent(id: &str) -> RegistryAgent {
    RegistryAgent::Npx(RegistryNpxAgent {
        metadata: metadata(id),
        package: id.to_string(),
        args: Vec::new(),
        env: HashMap::new(),
    })
}

fn write_executable(dir: &Path, name: &str) {
    let path = dir.join(name);
    std::fs::write(&path, b"#!/bin/sh\n").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
}

/// What an executable called `stem` is named on disk on this host. Windows
/// finds a program by its extension, so a bare `agent` there is not one.
fn exe(stem: &str) -> String {
    format!("{stem}{}", std::env::consts::EXE_SUFFIX)
}

fn path_var(dirs: &[&Path]) -> OsString {
    std::env::join_paths(dirs.iter().map(|dir| dir.to_path_buf())).unwrap()
}

#[test]
fn resolves_the_first_match_in_path_order() {
    let first = tempfile::tempdir().unwrap();
    let second = tempfile::tempdir().unwrap();
    write_executable(first.path(), &exe("agent"));
    write_executable(second.path(), &exe("agent"));

    let found = find_on_path("agent", &path_var(&[first.path(), second.path()])).unwrap();
    assert_eq!(found, first.path().join(exe("agent")));
}

#[cfg(unix)]
#[test]
fn a_file_without_the_executable_bit_is_not_a_hit() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("agent"), b"not executable").unwrap();

    assert!(find_on_path("agent", &path_var(&[dir.path()])).is_none());
}

/// Windows' version of the executable bit: a file is runnable by extension,
/// and `CreateProcess` cannot start an extensionless one.
#[cfg(windows)]
#[test]
fn a_file_without_an_executable_extension_is_not_a_hit() {
    let dir = tempfile::tempdir().unwrap();
    write_executable(dir.path(), "agent");

    assert!(find_on_path("agent", &path_var(&[dir.path()])).is_none());
}

/// npm's global installs and many CLIs ship as a `.cmd` shim on Windows. Within
/// one directory `.exe` is tried first, but `PATH` order still outranks the
/// extension, as it does in `cmd.exe`.
#[cfg(windows)]
#[test]
fn finds_cmd_shims_and_keeps_path_order_over_extension_order() {
    let first = tempfile::tempdir().unwrap();
    let second = tempfile::tempdir().unwrap();
    write_executable(first.path(), "agent.cmd");
    write_executable(second.path(), "agent.exe");

    let found = find_on_path("agent", &path_var(&[first.path(), second.path()])).unwrap();
    assert_eq!(found, first.path().join("agent.cmd"));

    write_executable(first.path(), "agent.exe");
    let found = find_on_path("agent", &path_var(&[first.path(), second.path()])).unwrap();
    assert_eq!(found, first.path().join("agent.exe"));
}

#[test]
fn detects_an_installed_binary_agent_and_offers_it_as_a_custom_entry() {
    let dir = tempfile::tempdir().unwrap();
    write_executable(dir.path(), &exe("some-cli"));

    let detected = detect_on_path(
        &[binary_agent("some-cli", "./some-cli")],
        Some(&path_var(&[dir.path()])),
    );

    assert_eq!(detected.len(), 1);
    assert_eq!(detected[0].id, "some-cli");
    assert_eq!(detected[0].program, dir.path().join(exe("some-cli")));
    assert_eq!(detected[0].args, vec!["--acp".to_string()]);

    // Accepting a detection runs *the copy the user already has* — a `Custom`
    // entry. A `Registry` entry would ignore the find and download our own.
    let entry = detected[0].install_entry();
    assert!(matches!(entry, AgentServerSettings::Custom { .. }));
    assert_eq!(
        entry.command().unwrap().path,
        dir.path().join(exe("some-cli"))
    );
}

/// Registry targets for Windows spell the extension out (`./agent.exe`). That
/// name is looked up as written, not as `agent.exe.exe`.
#[test]
fn a_target_cmd_that_names_its_extension_is_found_as_spelled() {
    let dir = tempfile::tempdir().unwrap();
    write_executable(dir.path(), "some-cli.exe");

    let detected = detect_on_path(
        &[binary_agent("some-cli", "./some-cli.exe")],
        Some(&path_var(&[dir.path()])),
    );

    assert_eq!(detected.len(), 1);
    assert_eq!(detected[0].program, dir.path().join("some-cli.exe"));
}

/// "Node exists" is not "this agent is installed". Probing for `node` would
/// report every npx agent as detected, which is worse than detecting none.
#[test]
fn never_probes_for_node() {
    let dir = tempfile::tempdir().unwrap();
    write_executable(dir.path(), &exe("node"));

    let agents = [npx_agent("npx-only"), binary_agent("node-cmd", "node")];
    assert!(detect_on_path(&agents, Some(&path_var(&[dir.path()]))).is_empty());
}

#[test]
fn an_agent_that_is_not_installed_is_simply_absent() {
    let dir = tempfile::tempdir().unwrap();

    let detected = detect_on_path(
        &[binary_agent("some-cli", "./some-cli")],
        Some(&path_var(&[dir.path()])),
    );
    assert!(detected.is_empty());
}

#[test]
fn no_path_means_no_detections() {
    assert!(detect_on_path(&[binary_agent("some-cli", "./some-cli")], None).is_empty());
}
