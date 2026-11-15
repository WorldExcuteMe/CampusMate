// Reuse the same bounded supervisor for preview mode.
process.argv.splice(2, 0, "preview");
await import("./serve.mjs");
