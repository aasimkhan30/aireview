const esbuild = require("esbuild");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

const problemMatcherPlugin = {
  name: "problem-matcher",
  setup(build) {
    build.onStart(() => {
      console.log("[watch] build started");
    });

    build.onEnd((result) => {
      result.errors.forEach((error) => {
        console.error(formatError(error));
      });
      console.log("[watch] build finished");
    });
  }
};

function formatError(error) {
  if (!error.location) {
    return `error: ${error.text}`;
  }

  const { file, line, column, lineText } = error.location;
  return `${file}:${line}:${column}: error: ${error.text}\n${lineText}`;
}

async function main() {
  const context = await esbuild.context({
    entryPoints: ["src/extension.ts"],
    bundle: true,
    format: "cjs",
    platform: "node",
    outfile: "out/extension.js",
    external: ["vscode"],
    sourcemap: !production,
    minify: production,
    sourcesContent: false,
    logLevel: "silent",
    plugins: [problemMatcherPlugin]
  });

  if (watch) {
    await context.watch();
    return;
  }

  await context.rebuild();
  await context.dispose();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
