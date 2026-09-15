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

Use a writable clone directory. Prerequisites must be supplied through your approved software process; approved portable tools on PATH can also work. npm needs access to the dependencies in `package-lock.json` from the public npm registry at `https://registry.npmjs.org/` or a populated cache. The installer explicitly selects that registry for this command without changing your saved npm configuration. Existing proxy and certificate configuration is honored; the script does not change TLS trust or download Node.js. Cloning alone does not provide npm dependencies. See [npm ci](https://docs.npmjs.com/cli/commands/npm-ci/) for dependency configuration.

PowerShell script execution and locally built extension installation must be permitted by workstation policy. If scripts require signing, have the script signed through the approved process. No execution-policy bypass is used. If running scripts is unavailable but the individual commands are permitted, the equivalent commands are:

```powershell
npm.cmd ci --include=dev --no-audit --no-fund --registry=https://registry.npmjs.org/
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

## Endpoint compatibility

If an endpoint ignores system instructions or returns empty responses, open **EKOD Settings → Connection → Endpoint compatibility** and select **User message**. This sends instructions and conversation context in one user message and omits the JSON-mode request parameter. Standard remains the default. Both modes require valid action JSON and enforce the same permissions. Start a new chat and try a greeting, then a read-only question.

## Updating EKOD

From your existing clone, pull the latest code and rerun the installer:

```powershell
git pull --ff-only
.\scripts\Install-Ekod.ps1
```

Reload VS Code after installation. Check the [changelog](../CHANGELOG.md) for any migration steps before updating.

## Next steps

See [usage and troubleshooting](USAGE.md) for permissions, chat controls and diagnostics, or [development](DEVELOPMENT.md) for tests and packaging.
