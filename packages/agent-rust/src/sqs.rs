//! SNS/SQS notification listener placeholder for agent.
//! Full implementation deferred: agents use 60s polling fallback for now.
//! Future: subscribe to SNS→SQS for immediate config updates.

use aws_sdk_sns::Client as SnsClient;
use aws_sdk_sqs::Client as SqsClient;

#[allow(dead_code)]
pub async fn subscribe_to_cluster_topic(
  _sns: &SnsClient,
  _sqs: &SqsClient,
  _cluster_id: &str,
) -> Result<String, Box<dyn std::error::Error>> {
  // Stub: SNS→SQS subscription not yet fully implemented.
  // Agents fall back to 60s polling interval when SNS unavailable.
  Ok("sns-subscription-arn".to_string())
}

#[allow(dead_code)]
pub async fn poll_sqs_messages(
  _sqs: &SqsClient,
  _queue_url: &str,
  _on_message: impl Fn() + Send + Sync + 'static,
) {
  // Stub: polling not yet implemented.
  // Agents use S3 polling as primary mechanism (60s interval).
}
