import type { Role } from './types.ts';

export function assertRoleExists(roles: Record<string, Role>, roleName: string | undefined): void {
	if (!roleName) return;
	if (roles[roleName]) return;
	const available = Object.keys(roles);
	const list = available.length > 0 ? available.join(', ') : '(none defined)';
	throw new Error(
		`[flue] Role "${roleName}" not registered. Available roles: ${list}. ` +
			`Define roles as markdown files under \`.flue/roles/\`.`,
	);
}

export function resolveEffectiveRole(options: {
	roles: Record<string, Role>;
	agentRole?: string;
	sessionRole?: string;
	callRole?: string;
}): string | undefined {
	const role = options.callRole ?? options.sessionRole ?? options.agentRole;
	assertRoleExists(options.roles, role);
	return role;
}

export function resolveRoleModel(
	roles: Record<string, Role>,
	roleName: string | undefined,
): string | undefined {
	assertRoleExists(roles, roleName);
	return roleName ? roles[roleName]?.model : undefined;
}
