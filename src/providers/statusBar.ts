import * as vscode from 'vscode';
import * as path from 'node:path';
import type { AnalysisProgress, AnalysisStep, StepStatus } from '../services/progress';

const STEP_ICONS: Record<StepStatus, string> = {
	pending: '$(circle-outline)', running: '$(sync~spin)', completed: '$(check)', skipped: '$(dash)', failed: '$(warning)',
};

export function buildAnalysisStatus(progress: AnalysisProgress): { text: string; tooltip: vscode.MarkdownString } {
	const running = progress.status === 'running';
	const hasErrors = progress.status === 'failed' || progress.errors.length > 0;
	const active = progress.steps.filter(step => step.status === 'running');
	const activity = active.map(step => step.label + (step.total > 1 || step.id === 'crates' || step.id === 'tree' ? ` ${step.completed}/${step.total}` : '')).join(' + ');
	const manifestIndex = Math.min(progress.manifestsCompleted + 1, progress.manifestsTotal);
	const text = running
		? `$(sync~spin) Cargo Deps: ${activity || 'Preparing'}${progress.manifestsTotal > 1 ? ` [${manifestIndex}/${progress.manifestsTotal}]` : ''}`
		: hasErrors
			? `$(warning) Cargo Deps: ${progress.status === 'failed' ? 'analysis failed' : 'partial results'}`
			: '$(check) Cargo Deps';
	const tooltip = new vscode.MarkdownString('', true);
	tooltip.isTrusted = { enabledCommands: ['cargo-deps.showOutput'] };
	tooltip.appendMarkdown(`### Cargo Deps\n\n**${running ? 'Analyzing dependencies' : progress.status === 'failed' ? 'Analysis failed' : hasErrors ? 'Analysis finished with errors' : 'Analysis complete'}**\n\n`);
	tooltip.appendMarkdown(`Manifests processed: **${progress.manifestsCompleted}/${progress.manifestsTotal}**\n\n`);
	if (progress.root) {
		tooltip.appendMarkdown('Current manifest:\n');
		tooltip.appendCodeblock(vscode.workspace.asRelativePath(path.join(progress.root, 'Cargo.toml')), 'text');
	}
	tooltip.appendMarkdown('\n| Step | State | Progress |\n| :--- | :--- | :--- |\n');
	for (const [index, step] of progress.steps.entries()) {
		tooltip.appendMarkdown(`| ${index + 1}. ${step.label} | ${STEP_ICONS[step.status]} ${step.status} | ${step.total > 0 ? `${step.completed}/${step.total}` : '-'} |\n`);
	}
	tooltip.appendMarkdown('\n`cargo audit` and `cargo outdated` run in parallel.\n\n');
	for (const step of progress.steps) {
		appendStepDetails(tooltip, step);
	}
	if (progress.activeCrates.length > 0) {
		tooltip.appendMarkdown('\n**Crates being resolved:**\n');
		tooltip.appendCodeblock(progress.activeCrates.slice(0, 12).join('\n'), 'text');
		if (progress.activeCrates.length > 12) {
			tooltip.appendMarkdown(`\n${progress.activeCrates.length - 12} more active crate lookups.\n`);
		}
	}
	tooltip.appendMarkdown(`\n**HTTP requests settled (all manifests): ${progress.requestsCompleted}/${progress.requestsTotal}**`);
	if (progress.requestsFailed) {
		tooltip.appendMarkdown(` - ${progress.requestsFailed} failed`);
	}
	tooltip.appendMarkdown(`\n\nCache hits: **${progress.cacheHits}** - Shared lookups: **${progress.sharedRequests}**\n`);
	if (progress.errors.length > 0) {
		tooltip.appendMarkdown('\n**Errors**\n\n');
		for (const error of progress.errors.slice(0, 8)) {
			tooltip.appendMarkdown('- ');
			tooltip.appendText(error.replace(/\r?\n/g, ' '));
			tooltip.appendMarkdown('\n');
		}
		if (progress.errors.length > 8) {
			tooltip.appendMarkdown(`\n${progress.errors.length - 8} more errors.\n`);
		}
		tooltip.appendMarkdown('\n[View all errors in Output](command:cargo-deps.showOutput)\n');
	}
	if (progress.finishedAt !== undefined) {
		tooltip.appendMarkdown(`\nDuration: ${Math.max(0, Math.round((progress.finishedAt - progress.startedAt) / 1000))}s\n`);
	}
	tooltip.appendMarkdown(hasErrors ? '\nClick to open the full analysis log.' : '\n[Open analysis log](command:cargo-deps.showOutput)\n\nClick to refresh the workspace.');
	return { text, tooltip };
}

function appendStepDetails(tooltip: vscode.MarkdownString, step: AnalysisStep): void {
	if (step.detail) {
		tooltip.appendMarkdown(`**${step.label}:** `);
		tooltip.appendText(step.detail.replace(/\r?\n/g, ' '));
		tooltip.appendMarkdown('\n\n');
	}
	if (step.active.length > 0) {
		tooltip.appendMarkdown(`**${step.label} - active:**\n`);
		for (const current of step.active.slice(0, 8)) {
			tooltip.appendCodeblock(current, 'text');
		}
		if (step.active.length > 8) {
			tooltip.appendMarkdown(`\n${step.active.length - 8} more active operations.\n`);
		}
	}
}

export class AnalysisStatusBar implements vscode.Disposable {
	private readonly subscription: vscode.Disposable;
	private disposed = false;

	constructor(
		onDidProgress: vscode.Event<AnalysisProgress>,
		private readonly item = vscode.window.createStatusBarItem('cargo-deps.analysis', vscode.StatusBarAlignment.Left, 0),
	) {
		this.item.name = 'Cargo Deps Analysis';
		this.item.command = 'cargo-deps.refresh';
		this.subscription = onDidProgress(progress => {
			if (this.disposed) {
				return;
			}
			if (progress.manifestsTotal === 0) {
				this.item.hide();
				return;
			}
			const view = buildAnalysisStatus(progress);
			this.item.command = progress.status === 'failed' || progress.errors.length > 0 ? 'cargo-deps.showOutput' : 'cargo-deps.refresh';
			this.item.text = view.text;
			this.item.tooltip = view.tooltip;
			this.item.backgroundColor = progress.status === 'failed' || progress.errors.length > 0
				? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
			this.item.accessibilityInformation = { label: view.text.replace(/\$\([^)]+\)/g, '').trim() };
			this.item.show();
		});
	}

	discover(): void {
		if (!this.disposed) {
			this.item.text = '$(sync~spin) Cargo Deps: finding manifests';
			this.item.command = 'cargo-deps.refresh';
			this.item.tooltip = 'Discovering Cargo.toml files in the workspace.';
			this.item.backgroundColor = undefined;
			this.item.accessibilityInformation = { label: 'Cargo Deps: finding manifests' };
			this.item.show();
		}
	}

	fail(message: string): void {
		if (!this.disposed) {
			this.item.text = '$(warning) Cargo Deps: analysis failed';
			this.item.command = 'cargo-deps.showOutput';
			const tooltip = new vscode.MarkdownString();
			tooltip.appendText(message);
			tooltip.appendMarkdown('\n\nClick to open the full analysis log.');
			this.item.tooltip = tooltip;
			this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
			this.item.accessibilityInformation = { label: 'Cargo Deps: analysis failed' };
			this.item.show();
		}
	}

	dispose(): void {
		this.disposed = true;
		this.subscription.dispose();
		this.item.dispose();
	}
}