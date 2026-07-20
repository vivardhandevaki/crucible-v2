// Stub adapter — placeholder surface for the P0-02 scaffold.
//
// The real executable (resolve/run verbs over JSON stdin/stdout, per charter
// §"Bindings & the Adapter Protocol") is built in P1-10. Adapters are separate
// processes: framework core never imports this package.

/** Adapter identifier reported in its manifest. */
export const ADAPTER_ID = 'stub';
