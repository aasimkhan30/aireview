import * as React from "react";
import { createRoot } from "react-dom/client";
import { createWebviewConnection } from "../webviewRpc";
import { SettingsApp } from "./App";
import "../reviewPanel/theme.css";
import "./styles.css";

const element = document.getElementById("root");
if (!element) {
	throw new Error("Missing root element");
}

const connection = createWebviewConnection();
connection.listen();
window.addEventListener("pagehide", () => connection.dispose(), { once: true });

createRoot(element).render(
	<React.StrictMode>
		<SettingsApp connection={connection} />
	</React.StrictMode>
);
