import { collectArchivedRequirementIds, collectRegressionSuite } from '../regression/regression.js';
import { lintTraceability } from '../lint/traceability.js';
import {
  aggregate,
  regressionCheck,
  traceabilityCheck,
  type VerifyReport,
} from '../verifyx/report.js';
import type { VerifyDeps } from './verify.js';

/** CI-only archive lane judge. Archive registration has no active bundle, so it
 * verifies the complete registered regression suite directly. */
export async function verifyCiArchiveRegression(
  root: string,
  deps: VerifyDeps,
): Promise<VerifyReport> {
  const suite = collectRegressionSuite(root).oracles;
  const trace = traceabilityCheck(
    await lintTraceability([], suite, deps.resolve, collectArchivedRequirementIds(root)),
  );
  const checks = [trace];
  if (trace.status === 'pass') checks.push(regressionCheck(await deps.run(suite)));
  return aggregate('archive', checks);
}
