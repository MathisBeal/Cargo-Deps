import * as vscode from 'vscode';

export type AnalysisStepId = 'manifest' | 'audit' | 'outdated' | 'tree' | 'crates';
export type StepStatus = 'pending' | 'running' | 'completed' | 'skipped' | 'failed';

export interface AnalysisStep {
	id: AnalysisStepId;
	label: string;
	status: StepStatus;
	completed: number;
	total: number;
	active: string[];
	detail?: string;
}

export interface AnalysisProgress {
	status: 'running' | 'completed' | 'failed';
	root?: string;
	manifestsCompleted: number;
	manifestsTotal: number;
	steps: AnalysisStep[];
	requestsCompleted: number;
	requestsTotal: number;
	requestsFailed: number;
	cacheHits: number;
	sharedRequests: number;
	activeCrates: string[];
	errors: string[];
	startedAt: number;
	finishedAt?: number;
}

function initialSteps(): AnalysisStep[] {
	return [
		{ id: 'manifest', label: 'Cargo.toml / workspace', status: 'pending', completed: 0, total: 1, active: [] },
		{ id: 'audit', label: 'cargo audit', status: 'pending', completed: 0, total: 1, active: [] },
		{ id: 'outdated', label: 'cargo outdated', status: 'pending', completed: 0, total: 1, active: [] },
		{ id: 'tree', label: 'cargo tree', status: 'pending', completed: 0, total: 0, active: [] },
		{ id: 'crates', label: 'crates.io', status: 'pending', completed: 0, total: 0, active: [] },
	];
}

export class AnalysisProgressTracker implements vscode.Disposable {
	private readonly emitter = new vscode.EventEmitter<AnalysisProgress>();
	readonly onDidChange = this.emitter.event;
	private state?: AnalysisProgress;

	begin(total: number): void {
		this.state = {
			status: 'running', manifestsCompleted: 0, manifestsTotal: total, steps: initialSteps(),
			requestsCompleted: 0, requestsTotal: 0, requestsFailed: 0, cacheHits: 0, sharedRequests: 0, activeCrates: [],
			errors: [], startedAt: Date.now(),
		};
		this.emit();
	}

	manifest(root: string): void {
		if (this.state) {
			this.state.root = root;
			this.state.steps = initialSteps();
			this.state.activeCrates = [];
			this.emit();
		}
	}

	update(id: AnalysisStepId, patch: Partial<Omit<AnalysisStep, 'id' | 'label'>>): void {
		const step = this.state?.steps.find(candidate => candidate.id === id);
		if (step) {
			Object.assign(step, patch);
			this.emit();
		}
	}

	error(id: AnalysisStepId, message: string): void {
		this.recordError(message);
		this.update(id, { status: 'failed', detail: message, active: [] });
	}

	recordError(message: string): void {
		this.state?.errors.push(message);
		this.emit();
	}

	lookup(crateName: string, running: boolean): void {
		if (this.state) {
			this.state.activeCrates = this.state.activeCrates.filter(name => name !== crateName);
			if (running) {
				this.state.activeCrates.push(crateName);
			}
			this.emit();
		}
	}

	request(event: CratesIoProgress): void {
		if (!this.state) {
			return;
		}
		if (event.kind === 'fetch') {
			this.state.requestsTotal += event.total;
		} else if (event.kind === 'cache') {
			this.state.cacheHits++;
		} else if (event.kind === 'shared') {
			this.state.sharedRequests++;
		} else if (event.kind === 'request') {
			const step = this.state.steps.find(candidate => candidate.id === 'crates');
			if (step) {
				step.active = step.active.filter(url => url !== event.url);
				if (event.status === 'running') {
					step.active.push(event.url);
				} else {
					this.state.requestsCompleted++;
					if (event.status === 'failed') {
						this.state.requestsFailed++;
					}
				}
			}
		}
		this.emit();
	}

	manifestCompleted(): void {
		if (this.state) {
			this.state.manifestsCompleted++;
			this.emit();
		}
	}

	finish(error?: string): void {
		if (this.state) {
			if (error) {
				this.state.errors.push(error);
			}
			this.state.status = error ? 'failed' : 'completed';
			this.state.finishedAt = Date.now();
			this.state.activeCrates = [];
			for (const step of this.state.steps) {
				if (step.status === 'pending' || step.status === 'running') {
					step.status = error ? 'failed' : 'skipped';
					step.active = [];
				}
			}
			this.emit();
		}
	}

	dispose(): void {
		this.emitter.dispose();
	}

	private emit(): void {
		if (this.state) {
			this.emitter.fire(structuredClone(this.state));
		}
	}
}

export type CratesIoProgress =
	| { kind: 'fetch'; total: number }
	| { kind: 'cache' | 'shared' }
	| { kind: 'request'; url: string; status: 'running' | 'completed' | 'failed' };