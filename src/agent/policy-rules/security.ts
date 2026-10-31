/**
 * Security Policy Rules
 *
 * - Replication (spawning, funding or starting child automatons) is off
 *   unless security.replicationEnabled is set. Upstream exposed a
 *   maxChildren setting that the spawn path never read, so setting it to 0
 *   did not stop replication.
 * - Shell commands that touch secret material, the runtime database, the
 *   mission CLI, or that dump the environment are denied.
 */

import type { PolicyRequest, PolicyRule, PolicyRuleResult } from "../../types.js";
import { detectSensitiveCommand } from "../../security/sensitive.js";

const REPLICATION_TOOLS = ["spawn_child", "fund_child", "start_child"];

function createReplicationRule(): PolicyRule {
  return {
    id: "security.replication_disabled",
    description: "Deny spawning, funding or starting child automatons unless replication is enabled",
    priority: 30,
    appliesTo: { by: "name", names: REPLICATION_TOOLS },
    evaluate(request: PolicyRequest): PolicyRuleResult | null {
      if (request.context?.config?.security?.replicationEnabled === true) return null;
      return {
        rule: "security.replication_disabled",
        action: "deny",
        reasonCode: "REPLICATION_DISABLED",
        humanMessage: "Replication is disabled. The operator must set security.replicationEnabled to allow child automatons.",
      };
    },
  };
}

function createSensitiveCommandRule(): PolicyRule {
  return {
    id: "command.sensitive_access",
    description: "Deny shell commands that touch secrets, protected state or dump the environment",
    priority: 300,
    appliesTo: { by: "name", names: ["exec"] },
    evaluate(request: PolicyRequest): PolicyRuleResult | null {
      const command = request.args?.command;
      if (typeof command !== "string") return null;
      const match = detectSensitiveCommand(command);
      if (!match) return null;
      return {
        rule: "command.sensitive_access",
        action: "deny",
        reasonCode: "SENSITIVE_COMMAND",
        humanMessage: `Command blocked: it touches ${match.reason}.`,
      };
    },
  };
}

export function createSecurityRules(): PolicyRule[] {
  return [createReplicationRule(), createSensitiveCommandRule()];
}
