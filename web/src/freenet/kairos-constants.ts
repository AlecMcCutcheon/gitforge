/* Kairos time-oracle constants (public goods soft-host). Keep in sync with
 * kairos/site/src/kairos-constants.js after kairos `scripts/build.sh`. */
export const KAIROS_PARAMS_UTF8 = "kairos-time-v2";
export const KAIROS_WASM_HASH_B58 =
  "4PWZzjjmTGxBwzKYwtL2wtMTLmkRywyeHArBauQds42F";

/** Match kairos contract MIN_AGE_MS. */
export const KAIROS_MIN_AGE_MS = 3_600_000;
export const KAIROS_MIN_STAMP_WITNESSES = 5;
export const KAIROS_MAX_OBSERVE_PER_DUTY = 5;

export const KAIROS_EXAMPLE_STAMP_CONTENT_HASH = "kairos.public.example.v1";
export const KAIROS_EXAMPLE_STAMP_NONCE = "v1";
export const KAIROS_EXAMPLE_STAMP_ID = `${KAIROS_EXAMPLE_STAMP_CONTENT_HASH}:${KAIROS_EXAMPLE_STAMP_NONCE}`;
