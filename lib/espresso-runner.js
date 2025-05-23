import { JWProxy, errors } from 'appium/driver';
import { waitForCondition } from 'asyncbox';
import { ServerBuilder, buildServerSigningConfig } from './server-builder';
import path from 'path';
import { fs, util, mkdirp, timing } from 'appium/support';
import B from 'bluebird';
import _ from 'lodash';
import { copyGradleProjectRecursively, getPackageInfoSync, getPackageInfo } from './utils';
import axios from 'axios';
import * as semver from 'semver';


const TEST_SERVER_ROOT = path.resolve(__dirname, '..', '..', 'espresso-server');
const TEST_APK_PKG = 'io.appium.espressoserver.test';
const REQUIRED_PARAMS = [
  'adb',
  'tmpDir',
  'host',
  'systemPort',
  'devicePort',
  'appPackage',
  'forceEspressoRebuild',
];
const ESPRESSO_SERVER_LAUNCH_TIMEOUT_MS = 45000;
const TARGET_PACKAGE_CONTAINER = '/data/local/tmp/espresso.apppackage';

class EspressoProxy extends JWProxy {

  /**
   * @type {{crashed: boolean, exited: boolean}}
   */
  instrumentationState;

  async proxyCommand (url, method, body = null) {
    const {crashed, exited} = this.instrumentationState;
    if (exited) {
      throw new errors.InvalidContextError(`'${method} ${url}' cannot be proxied to Espresso server because ` +
        `the instrumentation process has ${crashed ? 'crashed' : 'been unexpectedly terminated'}. ` +
        `Check the Appium server log and the logcat output for more details`);
    }
    return await super.proxyCommand(url, method, body);
  }
}

class EspressoRunner {

  /** @type {string} */
  host;

  /** @type {number} */
  systemPort;

  /** @type {string} */
  appPackage;

  /** @type {import('appium-adb').ADB} */
  adb;

  /** @type {string} */
  tmpDir;

  /**@type {boolean} */
  forceEspressoRebuild;

  /**
   *
   * @param {import('@appium/types').AppiumLogger} log
   * @param {import('@appium/types').StringRecord} opts
   */
  constructor (log, opts = {}) {
    for (const req of REQUIRED_PARAMS) {
      if (!opts || !util.hasValue(opts[req])) {
        throw new Error(`Option '${req}' is required!`);
      }
      this[req] = opts[req];
    }
    this.log = log;
    const proxyOpts = {
      log,
      server: this.host,
      port: this.systemPort,
      keepAlive: true,
    };
    if (opts.reqBasePath) {
      proxyOpts.reqBasePath = opts.reqBasePath;
    }
    this.jwproxy = new EspressoProxy(proxyOpts);
    this.proxyReqRes = this.jwproxy.proxyReqRes.bind(this.jwproxy);
    this.proxyCommand = this.jwproxy.command.bind(this.jwproxy);
    this.jwproxy.instrumentationState = {
      exited: false,
      crashed: false,
    };

    const { manifestPayload } = getPackageInfoSync();
    const modServerName = fs.sanitizeName(
      `${TEST_APK_PKG}_${manifestPayload.version}_${this.appPackage}_${this.adb.curDeviceId}.apk`,
      {replacement: '-'}
    );
    this.modServerPath = path.resolve(this.tmpDir, modServerName);
    this.showGradleLog = opts.showGradleLog;
    this.espressoBuildConfig = opts.espressoBuildConfig;

    this.serverLaunchTimeout = opts.serverLaunchTimeout || ESPRESSO_SERVER_LAUNCH_TIMEOUT_MS;
    this.androidInstallTimeout = opts.androidInstallTimeout;

    this.disableSuppressAccessibilityService = opts.disableSuppressAccessibilityService;

    // Espresso Server app needs to be signed with same keyStore as appPackage
    if (opts.useKeystore && opts.keystorePath && opts.keystorePassword && opts.keyAlias && opts.keyPassword) {
      this.signingConfig = buildServerSigningConfig({
        keystoreFile: opts.keystorePath,
        keystorePassword: opts.keystorePassword,
        keyAlias: opts.keyAlias,
        keyPassword: opts.keyPassword
      });
    } else {
      this.signingConfig = null;
    }
  }

  async isAppPackageChanged () {
    if (!await this.adb.fileExists(TARGET_PACKAGE_CONTAINER)) {
      this.log.debug('The previous target application package is unknown');
      return true;
    }
    const previousAppPackage = (await this.adb.shell(['cat', TARGET_PACKAGE_CONTAINER])).trim();
    this.log.debug(`The previous target application package was '${previousAppPackage}'. ` +
      `The current package is '${this.appPackage}'`);
    return previousAppPackage !== this.appPackage;
  }

  /**
   * Installs Espresso server apk on to the device or emulator.
   * Each adb command uses default timeout by them.
   */
  async installServer () {
    const appState = await this.adb.getApplicationInstallState(this.modServerPath, TEST_APK_PKG);

    const shouldUninstallApp = [
      this.adb.APP_INSTALL_STATE.OLDER_VERSION_INSTALLED,
      this.adb.APP_INSTALL_STATE.NEWER_VERSION_INSTALLED
    ].includes(appState);
    const shouldInstallApp = shouldUninstallApp || [
      this.adb.APP_INSTALL_STATE.NOT_INSTALLED
    ].includes(appState);

    if (shouldUninstallApp) {
      this.log.info(`Uninstalling Espresso Test Server apk from the target device (pkg: '${TEST_APK_PKG}')`);
      try {
        await this.adb.uninstallApk(TEST_APK_PKG);
      } catch (err) {
        this.log.warn(`Error uninstalling '${TEST_APK_PKG}': ${err.message}`);
      }
    }

    if (shouldInstallApp) {
      this.log.info(`Installing Espresso Test Server apk from the target device (path: '${this.modServerPath}')`);
      try {
        await this.adb.install(this.modServerPath, { replace: false, timeout: this.androidInstallTimeout });
        this.log.info(`Installed Espresso Test Server apk '${this.modServerPath}' (pkg: '${TEST_APK_PKG}')`);
      } catch (err) {
        throw this.log.errorWithException(`Cannot install '${this.modServerPath}' because of '${err.message}'`);
      }
    }
  }

  async installTestApk () {
    let rebuild = this.forceEspressoRebuild;
    if (rebuild) {
      this.log.debug(`'forceEspressoRebuild' capability is enabled`);
    } else if (await this.isAppPackageChanged()) {
      this.log.info(`Forcing Espresso server rebuild because of changed application package`);
      rebuild = true;
    }

    if (rebuild && await fs.exists(this.modServerPath)) {
      this.log.debug(`Deleting the obsolete Espresso server package '${this.modServerPath}'`);
      await fs.unlink(this.modServerPath);
    }
    if (!(await fs.exists(this.modServerPath))) {
      await this.buildNewModServer();
    }
    const isSigned = await this.adb.checkApkCert(this.modServerPath, TEST_APK_PKG);
    if (!isSigned) {
      await this.adb.sign(this.modServerPath);
    }
    if ((rebuild || !isSigned) && await this.adb.uninstallApk(TEST_APK_PKG)) {
      this.log.info('Uninstalled the obsolete Espresso server package from the device under test');
    }

    await this.installServer();
  }

  async buildNewModServer () {
    let buildConfiguration = {};
    if (this.espressoBuildConfig) {
      let buildConfigurationStr;
      if (await fs.exists(this.espressoBuildConfig)) {
        this.log.info(`Loading the build configuration from '${this.espressoBuildConfig}'`);
        buildConfigurationStr = await fs.readFile(this.espressoBuildConfig, 'utf8');
      } else {
        this.log.info(`Loading the build configuration from 'espressoBuildConfig' capability`);
        buildConfigurationStr = this.espressoBuildConfig;
      }
      try {
        buildConfiguration = JSON.parse(buildConfigurationStr);
      } catch (e) {
        this.log.error('Cannot parse the build configuration JSON', e);
        throw e;
      }
    }
    const dirName = fs.sanitizeName(`espresso-server-${this.adb.curDeviceId}`, {
      replacement: '-',
    });
    const serverPath = path.resolve(this.tmpDir, dirName);
    this.log.info(`Building espresso server in '${serverPath}'`);
    this.log.debug(`The build folder root could be customized by changing the 'tmpDir' capability`);
    await fs.rimraf(serverPath);
    await mkdirp(serverPath);
    this.log.debug(`Copying espresso server template from ('${TEST_SERVER_ROOT}' to '${serverPath}')`);
    await copyGradleProjectRecursively(TEST_SERVER_ROOT, serverPath);
    this.log.debug('Bulding espresso server');
    await new ServerBuilder(this.log, {
      serverPath, buildConfiguration,
      showGradleLog: this.showGradleLog,
      testAppPackage: this.appPackage,
      signingConfig: this.signingConfig
    }).build();
    const apkPath = path.resolve(serverPath, 'app', 'build', 'outputs', 'apk', 'androidTest', 'debug', 'app-debug-androidTest.apk');
    this.log.debug(`Copying built apk from '${apkPath}' to '${this.modServerPath}'`);
    await fs.copyFile(apkPath, this.modServerPath);
  }

  async cleanupSessionLeftovers () {
    this.log.debug('Performing cleanup of automation leftovers');

    try {
      const {value} = (await axios({
        url: `http://${this.host}:${this.systemPort}/sessions`,
        timeout: 500,
      })).data;
      const activeSessionIds = value.map((sess) => sess.id);
      if (activeSessionIds.length) {
        this.log.debug(`The following obsolete sessions are still running: ${JSON.stringify(activeSessionIds)}`);
        this.log.debug('Cleaning up the obsolete sessions');
        await B.all(activeSessionIds.map((id) =>
          axios({
            url: `http://${this.host}:${this.systemPort}/session/${id}`,
            method: 'DELETE',
          })
        ));
        // Let all sessions to be properly terminated before continuing
        await B.delay(1000);
      } else {
        this.log.debug('No obsolete sessions have been detected');
      }
    } catch (e) {
      this.log.debug(`No obsolete sessions have been detected (${e.message})`);
    }
  }

  /**
   * @param {string} driverVersion
   * @param {import('@appium/types').StringRecord} serverStatus
   * @returns {Promise<boolean>}
   */
  async _verifyServerStatus(driverVersion, serverStatus) {
    if (!_.isPlainObject(serverStatus) || !_.isPlainObject(serverStatus.build)) {
      throw this.log.errorWithException(
        `The Espresso server version integrated with the application under test is not compatible ` +
        `with the current driver version '${driverVersion}'.`
      );
    }
    const {
      build: {
        version: serverVersion,
        packageName: serverPackageName,
      }
    } = serverStatus;
    const appLabel = serverPackageName ? `'${serverPackageName}' application` : 'application under test';
    const parsedServerVersion = semver.coerce(serverVersion);
    const parsedDriverVersion = semver.coerce(driverVersion);
    if (parsedServerVersion && parsedDriverVersion) {
      if (parsedServerVersion.major !== parsedDriverVersion.major) {
        throw this.log.errorWithException(
          `The Espresso server version '${serverVersion}' integrated with the ${appLabel} is not compatible ` +
          `with the current driver version '${driverVersion}'.`
        );
      } else if (parsedServerVersion.minor < parsedDriverVersion.minor) {
        this.log.warn(
          `The Espresso server version integrated with the ${appLabel} might not be compatible ` +
          `with the current driver version (${serverVersion} < ${driverVersion})'.`
        );
      }
    } else {
      const warnMessage = parsedServerVersion
        ? `The Espresso driver version '${driverVersion}' ` +
        `cannot be parsed. It might be incompatible with the current server '${serverVersion}' ` +
        `integrated with the ${appLabel}.`
        : `The Espresso server version '${serverVersion}' integrated with the ${appLabel} ` +
        `cannot be parsed. It might be incompatible with the current driver ` +
        `version '${driverVersion}'.`;
      this.log.warn(warnMessage);
    }
    if (this.appPackage && serverPackageName && this.appPackage !== serverPackageName) {
      throw this.log.errorWithException(
        `The Espresso server that is listening on the device under tests is built for a different ` +
        `application package (${serverPackageName} !== ${this.appPackage}).`
      );
    }
    return true;
  }

  async startSession (caps) {
    await this.cleanupSessionLeftovers();

    /** @type {string[]} */
    const cmd = [
      'shell',
      'am', 'instrument',
      '-w',
      '-e', 'debug', String(process.env.ESPRESSO_JAVA_DEBUG === 'true'),
      '-e', 'disableAnalytics', 'true', // To avoid unexpected error by google analytics
    ];

    if (_.isBoolean(this.disableSuppressAccessibilityService)) {
      cmd.push('-e', 'DISABLE_SUPPRESS_ACCESSIBILITY_SERVICES', String(this.disableSuppressAccessibilityService));
    }

    cmd.push(`${TEST_APK_PKG}/androidx.test.runner.AndroidJUnitRunner`);

    const {manifestPayload} = await getPackageInfo();
    this.log.info(`Starting Espresso Server v${manifestPayload.version} with cmd: adb ${cmd.join(' ')}`);

    let hasSocketError = false;
    // start the instrumentation process
    this.jwproxy.instrumentationState = {
      exited: false,
      crashed: false,
    };
    this.instProcess = this.adb.createSubProcess(cmd);
    this.instProcess.on('exit', (code, signal) => {
      this.log.info(`Instrumentation process exited with code ${code} from signal ${signal}`);
      this.jwproxy.instrumentationState.exited = true;
    });
    this.instProcess.on('output', (stdout, stderr) => {
      const line = stdout || stderr;
      if (_.isEmpty(line.trim())) {
        // Do not print empty lines into the system log
        return;
      }

      this.log.debug(`[Instrumentation] ${line.trim()}`);
      // A 'SocketException' indicates that we couldn't connect to the Espresso server,
      // because the INTERNET permission is not set
      if (line.toLowerCase().includes('java.net.socketexception')) {
        hasSocketError = true;
      } else if (line.includes('Process crashed')) {
        this.jwproxy.instrumentationState.crashed = true;
      }
    });

    const timer = new timing.Timer().start();
    await this.instProcess.start(0);
    this.log.info(`Waiting up to ${this.serverLaunchTimeout}ms for Espresso server to be online`);
    try {
      await waitForCondition(async () => {
        if (hasSocketError) {
          throw this.log.errorWithException(
            `Espresso server has failed to start due to an unexpected exception. ` +
            `Make sure the 'INTERNET' permission is requested in the Android manifest of your ` +
            `application under test (<uses-permission android:name="android.permission.INTERNET" />)`
          );
        } else if (this.jwproxy.instrumentationState.exited) {
          throw this.log.errorWithException(
            `Espresso server process has been unexpectedly terminated. ` +
            `Check the Appium server log and the logcat output for more details`
          );
        }
        let serverStatus;
        try {
          (serverStatus = /** @type {import('@appium/types').StringRecord} */ (
            await this.jwproxy.command('/status', 'GET')
          ));
        } catch {
          return false;
        }
        return await this._verifyServerStatus(manifestPayload.version, serverStatus);
      }, {
        waitMs: this.serverLaunchTimeout,
        intervalMs: 500,
      });
    } catch (e) {
      if (/Condition unmet/.test(e.message)) {
        throw this.log.errorWithException(
          `Timed out waiting for Espresso server to be ` +
          `online within ${this.serverLaunchTimeout}ms. The timeout value could be ` +
          `customized using 'espressoServerLaunchTimeout' capability`
        );
      }
      throw e;
    }
    this.log.info(`Espresso server is online. ` +
      `The initialization process took ${timer.getDuration().asMilliSeconds.toFixed(0)}ms`);
    this.log.info('Starting the session');

    await this.jwproxy.command('/session', 'POST', {
      capabilities: {
        firstMatch: [caps],
        alwaysMatch: {}
      }
    });
    await this.recordTargetAppPackage();
  }

  async recordTargetAppPackage () {
    await this.adb.shell([`echo "${this.appPackage}" > "${TARGET_PACKAGE_CONTAINER}"`]);
    this.log.info(`Recorded the target application package '${this.appPackage}' to ${TARGET_PACKAGE_CONTAINER}`);
  }

  async deleteSession () {
    this.log.debug('Deleting Espresso server session');
    // rely on jwproxy's intelligence to know what we're talking about and
    // delete the current session
    try {
      await this.jwproxy.command('/', 'DELETE');
    } catch (err) {
      this.log.warn(`Did not get confirmation Espresso deleteSession worked; ` +
          `Error was: ${err}`);
    }

    if (this.instProcess && this.instProcess.isRunning) {
      await this.instProcess.stop();
    }
  }
}

export { EspressoRunner, REQUIRED_PARAMS, TEST_APK_PKG };
export default EspressoRunner;
