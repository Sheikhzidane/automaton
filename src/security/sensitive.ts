/**
 * Sensitive command detection.
 *
 * The upstream shell guard only blocked `cat …wallet.json` and `rm …`.
 * Any other reader (head, base64, cp, python -c, a glob such as w*.json)
 * got through. This module widens the check to any command that references
 * secret material, the runtime database, the mission CLI, or that dumps the
 * environment.
 *
 * This is defence in depth, not a guarantee: a determined shell user can
 * always construct a path the patterns miss. The real controls are
 * (1) no agent shell in mission mode, (2) host shell disabled by default,
 * (3) scrubbed child-process environments, (4) a near-empty wallet.
 */

export interface SensitiveCommandMatch {
  reason: string;
}

const SENSITIVE_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /wallet\.json/i, reason: "wallet key file" },
  { pattern: /automaton\.json/i, reason: "runtime config (contains API keys)" },
  { pattern: /(^|[\s/=:<>|;&(])\.env(\.[\w-]+)?(?=$|[\s;&|)<>])/i, reason: "environment file" },
  { pattern: /private-key/i, reason: "private key file" },
  { pattern: /\.(pem|key|p12|pfx)(?=$|[\s;&|)<>])/i, reason: "key material" },
  { pattern: /\.ssh(\/|\b)/, reason: "SSH keys" },
  { pattern: /\.gnupg(\/|\b)/, reason: "GPG keys" },
  { pattern: /\/proc\/[^\s/]+\/environ/, reason: "process environment" },
  { pattern: /state\.db/i, reason: "runtime database (ledger and approvals)" },
  { pattern: /\bmission_(ledger|approvals|capital_grants|milestones)\b/i, reason: "mission financial tables" },
  { pattern: /--mission\b/, reason: "the mission CLI is for the human operator only" },
  { pattern: /(^|[\s;&|(`$])printenv\b/, reason: "environment dump" },
  { pattern: /(^|[\s;&|(`$])(env|export\s+-p|declare\s+-x)\s*(?=$|[;&|)])/, reason: "environment dump" },
];

/** Wildcards anywhere in a command that also mentions the runtime directory. */
const RUNTIME_DIR = /\.automaton\b/;
const GLOB_CHARS = /[*?[]/;

/**
 * Normalise quoting and $HOME forms so trivial obfuscation does not slip
 * past the patterns: `cat "wal"'let'.json`, `cat $HOME/.automaton/...`.
 */
export function normaliseCommand(command: string): string {
  return command
    .replace(/['"\\]/g, "")
    .replace(/\$\{HOME\}|\$HOME/g, "~")
    .replace(/\/\.\//g, "/")
    .replace(/\/{2,}/g, "/");
}

/**
 * Return a match if the command touches secret material or protected state.
 */
export function detectSensitiveCommand(
  command: string,
): SensitiveCommandMatch | null {
  if (typeof command !== "string" || command.length === 0) return null;
  const normalised = normaliseCommand(command);

  for (const { pattern, reason } of SENSITIVE_PATTERNS) {
    if (pattern.test(normalised)) return { reason };
  }

  if (RUNTIME_DIR.test(normalised) && GLOB_CHARS.test(normalised)) {
    return { reason: "wildcard used alongside the runtime directory" };
  }

  return null;
}
