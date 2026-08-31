const REGEXP_SPECIALS = /[.+^${}()|[\]\\]/g;

export function globToRegExp(pattern: string): RegExp {
  let source = "";
  let index = 0;
  while (index < pattern.length) {
    const character = pattern[index] as string;
    if (character === "*") {
      if (pattern[index + 1] === "*") {
        if (pattern[index + 2] === "/") {
          source += "(?:[^/]+/)*";
          index += 3;
        } else {
          source += ".*";
          index += 2;
        }
      } else {
        source += "[^/]*";
        index += 1;
      }
      continue;
    }
    if (character === "?") {
      source += "[^/]";
      index += 1;
      continue;
    }
    source += character.replace(REGEXP_SPECIALS, "\\$&");
    index += 1;
  }
  return new RegExp("^" + source + "$");
}

export function normalizePath(input: string): string {
  return input.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

export function escapesWorkspace(input: string): boolean {
  const normalized = input.replace(/\\/g, "/");
  if (normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized)) return true;
  return normalized
    .split("/")
    .some((segment) => segment === "..");
}

export function matchesAny(patterns: string[], candidate: string): boolean {
  const target = normalizePath(candidate);
  return patterns.some((pattern) =>
    globToRegExp(normalizePath(pattern)).test(target),
  );
}
