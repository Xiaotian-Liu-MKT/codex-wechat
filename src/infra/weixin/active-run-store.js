const fs = require("fs");
const path = require("path");

function normalizeAccountId(raw) {
  return String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function ensureRuntimeDir(config) {
  const runtimeDir = config.activeRunsDir || path.join(config.stateDir, "runtime");
  fs.mkdirSync(runtimeDir, { recursive: true });
  return runtimeDir;
}

function resolveActiveRunsPath(config, accountId) {
  const runtimeDir = ensureRuntimeDir(config);
  return path.join(runtimeDir, `${normalizeAccountId(accountId)}.active-runs.json`);
}

function normalizeRecord(record) {
  if (!record || typeof record !== "object") {
    return null;
  }

  const threadId = String(record.threadId || "").trim();
  const senderId = String(record.senderId || "").trim();
  const contextToken = String(record.contextToken || "").trim();
  const runKey = String(record.runKey || "").trim();
  if (!threadId || !senderId || !contextToken || !runKey) {
    return null;
  }

  return {
    threadId,
    runKey,
    senderId,
    contextToken,
    workspaceRoot: String(record.workspaceRoot || "").trim(),
    bindingKey: String(record.bindingKey || "").trim(),
    startedAt: String(record.startedAt || "").trim() || new Date().toISOString(),
    updatedAt: String(record.updatedAt || "").trim() || new Date().toISOString(),
  };
}

function loadActiveRuns(config, accountId) {
  try {
    const filePath = resolveActiveRunsPath(config, accountId);
    if (!fs.existsSync(filePath)) {
      return {};
    }

    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return {};
    }

    const normalized = {};
    for (const [threadId, record] of Object.entries(parsed)) {
      const normalizedRecord = normalizeRecord({
        ...record,
        threadId,
      });
      if (normalizedRecord) {
        normalized[normalizedRecord.threadId] = normalizedRecord;
      }
    }
    return normalized;
  } catch {
    return {};
  }
}

function saveActiveRuns(config, accountId, records) {
  const normalized = {};
  for (const [threadId, record] of Object.entries(records || {})) {
    const normalizedRecord = normalizeRecord({
      ...record,
      threadId,
    });
    if (normalizedRecord) {
      normalized[normalizedRecord.threadId] = normalizedRecord;
    }
  }

  const filePath = resolveActiveRunsPath(config, accountId);
  fs.writeFileSync(filePath, JSON.stringify(normalized, null, 2), "utf8");
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // best effort
  }
  return normalized;
}

function persistActiveRun(config, accountId, record) {
  const normalizedRecord = normalizeRecord(record);
  if (!normalizedRecord) {
    return loadActiveRuns(config, accountId);
  }

  const existing = loadActiveRuns(config, accountId);
  return saveActiveRuns(config, accountId, {
    ...existing,
    [normalizedRecord.threadId]: normalizedRecord,
  });
}

function clearActiveRun(config, accountId, threadId) {
  const normalizedThreadId = String(threadId || "").trim();
  if (!normalizedThreadId) {
    return loadActiveRuns(config, accountId);
  }

  const existing = loadActiveRuns(config, accountId);
  if (!(normalizedThreadId in existing)) {
    return existing;
  }

  delete existing[normalizedThreadId];
  return saveActiveRuns(config, accountId, existing);
}

function clearAllActiveRuns(config, accountId) {
  return saveActiveRuns(config, accountId, {});
}

module.exports = {
  clearActiveRun,
  clearAllActiveRuns,
  loadActiveRuns,
  persistActiveRun,
  resolveActiveRunsPath,
};
