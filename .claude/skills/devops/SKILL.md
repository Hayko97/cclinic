---
name: devops
description: "Sets up a local environment suited to the project, and shows how to review each change, such as a link or a simulator build. Use when the user asks to set up, run or preview the project locally, or after implementing a change, so the user can try it before approving it."
metadata:
  generated-by: cclinic
  content-hash: "f7b6d43d4cecdeb26e54319e189812301885f3c8c6d8f7d66ba552c056a9d21a"
---

# Set up and use the local environment

Give the user a real way to try the project and each change. Report only what you actually saw happen.

## Rules

- **Don't commit or push.** Environment files follow the project's normal commit rules, so the user decides.
- **Don't install or start software on the user's computer,** such as Docker, simulators or SDKs. Say what's needed.
- **Don't edit the hosts file, or install certificates, DNS tools or a proxy.**
- **Don't read or copy `.env` files, private keys or other secret files, and don't connect to production services.** Use example configuration and local services. If a real value is needed, use a placeholder and tell the user what's missing.
- **Don't change the project's existing Docker files.** Put new files in `.cclinic/environment/`.
- **Don't stop anything you didn't start, or delete data volumes,** without asking.

## Set up the environment

Skip this if `.cclinic/environment/environment.json` already exists and still works.

1. **Identify what runs.** Read `.cclinic/sdd/stack.md` and `architecture.md` if they exist, plus the project's manifests. List each part that runs, and its type. If it's unclear, ask the user. If nobody can answer, stop and report what you found, without guessing.

   | Type | Signs | Preview |
   |---|---|---|
   | `web` | A web framework or HTTP server, including APIs | Docker Compose, and a link |
   | `ios` | An Xcode project or workspace | The app in the iOS Simulator |
   | `android` | A Gradle Android project | The app in the Android emulator |
   | `desktop` | A desktop framework, such as Electron or Tauri | The command that opens the app |
   | `cli` | A declared executable or command entry point | A command, and what it should print |
   | `library` | A package with no entry point of its own | The test command, or a short usage example |

   A cross-platform mobile app has one part per platform, and a monorepo has one part for each thing that runs.

2. **Choose the alias.** Use the manifest's name, or else the folder's name. Lowercase it, replace each run of other characters with one hyphen, remove leading and trailing hyphens, and limit it to 63 characters. If nothing is left, use `app`. So `@acme/Web_App` becomes `acme-web-app`. All parts share it.

3. **Set up each part,** following the section for its type.

4. **Write `.cclinic/environment/environment.json`,** in exactly this form, with no other keys. `stop` is required for anything left running. `url` and `fallbackUrl` are only for `web`, and are required there.

   ```json
   {
     "version": 1,
     "alias": "shop",
     "parts": [
       {
         "name": "web",
         "type": "web",
         "start": "docker compose -f .cclinic/environment/compose.yaml -p shop up --build --wait",
         "stop": "docker compose -f .cclinic/environment/compose.yaml -p shop down",
         "url": "http://shop.localhost:5173",
         "fallbackUrl": "http://localhost:5173",
         "review": "Open the link in a browser"
       }
     ]
   }
   ```

5. **Run each start command you recorded,** and report the real result. If a part fails to start, report its error, and don't describe it as working.

### Web projects

1. Check that Docker is installed and running. If not, tell the user what's needed. If the project has its own development command, use that for the preview, and say that Docker wasn't used.
2. If the project's Docker files can run it, use them unchanged, and report any port that isn't limited to this computer. Otherwise, write new ones in `.cclinic/environment/`.
3. New Compose files must:
   - publish ports on `127.0.0.1` only, such as `127.0.0.1:5173:5173`
   - give each web service a health check, so `--wait` means it's ready
   - not use privileged mode, mount the Docker socket, or mount anything outside the project folder
   - copy only the files the app needs into images, and never `.env` or other secret files
   - run any database or other service the project needs as a local container, with example values
4. Choose a free port, preferring the project's usual one. Don't stop other containers to free a port.
5. Start it with `-p <alias>` and `up --build --wait`. If containers from another folder are already running under that project name, tell the user first, because starting would replace them.
6. Request both `http://<alias>.localhost:<port>` and `http://localhost:<port>`, and check the responses. If the alias is refused, for example by a development server's host check, say why, and give the plain `localhost` link as the one to open.

### iOS and Android

Build the app and launch it on a simulator or emulator, without signing or a real device. Check the commands against the installed tools' own help. If a tool is missing, or the platform can't run it, such as iOS away from macOS, say what's needed.

### Desktop, command-line tools and libraries

Don't add Docker or a server. Run the project's own build, then record a command to try, and what it should do.

## After each implementation

Do this after the tests have run, and before asking the user to approve the implementation.

1. **If the change has nothing to run,** such as documentation or a comment, say that no preview is needed, and stop here.
2. **Set up the environment** if there's no valid environment file.
3. **Rebuild or restart,** so the preview includes this change. Then check it.
4. **Leave it running,** and tell the user:

   ```markdown
   **Review this change**
   - Open: http://shop.localhost:5173
   - If that doesn't open: http://localhost:5173
   - Look at: the checkout page, which now shows the currency symbol
   - Stop it: docker compose -f .cclinic/environment/compose.yaml -p shop down
   - Checked: yes, the page returned the new text
   ```

5. **If the preview can't start,** say why, report the test results anyway, and still ask for review. Never hide a failed preview, and never let it block the review.
