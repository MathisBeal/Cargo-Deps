export interface Dependency {
	name: string;
	packageName: string;
	versionRequirement: string;
	localPath?: string;
	git?: string;
	registry?: string;
	workspace?: 'declaration' | 'inherited';
	section?: string;
	versionRange?: { start: number; end: number };
	line: number;
}

export interface Advisory {
	id: string;
	title: string;
	severity?: string;
	packageName: string;
	packageVersion: string;
	treePath?: string;
}

export interface PublishedVersion {
	number: string;
	createdAt: string;
	yanked: boolean;
}

export interface CrateReleaseInfo {
	latestVersion: string;
	versions: PublishedVersion[];
	documentationUrl?: string;
	repositoryUrl?: string;
}

export interface DependencyHealth {
	dependency: Dependency;
	installedVersion: string;
	latestVersion: string;
	versions: PublishedVersion[];
	documentationUrl?: string;
	repositoryUrl?: string;
	advisories: Advisory[];
	auditAvailable?: boolean;
}

export interface AnalysisSnapshot {
	root: string;
	packageName?: string;
	workspaceRoot?: string;
	auditAvailable?: boolean;
	contents: string;
	dependencies: DependencyHealth[];
	workspaceDependencies?: Dependency[];
	updatedAt: number;
}

export interface CargoOutdatedEntry {
	name: string;
	project?: string;
	latest?: string;
	crateName?: string;
}

export interface CargoAuditEntry {
	packageName: string;
	packageVersion: string;
	id: string;
	title: string;
	severity?: string;
}