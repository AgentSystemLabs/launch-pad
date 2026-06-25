//! EC2 instance metadata (IMDSv2). Mirrors `packages/agent/src/metadata.ts`.
//!
//! Synchronous (ureq) — the private IPv4 is fetched once and cached for the process
//! lifetime. IMDSv2 requires a PUT-issued session token.

use std::sync::Mutex;
use std::time::Duration;

const IMDS_TOKEN_URL: &str = "http://169.254.169.254/latest/api/token";
const IMDS_LOCAL_IP_URL: &str = "http://169.254.169.254/latest/meta-data/local-ipv4";

static CACHE: Mutex<Option<String>> = Mutex::new(None);

/// EC2 instance private IPv4 via IMDS (cached for the process lifetime).
pub fn get_private_ip() -> Result<String, String> {
    if let Some(ip) = CACHE.lock().unwrap().clone() {
        return Ok(ip);
    }
    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(2))
        .build();
    let token = agent
        .put(IMDS_TOKEN_URL)
        .set("X-aws-ec2-metadata-token-ttl-seconds", "21600")
        .call()
        .map_err(|e| format!("IMDS token: {e}"))?
        .into_string()
        .map_err(|e| e.to_string())?;
    let ip = agent
        .get(IMDS_LOCAL_IP_URL)
        .set("X-aws-ec2-metadata-token", &token)
        .call()
        .map_err(|e| format!("IMDS local-ipv4: {e}"))?
        .into_string()
        .map_err(|e| e.to_string())?;
    let ip = ip.trim().to_string();
    if ip.is_empty() {
        return Err("IMDS local-ipv4 returned empty body".into());
    }
    *CACHE.lock().unwrap() = Some(ip.clone());
    Ok(ip)
}

/// Pick the IP the edge should dial for this node, by precedence:
/// `LAUNCHPAD_ADVERTISE_IP` env override > `advertiseIp` from agent.json > None.
/// Whitespace-only / empty values are treated as absent.
pub fn pick_advertise_ip(env_override: Option<String>, config_ip: Option<&str>) -> Option<String> {
    if let Some(env) = env_override {
        let trimmed = env.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }
    if let Some(cfg) = config_ip {
        let trimmed = cfg.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }
    None
}

/// Resolve the advertise IP for the upstream shard: the explicit override
/// (env > config) if present, otherwise fall back to the IMDS private IP.
pub fn resolve_advertise_ip(config_ip: Option<&str>) -> Result<String, String> {
    match pick_advertise_ip(std::env::var("LAUNCHPAD_ADVERTISE_IP").ok(), config_ip) {
        Some(ip) => Ok(ip),
        None => get_private_ip(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn env_override_wins_over_config() {
        assert_eq!(
            pick_advertise_ip(Some("1.2.3.4".into()), Some("10.0.0.1")),
            Some("1.2.3.4".to_string())
        );
    }

    #[test]
    fn config_used_when_env_absent() {
        assert_eq!(
            pick_advertise_ip(None, Some("10.0.0.1")),
            Some("10.0.0.1".to_string())
        );
    }

    #[test]
    fn whitespace_or_empty_treated_as_absent() {
        // Empty/whitespace env falls through to config …
        assert_eq!(
            pick_advertise_ip(Some("   ".into()), Some("10.0.0.1")),
            Some("10.0.0.1".to_string())
        );
        assert_eq!(
            pick_advertise_ip(Some("".into()), Some("10.0.0.1")),
            Some("10.0.0.1".to_string())
        );
        // … and empty/whitespace config falls through to None.
        assert_eq!(pick_advertise_ip(None, Some("  ")), None);
        assert_eq!(pick_advertise_ip(None, Some("")), None);
        // Trimmed when used.
        assert_eq!(
            pick_advertise_ip(Some("  5.6.7.8  ".into()), None),
            Some("5.6.7.8".to_string())
        );
    }

    #[test]
    fn none_when_both_absent() {
        assert_eq!(pick_advertise_ip(None, None), None);
    }
}
