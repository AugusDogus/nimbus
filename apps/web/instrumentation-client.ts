import { config } from "zod/mini";

// Zod probes for `new Function` to compile fast parsers. The Content-Security-Policy
// forbids eval, so turn the probe off instead of letting the browser report a violation.
config({ jitless: true });
