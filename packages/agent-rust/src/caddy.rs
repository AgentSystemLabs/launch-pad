//! Caddy admin-API config builder. Mirrors the pure half of
//! `packages/agent/src/caddy.ts` (`buildConfig` + `WebRoute`). The imperative
//! `applyCaddy` (POST to the admin API with the in-memory idempotency cache) lands later.

use serde_json::{json, Value};

/// A host-matched reverse-proxy route.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WebRoute {
    pub domain: String,
    /// Reverse-proxy upstream dials, e.g. "127.0.0.1:20001" or "10.0.1.5:20001".
    pub upstreams: Vec<String>,
    /// Active-health-check path (web replicas only).
    pub health_path: Option<String>,
}

/// The result of an `applyCaddy` pass, surfaced into `status.json`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CaddyOutcome {
    pub managed: bool,
    pub last_reload_at: Option<String>,
    pub error: Option<String>,
}

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

// ── imperative apply (POST to the Caddy admin API; the Phase-6 I/O seam) ─────────────

/// In-memory idempotency cache so we don't reload Caddy every tick when nothing changed.
#[derive(Debug, Default)]
pub struct CaddyState {
    pub last_config_json: String,
    pub last_reload_at: Option<String>,
}

/// Push the desired routing config to Caddy's admin API (idempotent). `admin` is the
/// admin base URL (default `http://127.0.0.1:2019`); `now` is the reload timestamp.
pub fn apply_caddy(
    routes: &[WebRoute],
    admin: &str,
    state: &mut CaddyState,
    now: &str,
) -> CaddyOutcome {
    let managed = !routes.is_empty();
    let json = serde_json::to_string(&build_config(routes)).expect("config is serializable");

    if json == state.last_config_json {
        return CaddyOutcome {
            managed,
            last_reload_at: state.last_reload_at.clone(),
            error: None,
        };
    }

    match ureq::post(&format!("{admin}/load"))
        .set("Content-Type", "application/json")
        .send_string(&json)
    {
        Ok(_) => {
            state.last_config_json = json;
            state.last_reload_at = Some(now.to_string());
            CaddyOutcome {
                managed,
                last_reload_at: state.last_reload_at.clone(),
                error: None,
            }
        }
        Err(e) => CaddyOutcome {
            managed,
            last_reload_at: state.last_reload_at.clone(),
            error: Some(format!("caddy /load: {e}")),
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
}
