import {
	entitlementTypeToIdMap,
	type Agent,
	type ValorantLoadout,
} from 'types';
import type { Loadout } from '~/utils';
import {
	getLockfile,
	getUser,
	getUserConfig,
	randomItem,
} from '~/utils.server';
import type { User } from './userman';
import { createTray, type Tray } from './tray';
import WebSocket from 'ws';
import { isAxiosError } from 'axios';

function describeError(e: unknown) {
	if (isAxiosError(e)) {
		return `${e.config?.method?.toUpperCase()} ${e.config?.url?.split('?')[0]} -> ${e.response ? `HTTP ${e.response.status}` : e.code}`;
	}
	return e instanceof Error ? e.message : String(e);
}

function tryParseJson<T>(json: string): T | null {
	try {
		return JSON.parse(json);
	} catch (e) {
		return null;
	}
}

export class AppManager {
	private isAutoShuffleEnabled = true;
	private isAgentDetectionEnabled = true;

	private tray: Tray;
	private wsErrorLogged = false;

	constructor() {
		this.tray = createTray(
			`http://localhost:${process.env.PORT || '3000'}`,
			{
				onToggleShuffle: (enabled) => {
					this.isAutoShuffleEnabled = enabled;
				},
				onToggleAgentDetection: (enabled) => {
					this.isAgentDetectionEnabled = enabled;
				},
			},
		);
		this.connect();
	}

	notify(title: string, text: string) {
		this.tray.notify(title, text);
	}

	async connect() {
		try {
			const lockfile = await getLockfile();

			if (!lockfile) {
				setTimeout(() => {
					this.connect();
				}, 5000);
				return;
			}

			const { port, password } = lockfile;
			const ws = new WebSocket(`wss://riot:${password}@127.0.0.1:${port}`, {
				rejectUnauthorized: false,
			});

			const matchCharacterSelectionStates = new Map<string, string>();

			ws.addEventListener('open', async () => {
				try {
					console.log('Connecté au Riot Client, détection des parties active.');
					this.wsErrorLogged = false;
					ws.send(JSON.stringify([5, 'OnJsonApiEvent']));
				} catch (e) {
					console.warn('Erreur websocket (open) :', describeError(e));
				}
			});

			let abortController: AbortController = new AbortController();

			ws.addEventListener('message', async ({ data }) => {
				try {
					const parsed = tryParseJson<[number, string, object]>(
						data.toString(),
					);

					if (!parsed) {
						return;
					}

					const [type, event, payload] = parsed;

					if (type !== 8 || event !== 'OnJsonApiEvent') {
						return;
					}

					const { uri, eventType } = payload as {
						uri: string;
						eventType: string;
						data: object;
					};

					const uriMatch = uri.match(/\/pregame\/v1\/matches\/(.*)/);
					if (eventType === 'Create' && uriMatch && uriMatch[1]) {
						const matchId = uriMatch[1];
						console.log('Match found:', matchId);

						const existingState = matchCharacterSelectionStates.get(matchId);

						if (existingState === 'locked') {
							console.log('Match already locked, no need to process');
							return;
						}

						const user = await getUser();

						if (!user) {
							console.log('User not found');
							return;
						}

						const match = await user.getPregame();

						const player = match.AllyTeam.Players.find(
							(player) => player.Subject === user.userId,
						);

						const newState = player?.CharacterSelectionState;

						if (
							newState &&
							newState !== matchCharacterSelectionStates.get(matchId)
						) {
							if (newState === 'locked' && this.isAutoShuffleEnabled) {
								this.equip(
									user,
									this.isAgentDetectionEnabled ? player.CharacterID : undefined,
								);
							}

							matchCharacterSelectionStates.set(matchId, newState);
						}
					}
				} catch (e) {
					console.warn('Erreur pendant la sélection d\'agent / l\'équipement :', describeError(e));
				}
			});

			ws.addEventListener('close', () => {
				try {
					abortController?.abort();
					setTimeout(() => {
						this.connect();
					}, 5000);
				} catch (e) {
					console.warn('Erreur websocket (close) :', describeError(e));
				}
			});

			ws.addEventListener('error', (err) => {
				if (!this.wsErrorLogged) {
					console.warn('Connexion au Riot Client impossible :', err.message);
					this.wsErrorLogged = true;
				}
				// this.notify('Websocket Error', err.message);
			});
		} catch (e) {
			console.warn('Erreur de connexion :', describeError(e));
		}
	}

	equip = async (user: User, agentId?: string) => {
		const config = await getUserConfig(user.userId);

		const agent: Agent | undefined = valorantData.agents.find(
			(a) => a.uuid === agentId,
		)!;

		const loadoutsToConsider = (function (
			loadouts: Loadout[],
			agentId?: string,
		) {
			if (!agentId) {
				console.log('No agent specified, considering all loadouts.');
				return loadouts;
			}

			const agentSpecificLoadouts = loadouts.filter((l) =>
				l.agentIds.includes(agentId),
			);

			if (agentSpecificLoadouts.length === 0) {
				console.log(
					'No loadouts for',
					agentId,
					`(${agent.displayName})`,
					'falling back to all loadouts.',
				);
				return loadouts;
			}

			console.log(
				'Only considering loadouts for',
				agentId,
				`(${agent.displayName})`,
			);
			return agentSpecificLoadouts;
		})(
			config.loadouts.filter((loadout) => loadout.enabled),
			agentId,
		);

		if (loadoutsToConsider.length === 0) {
			console.log('No loadouts, not equipping.');
			return;
		}

		const loadout = randomItem(loadoutsToConsider);
		this.equipLoadout(user, loadout);
	};

	async equipLoadout(user: User, loadout: Loadout) {
		const weapons = valorantData.weapons;

		const [existingLoadout, entitlements] = await Promise.all([
			user.getLoadout(),
			user.getEntitlements(),
		]);

		const buddyEntitlements = entitlements.buddy.reduce((acc, buddy) => {
			const existing = acc.get(buddy.ItemID) || [];
			existing.push(buddy.InstanceID);

			acc.set(buddy.ItemID, existing);
			return acc;
		}, new Map<string, string[]>());

		const loadoutToEquip: ValorantLoadout = {
			...existingLoadout,
			Identity: {
				...existingLoadout.Identity,
				PlayerCardID:
					randomItem(loadout.playerCardIds) ||
					'9fb348bc-41a0-91ad-8a3e-818035c4e561',
			},
			ActiveExpressions: [
				randomItem([
					...loadout.expressionIds.top.sprayIds.map((id) => ({
						TypeID: entitlementTypeToIdMap.spray,
						AssetID: id,
					})),
					...loadout.expressionIds.top.flexIds.map((id) => ({
						TypeID: entitlementTypeToIdMap.flex,
						AssetID: id,
					})),
				]) || {
					TypeID: entitlementTypeToIdMap.spray,
					AssetID: '0a6db78c-48b9-a32d-c47a-82be597584c1',
				},
				randomItem([
					...loadout.expressionIds.right.sprayIds.map((id) => ({
						TypeID: entitlementTypeToIdMap.spray,
						AssetID: id,
					})),
					...loadout.expressionIds.right.flexIds.map((id) => ({
						TypeID: entitlementTypeToIdMap.flex,
						AssetID: id,
					})),
				]) || {
					TypeID: entitlementTypeToIdMap.spray,
					AssetID: '0a6db78c-48b9-a32d-c47a-82be597584c1',
				},
				randomItem([
					...loadout.expressionIds.bottom.sprayIds.map((id) => ({
						TypeID: entitlementTypeToIdMap.spray,
						AssetID: id,
					})),
					...loadout.expressionIds.bottom.flexIds.map((id) => ({
						TypeID: entitlementTypeToIdMap.flex,
						AssetID: id,
					})),
				]) || {
					TypeID: entitlementTypeToIdMap.spray,
					AssetID: '0a6db78c-48b9-a32d-c47a-82be597584c1',
				},
				randomItem([
					...loadout.expressionIds.left.sprayIds.map((id) => ({
						TypeID: entitlementTypeToIdMap.spray,
						AssetID: id,
					})),
					...loadout.expressionIds.left.flexIds.map((id) => ({
						TypeID: entitlementTypeToIdMap.flex,
						AssetID: id,
					})),
				]) || {
					TypeID: entitlementTypeToIdMap.flex,
					AssetID: 'af52b5a0-4a4c-03b2-c9d7-8187a08a2675',
				},
			],
			Guns: Object.entries(loadout.weapons).map(([weaponId, { templates }]) => {
				if (!templates.length) {
					const weapon = weapons.find((w) => w.uuid === weaponId)!;
					const skin = weapon.skins.find(
						(s) => s.uuid === weapon.defaultSkinUuid,
					)!;

					return {
						ID: weaponId,
						SkinID: skin.uuid,
						ChromaID: skin.chromas[0].uuid,
						SkinLevelID: skin.levels[0].uuid,
						Attachments: [],
					};
				}

				const template = randomItem(templates);

				const buddyData = (() => {
					const buddy = randomItem(template.buddies);
					if (!buddy) return null;

					const buddyLevelId = randomItem(buddy.levelIds);

					const consumedBuddy = (
						buddyEntitlements.get(buddyLevelId) || []
					).shift();

					if (!consumedBuddy) return null;

					return {
						CharmInstanceID: consumedBuddy,
						CharmID: buddy.id,
						CharmLevelID: buddyLevelId,
					};
				})();

				return {
					ID: weaponId,
					SkinID: template.skinId,
					ChromaID: randomItem(template.chromaIds),
					SkinLevelID: randomItem(template.levelIds),
					Attachments: [],
					...buddyData,
				};
			}),
		};

		console.log('Équipement du loadout', loadout.name);
		await user.equipLoadout(loadoutToEquip);
	}
}
