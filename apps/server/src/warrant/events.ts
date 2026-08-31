import { normalizePath } from "./glob.js";
import type { AgentAction } from "./types.js";

export interface RuntimeItem {
  id: string;
  type: string;
  raw: Record<string, unknown>;
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

export function extractItem(event: Record<string, unknown>): RuntimeItem | null {
  if (event.type !== "item.started" && event.type !== "item.completed") return null;
  const item = asRecord(event.item);
  if (!item) return null;
  const type = typeof item.type === "string" ? item.type : null;
  if (!type) return null;
  const id = typeof item.id === "string" ? item.id : type;
  return { id, type, raw: item };
}

export function relativizePath(candidate: string, workspaceRoots: string[]): string {
  const normalized = candidate.replace(/\\/g, "/");
  for (const root of workspaceRoots) {
    const base = root.replace(/\\/g, "/").replace(/\/+$/, "");
    if (normalized.startsWith(base + "/")) {
      return normalizePath(normalized.slice(base.length + 1));
    }
    if (normalized === base) {
      // A write to the workspace root itself is treated as an escape.
      return normalized;
    }
  }
  // An absolute path outside every workspace root must stay absolute so the
  // downstream workspace-escape check rejects it, instead of normalizePath
  // stripping the leading slash and disguising it as an in-workspace path.
  if (normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized)) {
    return normalized;
  }
  return normalizePath(normalized);
}

const COMMAND_FIELDS = ["command", "cmd", "parsed_cmd", "argv"] as const;

function coerceCommand(value: unknown): string | null {
  if (typeof value === "string" && value.trim().length > 0) return value;
  if (Array.isArray(value)) {
    const joined = value
      .filter((part): part is string => typeof part === "string")
      .join(" ")
      .trim();
    return joined.length > 0 ? joined : null;
  }
  return null;
}

function readCommand(item: Record<string, unknown>): string | null {
  for (const field of COMMAND_FIELDS) {
    const value = coerceCommand(item[field]);
    if (value) return value;
  }
  return null;
}

const PATH_FIELDS = [
  "path",
  "file_path",
  "absolute_file_path",
  "file",
  "filename",
] as const;

function pathFromRecord(record: Record<string, unknown>): string | null {
  for (const field of PATH_FIELDS) {
    if (typeof record[field] === "string") return record[field] as string;
  }
  return null;
}

function readChangedPaths(item: Record<string, unknown>): string[] {
  const changes = item.changes ?? item.files ?? item.paths;
  if (Array.isArray(changes)) {
    return changes
      .map((entry) => {
        if (typeof entry === "string") return entry;
        const record = asRecord(entry);
        return record ? pathFromRecord(record) : null;
      })
      .filter((path): path is string => path !== null);
  }
  const record = asRecord(changes);
  if (record) return Object.keys(record);
  // Some shapes report a single changed path directly on the item.
  const direct = pathFromRecord(item);
  return direct ? [direct] : [];
}

export function itemToAction(
  item: RuntimeItem,
  workspaceRoots: string[],
): AgentAction | null {
  if (item.type === "command_execution") {
    const command = readCommand(item.raw);
    return command ? { kind: "command", itemId: item.id, command } : null;
  }
  if (item.type === "file_change" || item.type === "patch_apply") {
    const paths = readChangedPaths(item.raw).map((path) =>
      relativizePath(path, workspaceRoots),
    );
    return paths.length > 0 ? { kind: "file_change", itemId: item.id, paths } : null;
  }
  if (item.type === "mcp_tool_call" || item.type === "web_search") {
    const name =
      typeof item.raw.tool === "string"
        ? item.raw.tool
        : typeof item.raw.name === "string"
          ? item.raw.name
          : item.type;
    return { kind: "tool_call", itemId: item.id, tool: name };
  }
  return null;
}

export function describeAction(action: AgentAction): string {
  if (action.kind === "command") return action.command;
  if (action.kind === "file_change") return action.paths.join(", ");
  return action.tool;
}
