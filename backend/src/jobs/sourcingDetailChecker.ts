// The additional sourcing alerts (docs/SourcingPlanDetailing_Spec.md) — gathers the facts and runs the pure detectors. Called by
// runSourcingCheck(): the engine merges what this returns into its desired set, so the same reconcile (INSERT … ON CONFLICT, auto-clear,
// history) governs old and new alert types alike. Every alert here is PROVISIONAL (is_shadow) until `detail_thresholds.alerts_live` is true.
import { detectDetailExceptions, DetailDetected } from '../utils/sourcingDetailRules.js';
import { QualifiedRule } from '../utils/sourcingConfig.js';
import { loadDetailFacts, loadDetailThresholds } from '../services/sourcingDetailFacts.js';

export async function collectDetailExceptions(now: Date, rule: QualifiedRule): Promise<DetailDetected[]> {
  const [thresholds, facts] = await Promise.all([loadDetailThresholds(), loadDetailFacts({ now, statuses: ['active'] })]);
  return detectDetailExceptions(facts, now, rule, thresholds);
}
