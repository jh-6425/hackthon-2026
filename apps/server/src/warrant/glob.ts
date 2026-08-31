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

export function escapesWorkspace(input: string, win: boolean = IS_WINDOWS): boolean {
  const normalized = win ? input.replace(/\\/g, "/") : input;
  // POSIX absolute, or Windows drive/UNC absolute -> escape.
  if (normalized.startsWith("/")) return true;
  if (win && (/^[a-zA-Z]:/.test(normalized) || normalized.startsWith("//"))) return true;
  // Any ".." path segment -> escape.
  return normalized.split("/").some((segment) => segment === "..");
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
export function canonicalizePath(input: string, win: boolean = IS_WINDOWS): string {
  const slashed = win ? input.replace(/\\/g, "/") : input;
  // Preserve a rooted prefix so an absolute / UNC / drive path stays clearly
  // non-relative and is rejected by escapesWorkspace instead of being collapsed
  // into a look-alike in-workspace path.
  let prefix = "";
  let rest = slashed;
  if (slashed.startsWith("//")) {
    prefix = "//"; // UNC
    rest = slashed.slice(2);
  } else if (slashed.startsWith("/")) {
    prefix = "/"; // POSIX / Windows root-relative
    rest = slashed.slice(1);
  } else if (win && /^[a-zA-Z]:/.test(slashed)) {
    prefix = slashed.slice(0, 2) + "/"; // drive
    rest = slashed.slice(2).replace(/^\/+/, "");
  }
  const segments: string[] = [];
  for (const seg of rest.split("/")) {
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
  return prefix + segments.join("/");
}
