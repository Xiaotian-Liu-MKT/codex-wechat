function extractBindPath(text) {
  return extractCommandArgument(text, "/codex bind ");
}

function extractUseTarget(text) {
  return extractCommandArgument(text, "/codex use ");
}

function parsePlanCommand(text) {
  const trimmed = String(text || "").trim();
  const normalized = trimmed.toLowerCase();

  if (normalized === "/codex plan") {
    return { action: "enter" };
  }
  if (normalized === "/codex plan status") {
    return { action: "status" };
  }
  if (normalized === "/codex plan show") {
    return { action: "show" };
  }
  if (normalized === "/codex execute") {
    return { action: "execute" };
  }
  if (normalized === "/codex exit plan" || normalized === "/codex mode default") {
    return { action: "exit" };
  }

  return { action: "" };
}

function extractSwitchThreadId(text) {
  return extractCommandArgument(text, "/codex switch ");
}

function extractRemoveWorkspacePath(text) {
  return extractCommandArgument(text, "/codex remove ");
}

function extractSendPath(text) {
  return extractCommandArgument(text, "/codex send ");
}

function extractModelValue(text) {
  return extractCommandArgument(text, "/codex model ");
}

function extractEffortValue(text) {
  return extractCommandArgument(text, "/codex effort ");
}

function parsePresetCommand(text) {
  const trimmed = String(text || "").trim();
  const normalized = trimmed.toLowerCase();
  if (normalized === "/codex preset" || normalized === "/codex preset list") {
    return { action: "list", name: "", workspaceRoot: "" };
  }

  if (normalized.startsWith("/codex preset add ")) {
    const remainder = trimmed.slice("/codex preset add ".length).trim();
    const [name, ...rest] = remainder.split(/\s+/);
    return {
      action: "add",
      name: String(name || "").trim(),
      workspaceRoot: rest.join(" ").trim(),
    };
  }

  if (normalized.startsWith("/codex preset remove ")) {
    return {
      action: "remove",
      name: trimmed.slice("/codex preset remove ".length).trim(),
      workspaceRoot: "",
    };
  }

  return { action: "", name: "", workspaceRoot: "" };
}

function extractCommandArgument(text, prefix) {
  const trimmed = String(text || "").trim();
  const normalizedPrefix = String(prefix || "").toLowerCase();
  if (trimmed.toLowerCase().startsWith(normalizedPrefix)) {
    return trimmed.slice(normalizedPrefix.length).trim();
  }
  return "";
}

module.exports = {
  extractBindPath,
  extractCommandArgument,
  extractEffortValue,
  extractModelValue,
  parsePlanCommand,
  extractUseTarget,
  extractRemoveWorkspacePath,
  extractSendPath,
  extractSwitchThreadId,
  parsePresetCommand,
};
