//! SNS→SQS deploy-notification listener (the push half of the hybrid model).
//!
//! The CLI creates a per-node SQS queue (`launch-pad-<cluster>-<node>`), subscribes
//! it to the cluster's SNS topic, and publishes a `config-changed` message on every
//! deploy. This background task long-polls that queue and, on any message, wakes the
//! reconcile loop (via `Notify`) so the node fetches the new desired state in
//! milliseconds instead of waiting for the next poll interval. The agent is a pure
//! CONSUMER — it never creates the queue or subscribes (that's the CLI's job, run with
//! provisioning-grade IAM); its own IAM grants only receive/delete on its queue. If the
//! queue doesn't exist yet (cluster never deployed, or a node not yet redeployed after
//! upgrade) the URL lookup retries with backoff while 60s polling carries the node.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use aws_sdk_sqs::Client as SqsClient;
use tokio::sync::Notify;

/// How long to wait between failed `GetQueueUrl` attempts (queue not created yet).
const QUEUE_LOOKUP_BACKOFF: Duration = Duration::from_secs(30);
/// Backoff after a transient `ReceiveMessage` error before retrying.
const RECEIVE_ERROR_BACKOFF: Duration = Duration::from_secs(5);
/// SQS long-poll wait — holds the connection open until a message or this elapses.
const LONG_POLL_SECONDS: i32 = 20;

/// The per-node SQS queue name. MUST match the CLI's `ensureNodeQueue`
/// (`launch-pad-${clusterId}-${nodeId}`) byte-for-byte — the CLI creates and subscribes
/// the queue under this name; the agent looks it up by the same name.
pub fn queue_name(cluster_id: &str, node_id: &str) -> String {
    format!("launch-pad-{cluster_id}-{node_id}")
}

/// Run the SQS deploy-notification listener until `term` is set. Resolves the node's
/// queue URL (retrying until the CLI has created it), then long-polls for messages and
/// fires `notify` whenever any arrive so the main loop reconciles immediately.
pub async fn run_sqs_listener(
    sqs: SqsClient,
    cluster_id: String,
    node_id: String,
    notify: Arc<Notify>,
    term: Arc<AtomicBool>,
) {
    let queue_name = queue_name(&cluster_id, &node_id);

    let queue_url = match resolve_queue_url(&sqs, &queue_name, &term).await {
        Some(url) => url,
        None => return, // term set before the queue ever appeared
    };
    eprintln!("[agent] SNS deploy notifications active (queue {queue_name})");

    while !term.load(Ordering::Relaxed) {
        match sqs
            .receive_message()
            .queue_url(&queue_url)
            .max_number_of_messages(10)
            .wait_time_seconds(LONG_POLL_SECONDS)
            .send()
            .await
        {
            Ok(out) => {
                let messages = out.messages();
                if messages.is_empty() {
                    continue;
                }
                for msg in messages {
                    if let Some(handle) = msg.receipt_handle() {
                        // Log delete failures — a missing sqs:DeleteMessage grant would
                        // otherwise silently redeliver every message and wake the loop
                        // each visibility-timeout cycle with no greppable signal.
                        if let Err(err) = sqs
                            .delete_message()
                            .queue_url(&queue_url)
                            .receipt_handle(handle)
                            .send()
                            .await
                        {
                            eprintln!("[agent] sqs delete error: {err}");
                        }
                    }
                }
                // One wake reconciles the whole desired state, so collapsing a burst of
                // messages into a single notify is correct (and cheaper).
                notify.notify_one();
            }
            Err(err) => {
                eprintln!("[agent] sqs receive error: {err}");
                tokio::time::sleep(RECEIVE_ERROR_BACKOFF).await;
            }
        }
    }
}

/// Look up the queue URL by name, retrying with backoff until it exists or `term` is
/// set. Returns `None` only if shutdown is requested before the queue appears.
async fn resolve_queue_url(
    sqs: &SqsClient,
    queue_name: &str,
    term: &AtomicBool,
) -> Option<String> {
    loop {
        if term.load(Ordering::Relaxed) {
            return None;
        }
        match sqs.get_queue_url().queue_name(queue_name).send().await {
            Ok(out) => {
                if let Some(url) = out.queue_url() {
                    return Some(url.to_string());
                }
            }
            Err(_) => {
                // Queue not created yet (no deploy) or transient — polling fallback covers
                // the node meanwhile. Quietly retry.
            }
        }
        tokio::time::sleep(QUEUE_LOOKUP_BACKOFF).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn queue_name_matches_cli_contract() {
        // Must equal the CLI's `launch-pad-${clusterId}-${nodeId}` exactly.
        assert_eq!(queue_name("default", "node-1"), "launch-pad-default-node-1");
        assert_eq!(queue_name("prod", "edge-1"), "launch-pad-prod-edge-1");
    }
}
