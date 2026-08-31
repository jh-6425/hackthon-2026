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
    const prefix = root.replace(/\\/g, "/").replace(/\/+$/, "") + "/";
    if (normalized.startsWith(prefix)) {
      return normalizePath(normalized.slice(prefix.length));
    }
  }
  return normalizePath(normalized);
}

function readCommand(item: Record<string, unknown>): string | null {
  if (typeof item.command === "string") return item.command;
  if (Array.isArray(item.command)) {
    return item.command.filter((part) => typeof part === "string").join(" ");
  }
  return null;
}

function readChangedPaths(item: Record<string, unknown>): string[] {
  const { changes } = item;
  if (Array.isArray(changes)) {
    return changes
      .map((entry) => {
        if (typeof entry === "string") return entry;
        const record = asRecord(entry);
        return record && typeof record.path === "string" ? record.path : null;
      })
      .filter((path): path is string => path !== null);
  }
  const record = asRecord(changes);
  if (record) return Object.keys(record);
  return [];
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
