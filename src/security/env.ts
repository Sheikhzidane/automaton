/**
 * Child-process environment scrubbing.
 *
 * The runtime copies provider API keys into process.env (see agent/loop.ts
 * orchestration bootstrap), and child_process.execSync inherits process.env
 * by default. Without scrubbing, any shell command the agent runs could print
 * every secret with `env` or `echo $ANTHROPIC_API_KEY`.
 *
 * scrubbedEnv() returns a copy of the environment with secret-looking
 * variables removed. It is deliberately a denylist on names so that ordinary
 * tooling (PATH, HOME, locale, git identity via config) keeps working.
 */

const SECRET_NAME_PATTERN =
  /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|PRIVATE|CREDENTIAL|AUTH|COOKIE|SESSION|MNEMONIC|SEED|DSN|CONNECTION_STRING|DATABASE_URL)/i;

/** Variables that are never secrets and that shells and tools rely on. */
const ALWAYS_KEEP = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LANGUAGE",
  "TERM",
  "TZ",
  "TMPDIR",
  "PWD",
  "NODE_ENV",
]);

export function isSecretEnvName(name: string): boolean {
  if (ALWAYS_KEEP.has(name)) return false;
  if (name.startsWith("LC_")) return false;
  return SECRET_NAME_PATTERN.test(name);
}

/**
 * Return a copy of `source` without variables whose names look like secrets.
 */
export function scrubbedEnv(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (isSecretEnvName(name)) continue;
    result[name] = value;
  }
  return result;
}
