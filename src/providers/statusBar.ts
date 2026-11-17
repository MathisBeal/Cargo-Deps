import * as vscode from 'vscode';
import * as path from 'node:path';
import type { AnalysisProgress, AnalysisStepId, StepStatus } from '../services/progress';

const STEP_ICONS: Record<StepStatus, string> = {
	pending: '$(circle-outline)', running: '$(sync~spin)', completed: '$(check)', skipped: '$(dash)', failed: '$(warning)',
};

const STEP_ACTIVITY: Record<AnalysisStepId, string> = {
	manifest: 'Reading manifest',
	audit: 'Checking security advisories',
	outdated: 'Checking dependency updates',
	tree: 'Tracing affected dependencies',
	crates: 'Loading published versions',
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
	tooltip.appendMarkdown(`**Workspace** - ${progress.manifestsCompleted}/${progress.manifestsTotal} manifests processed\n\n`);
	appendProgressBar(tooltip, progress.manifestsTotal > 0 ? progress.manifestsCompleted / progress.manifestsTotal : 0);
	if (running && progress.root) {
		tooltip.appendMarkdown('\n**Current manifest**\n');
		tooltip.appendCodeblock(vscode.workspace.asRelativePath(path.join(progress.root, 'Cargo.toml')), 'text');
		tooltip.appendMarkdown('\n');
		for (const step of progress.steps) {
			const count = step.total > 0 && (step.id === 'tree' || step.id === 'crates')
				? ` (${step.completed}/${step.total})` : '';
			tooltip.appendMarkdown(`- ${STEP_ICONS[step.status]} ${STEP_ACTIVITY[step.id]}${count} - ${step.status}\n`);
		}
	}
	if (progress.errors.length > 0) {
		tooltip.appendMarkdown(`\n$(warning) **${progress.errors.length} analysis error${progress.errors.length === 1 ? '' : 's'}** - results may be incomplete.\n`);
	}
	if (progress.finishedAt !== undefined) {
		tooltip.appendMarkdown(`\nDuration: ${Math.max(0, Math.round((progress.finishedAt - progress.startedAt) / 1000))}s\n`);
	}
	tooltip.appendMarkdown('\n[Open analysis log](command:cargo-deps.showOutput)\n\n');
	tooltip.appendMarkdown(hasErrors ? 'Click the status bar to view errors.' : 'Click the status bar to refresh.');
	return { text, tooltip };
}

function appendProgressBar(tooltip: vscode.MarkdownString, fraction: number): void {
	const progress = Math.min(1, Math.max(0, fraction));
	const filled = Math.floor(progress * 20);
	tooltip.appendMarkdown(`\`[${'='.repeat(filled)}${'-'.repeat(20 - filled)}]\` **${Math.floor(progress * 100)}%**\n`);
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