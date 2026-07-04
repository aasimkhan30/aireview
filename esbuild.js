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
  const extensionContext = await esbuild.context({
    entryPoints: ["src/extension.ts"],
    bundle: true,
    format: "cjs",
    platform: "node",
    outfile: "out/extension.js",
    external: ["vscode"],
    define: {
      "process.env.NODE_ENV": JSON.stringify(production ? "production" : "development")
    },
    sourcemap: !production,
    minify: production,
    sourcesContent: false,
    logLevel: "silent",
    plugins: [problemMatcherPlugin]
  });

  const webviewContext = await esbuild.context({
    entryPoints: ["src/webview/reviewPanel/index.tsx"],
    bundle: true,
    format: "iife",
    platform: "browser",
    outfile: "media/reviewPanel.js",
    define: {
      "process.env.NODE_ENV": JSON.stringify(production ? "production" : "development")
    },
    sourcemap: !production,
    minify: production,
    sourcesContent: false,
    logLevel: "silent",
    loader: {
      ".woff": "file",
      ".woff2": "file"
    },
    plugins: [problemMatcherPlugin]
  });

  if (watch) {
    await Promise.all([
      extensionContext.watch(),
      webviewContext.watch()
    ]);
    return;
  }

  await Promise.all([
    extensionContext.rebuild(),
    webviewContext.rebuild()
  ]);
  await Promise.all([
    extensionContext.dispose(),
    webviewContext.dispose()
  ]);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
