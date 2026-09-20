const esbuild = require("esbuild");

esbuild
  .build({
    entryPoints: ["src/extension.ts"],
    bundle: true,
    outfile: "dist/extension.js",
    external: ["vscode"], // vscode is always provided by the host; never bundle it
    format: "cjs",
    platform: "node",
    sourcemap: true,
    minify: false, // keep readable for debugging; set true for production
  })
  .catch(() => process.exit(1));
