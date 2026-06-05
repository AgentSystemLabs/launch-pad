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
