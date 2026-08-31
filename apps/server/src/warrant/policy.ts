import { escapesWorkspace, matchesAny } from "./glob.js";
import type {
  AgentAction,
  PolicyDecision,
  Warrant,
  WarrantUsage,
} from "./types.js";

const SHELL_SEPARATORS = /(?:&&|\|\||[;|\n])/;
const SUBSTITUTIONS = /\$\(([^)]*)\)|`([^`]*)`/g;
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const SHELL_BINARIES = new Set(["bash", "sh", "zsh", "dash", "ksh"]);
const SHELL_COMMAND_FLAG = /^-[a-z]*c$/;

const NETWORK_BINARIES = new Set([
  "curl",
  "wget",
  "nc",
  "ncat",
  "netcat",
  "ssh",
  "scp",
  "sftp",
  "rsync",
  "telnet",
  "ftp",
]);

const SECRET_REFERENCES = [
  /ARK_API_KEY/,
  /APP_AUTH_TOKEN/,
  /\/proc\/self\/environ/,
  /\bid_rsa\b/,
];

const allow = (clause: string, reason: string): PolicyDecision => ({
  verdict: "allow",
  clause,
  reason,
});

const block = (clause: string, reason: string): PolicyDecision => ({
  verdict: "block",
  clause,
  reason,
});

function stripOuterQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' || first === "'") && first === last) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

/**
 * Codex almost always wraps a command as `bash -lc "<script>"`. Treating the
 * wrapper as the effective binary would let the real command hide inside a
 * quoted argument, so shell wrappers are transparent: the inner script is
 * expanded and evaluated in their place, recursively.
 */
export function unwrapShell(segment: string): string[] {
  const tokens = segment.split(/\s+/).filter((token) => token.length > 0);
  let index = 0;
  while (index < tokens.length && ENV_ASSIGNMENT.test(tokens[index] as string)) {
    index += 1;
  }
  const binary = (tokens[index] ?? "").replace(/\\/g, "/").split("/").pop() ?? "";
  if (!SHELL_BINARIES.has(binary)) return [segment];
  const flagAt = tokens.findIndex(
    (token, position) => position > index && SHELL_COMMAND_FLAG.test(token),
  );
  if (flagAt === -1) return [segment];
  const script = stripOuterQuotes(tokens.slice(flagAt + 1).join(" "));
  if (!script) return [segment];
  return splitShellSegments(script).flatMap((inner) => unwrapShell(inner));
}

export function splitShellSegments(command: string): string[] {
  const expanded: string[] = [];
  const stripped = command.replace(SUBSTITUTIONS, (_match, parens, ticks) => {
    const inner = (parens ?? ticks ?? "").trim();
    if (inner) expanded.push(inner);
    return " ";
  });
  const segments = [stripped, ...expanded]
    .flatMap((part) => part.split(SHELL_SEPARATORS))
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  return segments;
}

export function commandBinary(segment: string): string {
  const tokens = segment.split(/\s+/).filter((token) => token.length > 0);
  let index = 0;
  while (index < tokens.length && ENV_ASSIGNMENT.test(tokens[index] as string)) {
    index += 1;
  }
  if (tokens[index] === "sudo" || tokens[index] === "command") index += 1;
  const binary = tokens[index] ?? "";
  return binary.replace(/\\/g, "/").split("/").pop() ?? "";
}

function referencesSecret(segment: string): boolean {
  return SECRET_REFERENCES.some((pattern) => pattern.test(segment));
}

function dumpsEnvironment(segment: string, binary: string): boolean {
  if (binary === "printenv") return true;
  if (binary !== "env") return false;
  const tokens = segment.split(/\s+/).slice(1);
  return tokens.every((token) => !ENV_ASSIGNMENT.test(token));
}

function checkWarrantState(warrant: Warrant, at: Date): PolicyDecision | null {
  if (warrant.status === "revoked") {
    return block("warrant.status", "The warrant for this run was revoked");
  }
  if (warrant.status !== "approved") {
    return block(
      "warrant.status",
      "The warrant is " + warrant.status + " and has not been approved",
    );
  }
  if (Date.parse(warrant.expiresAt) <= at.getTime()) {
    return block("warrant.expiresAt", "The warrant expired at " + warrant.expiresAt);
  }
  return null;
}

function evaluateCommand(
  command: string,
  warrant: Warrant,
  usage: WarrantUsage,
): PolicyDecision {
  const { scope } = warrant;
  if (usage.commands >= scope.maxCommands) {
    return block(
      "scope.maxCommands",
      "The warrant allows at most " + scope.maxCommands + " commands",
    );
  }
  const segments = splitShellSegments(command).flatMap((segment) =>
    unwrapShell(segment),
  );
  if (segments.length === 0) {
    return block("scope.commands", "The command could not be parsed");
  }
  for (const segment of segments) {
    const binary = commandBinary(segment);
    if (!binary) {
      return block("scope.commands", "A command segment had no executable");
    }
    if (referencesSecret(segment)) {
      return block(
        "scope.secretHandling",
        "Segment '" + segment + "' references a protected credential",
      );
    }
    if (dumpsEnvironment(segment, binary)) {
      return block(
        "scope.secretHandling",
        "Segment '" + segment + "' dumps the process environment",
      );
    }
    if (scope.denyCommands.includes(binary)) {
      return block(
        "scope.denyCommands",
        "Command '" + binary + "' is explicitly denied by the warrant",
      );
    }
    if (!scope.networkEgress && NETWORK_BINARIES.has(binary)) {
      return block(
        "scope.networkEgress",
        "Command '" + binary + "' performs network egress, which this warrant forbids",
      );
    }
    if (!scope.commands.includes(binary)) {
      return block(
        "scope.commands",
        "Command '" + binary + "' is outside the warranted command set",
      );
    }
  }
  return allow("scope.commands", "All " + segments.length + " command segments are warranted");
}

function evaluateFileChange(
  paths: string[],
  warrant: Warrant,
  usage: WarrantUsage,
): PolicyDecision {
  const { scope } = warrant;
  if (usage.fileWrites + paths.length > scope.maxFileWrites) {
    return block(
      "scope.maxFileWrites",
      "The warrant allows at most " + scope.maxFileWrites + " file writes",
    );
  }
  for (const path of paths) {
    if (escapesWorkspace(path)) {
      return block(
        "scope.writePaths",
        "Path '" + path + "' resolves outside the Agent workspace",
      );
    }
    if (!matchesAny(scope.writePaths, path)) {
      return block(
        "scope.writePaths",
        "Path '" + path + "' is outside the warranted write scope",
      );
    }
  }
  return allow("scope.writePaths", "All " + paths.length + " paths are within the write scope");
}

export function evaluateAction(
  action: AgentAction,
  warrant: Warrant,
  usage: WarrantUsage,
  at: Date = new Date(),
): PolicyDecision {
  const stateDecision = checkWarrantState(warrant, at);
  if (stateDecision) return stateDecision;

  if (action.kind === "command") {
    return evaluateCommand(action.command, warrant, usage);
  }
  if (action.kind === "file_change") {
    return evaluateFileChange(action.paths, warrant, usage);
  }
  if (!warrant.scope.networkEgress && action.tool.startsWith("web_")) {
    return block(
      "scope.networkEgress",
      "Tool '" + action.tool + "' reaches the network, which this warrant forbids",
    );
  }
  return allow("scope.toolCalls", "Tool '" + action.tool + "' is permitted");
}

export function applyUsage(action: AgentAction, usage: WarrantUsage): WarrantUsage {
  if (action.kind === "command") {
    return { ...usage, commands: usage.commands + 1 };
  }
  if (action.kind === "file_change") {
    return { ...usage, fileWrites: usage.fileWrites + action.paths.length };
  }
  return usage;
}
