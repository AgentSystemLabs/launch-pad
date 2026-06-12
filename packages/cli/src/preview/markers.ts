import { parsePreviewMarker, previewMarkerKey, type PreviewMarker } from "@agentsystemlabs/launch-pad-shared";
import type { AwsEnv } from "../aws/context";
import { awsErrorName } from "../aws/errors";
import { getJson, listProjectIds } from "../aws/s3-state";
import { log } from "../ui/log";

/** Every readable env marker in the cluster (unparsable ones are warned about, not fatal). */
export async function loadEnvMarkers(aws: AwsEnv): Promise<PreviewMarker[]> {
  let owners: string[];
  try {
    owners = await listProjectIds(aws.s3, aws.bucket, aws.clusterId);
  } catch (error) {
    if (awsErrorName(error) === "NoSuchBucket") return [];
    throw error;
  }
  const markers: PreviewMarker[] = [];
  for (const owner of owners) {
    const obj = await getJson(aws.s3, aws.bucket, previewMarkerKey(aws.clusterId, owner));
    if (!obj) continue;
    try {
      markers.push(parsePreviewMarker(obj.raw));
    } catch {
      log.warn(`unreadable env marker for "${owner}" — skipping (re-deploy the env to repair it)`);
    }
  }
  return markers;
}
