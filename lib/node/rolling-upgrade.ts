// Rolling cluster upgrade — the orchestration on top of a served unit's auto-registered
// `<name>.sys.upgrade` relup subject. A single `sys.upgrade` swaps one unit's code; this drives the
// swap across every node hosting that unit, a batch at a time, verifying the new version (and an
// optional health check) after each batch and HALTING the moment one fails — so a bad build stops at
// the canary instead of taking down the fleet. Zero-downtime: callers in flight finish on the old
// code, the next message meets the new. Universal (issues ordinary `call`s through a NodeHandle).
import { isFailure } from '../result/failure.ts';
import type { NodeHandle } from './node.ts';

/** The outcome of a {@link rollingUpgrade}: who upgraded, who failed, and whether it halted early. */
export interface RollingUpgradeReport {
  /** Node names that upgraded and verified, in the order they were rolled. */
  upgraded: string[];
  /** The first failure that halted the rollout (empty if every target succeeded). */
  failed: { target: string; reason: unknown }[];
  /** True if a failure stopped the rollout before every target was reached. */
  halted: boolean;
}

/**
 * Roll a new version of `unit` across the cluster via its `<unit>.sys.upgrade` subject. Targets are
 * the explicit `targets` list, or the members of `group`. Upgrades proceed `batchSize` at a time
 * (default 1 — one canary at a time); after each batch every target must report the expected
 * `version` (and pass `healthCheck`, if given) or the rollout HALTS with the failures recorded and
 * the remaining targets untouched. `settleMs` waits between batches (let the new code warm up).
 *
 * ```ts
 * import { Node, memoryHub, genServer } from './index.ts';
 *
 * const hub = memoryHub();
 * const ops = Node.start('ops@ru', hub.transport());
 * const a = Node.start('a@ru', hub.transport());
 * genServer(a, 'svc', { version: '1', init: () => 0, handlers: {} });
 * const url = 'data:text/javascript,' + encodeURIComponent('export default { version: "2", handlers: {} }');
 * await new Promise((r) => setTimeout(r, 10));
 * const report = await rollingUpgrade({ node: ops, unit: 'svc', url, version: '2', targets: ['a@ru'] });
 * report.upgraded; // ['a@ru']
 * ops.stop();
 * a.stop();
 * ```
 */
export async function rollingUpgrade(options: {
  node: NodeHandle;
  unit: string;
  url: string;
  version: string;
  targets?: string[];
  group?: string;
  batchSize?: number;
  settleMs?: number;
  timeoutMs?: number;
  healthCheck?: (target: string) => boolean | Promise<boolean>;
}): Promise<RollingUpgradeReport> {
  const { node, unit, url, version } = options;
  const targets = options.targets ?? (options.group ? node.groupMembers(options.group) : []);
  const batchSize = Math.max(1, options.batchSize ?? 1);
  const subject = `${unit}.sys.upgrade`;
  const report: RollingUpgradeReport = { upgraded: [], failed: [], halted: false };

  const upgradeOne = async (target: string): Promise<{ target: string; reason?: unknown }> => {
    const reply = await node.call(target, subject, { url }, options.timeoutMs).result();
    if (isFailure(reply)) return { target, reason: reply };
    if (reply !== version)
      return { target, reason: `reported ${String(reply)}, expected ${version}` };
    if (options.healthCheck && !(await options.healthCheck(target)))
      return { target, reason: 'health check failed' };
    return { target };
  };

  for (let i = 0; i < targets.length; i += batchSize) {
    const batch = targets.slice(i, i + batchSize);
    const outcomes = await Promise.all(batch.map(upgradeOne));
    const failures = outcomes.filter((o) => o.reason !== undefined);
    for (const ok of outcomes) if (ok.reason === undefined) report.upgraded.push(ok.target);
    if (failures.length > 0) {
      report.failed = failures.map((f) => ({ target: f.target, reason: f.reason }));
      report.halted = true;
      return report; // a bad build stops at the canary — the rest of the fleet is left on the old code
    }
    if (options.settleMs && i + batchSize < targets.length)
      await new Promise((resolve) => setTimeout(resolve, options.settleMs));
  }
  return report;
}
