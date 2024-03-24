// Copyright(c) ZenML GmbH 2024. All Rights Reserved.
// Licensed under the Apache License, Version 2.0(the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at:
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express
// or implied.See the License for the specific language governing
// permissions and limitations under the License.
import * as fs from 'fs-extra';
import * as path from 'path';
import * as vscode from 'vscode';

import { registerPipelineCommands } from '../commands/pipelines/registry';
import { registerServerCommands } from '../commands/server/registry';
import { registerStackCommands } from '../commands/stack/registry';
import { EXTENSION_ROOT_DIR } from '../common/constants';
import { registerLogger, traceLog, traceVerbose } from '../common/log/logging';
import {
  IInterpreterDetails,
  getInterpreterDetails,
  initializePython,
  onDidChangePythonInterpreter,
} from '../common/python';
import { runServer } from '../common/server';
import {
  checkIfConfigurationChanged,
  updateWorkspaceInterpreterSettings,
} from '../common/settings';
import { registerLanguageStatusItem } from '../common/status';
import { getLSClientTraceLevel } from '../common/utilities';
import {
  createOutputChannel,
  onDidChangeConfiguration,
  registerCommand,
} from '../common/vscodeapi';
import { updateDefaultPythonInterpreterPath } from '../utils/global';
import { refreshUIComponents } from '../utils/refresh';
import { PipelineDataProvider, ServerDataProvider, StackDataProvider } from '../views/activityBar';
import ZenMLStatusBar from '../views/statusBar';
import { LSClient } from './LSClient';
import { EnvironmentDataProvider } from '../views/activityBar/environmentView/EnvironmentDataProvider';

export interface IServerInfo {
  name: string;
  module: string;
}

export class ZenExtension {
  private static context: vscode.ExtensionContext;
  static commandDisposables: vscode.Disposable[] = [];
  static viewDisposables: vscode.Disposable[] = [];
  private static lsClient: LSClient;
  private static outputChannel: vscode.LogOutputChannel;
  private static serverId: string;
  private static serverName: string;
  private static viewsAndCommandsSetup = false;

  private static dataProviders = new Map<string, vscode.TreeDataProvider<vscode.TreeItem>>([
    ['zenmlServerView', ServerDataProvider.getInstance()],
    ['zenmlStackView', StackDataProvider.getInstance()],
    ['zenmlPipelineView', PipelineDataProvider.getInstance()],
    ['zenmlEnvironmentView', EnvironmentDataProvider.getInstance()]
  ]);

  private static registries = [
    registerServerCommands,
    registerStackCommands,
    registerPipelineCommands,
  ];

  /**
   * Initializes the extension services and saves the context for reuse.
   *
   * @param context The extension context provided by VS Code on activation.
   */
  static async activate(context: vscode.ExtensionContext, lsClient: LSClient): Promise<void> {
    this.context = context;
    this.lsClient = lsClient;
    const serverDefaults = this.loadServerDefaults();
    this.serverName = serverDefaults.name;
    this.serverId = serverDefaults.module;

    this.setupLoggingAndTrace();
    this.subscribeToCoreEvents();
    this.deferredInitialize();
  }

  /**
   * Deferred initialization tasks to be run after initializing other tasks.
   */
  static deferredInitialize(): void {
    setImmediate(async () => {
      const interpreterDetails = await getInterpreterDetails();
      if (interpreterDetails.path) {
        await this.updateGlobalSettings(interpreterDetails.path[0]);
      } else {
        // If no interpreter details are found, listen for changes from the Python extension
        traceLog(`Setting up Python extension listener.`);
        await initializePython(this.context.subscriptions);
      }
      // Start the server with the current or updated interpreter settings
      await runServer(this.serverId, this.serverName, this.outputChannel, this.lsClient);
      // Set up views and commands / Check ZenML installation
    });
  }

  /**
   * Updates the global settings for the ZenML extension.
   *
   * @param pythonPath The new Python interpreter path.
   */
  static async updateGlobalSettings(pythonPath: string): Promise<void> {
    await updateDefaultPythonInterpreterPath(pythonPath);
    await updateWorkspaceInterpreterSettings(pythonPath);
  }

  /**
   * Sets up the views and commands for the ZenML extension.
   */
  static async setupViewsAndCommands(): Promise<void> {
    if (this.viewsAndCommandsSetup) {
      console.log('Views and commands have already been set up. Refreshing views...');
      await refreshUIComponents();
      return;
    }

    ZenMLStatusBar.getInstance();
    this.dataProviders.forEach((provider, viewId) => {
      const view = vscode.window.createTreeView(viewId, { treeDataProvider: provider });
      this.viewDisposables.push(view);
    });
    this.registries.forEach(register => register(this.context));
    await refreshUIComponents();
    this.viewsAndCommandsSetup = true;
  }

  /**
   * Registers command and configuration event handlers to the extension context.
   */
  private static subscribeToCoreEvents(): void {
    this.context.subscriptions.push(
      onDidChangePythonInterpreter(async (interpreterDetails: IInterpreterDetails) => {
        if (interpreterDetails.path) {
          console.log('Interpreter changed, restarting LSP server...');
          await this.updateGlobalSettings(interpreterDetails.path[0]);
          await runServer(this.serverId, this.serverName, this.outputChannel, this.lsClient);
        }
      }),
      registerCommand(`${this.serverId}.showLogs`, async () => {
        this.outputChannel.show();
      }),
      onDidChangeConfiguration(async (e: vscode.ConfigurationChangeEvent) => {
        if (checkIfConfigurationChanged(e, this.serverId)) {
          console.log('Configuration changed, restarting LSP server...', e);
          await runServer(this.serverId, this.serverName, this.outputChannel, this.lsClient);
        }
      }),
      registerCommand(`${this.serverId}.restart`, async () => {
        await runServer(this.serverId, this.serverName, this.outputChannel, this.lsClient);
      }),
      registerCommand(`zenml.promptForInterpreter`, async () => {
        if (!this.lsClient.interpreterSelectionInProgress && !this.lsClient.isZenMLReady) {
          await this.promptForPythonInterpreter();
        }
      }),
      registerLanguageStatusItem(this.serverId, this.serverName, `${this.serverId}.showLogs`)
    );
  }

  /**
   * Prompts the user to select a Python interpreter.
   *
   * @returns {Promise<void>} A promise that resolves to void.
   */
  static async promptForPythonInterpreter(): Promise<void> {
    if (this.lsClient.isZenMLReady) {
      console.log('ZenML is already installed, no need to prompt for interpreter.');
      return;
    }
    this.lsClient.interpreterSelectionInProgress = true;
    let userCancelled = false;
    try {
      const selected = await vscode.window.showInformationMessage(
        'ZenML not found with the current Python interpreter. Would you like to select a different interpreter?',
        'Select Interpreter',
        'Cancel'
      );
      if (selected === 'Select Interpreter') {
        await vscode.commands.executeCommand('python.setInterpreter');
        console.log('Interpreter selection completed.');
        await vscode.commands.executeCommand(`${this.serverId}.restart`);
      } else {
        userCancelled = true;
        console.log('Interpreter selection cancelled.');
      }
    } finally {
      this.lsClient.interpreterSelectionInProgress = false;
      if (!this.lsClient.isZenMLReady && !userCancelled) {
        console.log('ZenML is still not installed. Prompting again...');
        // await this.promptForPythonInterpreter();
      } else if (this.lsClient.isZenMLReady) {
        vscode.window.showInformationMessage('🚀 ZenML installation found. Ready to use.');
      } else {
        vscode.window.showInformationMessage(
          'Interpreter selection cancelled. ZenML features will be disabled.'
        );
      }
    }
  }

  /**
   * Initializes the outputChannel and logging for the ZenML extension.
   */
  private static setupLoggingAndTrace(): void {
    this.outputChannel = createOutputChannel(this.serverName);

    this.context.subscriptions.push(this.outputChannel, registerLogger(this.outputChannel));
    const changeLogLevel = async (c: vscode.LogLevel, g: vscode.LogLevel) => {
      const level = getLSClientTraceLevel(c, g);
      const lsClient = LSClient.getInstance().getLanguageClient();
      await lsClient?.setTrace(level);
    };

    this.context.subscriptions.push(
      this.outputChannel.onDidChangeLogLevel(
        async e => await changeLogLevel(e, vscode.env.logLevel)
      ),
      vscode.env.onDidChangeLogLevel(
        async e => await changeLogLevel(this.outputChannel.logLevel, e)
      )
    );

    traceLog(`Name: ${this.serverName}`);
    traceLog(`Module: ${this.serverId}`);
    traceVerbose(
      `Full Server Info: ${JSON.stringify({ name: this.serverName, module: this.serverId })}`
    );
  }

  /**
   * Loads the server defaults from the package.json file.
   *
   * @returns {IServerInfo} The server defaults.
   */
  private static loadServerDefaults(): IServerInfo {
    const packageJson = path.join(EXTENSION_ROOT_DIR, 'package.json');
    const content = fs.readFileSync(packageJson).toString();
    const config = JSON.parse(content);
    return config.serverInfo as IServerInfo;
  }

  /**
   * Deactivates ZenML features when requirements not met.
   *
   * @returns {Promise<void>} A promise that resolves to void.
   */
  static async deactivateFeatures(): Promise<void> {
    this.commandDisposables.forEach(disposable => disposable.dispose());
    this.commandDisposables = [];

    this.viewDisposables.forEach(disposable => disposable.dispose());
    this.viewDisposables = [];
    console.log('Features deactivated due to unmet requirements.');
  }
}
