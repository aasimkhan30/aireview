import * as React from "react";
import { createRoot } from "react-dom/client";
import { createWebviewConnection } from "../webviewRpc";
import { WebviewDiagnostics } from "../webviewDiagnostics";
import { App } from "./App";
import "./theme.css";
import "./styles.css";

const root = document.getElementById("root");

if (!root) {
	throw new Error("Missing root element");
}

const connection = createWebviewConnection();
connection.listen();
const diagnostics = new WebviewDiagnostics(connection);
diagnostics.info("ui.mounted");
window.addEventListener(
	"pagehide",
	() => {
		diagnostics.info("ui.unmounted");
		connection.dispose();
	},
	{ once: true }
);

createRoot(root).render(
	<React.StrictMode>
		<App connection={connection} diagnostics={diagnostics} />
	</React.StrictMode>
);
