// Zod probes for `new Function` to compile fast parsers. The Content-Security-Policy
// forbids eval, so the probe would be reported as a violation. Zod reads this shared
// object (zod/v4/core `globalConfig`) at parse time; setting it here, before any app
// code runs, avoids loading zod into the startup bundle just to call `config()`.
// Mutate in place: zod keeps a reference to the object once it has loaded.
const zodGlobal = globalThis as typeof globalThis & {
  __zod_globalConfig?: { jitless?: boolean };
};
(zodGlobal.__zod_globalConfig ??= {}).jitless = true;
