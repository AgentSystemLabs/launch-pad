import { z } from "zod";

/** SNS notification schema version — bump when adding message types or fields. */
export const SNS_NOTIFICATION_VERSION = 1;

/** ISO 8601 timestamp format validation (YYYY-MM-DDTHH:mm:ss.sssZ). */
const iso8601Timestamp = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/);

/** Discriminated union for future message types. Start with "config-changed"; add new types as union members. */
export const SnsDeployNotificationSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("config-changed"),
    cluster: z.string().min(1),
    timestamp: iso8601Timestamp,
    version: z.literal(SNS_NOTIFICATION_VERSION),
  }).strict(),
]);

export type SnsDeployNotification = z.infer<typeof SnsDeployNotificationSchema>;
