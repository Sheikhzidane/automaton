/**
 * Agent shell gate.
 *
 * Upstream behaviour: when no Conway sandbox is configured, the `exec` tool
 * falls back to child_process.execSync on the host, in the operator's home
 * directory, as the operator's user. One prompt injection is then a shell on
 * the operator's machine.
 *
 * This module wraps the ConwayClient handed to agent tools so that:
 *   - host (local) execution is refused unless security.allowHostExec is true;
 *   - in mission mode, all agent shell access is refused unless
 *     mission.allowShell is true, because the approval system is only
 *     tamper-resistant when the agent cannot write to its own database.
 *
 * Runtime-internal callers (state repo init, heartbeat) keep the raw client.
 */

import type { AutomatonConfig, ConwayClient, ExecResult } from "../types.js";
import { isMissionEnabled } from "../mission/config.js";

export const DEFAULT_SECURITY_CONFIG = {
  allowHostExec: false,
  replicationEnabled: false,
} as const;

export function isHostExecAllowed(config: AutomatonConfig): boolean {
  return config.security?.allowHostExec === true;
}

export function isReplicationEnabled(config: AutomatonConfig): boolean {
  return config.security?.replicationEnabled === true;
}

/**
 * Why the agent may not run a shell command right now, or null if it may.
 */
export function agentShellBlockReason(config: AutomatonConfig): string | null {
  if (isMissionEnabled(config) && config.mission?.allowShell !== true) {
    return "Blocked: shell access is disabled in mission mode. Use the mission and file tools instead.";
  }
  const isLocal = !config.sandboxId;
  if (isLocal && !isHostExecAllowed(config)) {
    return "Blocked: host shell is disabled. Commands would run on the operator's own machine. Set security.allowHostExec only on a disposable machine.";
  }
  return null;
}

/**
 * Wrap a ConwayClient so that agent-initiated exec calls respect the gate.
 * A Proxy is used so class-based clients (including test mocks) keep their
 * prototype methods.
 */
export function createAgentConwayClient(
  conway: ConwayClient,
  config: AutomatonConfig,
): ConwayClient {
  const guardedExec = async (
    command: string,
    timeout?: number,
  ): Promise<ExecResult> => {
    const reason = agentShellBlockReason(config);
    if (reason) {
      return { stdout: "", stderr: reason, exitCode: 126 };
    }
    return conway.exec(command, timeout);
  };

  return new Proxy(conway, {
    get(target, prop, receiver) {
      if (prop === "exec") return guardedExec;
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
