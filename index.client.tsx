import type { PluginClientContext } from "@getpaseo/plugin/client";
import { provisionStart } from "./shared/contracts";
import { NewProjectForm } from "./client/new-project-form";
import { ProvisionStatusScreen } from "./client/provision-status";
import { SettingsScreen } from "./client/settings-screen";
import { setOpenScreenHandler } from "./client/nav";

export default function contribute(client: PluginClientContext) {
  setOpenScreenHandler((input) => client.openScreen(input));

  client.addScreen({
    id: "pnp-new-project",
    title: "New project",
    Component: NewProjectForm,
  });

  client.addScreen({
    id: "pnp-status",
    title: (params) =>
      typeof params.name === "string" && params.name ? `Provision: ${params.name}` : "Provision status",
    Component: ProvisionStatusScreen,
  });

  client.addSettingsScreen({
    id: "pnp-settings",
    title: "New project",
    icon: "FolderPlus",
    Component: SettingsScreen,
  });

  client.addCommandCenterItem({
    id: "pnp-new-project",
    title: "New project: provision a project",
    icon: "FolderPlus",
    keywords: ["provision", "project", "orchestrator"],
    context: "global",
    onSelect({ openScreen }) {
      openScreen({ screenId: "pnp-new-project" });
    },
  });

  client.addCommandCenterItem({
    id: "pnp-status",
    title: "New project: provision status",
    icon: "Activity",
    keywords: ["provision", "status", "job"],
    context: "global",
    onSelect({ openScreen }) {
      openScreen({ screenId: "pnp-status" });
    },
  });

  client.addSlashCommand({
    name: "new-project",
    description: "Provision a new project (name, optional goal)",
    argumentHint: "name [goal]",
    context: "workspace",
    async onSubmit({ args, rpc, openScreen }) {
      const trimmed = args.trim();
      const [name] = trimmed.split(/\s+/);
      if (!name) {
        openScreen({ screenId: "pnp-new-project" });
        return;
      }
      // Keep the goal's internal whitespace (including newlines) intact.
      const goalText = trimmed.slice(name.length).trim();
      const result = await rpc(provisionStart, goalText ? { name, goal: goalText } : { name });
      openScreen(
        result.existed
          ? { screenId: "pnp-status", params: { name, notice: "existed" } }
          : { screenId: "pnp-status", params: { name } },
      );
    },
  });

  return () => {};
}
