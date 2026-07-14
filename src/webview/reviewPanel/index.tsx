import * as React from "react";
import { createRoot } from "react-dom/client";
import { createWebviewConnection } from "../webviewRpc";
import { App } from "./App";
import "./theme.css";
import "./styles.css";

const root = document.getElementById("root");

if (!root) {
	throw new Error("Missing root element");
}

const connection = createWebviewConnection();
connection.listen();
window.addEventListener("pagehide", () => connection.dispose(), { once: true });

createRoot(root).render(
	<React.StrictMode>
		<App connection={connection} />
	</React.StrictMode>
);
