import path from "node:path";
import { DATADIR } from "@ccr/core/config/constants";

/**
 * Our storage sits beside CCR's, never inside its files. Upstream owns
 * usage.sqlite and request-logs.sqlite; we own everything under ccx/.
 */
export const CCX_DATA_DIR = path.join(DATADIR, "ccx");
export const CCX_METRICS_DB_FILE = path.join(CCX_DATA_DIR, "metrics.sqlite");
export const CCX_SESSIONS_DB_FILE = path.join(CCX_DATA_DIR, "sessions.sqlite");
