export interface Dependency {
	name: string;
	packageName: string;
	versionRequirement: string;
	localPath?: string;
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
}

export interface DependencyHealth {
	dependency: Dependency;
	installedVersion: string;
	latestVersion: string;
	versions: PublishedVersion[];
	advisories: Advisory[];
}

export interface AnalysisSnapshot {
	root: string;
	contents: string;
	dependencies: DependencyHealth[];
	updatedAt: number;
}

export interface CargoOutdatedEntry {
	name: string;
	project?: string;
	latest?: string;
}

export interface CargoAuditEntry {
	packageName: string;
	packageVersion: string;
	id: string;
	title: string;
	severity?: string;
}