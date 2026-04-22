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

function resolveUndeliveredPath(config, accountId) {
  const runtimeDir = ensureRuntimeDir(config);
  return path.join(runtimeDir, `${normalizeAccountId(accountId)}.undelivered.json`);
}

function normalizeReplyChunks(replyChunks) {
  if (!Array.isArray(replyChunks)) {
    return [];
  }
  return replyChunks
    .map((entry) => String(entry || "").trim())
    .filter(Boolean);
}

function normalizeRecord(record) {
  if (!record || typeof record !== "object") {
    return null;
  }

  const senderId = String(record.senderId || "").trim();
  const threadId = String(record.threadId || "").trim();
  const turnId = String(record.turnId || "").trim();
  const replyChunks = normalizeReplyChunks(record.replyChunks);
  if (!senderId || !threadId || !turnId || !replyChunks.length) {
    return null;
  }

  return {
    senderId,
    threadId,
    turnId,
    workspaceRoot: String(record.workspaceRoot || "").trim(),
    runKey: String(record.runKey || "").trim(),
    label: String(record.label || "").trim(),
    reason: String(record.reason || "").trim(),
    replyChunks,
    attempts: Math.max(1, Number(record.attempts) || 1),
    createdAt: String(record.createdAt || "").trim() || new Date().toISOString(),
    updatedAt: String(record.updatedAt || "").trim() || new Date().toISOString(),
  };
}

function loadUndeliveredReplies(config, accountId) {
  try {
    const filePath = resolveUndeliveredPath(config, accountId);
    if (!fs.existsSync(filePath)) {
      return {};
    }

    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return {};
    }

    const normalized = {};
    for (const [senderId, record] of Object.entries(parsed)) {
      const normalizedRecord = normalizeRecord({
        ...record,
        senderId,
      });
      if (normalizedRecord) {
        normalized[normalizedRecord.senderId] = normalizedRecord;
      }
    }
    return normalized;
  } catch {
    return {};
  }
}

function saveUndeliveredReplies(config, accountId, records) {
  const normalized = {};
  for (const [senderId, record] of Object.entries(records || {})) {
    const normalizedRecord = normalizeRecord({
      ...record,
      senderId,
    });
    if (normalizedRecord) {
      normalized[normalizedRecord.senderId] = normalizedRecord;
    }
  }

  const filePath = resolveUndeliveredPath(config, accountId);
  fs.writeFileSync(filePath, JSON.stringify(normalized, null, 2), "utf8");
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // best effort
  }
  return normalized;
}

function persistUndeliveredReply(config, accountId, record) {
  const normalizedRecord = normalizeRecord(record);
  if (!normalizedRecord) {
    return loadUndeliveredReplies(config, accountId);
  }

  const existing = loadUndeliveredReplies(config, accountId);
  return saveUndeliveredReplies(config, accountId, {
    ...existing,
    [normalizedRecord.senderId]: normalizedRecord,
  });
}

function clearUndeliveredReply(config, accountId, senderId) {
  const normalizedSenderId = String(senderId || "").trim();
  if (!normalizedSenderId) {
    return loadUndeliveredReplies(config, accountId);
  }

  const existing = loadUndeliveredReplies(config, accountId);
  if (!(normalizedSenderId in existing)) {
    return existing;
  }

  delete existing[normalizedSenderId];
  return saveUndeliveredReplies(config, accountId, existing);
}

module.exports = {
  clearUndeliveredReply,
  loadUndeliveredReplies,
  persistUndeliveredReply,
  resolveUndeliveredPath,
};
