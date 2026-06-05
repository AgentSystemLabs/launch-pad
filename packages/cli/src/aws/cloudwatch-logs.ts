import {
  type CloudWatchLogsClient,
  FilterLogEventsCommand,
  type FilteredLogEvent,
} from "@aws-sdk/client-cloudwatch-logs";
import { awsErrorName } from "./errors";

export interface LogEvent {
  /** Epoch millis the event was logged. */
  timestamp: number;
  message: string;
  /** Source stream, e.g. `{nodeId}/{replicaIndex}` (or `agent`/`caddy` for system). */
  logStreamName: string;
  /** Stable id used to dedupe across overlapping `--follow` polls. */
  eventId: string;
}

export interface FilterParams {
  logGroupName: string;
  /** Inclusive window start (epoch millis). */
  startTime: number;
  /** Exclusive window end (epoch millis); omit for "up to now". */
  endTime?: number;
  /** CloudWatch Logs filter pattern (a bare term matches that term in the message). */
  filterPattern?: string;
  nextToken?: string;
  limit?: number;
}

function toLogEvent(e: FilteredLogEvent): LogEvent {
  return {
    timestamp: e.timestamp ?? 0,
    message: e.message ?? "",
    logStreamName: e.logStreamName ?? "",
    eventId: e.eventId ?? "",
  };
}

/** One page of FilterLogEvents across every stream in the group (all nodes/replicas). */
export async function filterLogEventsPage(
  logs: CloudWatchLogsClient,
  p: FilterParams,
): Promise<{ events: LogEvent[]; nextToken?: string }> {
  const res = await logs.send(
    new FilterLogEventsCommand({
      logGroupName: p.logGroupName,
      startTime: p.startTime,
      endTime: p.endTime,
      filterPattern: p.filterPattern,
      nextToken: p.nextToken,
      limit: p.limit,
    }),
  );
  return { events: (res.events ?? []).map(toLogEvent), nextToken: res.nextToken };
}

/** Drain every page in the window, bounded by `maxEvents` so a huge window can't run away. */
export async function filterAllLogEvents(
  logs: CloudWatchLogsClient,
  p: FilterParams,
  maxEvents = 5000,
): Promise<LogEvent[]> {
  const all: LogEvent[] = [];
  let token: string | undefined;
  do {
    const { events, nextToken } = await filterLogEventsPage(logs, { ...p, nextToken: token });
    all.push(...events);
    token = nextToken;
  } while (token && all.length < maxEvents);
  return all;
}

/** True when the target log group has never been created (no logs shipped yet). */
export function isLogGroupMissing(error: unknown): boolean {
  return awsErrorName(error) === "ResourceNotFoundException";
}

/** True when the operator's local creds lack read access to the log group. */
export function isAccessDenied(error: unknown): boolean {
  const name = awsErrorName(error);
  return name === "AccessDeniedException" || name === "AccessDenied";
}
