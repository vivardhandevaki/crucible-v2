import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadApproval, verifyApproval } from '../artifacts/approval.js';
import { loadOracles } from '../artifacts/oracles.js';
import { loadOverride } from '../artifacts/override.js';
import { assertTypeConformance, readChangeType } from '../changetype/changetype.js';
import type { EnforcementConfig } from '../config/enforcement.js';
import { computeTier } from '../tier/tier.js';
import { preconditionError } from '../util/errors.js';
import { routingFor, routingWithOverride, type RoutingDecision } from '../verifyx/report.js';
import { gatherTypeFacts, loadRequirementsForType } from './bundle.js';
import type { DiffFacts } from './verify.js';

/** Deterministic route facts for one governed change; never runs an adapter. */
export function routeDecision(
  root: string,
  change: string,
  config: EnforcementConfig,
  facts: DiffFacts,
): RoutingDecision {
  const changeRel = join('openspec', 'changes', change);
  const changeDir = join(root, changeRel);
  if (!existsSync(changeDir)) {
    throw preconditionError(
      'NO_CHANGE',
      `No change bundle found at ${changeRel}.`,
      `Run \`crucible propose ${change} "<intent>"\` to scaffold the bundle first.`,
    );
  }
  const type = readChangeType(changeDir);
  const requirements = loadRequirementsForType(changeDir, changeRel, type);
  const oracles = loadOracles(join(changeDir, 'oracles.md'));
  assertTypeConformance(type, gatherTypeFacts(changeDir, oracles));
  const approvalPath = join(changeDir, 'approval.yaml');
  const approval = existsSync(approvalPath) ? loadApproval(approvalPath) : undefined;
  const tier = computeTier(
    {
      specDelta: requirements.length > 0,
      touchedPaths: facts.touchedPaths,
      diffLines: facts.diffLines,
      ...(approval?.minimum_tier === undefined ? {} : { forced: approval.minimum_tier }),
    },
    config,
  );
  if (approval !== undefined) {
    const checked = verifyApproval(root, approval, {
      ...(tier.tier === 'critical'
        ? { criticalOracleIds: oracles.map((oracle) => oracle.id) }
        : {}),
    });
    if (!checked.valid) {
      throw preconditionError(
        'INVALID_APPROVAL',
        `Approval for ${change} is no longer valid.`,
        `Run \`crucible amend ${change}\` to reseal the approved bundle.`,
      );
    }
  }
  const overridePath = join(changeDir, 'override.yaml');
  if (existsSync(overridePath)) {
    // Presence is not enough: a malformed bypass artifact must stop routing
    // rather than silently gaining the forced-human path.
    loadOverride(overridePath);
    return routingWithOverride(tier);
  }
  return routingFor(tier);
}

/** Aggregate a PR: one human-routed change makes the entire PR human-routed. */
export function aggregateRoute(decisions: readonly RoutingDecision[]): RoutingDecision {
  return (
    decisions.find((decision) => decision.decision === 'human') ?? {
      decision: 'auto',
      reasons: ['all governed changes are trivial or standard'],
    }
  );
}
