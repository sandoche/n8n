import { Entry } from 'ldapts';
import { LoggerProxy as Logger } from 'n8n-workflow';
import { LdapService } from './LdapService.ee';
import type { LdapConfig } from './types';
import { RunningMode, SyncStatus } from './constants';
import {
	getLdapUserRole,
	mapLdapUserToDbUser,
	processUsers,
	saveLdapSynchronization,
	createFilter,
	resolveBinaryAttributes,
	getLdapIds,
} from './helpers';
import type { User } from '@db/entities/User';
import type { Role } from '@db/entities/Role';
import { QueryFailedError } from 'typeorm/error/QueryFailedError';
import { InternalHooksManager } from '@/InternalHooksManager';

export class LdapSync {
	private intervalId: NodeJS.Timeout | undefined = undefined;

	private _config: LdapConfig;

	private _ldapService: LdapService;

	/**
	 * Updates the LDAP configuration
	 * @param  {LdapConfig} config
	 */
	set config(config: LdapConfig) {
		this._config = config;
		// If user disabled synchronization in the UI and there a job schedule,
		// stop it
		if (this.intervalId && !this._config.synchronizationEnabled) {
			this.stop();
			// If instance crashed with a job scheduled, once the server starts
			// again, reschedule it.
		} else if (!this.intervalId && this._config.synchronizationEnabled) {
			this.scheduleRun();
			// If job scheduled and the run interval got updated in the UI
			// stop the current one and schedule a new one with the new internal
		} else if (this.intervalId && this._config.synchronizationEnabled) {
			this.stop();
			this.scheduleRun();
		}
	}

	/**
	 * Set the LDAP service instance
	 * @param  {LdapService} service
	 */
	set ldapService(service: LdapService) {
		this._ldapService = service;
	}

	/**
	 * Schedule a synchronization job based
	 * on the interval set in the LDAP config
	 * @returns void
	 */
	scheduleRun(): void {
		if (!this._config.synchronizationInterval) {
			throw new Error('Interval variable has to be defined');
		}
		this.intervalId = setInterval(async () => {
			await this.run(RunningMode.LIVE);
		}, this._config.synchronizationInterval * 60000);
	}

	/**
	 * Run the synchronization job.
	 * If the job runs in "live" mode,
	 * changes to LDAP users are persisted
	 * in the database, else the users are
	 * not modified
	 * @param  {RunningMode} mode
	 * @returns Promise
	 */
	async run(mode: RunningMode): Promise<void> {
		Logger.debug(`LDAP - Starting a synchronization run in ${mode} mode`);

		let adUsers: Entry[] = [];

		try {
			adUsers = await this._ldapService.searchWithAdminBinding(
				createFilter(`(${this._config.loginIdAttribute}=*)`, this._config.userFilter),
			);

			Logger.debug(`LDAP - Users return by the query`, {
				users: adUsers,
			});

			resolveBinaryAttributes(adUsers);
		} catch (e) {
			if (e instanceof Error) {
				Logger.error(`LDAP - ${e.message}`);
				throw e;
			}
		}

		const startedAt = new Date();

		const localAdUsers = await getLdapIds();

		const role = await getLdapUserRole();

		const { usersToCreate, usersToUpdate, usersToDisable } = this.getUsersToProcess(
			adUsers,
			localAdUsers,
			role,
		);

		if (usersToDisable.length) {
			void InternalHooksManager.getInstance().onLdapUsersDisabled({
				reason: 'ldap_update',
				users: usersToDisable.length,
				user_ids: usersToDisable,
			});
		}

		Logger.debug(`LDAP - Users processed`, {
			created: usersToCreate.length,
			updated: usersToUpdate.length,
			disabled: usersToDisable.length,
		});

		const endedAt = new Date();
		let status = SyncStatus.SUCCESS;
		let errorMessage = '';

		try {
			if (mode === RunningMode.LIVE) {
				await processUsers(usersToCreate, usersToUpdate, usersToDisable);
			}
		} catch (error) {
			if (error instanceof QueryFailedError) {
				status = SyncStatus.ERROR;
				errorMessage = `${error.message}`;
			}
		}

		await saveLdapSynchronization({
			startedAt,
			endedAt,
			created: usersToCreate.length,
			updated: usersToUpdate.length,
			disabled: usersToDisable.length,
			scanned: adUsers.length,
			runMode: mode,
			status,
			error: errorMessage,
		});

		void InternalHooksManager.getInstance().onLdapSyncFinished({
			type: !this.intervalId ? 'scheduled' : `manual_${mode}`,
			succeeded: true,
			users_synced: usersToCreate.length + usersToUpdate.length + usersToDisable.length,
			error: errorMessage,
		});

		Logger.debug(`LDAP - Synchronization finished successfully`);
	}

	/**
	 * Stop the current job scheduled,
	 * if any
	 * @returns void
	 */
	stop(): void {
		clearInterval(this.intervalId);
		this.intervalId = undefined;
	}

	/**
	 * Get all the user that will be
	 * changed (created, updated, disabled),
	 * in the database
	 * @param  {Entry[]} adUsers
	 * @param  {string[]} localAdUsers
	 * @param  {Role} role
	 */
	private getUsersToProcess(
		adUsers: Entry[],
		localAdUsers: string[],
		role: Role,
	): {
		usersToCreate: Array<[string, User]>;
		usersToUpdate: Array<[string, User]>;
		usersToDisable: string[];
	} {
		return {
			usersToCreate: this.getUsersToCreate(adUsers, localAdUsers, role),
			usersToUpdate: this.getUsersToUpdate(adUsers, localAdUsers),
			usersToDisable: this.getUsersToDisable(adUsers, localAdUsers),
		};
	}

	/**
	 * Get users in LDAP that
	 * are not in the database
	 * @param  {Entry[]} adUsers
	 * @param  {string[]} localAdUsers
	 * @returns Array
	 */
	private getUsersToCreate(
		adUsers: Entry[],
		localAdUsers: string[],
		role: Role,
	): Array<[string, User]> {
		return adUsers
			.filter((user) => !localAdUsers.includes(user[this._config.ldapIdAttribute] as string))
			.map((user: Entry) => mapLdapUserToDbUser(user, this._config, role));
	}

	/**
	 * Get users in LDAP that
	 * are in the n8n database
	 * @param  {Entry[]} adUsers
	 * @param  {string[]} localAdUsers
	 * @returns Array
	 */
	private getUsersToUpdate(adUsers: Entry[], localAdUsers: string[]): Array<[string, User]> {
		return adUsers
			.filter((user) => localAdUsers.includes(user[this._config.ldapIdAttribute] as string))
			.map((user: Entry) => mapLdapUserToDbUser(user, this._config));
	}

	/**
	 * Get users that are in the database
	 * but no in the LDAP server
	 * @param  {Entry[]} adUsers
	 * @param  {string[]} localAdUsers
	 * @returns Array
	 */
	private getUsersToDisable(adUsers: Entry[], localAdUsers: string[]): string[] {
		const filteredAdUsers = adUsers.map((user) => user[this._config.ldapIdAttribute]);
		return localAdUsers.filter((user) => !filteredAdUsers.includes(user));
	}
}
