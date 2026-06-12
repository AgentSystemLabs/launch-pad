//! Docker container lifecycle. Mirrors `packages/agent/src/docker.ts`.
//!
//! Pure halves (`parse_inspect`, `build_run_args`, `volume_name`, `container_name`)
//! are unit-tested offline; the imperative wrappers shell out to the docker CLI —
//! the same seam the TypeScript agent used (execa), so behavior matches exactly.

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
    /// Fingerprint of env + secretRefs + restartAt + volumes at container create time.
    #[serde(rename = "configStamp", default)]
    pub config_stamp: String,
    /// Cron fire time (epoch ms) this container ran for — None for long-running replicas.
    #[serde(rename = "cronFireMs", default)]
    pub cron_fire_ms: Option<i64>,
    /// Container exit code — meaningful only when state is "exited"/"dead".
    #[serde(rename = "exitCode", default)]
    pub exit_code: Option<i64>,
}

/// `launchpad_{project}_{service}_{index}` — the managed container name.
pub fn container_name(project: &str, service: &str, index: i64) -> String {
    format!("launchpad_{project}_{service}_{index}")
}

/// Deterministic docker volume name for a service's persistent volume. Encodes the
/// full (project, service, name) tuple so the SAME volume is re-mounted across
/// container replacements (a rolling deploy / restart) — that's what makes the data
/// persist. The three parts are all label-shaped (lowercase alnum + hyphen, no `_`),
/// so the `_` separators stay unambiguous. Mirrors `volumeName`.
pub fn volume_name(project: &str, service: &str, name: &str) -> String {
    format!("launchpadvol_{project}_{service}_{name}")
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
    #[serde(rename = "ExitCode", default)]
    exit_code: Option<i64>,
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
        let config_stamp = lbls.get(labels::CONFIG_STAMP).cloned().unwrap_or_default();
        // Mirrors the TS `parseInt(...) || null`: an absent label is None, and an
        // unparseable or zero value also collapses to None.
        let cron_fire_ms = lbls
            .get(labels::CRON_FIRE)
            .and_then(|s| s.parse::<i64>().ok())
            .filter(|&n| n != 0);
        let name = c.name.unwrap_or_default();
        let name = name.strip_prefix('/').unwrap_or(&name).to_string();
        let state = c
            .state
            .as_ref()
            .and_then(|s| s.status.clone())
            .unwrap_or_else(|| "unknown".to_string());
        let exit_code = c.state.as_ref().and_then(|s| s.exit_code);
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
            config_stamp,
            cron_fire_ms,
            exit_code,
        });
    }

    for list in map.values_mut() {
        list.sort_by(|a, b| a.index.cmp(&b.index));
    }
    Ok(map)
}

// ── docker run argv (pure half of runContainer) ──────────────────────────────────────

/// What a single container run needs. Mirrors TS `RunSpec`.
pub struct RunSpec<'a> {
    pub config: &'a ServiceConfig,
    pub index: i64,
    /// Host port for a web replica; None for workers.
    pub host_port: Option<i64>,
    /// "127.0.0.1" (worker) or "0.0.0.0" (web — reachable by the edge).
    pub bind_host: &'a str,
    /// Set for a scheduled (`cron`) run: the fire time (epoch ms) this container
    /// executes for. Switches the restart policy to `no` (the container runs once
    /// and exits) and stamps the fire label the due-run check reads.
    pub cron_fire_ms: Option<i64>,
}

/// Build the `docker run` argv for a replica. Pure (env is resolved by the caller) so
/// the mount/label/port wiring is unit-testable without spawning docker. Mirrors
/// `buildRunArgs`.
pub fn build_run_args(
    spec: &RunSpec,
    merged_env: &BTreeMap<String, String>,
    stamp: &str,
) -> Vec<String> {
    let c = spec.config;
    let mut args: Vec<String> = vec![
        "run".into(),
        "-d".into(),
        "--name".into(),
        container_name(&c.project, &c.service, spec.index),
        "--label".into(),
        format!("{}=true", labels::MANAGED),
        "--label".into(),
        format!("{}={}", labels::PROJECT, c.project),
        "--label".into(),
        format!("{}={}", labels::SERVICE, c.service),
        "--label".into(),
        format!("{}={}", labels::IMAGE, c.image),
        "--label".into(),
        format!("{}={}", labels::REPLICA, spec.index),
        "--label".into(),
        format!("{}={}", labels::CPU, c.cpu),
        "--label".into(),
        format!("{}={}", labels::MEMORY, c.memory),
        "--label".into(),
        format!("{}={}", labels::CONFIG_STAMP, stamp),
    ];
    if let Some(fire_ms) = spec.cron_fire_ms {
        // A cron run executes once and exits — docker must NOT restart it, or a
        // completed job would re-run forever. The fire label is the durable record of
        // the last started run (it survives agent restarts).
        args.push("--label".into());
        args.push(format!("{}={}", labels::CRON_FIRE, fire_ms));
        args.push("--restart".into());
        args.push("no".into());
    } else {
        args.push("--restart".into());
        args.push("unless-stopped".into());
    }
    args.push("--cpus".into());
    args.push(format_cpus(c.cpu));
    args.push("--memory".into());
    args.push(format!("{}m", c.memory));
    // Persistent named volumes. Docker creates a missing named volume on first run and
    // a `docker rm` (without -v) leaves it intact, so the data outlives the container.
    for v in &c.volumes {
        args.push("-v".into());
        args.push(format!("{}:{}", volume_name(&c.project, &c.service, &v.name), v.path));
    }
    for (k, v) in merged_env {
        args.push("-e".into());
        args.push(format!("{k}={v}"));
    }
    if let (Some(ingress), Some(hp)) = (&c.ingress, spec.host_port) {
        args.push("-p".into());
        args.push(format!("{}:{hp}:{}", spec.bind_host, ingress.port));
    }
    args.push(c.image.clone());
    args
}

/// `cpu shares / 1024` formatted the way JS `String(n)` would (no trailing `.0`).
fn format_cpus(cpu_shares: i64) -> String {
    let cpus = cpu_shares as f64 / 1024.0;
    if cpus == cpus.trunc() {
        format!("{}", cpus as i64)
    } else {
        format!("{cpus}")
    }
}

// ── imperative docker subprocess ops (synchronous; the I/O seam) ─────────────────────

fn run_docker(args: &[&str]) -> Result<(), String> {
    let out = Command::new("docker")
        .args(args)
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(())
    } else {
        // Only the SUBCOMMAND is echoed, never the full argv: `docker run` argv
        // carries resolved SSM secrets as `-e KEY=value` pairs, and this error flows
        // into the service's status message → S3 status.json → CLI/CI output.
        Err(format!(
            "docker {}: {}",
            args.first().copied().unwrap_or(""),
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

/// Run a container. The caller resolves secrets into `merged_env` and computes the
/// config stamp (see `service_config_stamp`) — mirrors TS `runContainer`, where the
/// resolve happens just before the spawn.
pub fn run_container(
    spec: &RunSpec,
    merged_env: &BTreeMap<String, String>,
    stamp: &str,
) -> Result<(), String> {
    let args = build_run_args(spec, merged_env, stamp);
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    run_docker(&refs)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{Ingress, Rollout, VolumeDecl};

    fn web_config() -> ServiceConfig {
        ServiceConfig {
            project: "blog".into(),
            service: "web".into(),
            image: "img:1".into(),
            cpu: 512,
            memory: 256,
            replicas: 1,
            env: BTreeMap::from([("NODE_ENV".to_string(), "production".to_string())]),
            secret_refs: vec![],
            restart_at: None,
            cron: None,
            ingress: Some(Ingress {
                domain: "blog.example.com".into(),
                port: 3000,
                edge: "edge-1".into(),
            }),
            health_check: None,
            rollout: Rollout::default(),
            volumes: vec![],
        }
    }

    #[test]
    fn parses_managed_containers_grouped_by_service_and_sorted_by_index() {
        // Two replicas of blog/api (out of index order) + one unmanaged container (no labels).
        let json = r#"[
            {
                "Id": "id1", "Name": "/launchpad_blog_api_1",
                "State": { "Status": "running", "ExitCode": 0 },
                "Config": {
                    "Labels": {
                        "launchpad.managed": "true", "launchpad.project": "blog",
                        "launchpad.service": "api", "launchpad.image": "img:9",
                        "launchpad.replica": "1", "launchpad.cpu": "512", "launchpad.memory": "256",
                        "launchpad.configStamp": "stamp-a"
                    },
                    "Image": "sha256:abc"
                },
                "NetworkSettings": { "Ports": { "3000/tcp": [{ "HostIp": "127.0.0.1", "HostPort": "20001" }] } }
            },
            {
                "Id": "id0", "Name": "/launchpad_blog_api_0",
                "State": { "Status": "exited", "ExitCode": 137 },
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
        assert_eq!(reps[0].config_stamp, ""); // absent label defaults empty
        assert_eq!(reps[0].exit_code, Some(137));

        assert_eq!(reps[1].index, 1);
        assert_eq!(reps[1].image, "img:9"); // label wins
        assert_eq!(reps[1].cpu, 512);
        assert_eq!(reps[1].memory, 256);
        assert_eq!(reps[1].host_port, Some(20001));
        assert_eq!(reps[1].config_stamp, "stamp-a");
        assert_eq!(reps[1].cron_fire_ms, None);
        assert_eq!(reps[1].exit_code, Some(0));
    }

    #[test]
    fn parses_a_cron_run_container_fire_label() {
        let json = r#"[
            {
                "Id": "run1", "Name": "/launchpad_blog_job_0",
                "State": { "Status": "exited", "ExitCode": 0 },
                "Config": {
                    "Labels": {
                        "launchpad.managed": "true", "launchpad.project": "blog",
                        "launchpad.service": "job", "launchpad.replica": "0",
                        "launchpad.cronFire": "1765500000000"
                    }
                }
            }
        ]"#;
        let map = parse_inspect(json).unwrap();
        let reps = map.get("blog/job").unwrap();
        assert_eq!(reps[0].cron_fire_ms, Some(1_765_500_000_000));
    }

    #[test]
    fn returns_empty_for_no_containers() {
        assert_eq!(parse_inspect("[]").unwrap().len(), 0);
    }

    #[test]
    fn build_run_args_wires_labels_limits_env_and_port() {
        let config = web_config();
        let spec = RunSpec {
            config: &config,
            index: 0,
            host_port: Some(20001),
            bind_host: "0.0.0.0",
            cron_fire_ms: None,
        };
        let env = BTreeMap::from([("NODE_ENV".to_string(), "production".to_string())]);
        let args = build_run_args(&spec, &env, "stamp-x");
        let joined = args.join(" ");
        assert!(joined.contains("--name launchpad_blog_web_0"));
        assert!(joined.contains("--label launchpad.managed=true"));
        assert!(joined.contains("--label launchpad.configStamp=stamp-x"));
        assert!(joined.contains("--restart unless-stopped"));
        assert!(joined.contains("--cpus 0.5"));
        assert!(joined.contains("--memory 256m"));
        assert!(joined.contains("-e NODE_ENV=production"));
        assert!(joined.contains("-p 0.0.0.0:20001:3000"));
        assert!(joined.ends_with("img:1"));
        assert!(!joined.contains("cronFire"));
    }

    #[test]
    fn build_run_args_mounts_named_volumes() {
        let mut config = web_config();
        config.volumes = vec![
            VolumeDecl { name: "data".into(), path: "/data".into() },
            VolumeDecl { name: "cache".into(), path: "/var/cache/app".into() },
        ];
        let spec = RunSpec {
            config: &config,
            index: 1,
            host_port: Some(20002),
            bind_host: "0.0.0.0",
            cron_fire_ms: None,
        };
        let args = build_run_args(&spec, &BTreeMap::new(), "s");
        let joined = args.join(" ");
        // Volume names encode the (project, service, name) tuple — index-independent
        // so the SAME volume is re-mounted across replacements.
        assert!(joined.contains("-v launchpadvol_blog_web_data:/data"));
        assert!(joined.contains("-v launchpadvol_blog_web_cache:/var/cache/app"));
    }

    #[test]
    fn build_run_args_for_a_cron_run_uses_restart_no_and_the_fire_label() {
        let mut config = web_config();
        config.ingress = None;
        config.cron = Some("*/5 * * * *".into());
        let spec = RunSpec {
            config: &config,
            index: 0,
            host_port: None,
            bind_host: "127.0.0.1",
            cron_fire_ms: Some(1_765_500_000_000),
        };
        let args = build_run_args(&spec, &BTreeMap::new(), "s");
        let joined = args.join(" ");
        assert!(joined.contains("--label launchpad.cronFire=1765500000000"));
        assert!(joined.contains("--restart no"));
        assert!(!joined.contains("--restart unless-stopped"));
        assert!(!joined.contains("-p "));
    }

    #[test]
    fn volume_name_encodes_the_tuple() {
        assert_eq!(volume_name("blog", "db", "data"), "launchpadvol_blog_db_data");
    }

    #[test]
    fn format_cpus_matches_js_number_formatting() {
        assert_eq!(format_cpus(1024), "1");
        assert_eq!(format_cpus(512), "0.5");
        assert_eq!(format_cpus(256), "0.25");
        assert_eq!(format_cpus(2048), "2");
    }
}
