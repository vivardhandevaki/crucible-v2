// AgentSubstrate — the ONLY boundary through which Crucible invokes an agent
// (architecture.md §6, frozen P1-08; charter: "isolated behind one internal
// interface so pluggable substrates later are a refactor, not a rewrite").
//
// The result deliberately carries an exit status and a transcript path and
// NOTHING else: substrate output is never parsed for "did it succeed" —
// success is judged from the artifacts the run produced (invariant 2, "agent
// self-report is worth zero", enforced structurally by there being no field
// to trust).

/** The three fresh-context roles a substrate session runs (invariant 10). */
export const SUBSTRATE_ROLES = ['propose', 'implement', 'review'] as const;
export type SubstrateRole = (typeof SUBSTRATE_ROLES)[number];

export interface SubstrateRequest {
  role: SubstrateRole;
  /** Role prompt file, `.crucible/context/<role>.md`. Unreadable → the run
   * cannot start (SUBSTRATE_UNAVAILABLE, exit 3). */
  rolePromptPath: string;
  /** Distilled intent / work-order text handed to the session. */
  taskPayload: string;
  /** Directory the agent session operates in. */
  cwd: string;
  /** Model id from config; opaque to the substrate contract. */
  model: string;
  /** Where the substrate must write the session transcript. Caller-minted —
   * the naming convention (`.crucible/transcripts/<change>/<role>-<ts>.jsonl`)
   * is owned by `commands/`; the substrate never invents paths and knows
   * nothing of "changes" or wall clocks (architecture.md §6). */
  transcriptPath: string;
  /** Optional guard. Expiry kills the session; the outcome is still a
   * returned result (non-zero `exitCode`), never a throw. */
  timeoutMs?: number;
}

export interface SubstrateResult {
  /** Raw process exit status. Never sufficient to judge success (invariant 2):
   * the calling command validates the artifacts the role was required to
   * produce, regardless of this value. */
  exitCode: number;
  /** Echo of `request.transcriptPath`. The file exists on every returned
   * result (possibly truncated if the run died mid-stream). */
  transcriptPath: string;
}

export interface AgentSubstrate {
  /**
   * Run one fresh-context agent session. Every outcome of a *started* run is
   * returned, never thrown; throws `CrucibleError` (`SUBSTRATE_UNAVAILABLE`,
   * exit 3) only when the run cannot start at all (missing/unspawnable
   * binary, unreadable role prompt). Contrast adapters (§7): a broken judge
   * is exit 3 because it must never report green; a broken author has nothing
   * to report — its absent artifacts fail closed downstream.
   */
  run(req: SubstrateRequest): Promise<SubstrateResult>;
}
