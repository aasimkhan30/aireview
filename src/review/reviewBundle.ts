import type { ReviewNote } from "../common/reviewProtocol";

export function buildReviewBundle(overallInstructions: string, notes: readonly ReviewNote[]): string {
	const sections = ["# Requested code changes"];
	if (overallInstructions) {
		sections.push(`## Overall instructions\n\n${overallInstructions}`);
	}
	const grouped = new Map<string, ReviewNote[]>();
	for (const note of notes) {
		const filePath = note.anchor?.filePath || "Unattached notes";
		const group = grouped.get(filePath) ?? [];
		group.push(note);
		grouped.set(filePath, group);
	}
	for (const [filePath, fileNotes] of grouped) {
		const noteSections = fileNotes.map((note) => {
			const range = note.anchor?.range;
			const location = range ? `Lines ${range.startLine}–${range.endLine}` : "Location unavailable";
			const selectedText = note.anchor?.selectedText
				? `\n\nSelected code:\n\n\`\`\`\n${note.anchor.selectedText.slice(0, 12_000)}\n\`\`\``
				: "";
			const orphaned =
				note.anchorState === "orphaned" ? "\n\n> The original code location could not be reattached." : "";
			return `### ${location} · ${note.kind}\n\n${note.body}${selectedText}${orphaned}`;
		});
		sections.push(`## ${filePath}\n\n${noteSections.join("\n\n")}`);
	}
	return `${sections.join("\n\n")}\n`;
}
