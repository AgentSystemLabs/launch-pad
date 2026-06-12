//! SSM secret resolution. Mirrors `packages/agent/src/secrets.ts`.
//!
//! Secrets are resolved from SSM Parameter Store at container start (not pre-cached);
//! the pure merge half (`merge_resolved_env`) is unit-tested offline.

use std::collections::BTreeMap;

use aws_sdk_ssm::Client as SsmClient;

use crate::types::{SecretRef, ServiceConfig};

/// Pure: join fetched SSM values back to their env names and merge with plain env.
/// Plain env wins on collision. Errs when a referenced parameter is missing —
/// mirrors the TS `SSM parameter not found` throw.
pub fn merge_resolved_env(
    refs: &[SecretRef],
    fetched: &BTreeMap<String, String>,
    plain: &BTreeMap<String, String>,
) -> Result<BTreeMap<String, String>, String> {
    let mut merged: BTreeMap<String, String> = BTreeMap::new();
    for r in refs {
        match fetched.get(&r.ssm) {
            Some(value) => {
                merged.insert(r.name.clone(), value.clone());
            }
            None => {
                return Err(format!("SSM parameter not found: {} ({})", r.ssm, r.name));
            }
        }
    }
    for (k, v) in plain {
        merged.insert(k.clone(), v.clone());
    }
    Ok(merged)
}

/// Resolve secretRefs from SSM and merge with plain env. Mirrors `resolveServiceEnv`.
pub async fn resolve_service_env(
    ssm: &SsmClient,
    config: &ServiceConfig,
) -> Result<BTreeMap<String, String>, String> {
    let refs = &config.secret_refs;
    let mut fetched: BTreeMap<String, String> = BTreeMap::new();

    if !refs.is_empty() {
        let names: Vec<String> = refs.iter().map(|r| r.ssm.clone()).collect();
        let res = ssm
            .get_parameters()
            .set_names(Some(names))
            .with_decryption(true)
            .send()
            .await
            .map_err(|e| format!("ssm get-parameters: {e}"))?;
        for p in res.parameters() {
            if let (Some(name), Some(value)) = (p.name(), p.value()) {
                fetched.insert(name.to_string(), value.to_string());
            }
        }
    }

    merge_resolved_env(refs, &fetched, &config.env)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn refs() -> Vec<SecretRef> {
        vec![
            SecretRef {
                name: "DB_PASSWORD".into(),
                ssm: "/launch-pad/default/p/web/DB_PASSWORD".into(),
            },
            SecretRef {
                name: "API_KEY".into(),
                ssm: "/launch-pad/default/p/web/API_KEY".into(),
            },
        ]
    }

    #[test]
    fn resolves_refs_to_their_env_names() {
        let fetched = BTreeMap::from([
            ("/launch-pad/default/p/web/DB_PASSWORD".to_string(), "s3cret".to_string()),
            ("/launch-pad/default/p/web/API_KEY".to_string(), "key".to_string()),
        ]);
        let merged = merge_resolved_env(&refs(), &fetched, &BTreeMap::new()).unwrap();
        assert_eq!(merged.get("DB_PASSWORD").map(String::as_str), Some("s3cret"));
        assert_eq!(merged.get("API_KEY").map(String::as_str), Some("key"));
    }

    #[test]
    fn plain_env_wins_on_collision() {
        let fetched = BTreeMap::from([
            ("/launch-pad/default/p/web/DB_PASSWORD".to_string(), "from-ssm".to_string()),
            ("/launch-pad/default/p/web/API_KEY".to_string(), "key".to_string()),
        ]);
        let plain = BTreeMap::from([("DB_PASSWORD".to_string(), "from-env".to_string())]);
        let merged = merge_resolved_env(&refs(), &fetched, &plain).unwrap();
        assert_eq!(merged.get("DB_PASSWORD").map(String::as_str), Some("from-env"));
    }

    #[test]
    fn errs_on_a_missing_parameter() {
        let fetched = BTreeMap::from([
            ("/launch-pad/default/p/web/DB_PASSWORD".to_string(), "x".to_string()),
        ]);
        let err = merge_resolved_env(&refs(), &fetched, &BTreeMap::new()).unwrap_err();
        assert!(err.contains("SSM parameter not found"));
        assert!(err.contains("API_KEY"));
    }

    #[test]
    fn no_refs_yields_plain_env_only() {
        let plain = BTreeMap::from([("A".to_string(), "1".to_string())]);
        let merged = merge_resolved_env(&[], &BTreeMap::new(), &plain).unwrap();
        assert_eq!(merged, plain);
    }
}
