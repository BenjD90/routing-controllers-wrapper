import { N9Error } from '@neo9/n9-node-utils';
import { Module, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ExpressAdapter } from '@nestjs/platform-express';
import { ValidatorOptions } from 'class-validator';
import * as express from 'express';
import { Request, Response } from 'express';
import * as helmet from 'helmet';
import { createServer } from 'http';
import * as morgan from 'morgan';
import { FormatFn, TokenIndexer } from 'morgan';
import { N9NodeRoutingLoggerService } from './logger.service';
import { AllErrorsFilter } from './middleware/error-handler.interceptor';
import { SessionLoaderInterceptor } from './middleware/session-loader.interceptor';
import { N9NodeRouting } from './models/routing.models';
import { setRequestContext } from './requestid';
import { RootModule } from './root.module';
import bindSpecificRoutes from './routes';
import { importClassesFromDirectories } from './utils/import-classes-from-directories';
import ErrnoException = NodeJS.ErrnoException;
import _ = require('lodash');

function createNestAppModule(options: N9NodeRouting.Options): any {
	const controllers = importClassesFromDirectories([options.path + '/**/*.controller.*s']);
	const controllersUniq = _.uniqBy(controllers, 'name');

	if (controllers.length !== controllersUniq.length) {
		const controllerDuplicatedNames: Set<string> = new Set<string>();
		const sorted: string[] = _.map(controllers, 'name').sort();
		for (let i = 0; i < sorted.length - 1; i++) {
			if (sorted[i + 1] == sorted[i]) {
				controllerDuplicatedNames.add(sorted[i]);
			}
		}
		throw new N9Error('duplicated-controller', 400, { controllerDuplicatedNames: Array.from(controllerDuplicatedNames) })
	}

	class AppModule {}
	Module({
		controllers,
		imports: [
			RootModule,
		],
	})(AppModule);
	return AppModule;
}

const startExpressApp = async (options: N9NodeRouting.Options): Promise<N9NodeRouting.ReturnObject> => {

	// Default options
	options.http = options.http || {};
	options.http.port = options.http.port || process.env.PORT || 5000;
	options.http.logLevel = (typeof options.http.logLevel !== 'undefined' ? options.http.logLevel : (tokens: TokenIndexer, req: Request, res: Response) => {
		const formatLogInJSON: boolean = global.n9NodeRoutingData.formatLogInJSON;

		if (formatLogInJSON) {
			return JSON.stringify({
				'method': tokens.method(req, res),
				'request-id': options.enableRequestId ? `(${req.headers['x-request-id']})` : '',
				'path': tokens.url(req, res),
				'status': tokens.status(req, res),
				'duration': (Number.parseFloat(tokens['response-time'](req, res)) / 1000).toFixed(6),
				'response-time': tokens['response-time'](req, res),
				'content-length': tokens.res(req, res, 'content-length'),
			});
		} else {
			return [
				tokens.method(req, res),
				tokens.url(req, res),
				tokens.status(req, res),
				tokens['response-time'](req, res), 'ms - ',
				tokens.res(req, res, 'content-length'),
			].join(' ');
		}
	});

	// TODO:
	// app.useGlobalInterceptors(new LoggingInterceptor());
	options.http.validation = {
		whitelist: true,
		forbidNonWhitelisted: true,
	} as ValidatorOptions;

	// options.log.info(`-- start-express-app.ts options.http --`, JSON.stringify(options.http, null, 2));

	// Listeners
	const analyzeError = (error: ErrnoException) => {
		/* istanbul ignore if */
		if (error.syscall !== 'listen') {
			return error;
		}
		// handle specific listen errors with friendly messages
		switch (error.code) {
			case 'EACCES':
				return new Error(`Port ${options.http.port} requires elevated privileges`);
			case 'EADDRINUSE':
				return new Error(`Port ${options.http.port} is already in use`);
				/* istanbul ignore next */
			default:
				return error;
		}
	};
	const onListening = () => {
		options.log.info('Listening on port ' + options.http.port);
	};

	// Create HTTP server
	let expressApp = express();

	// Middleware
	expressApp.use(setRequestContext);
	expressApp.use(helmet());
	expressApp.use(SessionLoaderInterceptor.use);
	// Logger middleware
	if (options.http.logLevel) {
		expressApp.use(morgan(options.http.logLevel as FormatFn, {
			stream: {
				write: (message) => {
					if (global.n9NodeRoutingData.formatLogInJSON) {
						try {
							const morganDetails = JSON.parse(message);
							options.log.info('api call ' + morganDetails.path, {
								...morganDetails,
								durationMs: Number.parseFloat(morganDetails['response-time']),
							});
						} catch (e) {
							message = message && message.replace('\n', '');
							options.log.info(message, { error: e });
						}
					} else {
						message = message && message.replace('\n', '');
						options.log.info(message);
					}
				},
			},
		}));
	}
	const nestAppModule = createNestAppModule(options);

	await bindSpecificRoutes(expressApp, options, nestAppModule);

	const server = createServer(expressApp);

	if (options.http.beforeRoutingControllerLaunchHook) {
		await options.http.beforeRoutingControllerLaunchHook(expressApp, options.log, options);
	}


	const nestApp = await NestFactory.create(nestAppModule, new ExpressAdapter(expressApp), {
		bodyParser: true,
		logger: new N9NodeRoutingLoggerService(options.log, 'nest'),
	});
	nestApp.useGlobalFilters(new AllErrorsFilter());
	nestApp.useGlobalPipes(new ValidationPipe({
		transform: true,
		... options.http.validation
	}));
	await nestApp.init();

	if (options.http.afterRoutingControllerLaunchHook) {
		await options.http.afterRoutingControllerLaunchHook(expressApp, options.log, options);
	}

	// Listen method
	const listen = async () => {
		return new Promise((resolve, reject) => {
			server.listen(options.http.port);
			// const routes = _.compact(_.map(expressApp._router.stack, 'route'));
			// for (const route of routes) {
			// 	console.log(`-- start-express-app.ts app._router.stack → path --`, route.path);
			// }
			server.on('error', (error: ErrnoException) => {
				reject(analyzeError(error));
			});
			server.on('listening', () => {
				onListening();
				resolve();
			});
		});
	};

	// Make the server listen
	if (!options.http.preventListen) await listen();

	return {
		app: expressApp,
		server,
	};
};

export default startExpressApp;
