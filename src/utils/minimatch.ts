/**
 * Simple glob pattern matching (subset of minimatch).
 * Supports: * (any chars except /), ? (single char), ** (any path).
 */

export function minimatch(str: string, pattern: string): boolean {
  const regex = globToRegex(pattern);
  return regex.test(str);
}

function globToRegex(pattern: string): RegExp {
  let result = "^";
  let i = 0;

  while (i < pattern.length) {
    const c = pattern[i];

    if (c === "*") {
      if (pattern[i + 1] === "*") {
        // ** matches any path
        result += ".*";
        i += 2;
        if (pattern[i] === "/") i++; // skip trailing /
        continue;
      }
      // * matches anything except /
      result += "[^/]*";
    } else if (c === "?") {
      result += "[^/]";
    } else if (c === ".") {
      result += "\\.";
    } else if (c === "(" || c === ")" || c === "[" || c === "]" || c === "{" || c === "}" || c === "+" || c === "^" || c === "$" || c === "|" || c === "\\") {
      result += "\\" + c;
    } else {
      result += c;
    }
    i++;
  }

  result += "$";
  return new RegExp(result);
}
