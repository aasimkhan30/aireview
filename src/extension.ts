import * as vscode from "vscode";
import { createDiagnosticsRecorder, readDiagnosticsLaunchConfig } from "./diagnostics/bootstrapDiagnostics";
import type { DiagnosticsRecorder } from "./diagnostics/diagnostics";
import type { ExtensionRuntime } from "./extensionRuntime";

let recorder: DiagnosticsRecorder | undefined;
let runtime: ExtensionRuntime | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	const config = readDiagnosticsLaunchConfig(process.env);
	const outputChannel = vscode.window.createOutputChannel("Request Changes", { log: true });
	context.subscriptions.push(outputChannel);

	recorder = await createDiagnosticsRecorder({
		config,
		outputChannel,
		extensionPath: context.extensionPath,
		extensionVersion: String(context.extension.packageJSON.version ?? "unknown")
	});
	recorder.info("lifecycle", "activation.started");

	try {
		const { createExtensionRuntime } = await import("./extensionRuntime");
		runtime = await createExtensionRuntime({ context, diagnosticsRecorder: recorder });
		recorder.info("lifecycle", "activation.completed");
	} catch (error) {
		recorder.error("lifecycle", "activation.failed", error);
		await recorder.flush();
		throw error;
	}
}

export async function deactivate(): Promise<void> {
	const activeRecorder = recorder;
	try {
		runtime?.dispose();
		runtime = undefined;
		activeRecorder?.info("lifecycle", "deactivation.completed");
	} catch (error) {
		activeRecorder?.error("lifecycle", "deactivation.failed", error);
	} finally {
		recorder = undefined;
		await activeRecorder?.close();
	}
}
