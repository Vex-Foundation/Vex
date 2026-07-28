/**
 * A tiny evaluator for the SUBSET of SQL boolean expressions that
 * `agent_activity`'s CHECK constraints are written in, so a migration's
 * predicate can be tested against concrete row shapes WITHOUT a live Postgres.
 *
 * WHY THIS EXISTS. `053_agent_activity_yield_vocabulary.sql` encodes five
 * different per-role confirmed-leg predicates in one constraint. Asserting on
 * its TEXT (the `039_hyperliquid_execution_intents.sql` test's approach) proves
 * only that a string is present — it cannot catch an arm that accidentally
 * accepts a `yield_claim` with no output credit. This evaluator parses the
 * constraint as WRITTEN in the migration source and answers "would Postgres
 * accept this row?", which is the property that matters.
 *
 * SCOPE, deliberately narrow — anything outside it THROWS rather than guessing:
 *   OR / AND / NOT, parentheses, `col IS [NOT] NULL`, `col = 'lit'`,
 *   `col <> 'lit'`, `col [NOT] IN ('a', 'b')`, and `<>` between two boolean
 *   sub-expressions (SQL's boolean inequality, i.e. XOR).
 *
 * THREE-VALUED LOGIC is NOT modelled. Every column a comparison touches must be
 * non-null in the test row; a NULL there throws instead of silently returning a
 * value Postgres would have treated as UNKNOWN. Test rows therefore always
 * state `status` and `event_role` explicitly.
 */

type Token = { kind: "punct" | "word" | "string"; value: string };

const PUNCT = new Set(["(", ")", ",", "<>", "="]);

function tokenize(sql: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i]!;
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (ch === "'") {
      const end = sql.indexOf("'", i + 1);
      if (end === -1) throw new Error("sql-check-eval: unterminated string literal");
      tokens.push({ kind: "string", value: sql.slice(i + 1, end) });
      i = end + 1;
      continue;
    }
    if (sql.startsWith("<>", i)) {
      tokens.push({ kind: "punct", value: "<>" });
      i += 2;
      continue;
    }
    if (PUNCT.has(ch)) {
      tokens.push({ kind: "punct", value: ch });
      i += 1;
      continue;
    }
    const word = /^[A-Za-z_][A-Za-z0-9_]*/.exec(sql.slice(i));
    if (!word) throw new Error(`sql-check-eval: unexpected character ${JSON.stringify(ch)}`);
    tokens.push({ kind: "word", value: word[0] });
    i += word[0].length;
  }
  return tokens;
}

/** A row under test: column name -> value. `null` means SQL NULL. */
export type SqlRow = Readonly<Record<string, string | null>>;

class Parser {
  private pos = 0;

  constructor(
    private readonly tokens: readonly Token[],
    private readonly row: SqlRow,
  ) {}

  static evaluate(expression: string, row: SqlRow): boolean {
    const parser = new Parser(tokenize(expression), row);
    const value = parser.parseOr();
    parser.expectEnd();
    return value;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private isKeyword(word: string): boolean {
    const token = this.peek();
    return token?.kind === "word" && token.value.toUpperCase() === word;
  }

  private isPunct(value: string): boolean {
    const token = this.peek();
    return token?.kind === "punct" && token.value === value;
  }

  private take(): Token {
    const token = this.tokens[this.pos];
    if (!token) throw new Error("sql-check-eval: unexpected end of expression");
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    if (!this.isPunct(value)) {
      throw new Error(`sql-check-eval: expected ${value}, got ${JSON.stringify(this.peek())}`);
    }
    this.pos += 1;
  }

  private expectEnd(): void {
    if (this.pos !== this.tokens.length) {
      throw new Error(`sql-check-eval: trailing input at token ${this.pos}`);
    }
  }

  private column(name: string): string | null {
    if (!(name in this.row)) {
      throw new Error(`sql-check-eval: row does not define column '${name}'`);
    }
    return this.row[name] ?? null;
  }

  private nonNullColumn(name: string): string {
    const value = this.column(name);
    if (value === null) {
      throw new Error(
        `sql-check-eval: column '${name}' is NULL in a comparison — three-valued logic is not modelled`,
      );
    }
    return value;
  }

  private parseOr(): boolean {
    let value = this.parseAnd();
    while (this.isKeyword("OR")) {
      this.pos += 1;
      // Both sides are evaluated: a short-circuit would hide a malformed arm.
      const right = this.parseAnd();
      value = value || right;
    }
    return value;
  }

  private parseAnd(): boolean {
    let value = this.parseNot();
    while (this.isKeyword("AND")) {
      this.pos += 1;
      const right = this.parseNot();
      value = value && right;
    }
    return value;
  }

  private parseNot(): boolean {
    if (this.isKeyword("NOT")) {
      this.pos += 1;
      return !this.parseNot();
    }
    return this.parseComparison();
  }

  /** A primary, optionally followed by boolean `<>` (SQL boolean inequality = XOR). */
  private parseComparison(): boolean {
    const left = this.parsePrimary();
    if (this.isPunct("<>")) {
      this.pos += 1;
      const right = this.parsePrimary();
      return left !== right;
    }
    return left;
  }

  private parsePrimary(): boolean {
    if (this.isPunct("(")) {
      this.pos += 1;
      const inner = this.parseOr();
      this.expectPunct(")");
      return inner;
    }
    const token = this.take();
    if (token.kind !== "word") {
      throw new Error(`sql-check-eval: expected a column name, got ${JSON.stringify(token)}`);
    }
    return this.parseColumnPredicate(token.value);
  }

  private parseColumnPredicate(column: string): boolean {
    if (this.isKeyword("IS")) {
      this.pos += 1;
      const negated = this.isKeyword("NOT");
      if (negated) this.pos += 1;
      if (!this.isKeyword("NULL")) {
        throw new Error("sql-check-eval: expected NULL after IS");
      }
      this.pos += 1;
      const isNull = this.column(column) === null;
      return negated ? !isNull : isNull;
    }
    if (this.isPunct("=") || this.isPunct("<>")) {
      const operator = this.take().value;
      const literal = this.take();
      if (literal.kind !== "string") {
        throw new Error("sql-check-eval: only string literals are supported in comparisons");
      }
      const equal = this.nonNullColumn(column) === literal.value;
      return operator === "=" ? equal : !equal;
    }
    const negated = this.isKeyword("NOT");
    if (negated) this.pos += 1;
    if (!this.isKeyword("IN")) {
      throw new Error(`sql-check-eval: unsupported predicate on column '${column}'`);
    }
    this.pos += 1;
    this.expectPunct("(");
    const members: string[] = [];
    for (;;) {
      const literal = this.take();
      if (literal.kind !== "string") {
        throw new Error("sql-check-eval: only string literals are supported in IN lists");
      }
      members.push(literal.value);
      if (this.isPunct(",")) {
        this.pos += 1;
        continue;
      }
      break;
    }
    this.expectPunct(")");
    const contained = members.includes(this.nonNullColumn(column));
    return negated ? !contained : contained;
  }
}

/** Evaluate a CHECK body against a row. Returns true when Postgres would ACCEPT the row. */
export function evaluateSqlCheck(expression: string, row: SqlRow): boolean {
  return Parser.evaluate(expression, row);
}

/**
 * Extract the LAST `ADD CONSTRAINT <name> CHECK ( … )` body from migration SQL,
 * balancing parentheses so a nested predicate is not truncated. "Last" because a
 * later migration may DROP and re-ADD a constraint widened — the final
 * definition in migration order is the live one.
 */
export function extractCheckBody(sql: string, constraintName: string): string {
  const anchor = new RegExp(`ADD\\s+CONSTRAINT\\s+${constraintName}\\s+CHECK\\s*\\(`, "gi");
  let match: RegExpExecArray | null;
  let start = -1;
  while ((match = anchor.exec(sql)) !== null) {
    start = match.index + match[0].length;
  }
  if (start === -1) {
    throw new Error(`sql-check-eval: constraint '${constraintName}' not found`);
  }
  let depth = 1;
  let i = start;
  let inString = false;
  while (i < sql.length) {
    const ch = sql[i]!;
    if (inString) {
      if (ch === "'") inString = false;
    } else if (ch === "'") {
      inString = true;
    } else if (ch === "(") {
      depth += 1;
    } else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return sql.slice(start, i);
    }
    i += 1;
  }
  throw new Error(`sql-check-eval: unbalanced CHECK body for '${constraintName}'`);
}
