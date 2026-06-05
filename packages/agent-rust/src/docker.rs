//! Docker-derived types. Mirrors `packages/agent/src/docker.ts`.
//!
//! Phase 1 only needs the `ManagedReplica` shape (the result of `docker inspect`,
//! consumed by the pure planners). The imperative command wrappers / inspect parsing
//! land in Phase 4.

use std::collections::BTreeMap;
use std::process::Command;

use serde::{Deserialize, Serialize};

use crate::types::{labels, service_key, ServiceConfig};

/// A launch-pad-managed container as read from `docker inspect`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ManagedReplica {
    pub id: String,
    pub name: String,
    pub index: i64,
    /// docker container state: running | exited | created | ...
    pub state: String,
    pub project: String,
    pub service: String,
    /// The desired image recorded on the container (launchpad.image label).
    pub image: String,
    /// vCPU shares (1024 = 1 vCPU) from launchpad.cpu label.
    pub cpu: i64,
    /// Memory limit in MB from launchpad.memory label.
    pub memory: i64,
    /// Published host port (None for workers / unpublished).
    #[serde(rename = "hostPort")]
    pub host_port: Option<i64>,
}

/// `launchpad_{project}_{service}_{index}` — the managed container name.
pub fn container_name(project: &str, service: &str, index: i64) -> String {
    format!("launchpad_{project}_{service}_{index}")
}

// ── `docker inspect` JSON parsing (pure half of inspectManaged) ──────────────────────

#[derive(Deserialize)]
struct DockerInspect {
    #[serde(rename = "Id")]
    id: String,
    #[serde(rename = "Name", default)]
    name: Option<String>,
    #[serde(rename = "State", default)]
    state: Option<DockerStateField>,
    #[serde(rename = "Config", default)]
    config: Option<DockerConfigField>,
    #[serde(rename = "NetworkSettings", default)]
    network_settings: Option<NetworkSettings>,
}

#[derive(Deserialize)]
struct DockerStateField {
    #[serde(rename = "Status", default)]
    status: Option<String>,
}

#[derive(Deserialize)]
struct DockerConfigField {
    #[serde(rename = "Labels", default)]
    labels: Option<BTreeMap<String, String>>,
    #[serde(rename = "Image", default)]
    image: Option<String>,
}

#[derive(Deserialize)]
struct NetworkSettings {
    #[serde(rename = "Ports", default)]
    ports: Option<BTreeMap<String, Option<Vec<PortBinding>>>>,
}

#[derive(Deserialize)]
struct PortBinding {
    #[serde(rename = "HostPort", default)]
    host_port: Option<String>,
}

fn parse_host_port(net: Option<&NetworkSettings>) -> Option<i64> {
    let ports = net?.ports.as_ref()?;
    for bindings in ports.values() {
        let Some(list) = bindings else { continue };
        if let Some(first) = list.first() {
            if let Some(hp) = &first.host_port {
                if !hp.is_empty() {
                    if let Ok(n) = hp.parse::<i64>() {
                        return Some(n);
                    }
                }
            }
        }
    }
    None
}

/// Parse `docker inspect <ids...>` output into managed replicas grouped per
/// `project/service` (sorted by index). Containers missing the project/service labels
/// are skipped. Mirrors the parse loop in `inspectManaged`.
pub fn parse_inspect(json: &str) -> Result<BTreeMap<String, Vec<ManagedReplica>>, String> {
    let inspected: Vec<DockerInspect> = serde_json::from_str(json).map_err(|e| e.to_string())?;
    let mut map: BTreeMap<String, Vec<ManagedReplica>> = BTreeMap::new();

    for c in inspected {
        let lbls = c
            .config
            .as_ref()
            .and_then(|cfg| cfg.labels.clone())
            .unwrap_or_default();
        let project = match lbls.get(labels::PROJECT) {
            Some(p) if !p.is_empty() => p.clone(),
            _ => continue,
        };
        let service = match lbls.get(labels::SERVICE) {
            Some(s) if !s.is_empty() => s.clone(),
            _ => continue,
        };
        let index = lbls
            .get(labels::REPLICA)
            .and_then(|s| s.parse::<i64>().ok())
            .unwrap_or(0);
        let image = lbls
            .get(labels::IMAGE)
            .cloned()
            .or_else(|| c.config.as_ref().and_then(|cfg| cfg.image.clone()))
            .unwrap_or_default();
        let cpu = lbls
            .get(labels::CPU)
            .and_then(|s| s.parse::<i64>().ok())
            .unwrap_or(0);
        let memory = lbls
            .get(labels::MEMORY)
            .and_then(|s| s.parse::<i64>().ok())
            .unwrap_or(0);
        let name = c.name.unwrap_or_default();
        let name = name.strip_prefix('/').unwrap_or(&name).to_string();
        let state = c
            .state
            .as_ref()
            .and_then(|s| s.status.clone())
            .unwrap_or_else(|| "unknown".to_string());
        let host_port = parse_host_port(c.network_settings.as_ref());
        let key = service_key(&project, &service);
        map.entry(key).or_default().push(ManagedReplica {
            id: c.id,
            name,
            index,
            state,
            project,
            service,
            image,
            cpu,
            memory,
            host_port,
        });
    }

    for list in map.values_mut() {
        list.sort_by(|a, b| a.index.cmp(&b.index));
    }
    Ok(map)
}

// ── imperative docker subprocess ops (synchronous; the Phase-6 I/O seam) ─────────────

fn run_docker(args: &[&str]) -> Result<(), String> {
    let out = Command::new("docker")
        .args(args)
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(())
    } else {
        Err(format!(
            "docker {}: {}",
            args.join(" "),
            String::from_utf8_lossy(&out.stderr).trim()
        ))
    }
}

/// Inspect all managed containers, grouped per `project/service` (sorted by index).
pub fn inspect_managed() -> Result<BTreeMap<String, Vec<ManagedReplica>>, String> {
    let filter = format!("label={}=true", labels::MANAGED);
    let ids_out = Command::new("docker")
        .args(["ps", "-aq", "--filter", &filter])
        .output()
        .map_err(|e| e.to_string())?;
    if !ids_out.status.success() {
        return Err(format!(
            "docker ps: {}",
            String::from_utf8_lossy(&ids_out.stderr).trim()
        ));
    }
    let ids_str = String::from_utf8_lossy(&ids_out.stdout);
    let ids: Vec<&str> = ids_str.split_whitespace().collect();
    if ids.is_empty() {
        return Ok(BTreeMap::new());
    }
    let mut args: Vec<&str> = vec!["inspect"];
    args.extend(ids.iter().copied());
    let out = Command::new("docker")
        .args(&args)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(format!(
            "docker inspect: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    parse_inspect(&String::from_utf8_lossy(&out.stdout))
}

pub fn pull(image: &str) -> Result<(), String> {
    run_docker(&["pull", image])
}

pub fn start_container(id: &str) -> Result<(), String> {
    run_docker(&["start", id])
}

/// Hard remove (SIGKILL after 10s) — best-effort, mirrors TS `.catch(() => undefined)`.
pub fn remove_container(name_or_id: &str) -> Result<(), String> {
    let _ = run_docker(&["rm", "-f", name_or_id]);
    Ok(())
}

/// Graceful stop (SIGTERM → wait grace → SIGKILL) then remove — best-effort.
pub fn stop_container(name_or_id: &str, grace_seconds: i64) -> Result<(), String> {
    let _ = run_docker(&["stop", "--time", &grace_seconds.to_string(), name_or_id]);
    let _ = run_docker(&["rm", name_or_id]);
    Ok(())
}

pub fn run_container(
    config: &ServiceConfig,
    index: i64,
    host_port: Option<i64>,
    bind_host: &str,
) -> Result<(), String> {
    let cpus = (config.cpu as f64 / 1024.0).to_string();
    let memory = format!("{}m", config.memory);
    let mut args: Vec<String> = vec![
        "run".into(),
        "-d".into(),
        "--name".into(),
        container_name(&config.project, &config.service, index),
        "--label".into(),
        format!("{}=true", labels::MANAGED),
        "--label".into(),
        format!("{}={}", labels::PROJECT, config.project),
        "--label".into(),
        format!("{}={}", labels::SERVICE, config.service),
        "--label".into(),
        format!("{}={}", labels::IMAGE, config.image),
        "--label".into(),
        format!("{}={}", labels::REPLICA, index),
        "--label".into(),
        format!("{}={}", labels::CPU, config.cpu),
        "--label".into(),
        format!("{}={}", labels::MEMORY, config.memory),
        "--restart".into(),
        "unless-stopped".into(),
        "--cpus".into(),
        cpus,
        "--memory".into(),
        memory,
    ];
    for (k, v) in &config.env {
        args.push("-e".into());
        args.push(format!("{k}={v}"));
    }
    if let (Some(ingress), Some(hp)) = (&config.ingress, host_port) {
        args.push("-p".into());
        args.push(format!("{bind_host}:{hp}:{}", ingress.port));
    }
    args.push(config.image.clone());
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    run_docker(&refs)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_managed_containers_grouped_by_service_and_sorted_by_index() {
        // Two replicas of blog/api (out of index order) + one unmanaged container (no labels).
        let json = r#"[
            {
                "Id": "id1", "Name": "/launchpad_blog_api_1",
                "State": { "Status": "running" },
                "Config": {
                    "Labels": {
                        "launchpad.managed": "true", "launchpad.project": "blog",
                        "launchpad.service": "api", "launchpad.image": "img:9",
                        "launchpad.replica": "1", "launchpad.cpu": "512", "launchpad.memory": "256"
                    },
                    "Image": "sha256:abc"
                },
                "NetworkSettings": { "Ports": { "3000/tcp": [{ "HostIp": "127.0.0.1", "HostPort": "20001" }] } }
            },
            {
                "Id": "id0", "Name": "/launchpad_blog_api_0",
                "State": { "Status": "exited" },
                "Config": {
                    "Labels": {
                        "launchpad.managed": "true", "launchpad.project": "blog",
                        "launchpad.service": "api", "launchpad.replica": "0"
                    },
                    "Image": "sha256:fallback"
                },
                "NetworkSettings": { "Ports": {} }
            },
            { "Id": "other", "Config": { "Labels": {} } }
        ]"#;

        let map = parse_inspect(json).unwrap();
        assert_eq!(map.len(), 1);
        let reps = map.get("blog/api").unwrap();
        assert_eq!(reps.len(), 2);

        // Sorted by index: index 0 first.
        assert_eq!(reps[0].index, 0);
        assert_eq!(reps[0].id, "id0");
        assert_eq!(reps[0].name, "launchpad_blog_api_0"); // leading slash stripped
        assert_eq!(reps[0].state, "exited");
        assert_eq!(reps[0].image, "sha256:fallback"); // falls back to Config.Image
        assert_eq!(reps[0].host_port, None);

        assert_eq!(reps[1].index, 1);
        assert_eq!(reps[1].image, "img:9"); // label wins
        assert_eq!(reps[1].cpu, 512);
        assert_eq!(reps[1].memory, 256);
        assert_eq!(reps[1].host_port, Some(20001));
    }

    #[test]
    fn returns_empty_for_no_containers() {
        assert_eq!(parse_inspect("[]").unwrap().len(), 0);
    }
}
