// CI templates workspace — placeholder surface for the P0-02 scaffold.
//
// The real reusable workflow (ci-templates/crucible.yml) that runs verify with
// target-branch enforcement config lands in P1-15. This module exists only so
// the workspace compiles and carries a placeholder test today.

/** Filename of the reusable Crucible CI workflow shipped from this workspace. */
export const CI_TEMPLATE_FILE = 'crucible.yml';
