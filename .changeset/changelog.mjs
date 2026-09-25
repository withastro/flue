import defaultChangelog from '@changesets/cli/changelog';

export default {
	...defaultChangelog,
	async getDependencyReleaseLine(changesets, dependenciesUpdated) {
		if (dependenciesUpdated.length === 0) return '';

		const commits = [
			...new Set(
				changesets.flatMap((changeset) => (changeset.commit ? [changeset.commit.slice(0, 7)] : [])),
			),
		];
		const heading =
			commits.length > 0
				? `- Updated dependencies [${commits.join(', ')}]`
				: '- Updated dependencies';
		const dependencies = dependenciesUpdated.map(
			(dependency) => `  - ${dependency.name}@${dependency.newVersion}`,
		);

		return [heading, ...dependencies].join('\n');
	},
};
