//! Caddy admin-API config builder. Mirrors the pure half of
//! `packages/agent/src/caddy.ts` (`buildConfig` + `WebRoute`). The imperative
//! `applyCaddy` (POST to the admin API with the in-memory idempotency cache) lands later.

use serde_json::{json, Value};

use crate::types::CaddyStatus;

/// A host-matched reverse-proxy route.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WebRoute {
    pub domain: String,
    /// Reverse-proxy upstream dials, e.g. "127.0.0.1:20001" or "10.0.1.5:20001".
    pub upstreams: Vec<String>,
    /// Active-health-check path (web replicas only).
    pub health_path: Option<String>,
}

/// Cap on Caddy error-body text echoed into status (avoid unbounded status writes).
const CADDY_ERROR_TEXT_MAX: usize = 200;

fn admin_block() -> Value {
    // Caddy guards its admin API against DNS-rebinding by checking the request origin;
    // the agent calls it over loopback, so we allow the loopback hosts plus the empty
    // origin that a server-side fetch sends.
    json!({
        "listen": "127.0.0.1:2019",
        "origins": ["", "127.0.0.1:2019", "localhost:2019", "[::1]:2019"],
    })
}

fn reverse_proxy_handler(route: &WebRoute) -> Value {
    let mut health_checks = json!({
        "passive": {
            "fail_duration": "10s",
            "max_fails": 1,
            "unhealthy_status": [500, 502, 503, 504],
        }
    });
    if let Some(path) = &route.health_path {
        health_checks["active"] = json!({
            "uri": path,
            "interval": "5s",
            "timeout": "2s",
            "expect_status": 2,
        });
    }
    json!({
        "handler": "reverse_proxy",
        "upstreams": route.upstreams.iter().map(|dial| json!({ "dial": dial })).collect::<Vec<_>>(),
        "load_balancing": {
            "selection_policy": { "policy": "round_robin" },
            "retries": 3,
            "try_duration": "5s",
            "try_interval": "250ms",
        },
        "health_checks": health_checks,
    })
}

/// Build a Caddy server config listening on :443 with host-matched reverse-proxy routes.
/// Routes without upstreams are dropped; an empty result clears all servers.
pub fn build_config(routes: &[WebRoute]) -> Value {
    let live: Vec<&WebRoute> = routes.iter().filter(|r| !r.upstreams.is_empty()).collect();
    if live.is_empty() {
        return json!({ "admin": admin_block(), "apps": { "http": { "servers": {} } } });
    }
    let route_objs: Vec<Value> = live
        .iter()
        .map(|r| {
            json!({
                "match": [{ "host": [r.domain] }],
                "handle": [reverse_proxy_handler(r)],
            })
        })
        .collect();
    json!({
        "admin": admin_block(),
        "apps": {
            "http": {
                "servers": {
                    "launchpad": {
                        "listen": [":443"],
                        "routes": route_objs,
                    }
                }
            }
        }
    })
}

// ── imperative apply (POST to the Caddy admin API) ───────────────────────────────────

/// In-memory idempotency cache so we don't reload Caddy every tick when nothing changed.
#[derive(Debug, Default)]
pub struct CaddyState {
    pub last_config_json: String,
    pub last_reload_at: Option<String>,
}

/// Decide whether the desired config must be POSTed to `/load`.
///
/// The TS agent only compared against `last_config_json` — what the agent last SENT —
/// so a Caddy restart (crash/OOM/manual) reverted Caddy to its init config while the
/// stale cache suppressed the re-push, leaving HTTPS routing broken until the agent
/// restarted. This decision instead verifies what Caddy ACTUALLY holds (`remote`,
/// from `GET /config/` each tick — a cheap loopback call):
///
///   - desired ≠ last pushed            → push (ordinary change)
///   - remote unreadable / unparseable  → push (fail closed: the POST surfaces the
///     real error into status instead of silently serving a stale cache)
///   - remote ≠ desired                 → push (Caddy restarted out from under us)
///   - remote = desired                 → skip
pub fn decide_caddy_push(desired: &Value, last_pushed_json: &str, remote: Option<&Value>) -> bool {
    let desired_json = serde_json::to_string(desired).expect("config is serializable");
    if desired_json != last_pushed_json {
        return true;
    }
    match remote {
        None => true,
        Some(r) => r != desired,
    }
}

/// What Caddy currently holds: `GET {admin}/config/`, parsed. None when the admin API
/// is unreachable or the body isn't JSON (both mean "unknown state — re-push").
fn fetch_remote_config(admin: &str) -> Option<Value> {
    let body = ureq::get(&format!("{admin}/config/"))
        .call()
        .ok()?
        .into_string()
        .ok()?;
    serde_json::from_str(&body).ok()
}

fn truncate_error(e: impl std::fmt::Display) -> String {
    let mut s = e.to_string();
    if s.len() > CADDY_ERROR_TEXT_MAX {
        let mut cut = CADDY_ERROR_TEXT_MAX;
        while !s.is_char_boundary(cut) {
            cut -= 1;
        }
        s.truncate(cut);
    }
    s
}

/// Push the desired routing config to Caddy's admin API (idempotent). `admin` is the
/// admin base URL (default `http://127.0.0.1:2019`); `now` is the reload timestamp.
/// Probes Caddy's live config first so an out-of-band Caddy restart is detected and
/// the config force-re-pushed within one tick.
pub fn apply_caddy(
    routes: &[WebRoute],
    admin: &str,
    state: &mut CaddyState,
    now: &str,
) -> CaddyStatus {
    let managed = !routes.is_empty();
    let desired = build_config(routes);
    let json = serde_json::to_string(&desired).expect("config is serializable");

    let remote = fetch_remote_config(admin);
    if !decide_caddy_push(&desired, &state.last_config_json, remote.as_ref()) {
        return CaddyStatus {
            managed,
            last_reload_at: state.last_reload_at.clone(),
            error: None,
        };
    }
    if !state.last_config_json.is_empty() && json == state.last_config_json {
        eprintln!("[agent] caddy: running config drifted from last push (caddy restarted?) — re-pushing");
    }

    match ureq::post(&format!("{admin}/load"))
        .set("Content-Type", "application/json")
        .send_string(&json)
    {
        Ok(_) => {
            state.last_config_json = json;
            state.last_reload_at = Some(now.to_string());
            CaddyStatus {
                managed,
                last_reload_at: state.last_reload_at.clone(),
                error: None,
            }
        }
        Err(e) => CaddyStatus {
            managed,
            last_reload_at: state.last_reload_at.clone(),
            error: Some(format!("caddy /load: {}", truncate_error(e))),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn route(domain: &str, upstreams: &[&str], health_path: Option<&str>) -> WebRoute {
        WebRoute {
            domain: domain.into(),
            upstreams: upstreams.iter().map(|s| s.to_string()).collect(),
            health_path: health_path.map(|s| s.to_string()),
        }
    }

    #[test]
    fn includes_a_permissive_admin_block() {
        let cfg = build_config(&[]);
        let origins = cfg["admin"]["origins"].as_array().unwrap();
        assert!(origins.iter().any(|o| o.as_str() == Some("")));
        assert!(origins.iter().any(|o| o.as_str() == Some("127.0.0.1:2019")));
    }

    #[test]
    fn clears_all_servers_when_there_are_no_web_routes() {
        let cfg = build_config(&[]);
        assert_eq!(cfg["apps"]["http"]["servers"], json!({}));
    }

    #[test]
    fn drops_a_route_that_has_no_upstreams() {
        let cfg = build_config(&[route("x.com", &[], None)]);
        assert_eq!(cfg["apps"]["http"]["servers"], json!({}));
    }

    #[test]
    fn builds_a_load_balanced_health_checked_route_across_replicas() {
        let cfg = build_config(&[route(
            "app.example.com",
            &["127.0.0.1:20001", "127.0.0.1:20002"],
            Some("/healthz"),
        )]);
        let server = &cfg["apps"]["http"]["servers"]["launchpad"];
        assert_eq!(server["listen"], json!([":443"]));
        let route0 = &server["routes"][0];
        assert_eq!(route0["match"][0]["host"], json!(["app.example.com"]));
        let handler = &route0["handle"][0];
        assert_eq!(handler["handler"].as_str(), Some("reverse_proxy"));
        let dials: Vec<&str> = handler["upstreams"]
            .as_array()
            .unwrap()
            .iter()
            .map(|u| u["dial"].as_str().unwrap())
            .collect();
        assert_eq!(dials, vec!["127.0.0.1:20001", "127.0.0.1:20002"]);
        assert_eq!(
            handler["load_balancing"]["selection_policy"]["policy"].as_str(),
            Some("round_robin")
        );
        // Retries + passive eviction keep rollouts zero-downtime when an upstream drains.
        assert_eq!(handler["load_balancing"]["try_duration"].as_str(), Some("5s"));
        assert_eq!(handler["health_checks"]["active"]["uri"].as_str(), Some("/healthz"));
        assert_eq!(handler["health_checks"]["passive"]["max_fails"].as_i64(), Some(1));
    }

    #[test]
    fn keeps_passive_health_checks_even_with_no_active_health_path() {
        let cfg = build_config(&[route("app.example.com", &["127.0.0.1:20001"], None)]);
        let handler = &cfg["apps"]["http"]["servers"]["launchpad"]["routes"][0]["handle"][0];
        assert_eq!(
            handler["health_checks"]["passive"]["fail_duration"].as_str(),
            Some("10s")
        );
        assert!(handler["health_checks"]["active"].is_null());
    }

    // ── restart detection (the lastConfigJson staleness bug fix) ──

    #[test]
    fn pushes_when_the_desired_config_changed() {
        let desired = build_config(&[route("a.com", &["10.0.0.1:1"], None)]);
        // Last push was something else entirely → push regardless of remote.
        assert!(decide_caddy_push(&desired, "{}", Some(&desired)));
    }

    #[test]
    fn skips_when_remote_matches_the_unchanged_desired_config() {
        let desired = build_config(&[route("a.com", &["10.0.0.1:1"], None)]);
        let last = serde_json::to_string(&desired).unwrap();
        assert!(!decide_caddy_push(&desired, &last, Some(&desired)));
    }

    #[test]
    fn force_pushes_when_caddy_restarted_to_its_init_config() {
        // The agent's cache says "already pushed", but Caddy is actually holding its
        // boot-time init config (admin-only) — the exact bug: a Caddy restart without
        // an agent restart must force a re-push within one tick.
        let desired = build_config(&[route("a.com", &["10.0.0.1:1"], None)]);
        let last = serde_json::to_string(&desired).unwrap();
        let init_config = json!({ "admin": { "listen": "127.0.0.1:2019" } });
        assert!(decide_caddy_push(&desired, &last, Some(&init_config)));
    }

    #[test]
    fn force_pushes_when_the_remote_config_cannot_be_read() {
        // Unknown live state (admin unreachable / non-JSON) → fail closed and push;
        // the POST then surfaces the real error into status instead of silently
        // trusting a stale cache.
        let desired = build_config(&[route("a.com", &["10.0.0.1:1"], None)]);
        let last = serde_json::to_string(&desired).unwrap();
        assert!(decide_caddy_push(&desired, &last, None));
    }
}
