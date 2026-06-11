// Entry point for the SVG previews. chalk decides its color support the
// moment it's evaluated, so FORCE_COLOR must be set before anything that
// transitively imports ink/chalk loads; the dynamic import defeats ESM
// hoisting. Run with: npm run previews
process.env.FORCE_COLOR = "3";
await import("./render-previews-impl");

export {};
