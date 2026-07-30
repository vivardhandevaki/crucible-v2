// Development builds use the helper jar beside dist/. P3-06's package builder
// aliases this module at bundle time with the jar's base64 bytes + sha256, so
// the shipped executable is one hash-pinnable file covering wrapper and helper.

export const CRUCIBLE_EMBEDDED_HELPER_JAR = '';
export const CRUCIBLE_EMBEDDED_HELPER_SHA256 = '';
