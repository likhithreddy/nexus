import pino from "pino";
import { PRODUCT_NAME } from "./version.js";

const LEVEL = process.env.NEXUS_LOG_LEVEL ?? "info";

/**
 * Nexus logger.
 *
 * IMPORTANT: stdout is reserved for the MCP JSON-RPC wire protocol when Nexus
 * runs as a server (`nexus serve`). All logs therefore go to **stderr** (fd 2).
 * Human-facing CLI output (list-tools, add, ...) uses console.log on stdout and
 * is only ever produced by commands that do not speak MCP.
 */
export const logger = pino(
  { level: LEVEL, base: { name: PRODUCT_NAME } },
  pino.destination(2),
);
