//! Local port-allocation state. Mirrors `packages/agent/src/state.ts`.
//!
//! Phase 3 ports the pure allocation/persistence shape; the file read/write
//! (`/var/lib/launch-pad/state.json`, env-overridable) lands with the main loop.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

use crate::types::{HOST_PORT_COUNT, HOST_PORT_MIN};

const PORT_MIN: i64 = HOST_PORT_MIN;
const PORT_RANGE: i64 = HOST_PORT_COUNT;

/// Persisted local state. Mirrors `state.ts` `LocalState`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalState {
    /// Stable host-port allocations keyed by `project/service#index`.
    #[serde(default)]
    pub ports: BTreeMap<String, i64>,
    /// Per cron service key: the last fire (epoch ms) a run was started for — or,
    /// before the first run, the first-sight ANCHOR. The anchor stops a freshly
    /// deployed (or rebooted-without-containers) schedule from replaying fires that
    /// predate it; the run container's fire label is the other half of the record.
    #[serde(default)]
    pub cron_fires: BTreeMap<String, i64>,
}

/// Parse the persisted state JSON, defaulting to empty on any error (matches `loadState`).
pub fn parse_state(json: &str) -> LocalState {
    serde_json::from_str(json).unwrap_or_default()
}

/// Serialize state the way `saveState` writes it: pretty (2-space) + trailing newline.
pub fn serialize_state(state: &LocalState) -> String {
    format!(
        "{}\n",
        serde_json::to_string_pretty(state).expect("LocalState is serializable")
    )
}

/// FNV-ish 31-multiplier hash matching `state.ts` (`h = (h*31 + charCode) >>> 0`).
fn hash(input: &str) -> u32 {
    let mut h: u32 = 0;
    for ch in input.chars() {
        h = h.wrapping_mul(31).wrapping_add(ch as u32);
    }
    h
}

/// Deterministically allocate a stable host port for a (service, replica index).
pub fn allocate_port(state: &mut LocalState, key: &str, index: i64) -> i64 {
    let map_key = format!("{key}#{index}");
    if let Some(&existing) = state.ports.get(&map_key) {
        return existing;
    }

    let used: BTreeSet<i64> = state.ports.values().copied().collect();
    let mut port = PORT_MIN + (hash(&map_key) as i64 % PORT_RANGE);
    while used.contains(&port) {
        port = PORT_MIN + ((port + 1 - PORT_MIN) % PORT_RANGE);
    }
    state.ports.insert(map_key, port);
    port
}

/// Free a replica's port allocation (called on scale-down / rollout cleanup).
pub fn release_port(state: &mut LocalState, key: &str, index: i64) {
    state.ports.remove(&format!("{key}#{index}"));
}

const DEFAULT_STATE_PATH: &str = "/var/lib/launch-pad/state.json";

/// Resolve the state-file path (`LAUNCHPAD_STATE` or the default).
pub fn state_path() -> String {
    std::env::var("LAUNCHPAD_STATE").unwrap_or_else(|_| DEFAULT_STATE_PATH.to_string())
}

/// Read persisted state, defaulting to empty on any error (mirrors `loadState`).
pub fn load_state(path: &str) -> LocalState {
    std::fs::read_to_string(path)
        .map(|raw| parse_state(&raw))
        .unwrap_or_default()
}

/// Persist state. Returns false on failure (logged, never panics): ports degrade
/// gracefully (reassigned next boot), but CRON callers must check the result —
/// `record_cron_fire`'s skip-not-duplicate guarantee depends on the fire being
/// durably recorded BEFORE the run starts. Mirrors `saveState`.
///
/// Write to a temp file then atomically rename over the real one: a bare write
/// truncates-then-writes, so a crash mid-write would leave a truncated state.json —
/// `load_state` would swallow the parse error and return empty, silently dropping
/// every port allocation. rename() is atomic on the same filesystem.
pub fn save_state(path: &str, state: &LocalState) -> bool {
    let result = (|| -> std::io::Result<()> {
        if let Some(dir) = std::path::Path::new(path).parent() {
            std::fs::create_dir_all(dir)?;
        }
        let tmp = format!("{path}.tmp");
        std::fs::write(&tmp, serialize_state(state))?;
        std::fs::rename(&tmp, path)?;
        Ok(())
    })();
    match result {
        Ok(()) => true,
        Err(error) => {
            eprintln!("[agent] state: failed to persist {path}: {error}");
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allocates_a_stable_port_in_range_and_reuses_it() {
        let mut state = LocalState::default();
        let p = allocate_port(&mut state, "blog/web", 0);
        assert!((PORT_MIN..PORT_MIN + PORT_RANGE).contains(&p));
        // Reuse: a second allocation for the same key returns the same port.
        assert_eq!(allocate_port(&mut state, "blog/web", 0), p);
    }

    #[test]
    fn reuses_an_existing_allocation_from_loaded_state() {
        let mut state = LocalState {
            ports: BTreeMap::from([("blog/web#0".to_string(), 25000)]),
            cron_fires: BTreeMap::new(),
        };
        assert_eq!(allocate_port(&mut state, "blog/web", 0), 25000);
    }

    #[test]
    fn avoids_a_collision_by_probing_the_next_free_port() {
        // First, learn the port "blog/web#0" naturally hashes to.
        let mut a = LocalState::default();
        let natural = allocate_port(&mut a, "blog/web", 0);

        // Now occupy that exact port under a different key, then allocate ours.
        let mut b = LocalState {
            ports: BTreeMap::from([("squatter#0".to_string(), natural)]),
            cron_fires: BTreeMap::new(),
        };
        let probed = allocate_port(&mut b, "blog/web", 0);
        assert_ne!(probed, natural);
        assert_eq!(probed, PORT_MIN + ((natural + 1 - PORT_MIN) % PORT_RANGE));
    }

    #[test]
    fn releases_a_port_allocation() {
        let mut state = LocalState {
            ports: BTreeMap::from([("blog/web#0".to_string(), 25000)]),
            cron_fires: BTreeMap::new(),
        };
        release_port(&mut state, "blog/web", 0);
        assert!(!state.ports.contains_key("blog/web#0"));
    }

    #[test]
    fn parse_state_is_lenient_and_round_trips() {
        assert_eq!(parse_state("not json"), LocalState::default());
        assert_eq!(parse_state("{}"), LocalState::default());

        let state = LocalState {
            ports: BTreeMap::from([("blog/web#0".to_string(), 20001)]),
            cron_fires: BTreeMap::from([("blog/job".to_string(), 1_765_500_000_000)]),
        };
        let serialized = serialize_state(&state);
        assert!(serialized.ends_with('\n'));
        assert!(serialized.contains("\"cronFires\""));
        assert_eq!(parse_state(&serialized), state);
    }

    #[test]
    fn pre_cron_state_files_parse_with_empty_cron_fires() {
        let state = parse_state(r#"{ "ports": { "blog/web#0": 20001 } }"#);
        assert_eq!(state.ports.len(), 1);
        assert!(state.cron_fires.is_empty());
    }
}
