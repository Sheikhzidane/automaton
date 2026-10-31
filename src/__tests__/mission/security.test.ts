/**
 * Security fixes: environment scrubbing, sensitive command detection,
 * the agent shell gate, and the replication cap.
 */

import { describe, it, expect } from "vitest";
import { isSecretEnvName, scrubbedEnv } from "../../security/env.js";
import { detectSensitiveCommand, normaliseCommand } from "../../security/sensitive.js";
import { agentShellBlockReason, createAgentConwayClient } from "../../security/host-exec.js";
import { spawnChild } from "../../replication/spawn.js";
import { isProtectedFile } from "../../self-mod/code.js";
import { createTestConfig, createTestDb, createTestIdentity, MockConwayClient } from "../mocks.js";
import { missionConfig } from "./helpers.js";

describe("scrubbedEnv", () => {
  it("drops provider keys and tokens but keeps ordinary variables", () => {
    const env = scrubbedEnv({
      PATH: "/usr/bin",
      HOME: "/root",
      LANG: "en_GB.UTF-8",
      LC_ALL: "en_GB.UTF-8",
      ANTHROPIC_API_KEY: "sk-ant",
      OPENAI_API_KEY: "sk",
      CONWAY_API_KEY: "c",
      GITHUB_TOKEN: "g",
      DB_PASSWORD: "p",
      STRIPE_SECRET: "s",
      NODE_ENV: "production",
    });
    expect(env).toEqual({ PATH: "/usr/bin", HOME: "/root", LANG: "en_GB.UTF-8", LC_ALL: "en_GB.UTF-8", NODE_ENV: "production" });
    expect(isSecretEnvName("PATH")).toBe(false);
    expect(isSecretEnvName("AWS_SECRET_ACCESS_KEY")).toBe(true);
  });
});

describe("detectSensitiveCommand", () => {
  const blocked = [
    "head ~/.automaton/wallet.json",
    "tail -n 50 /root/.automaton/wallet.json",
    "cp ~/.automaton/wallet.json /tmp/w",
    "base64 ~/.automaton/wallet.json",
    "cat ~/.automaton/w*",
    "cd ~/.automaton && cat w?llet.*",
    'cat "/root/.automaton/wal"\'let.json\'',
    "cat $HOME/.automaton/automaton.json",
    "cat ${HOME}/.automaton/automaton.json",
    "grep -r KEY /root/.env",
    "cat .env.production",
    "cat ~/.ssh/id_ed25519",
    "cat /proc/self/environ",
    "printenv OPENAI_API_KEY",
    "env",
    "env | sort",
    "export -p",
    "sqlite3 ~/.automaton/state.db \"UPDATE mission_approvals SET status='approved'\"",
    "node dist/index.js --mission approve 01ABC",
    "openssl rsa -in server.key",
  ];
  for (const command of blocked) {
    it(`blocks: ${command}`, () => {
      expect(detectSensitiveCommand(command)).not.toBeNull();
    });
  }

  const allowed = [
    "ls -la",
    "git status",
    "npm test",
    "echo hello",
    "cat README.md",
    "node build/report.js",
    "env NODE_ENV=test node script.js",
    "grep -r environment docs/",
  ];
  for (const command of allowed) {
    it(`allows: ${command}`, () => {
      expect(detectSensitiveCommand(command)).toBeNull();
    });
  }

  it("normalises quoting and $HOME", () => {
    expect(normaliseCommand(`cat "$HOME"/x`)).toBe("cat ~/x");
  });
});

describe("agent shell gate", () => {
  it("blocks the host shell by default in local mode", async () => {
    const config = createTestConfig({ sandboxId: "" });
    expect(agentShellBlockReason(config)).toMatch(/host shell is disabled/);
    const conway = new MockConwayClient();
    const guarded = createAgentConwayClient(conway, config);
    const result = await guarded.exec("echo hi");
    expect(result.exitCode).toBe(126);
    expect(conway.execCalls).toHaveLength(0);
  });

  it("allows the host shell only when explicitly enabled outside mission mode", async () => {
    const config = createTestConfig({ sandboxId: "", security: { allowHostExec: true } });
    expect(agentShellBlockReason(config)).toBeNull();
  });

  it("blocks all agent shell access in mission mode, even in a sandbox", async () => {
    const config = missionConfig();
    const conway = new MockConwayClient();
    const result = await createAgentConwayClient(conway, config).exec("echo hi");
    expect(result.exitCode).toBe(126);
    expect(conway.execCalls).toHaveLength(0);
    expect(agentShellBlockReason(missionConfig({ allowShell: true }))).toBeNull();
  });

  it("keeps class-based clients working through the proxy", async () => {
    const conway = new MockConwayClient();
    const guarded = createAgentConwayClient(conway, createTestConfig());
    await guarded.exec("echo hi");
    expect(conway.execCalls).toHaveLength(1);
    await expect(guarded.getCreditsBalance()).resolves.toBeTypeOf("number");
  });
});

describe("self-modification protection", () => {
  it("protects the security and mission control files from the agent", () => {
    for (const file of [
      "/root/automaton/src/mission/policy.ts",
      "/root/automaton/dist/mission/approvals.js",
      "/root/automaton/src/mission/ledger.ts",
      "/root/automaton/src/security/host-exec.ts",
      "/root/automaton/dist/agent/policy-rules/security.js",
      "/root/automaton/src/state/schema.ts",
    ]) {
      expect(isProtectedFile(file), file).toBe(true);
    }
    expect(isProtectedFile("/root/automaton/src/mission/report.ts")).toBe(false);
  });
});

describe("replication cap", () => {
  it("refuses to spawn when maxChildren is 0", async () => {
    const db = createTestDb();
    await expect(
      spawnChild(new MockConwayClient(), createTestIdentity(), db, { name: "c", genesisPrompt: "x", creatorMessage: "", creatorAddress: "0x0" } as any, undefined, { maxChildren: 0 }),
    ).rejects.toThrow(/replication is disabled/);
  });
});
