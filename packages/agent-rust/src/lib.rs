//! Launch Pad node agent (Rust).
//!
//! Parity port of the retired TypeScript agent (`packages/agent`). One crate, two
//! role-specific binaries:
//!
//!   - `launchpad-agent-app`  (feature `app`)  — Docker reconciler: desired.json →
//!     containers, rollouts, cron runs, secrets, upstream-shard publishing.
//!   - `launchpad-agent-edge` (feature `edge`) — Caddy router: upstream shards →
//!     admin-API config pushes. No Docker/ECR/SSM code or deps compiled in.
//!
//! `default = both features` so `cargo test` covers every module in one run; the
//! release builds use `--no-default-features --features <role>` so each binary only
//! carries its own paths. Modules that are pure std (e.g. `docker`'s types/parsers)
//! stay ungated — the linker strips what a binary doesn't use.

// Shared across both roles.
pub mod aws;
pub mod cloudwatch_logs;
pub mod config;
pub mod cron;
pub mod docker;
pub mod logs;
pub mod runtime;
pub mod s3;
pub mod sqs;
pub mod stats;
pub mod status;
pub mod status_write;
pub mod types;

// App role only — the Docker/ECR/SSM reconciler half.
#[cfg(feature = "app")]
pub mod backup;
#[cfg(feature = "app")]
pub mod ecr;
#[cfg(feature = "app")]
pub mod health;
#[cfg(feature = "app")]
pub mod metadata;
#[cfg(feature = "app")]
pub mod reconcile;
#[cfg(feature = "app")]
pub mod s3_backup;
#[cfg(feature = "app")]
pub mod secrets;
#[cfg(feature = "app")]
pub mod state;
#[cfg(feature = "app")]
pub mod upstream;

// Edge role only — the Caddy routing half.
#[cfg(feature = "edge")]
pub mod caddy;
#[cfg(feature = "edge")]
pub mod edge;
#[cfg(feature = "edge")]
pub mod routes;

#[cfg(test)]
mod smoke {
    #[test]
    fn crate_builds_and_tests_run() {
        assert_eq!(2 + 2, 4);
    }
}
