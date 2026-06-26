//! AWS client construction. Mirrors `packages/agent/src/aws.ts` (+ the SSM client
//! the TS agent builds in `secrets.ts`).
//!
//! Credentials come from the default provider chain, which on EC2 resolves the
//! instance role via IMDSv2 — so no keys are needed.

use aws_config::meta::region::RegionProviderChain;
use aws_config::{BehaviorVersion, SdkConfig};
use aws_sdk_s3::config::Region;

/// Load the shared SDK config for the given region.
pub async fn load_sdk_config(region: &str) -> SdkConfig {
    let provider = RegionProviderChain::first_try(Region::new(region.to_string()));
    aws_config::defaults(BehaviorVersion::latest())
        .region(provider)
        .load()
        .await
}

/// S3 — both roles (desired/status/shards).
pub fn s3_client(conf: &SdkConfig) -> aws_sdk_s3::Client {
    aws_sdk_s3::Client::new(conf)
}

/// SQS — both roles (receive SNS deploy notifications from the node's own queue).
pub fn sqs_client(conf: &SdkConfig) -> aws_sdk_sqs::Client {
    aws_sdk_sqs::Client::new(conf)
}

/// CloudWatch Logs — both roles (direct log shipping).
#[cfg(any(feature = "app", feature = "edge"))]
pub fn cloudwatch_logs_client(conf: &SdkConfig) -> aws_sdk_cloudwatchlogs::Client {
    aws_sdk_cloudwatchlogs::Client::new(conf)
}

/// ECR — app role only (image pulls).
#[cfg(feature = "app")]
pub fn ecr_client(conf: &SdkConfig) -> aws_sdk_ecr::Client {
    aws_sdk_ecr::Client::new(conf)
}

/// SSM Parameter Store — app role only (secret resolution at container start).
#[cfg(feature = "app")]
pub fn ssm_client(conf: &SdkConfig) -> aws_sdk_ssm::Client {
    aws_sdk_ssm::Client::new(conf)
}
