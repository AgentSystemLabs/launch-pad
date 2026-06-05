//! ECR docker-login. Mirrors `packages/agent/src/ecr-auth.ts`.
//!
//! Gets an auth token from ECR via the instance role, decodes it, and pipes the
//! password into `docker login` over stdin. Cached for 6h (tokens last ~12h) — the
//! caller owns the `last_login_ms` cache cell.

use std::io::Write;
use std::process::{Command, Stdio};

use aws_sdk_ecr::Client as EcrClient;
use base64::prelude::{Engine as _, BASE64_STANDARD};

const LOGIN_TTL_MS: i64 = 6 * 60 * 60 * 1000;

/// `docker login` to ECR using the instance role; cached so we don't login every tick.
pub async fn ensure_ecr_login(
    ecr: &EcrClient,
    last_login_ms: &mut Option<i64>,
    now_ms: i64,
    force: bool,
) -> Result<(), String> {
    if !force {
        if let Some(last) = *last_login_ms {
            if now_ms - last < LOGIN_TTL_MS {
                return Ok(());
            }
        }
    }

    let res = ecr
        .get_authorization_token()
        .send()
        .await
        .map_err(|e| format!("ecr token: {e}"))?;
    let auth = res
        .authorization_data()
        .first()
        .ok_or("ECR returned no authorization token")?;
    let token = auth
        .authorization_token()
        .ok_or("ECR returned no authorization token")?;
    let proxy = auth
        .proxy_endpoint()
        .ok_or("ECR returned no proxy endpoint")?;

    let decoded = BASE64_STANDARD
        .decode(token)
        .map_err(|e| format!("decode token: {e}"))?;
    let decoded = String::from_utf8(decoded).map_err(|e| e.to_string())?;
    let password = match decoded.find(':') {
        Some(i) => &decoded[i + 1..],
        None => decoded.as_str(),
    };
    let host = proxy
        .strip_prefix("https://")
        .or_else(|| proxy.strip_prefix("http://"))
        .unwrap_or(proxy);

    let mut child = Command::new("docker")
        .args(["login", "--username", "AWS", "--password-stdin", host])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .spawn()
        .map_err(|e| format!("spawn docker login: {e}"))?;
    child
        .stdin
        .take()
        .ok_or("docker login: no stdin")?
        .write_all(password.as_bytes())
        .map_err(|e| e.to_string())?;
    let status = child.wait().map_err(|e| e.to_string())?;
    if !status.success() {
        return Err("docker login failed".into());
    }
    *last_login_ms = Some(now_ms);
    Ok(())
}
