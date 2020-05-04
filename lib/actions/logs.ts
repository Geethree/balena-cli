/*
Copyright 2016-2019 Balena

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

   http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import type { LogMessage } from 'balena-sdk';
import type { CommandDefinition } from 'capitano';

import { getBalenaSdk, stripIndent } from '../utils/lazy';
import { normalizeUuidProp } from '../utils/normalization';
import { validateDotLocalUrl } from '../utils/validation';

export const logs: CommandDefinition<
	{
		uuidOrDevice: string;
	},
	{
		tail?: boolean;
		service?: [string] | string;
		system?: boolean;
	}
> = {
	signature: 'logs <uuidOrDevice>',
	description: 'show device logs',
	help: stripIndent`
		Use this command to show logs for a specific device.

		By default, the command prints all log messages and exits.

		To continuously stream output, and see new logs in real time, use the \`--tail\` option.

		If an IP or .local address is passed to this command, logs are displayed from
		a local mode device with that address. Note that --tail is implied
		when this command is provided a local mode device.

		Logs from a single service can be displayed with the --service flag. Just system logs
		can be shown with the --system flag. Note that these flags can be used together.

		Examples:

			$ balena logs 23c73a1
			$ balena logs 23c73a1 --tail

			$ balena logs 192.168.0.31
			$ balena logs 192.168.0.31 --service my-service
			$ balena logs 192.168.0.31 --service my-service-1 --service my-service-2

			$ balena logs 23c73a1.local --system
			$ balena logs 23c73a1.local --system --service my-service`,
	options: [
		{
			signature: 'tail',
			description: 'continuously stream output',
			boolean: true,
			alias: 't',
		},
		{
			signature: 'service',
			description: stripIndent`
				Reject logs not originating from this service.
				This can be used in combination with --system or other --service flags.`,
			parameter: 'service',
			alias: 's',
		},
		{
			signature: 'system',
			alias: 'S',
			boolean: true,
			description:
				'Only show system logs. This can be used in combination with --service.',
		},
	],
	primary: true,
	async action(params, options) {
		normalizeUuidProp(params);
		const balena = getBalenaSdk();
		const { ExpectedError } = await import('../errors');
		const { serviceIdToName } = await import('../utils/cloud');
		const { displayDeviceLogs, displayLogObject } = await import(
			'../utils/device/logs'
		);
		const { validateIPAddress } = await import('../utils/validation');
		const { checkLoggedIn } = await import('../utils/patterns');
		const Logger = await import('../utils/logger');

		const logger = Logger.getLogger();

		const servicesToDisplay =
			options.service != null
				? Array.isArray(options.service)
					? options.service
					: [options.service]
				: undefined;

		const displayCloudLog = async (line: LogMessage) => {
			if (!line.isSystem) {
				let serviceName = await serviceIdToName(balena, line.serviceId);
				if (serviceName == null) {
					serviceName = 'Unknown service';
				}
				displayLogObject(
					{ serviceName, ...line },
					logger,
					options.system || false,
					servicesToDisplay,
				);
			} else {
				displayLogObject(
					line,
					logger,
					options.system || false,
					servicesToDisplay,
				);
			}
		};

		if (
			validateIPAddress(params.uuidOrDevice) ||
			validateDotLocalUrl(params.uuidOrDevice)
		) {
			const { DeviceAPI } = await import('../utils/device/api');
			const deviceApi = new DeviceAPI(logger, params.uuidOrDevice);
			logger.logDebug('Checking we can access device');
			try {
				await deviceApi.ping();
			} catch (e) {
				throw new ExpectedError(
					`Cannot access local mode device at address ${params.uuidOrDevice}`,
				);
			}
			const logStream = await deviceApi.getLogStream();
			await displayDeviceLogs(
				logStream,
				logger,
				options.system || false,
				servicesToDisplay,
			);
		} else {
			await checkLoggedIn();
			if (options.tail) {
				const logStream = await balena.logs.subscribe(params.uuidOrDevice, {
					count: 100,
				});
				// Never resolve (quit with CTRL-C), but reject on a broken connection
				await new Promise((_resolve, reject) => {
					logStream.on('line', displayCloudLog);
					logStream.on('error', reject);
				});
			} else {
				const logMessages = await balena.logs.history(params.uuidOrDevice);
				for (const logMessage of logMessages) {
					await displayCloudLog(logMessage);
				}
			}
		}
	},
};
