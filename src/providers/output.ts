import * as vscode from 'vscode';
import * as path from 'node:path';
import type { AnalysisProgress } from '../services/progress';

export class AnalysisOutput implements vscode.Disposable {
	private readonly subscription: vscode.Disposable;
	private previous?: AnalysisProgress;

	constructor(
		onDidProgress: vscode.Event<AnalysisProgress>,
		private readonly channel: Pick<vscode.LogOutputChannel, 'info' | 'error' | 'show' | 'dispose'> = vscode.window.createOutputChannel('Cargo Deps', { log: true }),
	) {
		this.subscription = onDidProgress(progress => this.writeProgress(progress));
	}

	show(): void {
		this.channel.show(true);
	}

	error(message: string, error?: unknown): void {
		if (error instanceof Error) {
			this.channel.error(message, error);
		} else {
			this.channel.error(message, error === undefined ? '' : String(error));
		}
	}

	dispose(): void {
		this.subscription.dispose();
		this.channel.dispose();
	}

	private writeProgress(progress: AnalysisProgress): void {
		const previous = this.previous;
		const newRun = !previous || progress.status === 'running' && (
			previous.status !== 'running' || progress.startedAt !== previous.startedAt
			|| progress.root === undefined && previous.root !== undefined
		);
		if (newRun) {
			this.channel.info(`Analysis started: ${progress.manifestsTotal} manifest(s).`);
		}
		if (progress.root && (newRun || progress.root !== previous?.root)) {
			this.channel.info(`Manifest: ${path.join(progress.root, 'Cargo.toml')}`);
		}
		for (const step of progress.steps) {
			const oldStep = !newRun && previous?.root === progress.root
				? previous.steps.find(candidate => candidate.id === step.id) : undefined;
			if (step.status !== 'pending' && (step.status !== oldStep?.status || step.detail !== oldStep?.detail)) {
				this.channel.info(`[${step.label}] ${step.status}${step.detail ? `: ${step.detail}` : ''}`);
			}
			for (const active of step.active) {
				if (!oldStep?.active.includes(active)) {
					this.channel.info(`[${step.label}] Active: ${active}`);
				}
			}
		}
		const oldErrorCount = newRun ? 0 : previous?.errors.length ?? 0;
		for (const error of progress.errors.slice(oldErrorCount)) {
			this.channel.error(`${progress.root ? `Manifest: ${path.join(progress.root, 'Cargo.toml')}\n` : ''}${error}`);
		}
		if (progress.status !== 'running' && (newRun || previous?.status === 'running')) {
			this.channel.info(`Analysis ${progress.status}: ${progress.manifestsCompleted}/${progress.manifestsTotal} manifests; ${progress.errors.length} error(s); HTTP ${progress.requestsCompleted}/${progress.requestsTotal} (${progress.requestsFailed} failed); cache hits ${progress.cacheHits}; shared lookups ${progress.sharedRequests}.`);
		}
		this.previous = progress;
	}
}