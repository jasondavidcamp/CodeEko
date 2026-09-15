# Getting started

With Git, Node.js 22 or newer (including npm), and VS Code already available, run this in a normal, non-administrator PowerShell terminal:

```powershell
git clone https://github.com/jasondavidcamp/EKOD.git
cd EKOD
.\scripts\Install-Ekod.ps1
```

The script installs locked build dependencies into the clone, builds a VSIX locally, installs it using the VS Code CLI, and verifies the installed version. It does not download a release VSIX, install global npm tools, or request elevation. Run it again after reviewing and pulling an update. Reload VS Code after installation, then configure EKOD Settings and use **EKOD: Set API Key**.

Options:

- `-BuildOnly`: build the local VSIX without installing it.
- `-RunTests`: run the automated suite before packaging. Windows PowerShell validation checks may report missing optional modules.
- `-CodeCommand 'C:\path\to\VS Code\bin\code.cmd'`: select a VS Code installation when its CLI is not on PATH. The standard per-user location is detected automatically.

Use a writable clone directory. Prerequisites must be supplied through your approved software process; approved portable tools on PATH can also work. npm needs access to the dependencies in `package-lock.json` through an accessible registry or a populated cache. Existing npm registry, proxy and certificate configuration is honored; the script does not change TLS trust or download Node.js. Cloning alone does not provide npm dependencies. See [npm ci](https://docs.npmjs.com/cli/commands/npm-ci/) for dependency configuration.

PowerShell script execution and locally built extension installation must be permitted by workstation policy. If scripts require signing, have the script signed through the approved process. No execution-policy bypass is used. If running scripts is unavailable but the individual commands are permitted, the equivalent commands are:

```powershell
npm.cmd ci --include=dev --no-audit --no-fund
npm.cmd run package
code.cmd --install-extension .\ekod.vsix --force
```

VS Code installs extensions for the current user; no administrator installation is requested. See the [VS Code CLI documentation](https://code.visualstudio.com/docs/configure/command-line). A policy that blocks extension installation itself still applies to locally built packages.

## Connect

1. Reload VS Code and open a trusted Git repository.
2. Open **EKOD Settings** using the gear in the chat pane. Set `ekod.endpoint` to your HTTPS API base URL. There is no default endpoint.
3. Run **EKOD: Set API Key**. Keys are stored in VS Code SecretStorage for that endpoint.
4. Choose a model from the chat composer. Discovery uses `/v1/models`; you can enter a model ID if discovery is unavailable.
5. Ask a question or request a code change. Review changes in VS Code Source Control.

The initial target is Windows PowerShell 5.1 repositories and VS Code 1.106 or newer. An origin/base endpoint gets `/v1` appended; explicit version paths are preserved.

### Upgrading to 0.4.42

Version 0.4.42 uses only EKOD identifiers. Configure your endpoint, model and preferences in EKOD Settings after upgrading from an earlier version. Chats and diagnostics are stored in EKOD’s private extension storage. Back up your existing extension data before upgrading; data in other extension storage folders is not loaded automatically. API keys remain in VS Code SecretStorage.


## Next steps

See [usage and troubleshooting](USAGE.md) for permissions, chat controls and diagnostics, or [development](DEVELOPMENT.md) for tests and packaging.
