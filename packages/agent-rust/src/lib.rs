//! Rust rewrite spike of the Launch Pad node agent.
//!
//! Parity port of `packages/agent` (TypeScript). Modules are added phase by phase
//! under strict TDD — each mirrors a TS source file and ports its Vitest suite.
//! See `README.md` for the phase checklist and parity table.

// Shared/agent-local types used across modules.
pub mod config;
pub mod docker;
pub mod edge;
pub mod logs;
pub mod types;

// Phase 1 — pure planners (added as each is ported)
pub mod caddy;
pub mod cloudwatch_logs;
pub mod reconcile;
pub mod routes;
pub mod stats;
pub mod status_write;
pub mod upstream;

// Phase 3 — status + state builders
pub mod state;
pub mod status;

// Phase 4 — I/O adapters (pure parsing + key derivation) + Phase 6 async clients
pub mod aws;
pub mod ecr;
pub mod health;
pub mod metadata;
pub mod s3;

#[cfg(test)]
mod smoke {
    #[test]
    fn crate_builds_and_tests_run() {
        assert_eq!(2 + 2, 4);
    }
}
