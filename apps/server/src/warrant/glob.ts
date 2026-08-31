const REGEXP_SPECIALS = /[.+^${}()|[\]\\]/g;

// Only convert backslashes to "/" on Windows. On POSIX a backslash is a legal
// filename character and MUST NOT be treated as a path separator, or a literal
// root file "tests\\evil.ts" would falsely match "tests/**".
const IS_WINDOWS = process.platform === "win32";
export function toSlash(input: string): string {
  return IS_WINDOWS ? input.replace(/\\/g, "/") : input;
}

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
  return toSlash(input).replace(/^\.\//, "").replace(/^\/+/, "");
}

export function escapesWorkspace(input: string): boolean {
  const normalized = toSlash(input);
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


/**
 * Canonical workspace-relative POSIX path used for BOTH reported-event paths and
 * on-disk digest keys so normalization can never cause a false out-of-band
 * classification. POSIX filenames may legitimately contain a literal backslash,
 * so backslash is NOT treated as a separator: "tests\\evil.ts" stays a single
 * root-level filename and does NOT collapse into "tests/evil.ts". Only "/" is a
 * separator; ".", "" and ".." segments are resolved lexically (a leading ".."
 * is preserved so an escape stays visible).
 */
export function canonicalizePath(input: string): string {
  const segments: string[] = [];
  for (const seg of input.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (segments.length > 0 && segments[segments.length - 1] !== "..") {
        segments.pop();
      } else {
        segments.push("..");
      }
      continue;
    }
    segments.push(seg);
  }
  return segments.join("/");
}
