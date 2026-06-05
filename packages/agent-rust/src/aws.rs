//! AWS client construction. Mirrors `packages/agent/src/aws.ts`.
//!
//! Credentials come from the default provider chain, which on EC2 resolves the
//! instance role via IMDSv2 — so no keys are needed.

use aws_config::meta::region::RegionProviderChain;
use aws_config::BehaviorVersion;
use aws_sdk_s3::config::Region;

/// Construct the S3 + ECR clients for the given region.
pub async fn make_clients(region: &str) -> (aws_sdk_s3::Client, aws_sdk_ecr::Client) {
    let provider = RegionProviderChain::first_try(Region::new(region.to_string()));
    let conf = aws_config::defaults(BehaviorVersion::latest())
        .region(provider)
        .load()
        .await;
    (
        aws_sdk_s3::Client::new(&conf),
        aws_sdk_ecr::Client::new(&conf),
    )
}
