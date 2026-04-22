const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const { SessionStore } = require("../infra/storage/session-store");
const { CodexRpcClient } = require("../infra/codex/rpc-client");
const codexMessageUtils = require("../infra/codex/message-utils");
const { getUpdates, sendMessage, getConfig, sendTyping } = require("../infra/weixin/api");
const { persistIncomingWeixinAttachments } = require("../infra/weixin/media-receive");
const { getMimeFromFilename } = require("../infra/weixin/media-mime");
const { sendWeixinMediaFile } = require("../infra/weixin/media-send");
const { resolveSelectedAccount } = require("../infra/weixin/account-store");
const {
  loadPersistedContextTokens,
  persistContextToken,
} = require("../infra/weixin/context-token-store");
const {
  clearActiveRun,
  clearAllActiveRuns,
  loadActiveRuns,
  persistActiveRun,
} = require("../infra/weixin/active-run-store");
const {
  clearUndeliveredReply,
  loadUndeliveredReplies,
  persistUndeliveredReply,
} = require("../infra/weixin/undelivered-store");
const { loadSyncBuffer, saveSyncBuffer } = require("../infra/weixin/sync-buffer-store");
const {
  chunkReplyText,
  markdownToPlainText,
  normalizeWeixinIncomingMessage,
} = require("../infra/weixin/message-utils");
const {
  extractBindPath,
  extractEffortValue,
  extractModelValue,
  extractRemoveWorkspacePath,
  extractSendPath,
  extractSwitchThreadId,
  extractUseTarget,
  parsePlanCommand,
  parsePresetCommand,
} = require("../shared/command-parsing");
const {
  filterThreadsByWorkspaceRoot,
  isAbsoluteWorkspacePath,
  isWorkspaceAllowed,
  normalizeWorkspacePath,
  pathMatchesWorkspaceRoot,
} = require("../shared/workspace-paths");
const {
  extractModelCatalogFromListResponse,
  findModelByQuery,
  resolveEffectiveModelForEffort,
} = require("../shared/model-catalog");
const { formatFailureText } = require("../shared/error-text");
const {
  buildPlanSummaryText,
  formatPlanCompletionReply,
  formatPromptDeliveryReply,
  formatTaskCompletionReply,
  formatTaskFailureReply,
  shouldUsePromptDelivery,
} = require("../shared/wechat-reply-format");

const SESSION_EXPIRED_ERRCODE = -14;
const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
const RETRY_DELAY_MS = 2_000;
const BACKOFF_DELAY_MS = 30_000;
const MAX_CONSECUTIVE_FAILURES = 3;
const TYPING_KEEPALIVE_MS = 5_000;
const CHUNK_SEND_DELAY_MS = 350;
const LONG_TASK_NOTICE_DELAY_MS = 60_000;
const PERIODIC_PROGRESS_NOTICE_INTERVAL_MS = 180_000;
const COMPLETION_REPLY_MAX_RETRIES = 3;
const PLAN_FILE_DIR = ".codex-wechat/plans";
const APPROVAL_METHOD_MAX_CHARS = 80;
const APPROVAL_PERMISSION_MAX_CHARS = 80;
const APPROVAL_REASON_MAX_CHARS = 280;
const APPROVAL_COMMAND_MAX_CHARS = 500;
const APPROVAL_PREFIX_RULE_MAX_CHARS = 220;
const THREAD_SOURCE_KINDS = new Set([
  "app",
  "cli",
  "vscode",
  "exec",
  "appServer",
  "subAgent",
  "subAgentReview",
  "subAgentCompact",
  "subAgentThreadSpawn",
  "subAgentOther",
  "unknown",
]);

class WechatRuntime {
  constructor(config) {
    this.config = config;
    this.sessionStore = new SessionStore({ filePath: config.sessionsFile });
    this.account = null;
    this.codex = new CodexRpcClient({
      endpoint: config.codexEndpoint,
      env: process.env,
      codexCommand: config.codexCommand,
    });
    this.contextTokenByUserId = new Map();
    this.pendingChatContextByThreadId = new Map();
    this.activeTurnIdByThreadId = new Map();
    this.pendingApprovalByThreadId = new Map();
    this.currentRunKeyByThreadId = new Map();
    this.replyBufferByRunKey = new Map();
    this.planStateByRunKey = new Map();
    this.planDeltaBufferByRunKey = new Map();
    this.progressNoticeByRunKey = new Map();
    this.runStartTimeByRunKey = new Map();
    this.typingStopByThreadId = new Map();
    this.bindingKeyByThreadId = new Map();
    this.workspaceRootByThreadId = new Map();
    this.approvalAllowlistByWorkspaceRoot = new Map();
    this.resumedThreadIds = new Set();
    this.inFlightApprovalRequestKeys = new Set();
    this.shutdownStarted = false;
    this.deliveryRetryableContextErrorPattern = /ret=-2\b/i;
    this.codex.onMessage((message) => {
      this.handleCodexMessage(message).catch((error) => {
        console.error(`[codex-wechat] failed to handle Codex message: ${error.message}`);
      });
    });
  }

  async start() {
    this.account = resolveSelectedAccount(this.config);
    this.validateConfig();
    this.restorePersistedContextTokens();
    await this.recoverInterruptedRuns();
    await this.codex.connect();
    await this.codex.initialize();
    await this.refreshAvailableModelCatalogAtStartup();
    console.log(`[codex-wechat] runtime ready account=${this.account.accountId} userId=${this.account.userId || "(unknown)"}`);
    await this.monitorLoop();
  }

  validateConfig() {
    if (!this.account || !this.account.token) {
      throw new Error("缺少已登录的微信账号，请先执行 `codex-wechat login`");
    }
    const defaultWorkspaceRoot = normalizeWorkspacePath(this.config.defaultWorkspaceRoot);
    if (defaultWorkspaceRoot) {
      if (!isAbsoluteWorkspacePath(defaultWorkspaceRoot)) {
        throw new Error("CODEX_WECHAT_DEFAULT_WORKSPACE 必须是绝对路径");
      }
      if (!isWorkspaceAllowed(defaultWorkspaceRoot, this.config.workspaceAllowlist)) {
        throw new Error("CODEX_WECHAT_DEFAULT_WORKSPACE 不在允许绑定的白名单中");
      }
    }
  }

  restorePersistedContextTokens() {
    const persistedTokens = loadPersistedContextTokens(this.config, this.account.accountId);
    let restoredCount = 0;
    for (const [userId, token] of Object.entries(persistedTokens)) {
      this.contextTokenByUserId.set(userId, token);
      restoredCount += 1;
    }
    if (restoredCount > 0) {
      console.log(`[codex-wechat] restored ${restoredCount} persisted context token(s)`);
    }
  }

  async recoverInterruptedRuns() {
    if (!this.account?.accountId) {
      return;
    }

    const activeRuns = loadActiveRuns(this.config, this.account.accountId);
    const interruptedRuns = Object.values(activeRuns);
    if (!interruptedRuns.length) {
      return;
    }

    console.log(`[codex-wechat] recovering ${interruptedRuns.length} interrupted run(s)`);
    const notifiedKeys = new Set();
    for (const run of interruptedRuns) {
      const notificationKey = `${run.senderId}:${run.contextToken}`;
      if (notifiedKeys.has(notificationKey)) {
        continue;
      }
      notifiedKeys.add(notificationKey);
      try {
        await this.sendReplyToUser(
          run.senderId,
          "本地 codex-wechat 服务在上一轮运行期间异常中断，上一条任务结果未送达。请直接重发上一条消息。",
          run.contextToken
        );
      } catch (error) {
        console.error(
          `[codex-wechat] failed to recover interrupted run notice to=${run.senderId}: ${error.message}`
        );
      }
    }

    clearAllActiveRuns(this.config, this.account.accountId);
  }

  rememberContextToken(userId, contextToken) {
    const normalizedUserId = typeof userId === "string" ? userId.trim() : "";
    const normalizedToken = typeof contextToken === "string" ? contextToken.trim() : "";
    if (!normalizedUserId || !normalizedToken || !this.account?.accountId) {
      return;
    }

    this.contextTokenByUserId.set(normalizedUserId, normalizedToken);
    persistContextToken(this.config, this.account.accountId, normalizedUserId, normalizedToken);
  }

  getLatestContextTokenForUser(userId) {
    const normalizedUserId = String(userId || "").trim();
    if (!normalizedUserId) {
      return "";
    }
    return String(this.contextTokenByUserId.get(normalizedUserId) || "").trim();
  }

  async refreshAvailableModelCatalogAtStartup() {
    const response = await this.codex.listModels();
    const models = extractModelCatalogFromListResponse(response);
    if (!models.length) {
      console.warn("[codex-wechat] model/list returned no models at startup");
      return;
    }
    this.sessionStore.setAvailableModelCatalog(models);
    this.validateDefaultModelConfig(models);
    console.log(`[codex-wechat] model catalog refreshed: ${models.length} entries`);
  }

  validateDefaultModelConfig(models) {
    if (this.config.defaultCodexModel) {
      const matched = findModelByQuery(models, this.config.defaultCodexModel);
      if (!matched) {
        throw new Error(`Invalid CODEX_WECHAT_DEFAULT_CODEX_MODEL: ${this.config.defaultCodexModel}`);
      }
      if (this.config.defaultCodexEffort) {
        const supported = matched.supportedReasoningEfforts || [];
        if (supported.length && !supported.includes(this.config.defaultCodexEffort)) {
          throw new Error(
            `Invalid CODEX_WECHAT_DEFAULT_CODEX_EFFORT: ${this.config.defaultCodexEffort} for model ${matched.model}`
          );
        }
      }
      return;
    }

    if (this.config.defaultCodexEffort) {
      const effectiveModel = resolveEffectiveModelForEffort(models, "");
      const supported = effectiveModel?.supportedReasoningEfforts || [];
      if (effectiveModel && supported.length && !supported.includes(this.config.defaultCodexEffort)) {
        throw new Error(
          `Invalid CODEX_WECHAT_DEFAULT_CODEX_EFFORT: ${this.config.defaultCodexEffort} for model ${effectiveModel.model}`
        );
      }
    }
  }

  async monitorLoop() {
    let getUpdatesBuf = loadSyncBuffer(this.config, this.account.accountId);
    let nextTimeoutMs = DEFAULT_LONG_POLL_TIMEOUT_MS;
    let consecutiveFailures = 0;

    while (true) {
      try {
        const response = await getUpdates({
          baseUrl: this.account.baseUrl,
          token: this.account.token,
          get_updates_buf: getUpdatesBuf,
          timeoutMs: nextTimeoutMs,
        });

        if (response.longpolling_timeout_ms && response.longpolling_timeout_ms > 0) {
          nextTimeoutMs = response.longpolling_timeout_ms;
        }

        const isApiError =
          (response.ret !== undefined && response.ret !== 0)
          || (response.errcode !== undefined && response.errcode !== 0);
        if (isApiError) {
          if (response.errcode === SESSION_EXPIRED_ERRCODE || response.ret === SESSION_EXPIRED_ERRCODE) {
            throw new Error("微信会话已失效，请重新执行 `codex-wechat login`");
          }
          consecutiveFailures += 1;
          console.error(`[codex-wechat] getUpdates failed ret=${response.ret} errcode=${response.errcode} errmsg=${response.errmsg || ""}`);
          if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            consecutiveFailures = 0;
            await sleep(BACKOFF_DELAY_MS);
          } else {
            await sleep(RETRY_DELAY_MS);
          }
          continue;
        }

        consecutiveFailures = 0;
        if (typeof response.get_updates_buf === "string" && response.get_updates_buf) {
          getUpdatesBuf = response.get_updates_buf;
          saveSyncBuffer(this.config, this.account.accountId, getUpdatesBuf);
        }

        const messages = Array.isArray(response.msgs) ? response.msgs : [];
        for (const message of messages) {
          await this.handleIncomingMessage(message);
        }
      } catch (error) {
        consecutiveFailures += 1;
        console.error(`[codex-wechat] monitor error (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}): ${error.message}`);
        if (String(error.message || "").includes("重新执行 `codex-wechat login`")) {
          throw error;
        }
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          consecutiveFailures = 0;
          await sleep(BACKOFF_DELAY_MS);
        } else {
          await sleep(RETRY_DELAY_MS);
        }
      }
    }
  }

  async handleIncomingMessage(message) {
    const senderId = typeof message?.from_user_id === "string" ? message.from_user_id.trim() : "";
    const contextToken = typeof message?.context_token === "string" ? message.context_token.trim() : "";
    if (senderId && contextToken) {
      this.rememberContextToken(senderId, contextToken);
    }

    const normalized = normalizeWeixinIncomingMessage(message, this.config, this.account.accountId);
    if (!normalized) {
      return;
    }

    if (!this.isUserAllowed(normalized.senderId)) {
      await this.sendReplyToUser(normalized.senderId, "当前账号未允许该微信号控制本机 Codex。", normalized.contextToken);
      return;
    }

    try {
      await this.flushUndeliveredRepliesForUser(normalized.senderId, normalized.contextToken);

      if (await this.dispatchTextCommand(normalized)) {
        return;
      }

      const workspaceContext = await this.resolveWorkspaceContext(normalized);
      if (!workspaceContext) {
        return;
      }

      const { bindingKey, workspaceRoot } = workspaceContext;
      const preparedNormalized = await this.prepareIncomingMessageForCodex(normalized, workspaceRoot);
      if (!preparedNormalized) {
        return;
      }

      const { threadId } = await this.resolveWorkspaceThreadState({
        bindingKey,
        workspaceRoot,
        normalized: preparedNormalized,
        autoSelectThread: true,
      });

      if (threadId) {
        this.pendingChatContextByThreadId.set(threadId, preparedNormalized);
      }
      const resolvedThreadId = await this.ensureThreadAndSendMessage({
        bindingKey,
        workspaceRoot,
        normalized: preparedNormalized,
        threadId,
      });
      this.pendingChatContextByThreadId.set(resolvedThreadId, preparedNormalized);
      this.bindingKeyByThreadId.set(resolvedThreadId, bindingKey);
      this.workspaceRootByThreadId.set(resolvedThreadId, workspaceRoot);
      await this.startTypingForThread(resolvedThreadId, preparedNormalized);
    } catch (error) {
      await this.sendReplyToUser(
        normalized.senderId,
        formatFailureText("处理失败", error),
        normalized.contextToken
      );
      throw error;
    }
  }

  isUserAllowed(senderId) {
    if (!Array.isArray(this.config.allowedUserIds) || !this.config.allowedUserIds.length) {
      return true;
    }
    return this.config.allowedUserIds.includes(senderId);
  }

  async dispatchTextCommand(normalized) {
    switch (normalized.command) {
      case "bind":
        await this.handleBindCommand(normalized);
        return true;
      case "where":
        await this.handleWhereCommand(normalized);
        return true;
      case "workspace":
        await this.handleWorkspaceCommand(normalized);
        return true;
      case "preset":
        await this.handlePresetCommand(normalized);
        return true;
      case "plan":
        await this.handlePlanCommand(normalized);
        return true;
      case "execute":
        await this.handleExecuteCommand(normalized);
        return true;
      case "exit_plan":
        await this.handleExitPlanCommand(normalized);
        return true;
      case "new":
        await this.handleNewCommand(normalized);
        return true;
      case "use":
        await this.handleUseCommand(normalized);
        return true;
      case "switch":
        await this.handleSwitchCommand(normalized);
        return true;
      case "inspect_message":
        await this.handleMessageCommand(normalized);
        return true;
      case "stop":
        await this.handleStopCommand(normalized);
        return true;
      case "model":
        await this.handleModelCommand(normalized);
        return true;
      case "effort":
        await this.handleEffortCommand(normalized);
        return true;
      case "approve":
      case "reject":
        await this.handleApprovalCommand(normalized);
        return true;
      case "remove":
        await this.handleRemoveCommand(normalized);
        return true;
      case "send":
        await this.handleSendCommand(normalized);
        return true;
      case "help":
        await this.handleHelpCommand(normalized);
        return true;
      case "unknown_command":
        await this.sendReplyToNormalized(normalized, `未知命令。\n\n${this.buildHelpText()}`);
        return true;
      default:
        return false;
    }
  }

  async handleBindCommand(normalized) {
    const rawWorkspaceRoot = extractBindPath(normalized.text);
    if (!rawWorkspaceRoot) {
      await this.sendReplyToNormalized(normalized, "用法: `/codex bind /绝对路径`");
      return;
    }

    await this.bindWorkspaceRoot(normalized, rawWorkspaceRoot);
  }

  async handlePresetCommand(normalized) {
    const bindingKey = this.sessionStore.buildBindingKey(normalized);
    const parsed = parsePresetCommand(normalized.text);
    if (!parsed.action) {
      await this.sendReplyToNormalized(
        normalized,
        "用法:\n/codex preset list\n/codex preset add <别名> <绝对路径>\n/codex preset remove <别名>"
      );
      return;
    }

    if (parsed.action === "list") {
      const presets = this.sessionStore.listWorkspacePresets(bindingKey);
      if (!presets.length) {
        await this.sendReplyToNormalized(normalized, "当前还没有常用目录预设。");
        return;
      }
      const activeWorkspaceRoot = this.sessionStore.getActiveWorkspaceRoot(bindingKey);
      const lines = ["常用目录："];
      for (let index = 0; index < presets.length; index += 1) {
        const preset = presets[index];
        const prefix = preset.workspaceRoot === activeWorkspaceRoot ? "* " : "";
        lines.push(`${index + 1}. ${prefix}${preset.name} -> ${preset.workspaceRoot}`);
      }
      lines.push("");
      lines.push("切换示例: `/codex use 1` 或 `/codex use pb`");
      await this.sendReplyToNormalized(normalized, lines.join("\n"));
      return;
    }

    if (parsed.action === "remove") {
      if (!parsed.name) {
        await this.sendReplyToNormalized(normalized, "用法: `/codex preset remove <别名>`");
        return;
      }
      const existing = this.sessionStore.getWorkspacePreset(bindingKey, parsed.name);
      if (!existing) {
        await this.sendReplyToNormalized(normalized, `未找到预设: ${parsed.name}`);
        return;
      }
      this.sessionStore.removeWorkspacePreset(bindingKey, parsed.name);
      await this.sendReplyToNormalized(normalized, `已删除预设: ${existing.name}`);
      return;
    }

    if (!parsed.name || !parsed.workspaceRoot) {
      await this.sendReplyToNormalized(normalized, "用法: `/codex preset add <别名> <绝对路径>`");
      return;
    }

    if (!/^[\p{L}\p{N}_-]+$/u.test(parsed.name)) {
      await this.sendReplyToNormalized(normalized, "预设别名只允许字母、数字、下划线和中划线。");
      return;
    }

    const resolvedWorkspaceRoot = await this.validateWorkspaceRoot(parsed.workspaceRoot, normalized);
    if (!resolvedWorkspaceRoot) {
      return;
    }

    this.sessionStore.setWorkspacePreset(bindingKey, parsed.name, resolvedWorkspaceRoot);
    await this.sendReplyToNormalized(
      normalized,
      `已保存预设。\n\nname: ${parsed.name}\nworkspace: ${resolvedWorkspaceRoot}\n\n可用 \`/codex use ${parsed.name}\` 快速切换。`
    );
  }

  async handleUseCommand(normalized) {
    const target = extractUseTarget(normalized.text);
    if (!target) {
      await this.sendReplyToNormalized(normalized, "用法: `/codex use <序号|别名>`");
      return;
    }

    const bindingKey = this.sessionStore.buildBindingKey(normalized);
    const preset = this.sessionStore.getWorkspacePreset(bindingKey, target);
    if (!preset) {
      const presets = this.sessionStore.listWorkspacePresets(bindingKey);
      if (!presets.length) {
        await this.sendReplyToNormalized(normalized, "当前还没有常用目录预设。先用 `/codex preset add <别名> <绝对路径>` 添加。");
        return;
      }
      await this.sendReplyToNormalized(normalized, `未找到预设: ${target}\n先发 \`/codex preset list\` 查看可用序号和别名。`);
      return;
    }

    await this.bindWorkspaceRoot(normalized, preset.workspaceRoot, `已切换到预设 ${preset.name}`);
  }

  async handlePlanCommand(normalized) {
    const parsed = parsePlanCommand(normalized.text);
    const workspaceContext = await this.resolveWorkspaceContext(normalized);
    if (!workspaceContext) {
      return;
    }
    const { bindingKey, workspaceRoot } = workspaceContext;

    if (parsed.action === "status") {
      const mode = this.sessionStore.getWorkspaceMode(bindingKey, workspaceRoot);
      const pendingPlan = this.sessionStore.getPendingPlanForWorkspace(bindingKey, workspaceRoot);
      const lines = [
        `workspace: ${workspaceRoot}`,
        `mode: ${mode}`,
        `plan: ${pendingPlan ? pendingPlan.status : "(none)"}`,
      ];
      if (pendingPlan?.planFilePath) {
        lines.push(`plan_file: ${pendingPlan.planFilePath}`);
      }
      await this.sendReplyToNormalized(normalized, lines.join("\n"));
      return;
    }

    if (parsed.action === "show") {
      const pendingPlan = this.sessionStore.getPendingPlanForWorkspace(bindingKey, workspaceRoot);
      if (!pendingPlan) {
        await this.sendReplyToNormalized(normalized, "当前工作区还没有已保存的计划。先进入 Plan mode 并发送一条任务描述。");
        return;
      }
      await this.sendReplyToNormalized(
        normalized,
        [
          `plan: ${pendingPlan.status}`,
          `file: ${pendingPlan.planFilePath}`,
          "",
          pendingPlan.summaryText || "暂无摘要。",
        ].join("\n")
      );
      return;
    }

    this.sessionStore.setWorkspaceMode(bindingKey, workspaceRoot, "plan");
    await this.sendReplyToNormalized(
      normalized,
      [
        "已进入 Plan mode。",
        "",
        `workspace: ${workspaceRoot}`,
        "接下来一条普通消息会以原生 Plan mode 提交，Codex 只做规划，不直接执行。",
        "计划完成后会在微信里回一份摘要，并在项目内保存详细 Markdown。",
        "确认无误后发送 `/codex execute` 开始执行。",
      ].join("\n")
    );
  }

  async handleExecuteCommand(normalized) {
    const workspaceContext = await this.resolveWorkspaceContext(normalized);
    if (!workspaceContext) {
      return;
    }

    const { bindingKey, workspaceRoot } = workspaceContext;
    const pendingPlan = this.sessionStore.getPendingPlanForWorkspace(bindingKey, workspaceRoot);
    if (!pendingPlan || pendingPlan.status !== "ready") {
      await this.sendReplyToNormalized(
        normalized,
        "当前没有可执行的计划。先进入 Plan mode 并等待计划生成完成。"
      );
      return;
    }

    let planText = "";
    try {
      planText = await fs.promises.readFile(pendingPlan.planFilePath, "utf8");
    } catch (error) {
      await this.sendReplyToNormalized(
        normalized,
        `计划文件读取失败: ${pendingPlan.planFilePath}\n${error.message || error}`
      );
      return;
    }

    const { threadId } = await this.resolveWorkspaceThreadState({
      bindingKey,
      workspaceRoot,
      normalized,
      autoSelectThread: true,
    });
    const effectiveThreadId = threadId || pendingPlan.threadId || "";
    if (!effectiveThreadId) {
      await this.sendReplyToNormalized(normalized, "当前找不到可继续执行的线程。请先发送一条普通消息重新建立线程。");
      return;
    }

    this.pendingChatContextByThreadId.set(effectiveThreadId, normalized);
    await this.ensureThreadResumed(effectiveThreadId);
    const response = await this.codex.sendUserMessage({
      threadId: effectiveThreadId,
      text: buildExecuteModePrompt({
        workspaceRoot,
        planFilePath: pendingPlan.planFilePath,
        planText,
      }),
      model: null,
      effort: null,
      accessMode: this.config.defaultCodexAccessMode,
      workspaceRoot,
      collaborationMode: this.buildCollaborationModeForWorkspace(bindingKey, workspaceRoot, {
        forceMode: "default",
      }),
    });
    this.persistActiveRunRecord({
      threadId: effectiveThreadId,
      bindingKey,
      workspaceRoot,
      normalized,
      response,
    });
    this.bindingKeyByThreadId.set(effectiveThreadId, bindingKey);
    this.workspaceRootByThreadId.set(effectiveThreadId, workspaceRoot);
    this.sessionStore.setWorkspaceMode(bindingKey, workspaceRoot, "default");
    this.sessionStore.markPendingPlanConsumed(bindingKey, workspaceRoot);
    await this.startTypingForThread(effectiveThreadId, normalized);
    await this.sendReplyToNormalized(
      normalized,
      `已开始按计划执行。\n\nworkspace: ${workspaceRoot}\nplan_file: ${pendingPlan.planFilePath}`
    );
  }

  async handleExitPlanCommand(normalized) {
    const workspaceContext = await this.resolveWorkspaceContext(normalized);
    if (!workspaceContext) {
      return;
    }
    const { bindingKey, workspaceRoot } = workspaceContext;
    this.sessionStore.setWorkspaceMode(bindingKey, workspaceRoot, "default");
    await this.sendReplyToNormalized(
      normalized,
      `已退出 Plan mode。\n\nworkspace: ${workspaceRoot}`
    );
  }

  async bindWorkspaceRoot(normalized, rawWorkspaceRoot, successTitle = "") {
    const workspaceRoot = await this.validateWorkspaceRoot(rawWorkspaceRoot, normalized);
    if (!workspaceRoot) {
      return;
    }

    const bindingKey = this.sessionStore.buildBindingKey(normalized);
    this.applyDefaultCodexParamsOnBind(bindingKey, workspaceRoot);
    this.sessionStore.setActiveWorkspaceRoot(bindingKey, workspaceRoot);
    await this.refreshWorkspaceThreads(bindingKey, workspaceRoot, normalized);
    const threadId = this.sessionStore.getThreadIdForWorkspace(bindingKey, workspaceRoot);
    const header = successTitle || (threadId ? "已切换到项目，并恢复原线程。" : "已绑定项目。");
    const text = threadId
      ? `${header}\n\nworkspace: ${workspaceRoot}\nthread: ${threadId}`
      : `${header}\n\nworkspace: ${workspaceRoot}`;
    await this.sendReplyToNormalized(normalized, text);
  }

  async handleWhereCommand(normalized) {
    const workspaceContext = await this.resolveWorkspaceContext(normalized, false);
    if (!workspaceContext) {
      await this.sendReplyToNormalized(
        normalized,
        this.config.defaultWorkspaceRoot
          ? `默认项目可用，但当前会话尚未持久化绑定。\n\nworkspace: ${normalizeWorkspacePath(this.config.defaultWorkspaceRoot)}`
          : "当前会话还未绑定项目。先发送 `/codex bind /绝对路径`。"
      );
      return;
    }

    const { bindingKey, workspaceRoot } = workspaceContext;
    const hasPendingNewThread = this.sessionStore.hasPendingNewThreadForWorkspace(bindingKey, workspaceRoot);
    const { threads, threadId } = await this.resolveWorkspaceThreadState({
      bindingKey,
      workspaceRoot,
      normalized,
      autoSelectThread: true,
    });
    const codexParams = this.getCodexParamsForWorkspace(bindingKey, workspaceRoot);
    const status = this.describeWorkspaceStatus(threadId);
    const mode = this.sessionStore.getWorkspaceMode(bindingKey, workspaceRoot);
    const pendingPlan = this.sessionStore.getPendingPlanForWorkspace(bindingKey, workspaceRoot);
    await this.sendReplyToNormalized(normalized, [
      `workspace: ${workspaceRoot}`,
      `thread: ${hasPendingNewThread ? "(new draft)" : (threadId || "(none)")}`,
      `status: ${status.label}`,
      `mode: ${mode}`,
      `model: ${codexParams.model || "(default)"}`,
      `effort: ${codexParams.effort || "(default)"}`,
      `threads: ${threads.length}`,
      `plan: ${pendingPlan ? pendingPlan.status : "(none)"}`,
    ].join("\n"));
  }

  async handleWorkspaceCommand(normalized) {
    const bindingKey = this.sessionStore.buildBindingKey(normalized);
    const workspaceRoots = this.sessionStore.listWorkspaceRoots(bindingKey);
    if (!workspaceRoots.length) {
      if (this.config.defaultWorkspaceRoot) {
        await this.sendReplyToNormalized(
          normalized,
          `当前没有显式绑定项目。\n默认项目: ${normalizeWorkspacePath(this.config.defaultWorkspaceRoot)}`
        );
        return;
      }
      await this.sendReplyToNormalized(normalized, "当前会话还没有绑定任何项目。");
      return;
    }

    const activeWorkspaceRoot = this.sessionStore.getActiveWorkspaceRoot(bindingKey);
    const lines = workspaceRoots.map((workspaceRoot) => {
      const threadId = this.sessionStore.getThreadIdForWorkspace(bindingKey, workspaceRoot);
      const hasPendingNewThread = this.sessionStore.hasPendingNewThreadForWorkspace(bindingKey, workspaceRoot);
      const prefix = workspaceRoot === activeWorkspaceRoot ? "* " : "- ";
      const threadText = hasPendingNewThread
        ? "\n  thread: (new draft)"
        : (threadId ? `\n  thread: ${threadId}` : "");
      return `${prefix}${workspaceRoot}${threadText}`;
    });
    await this.sendReplyToNormalized(normalized, lines.join("\n"));
  }

  async handleNewCommand(normalized) {
    const workspaceContext = await this.resolveWorkspaceContext(normalized);
    if (!workspaceContext) {
      return;
    }
    const { bindingKey, workspaceRoot } = workspaceContext;
    this.sessionStore.setPendingNewThreadForWorkspace(bindingKey, workspaceRoot, true);
    this.sessionStore.clearThreadIdForWorkspace(bindingKey, workspaceRoot);
    this.sessionStore.clearPendingPlanForWorkspace(bindingKey, workspaceRoot);
    await this.sendReplyToNormalized(
      normalized,
      `已切换到新会话，\n\nworkspace: ${workspaceRoot}\n。`
    );
  }

  async handleSwitchCommand(normalized) {
    const targetThreadId = extractSwitchThreadId(normalized.text);
    if (!targetThreadId) {
      await this.sendReplyToNormalized(normalized, "用法: `/codex switch <threadId>`");
      return;
    }

    const workspaceContext = await this.resolveWorkspaceContext(normalized);
    if (!workspaceContext) {
      return;
    }
    const { bindingKey, workspaceRoot } = workspaceContext;
    const threads = await this.refreshWorkspaceThreads(bindingKey, workspaceRoot, normalized);
    const selectedThread = threads.find((thread) => thread.id === targetThreadId);
    if (!selectedThread) {
      await this.sendReplyToNormalized(normalized, "指定线程当前不可用，请刷新后重试。");
      return;
    }

    const resolvedWorkspaceRoot = selectedThread.cwd || workspaceRoot;
    this.sessionStore.setActiveWorkspaceRoot(bindingKey, resolvedWorkspaceRoot);
    this.sessionStore.setPendingNewThreadForWorkspace(bindingKey, resolvedWorkspaceRoot, false);
    this.sessionStore.setThreadIdForWorkspace(
      bindingKey,
      resolvedWorkspaceRoot,
      targetThreadId,
      codexMessageUtils.buildBindingMetadata(normalized)
    );
    this.sessionStore.clearPendingPlanForWorkspace(bindingKey, resolvedWorkspaceRoot);
    this.resumedThreadIds.delete(targetThreadId);
    await this.ensureThreadResumed(targetThreadId);
    await this.sendReplyToNormalized(
      normalized,
      `已切换线程。\n\nworkspace: ${resolvedWorkspaceRoot}\nthread: ${targetThreadId}`
    );
  }

  async handleMessageCommand(normalized) {
    const workspaceContext = await this.resolveWorkspaceContext(normalized);
    if (!workspaceContext) {
      return;
    }
    const { bindingKey, workspaceRoot } = workspaceContext;
    if (this.sessionStore.hasPendingNewThreadForWorkspace(bindingKey, workspaceRoot)) {
      await this.sendReplyToNormalized(normalized, "当前是新会话，还没有历史消息。先发送一条普通消息开始。");
      return;
    }
    const { threads, threadId } = await this.resolveWorkspaceThreadState({
      bindingKey,
      workspaceRoot,
      normalized,
      autoSelectThread: true,
    });
    if (!threadId) {
      await this.sendReplyToNormalized(normalized, "当前项目还没有可查看的线程消息。");
      return;
    }

    this.resumedThreadIds.delete(threadId);
    let resumeResponse = null;
    try {
      resumeResponse = await this.ensureThreadResumed(threadId);
    } catch (error) {
      if (!isNoRolloutFoundError(error)) {
        throw error;
      }
      this.sessionStore.clearThreadIdForWorkspace(bindingKey, workspaceRoot);
      await this.sendReplyToNormalized(normalized, "当前线程还没有历史消息。先发送一条普通消息开始。");
      return;
    }
    const recentMessages = codexMessageUtils.extractRecentConversationFromResumeResponse(resumeResponse);
    const currentThread = threads.find((thread) => thread.id === threadId) || { id: threadId };
    const lines = [
      `workspace: ${workspaceRoot}`,
      `thread: ${currentThread.id}`,
      "",
    ];
    if (!recentMessages.length) {
      lines.push("暂无最近消息。");
    } else {
      for (const message of recentMessages) {
        lines.push(`${message.role === "assistant" ? "assistant" : "user"}: ${message.text}`);
      }
    }
    await this.sendReplyToNormalized(normalized, lines.join("\n"));
  }

  async handleStopCommand(normalized) {
    const { threadId } = this.getCurrentThreadContext(normalized);
    const turnId = threadId ? this.activeTurnIdByThreadId.get(threadId) || null : null;
    if (!threadId) {
      await this.sendReplyToNormalized(normalized, "当前会话还没有可停止的运行任务。");
      return;
    }

    await this.codex.sendRequest("turn/cancel", {
      threadId,
      turnId,
    });
    await this.stopTypingForThread(threadId);


    await this.sendReplyToNormalized(normalized, "已发送停止请求。");
  }

  async handleModelCommand(normalized) {
    const requested = extractModelValue(normalized.text);
    if (requested.toLowerCase() === "update") {
      const response = await this.codex.listModels();
      const models = extractModelCatalogFromListResponse(response);
      if (!models.length) {
        await this.sendReplyToNormalized(normalized, "model/list 返回空结果。");
        return;
      }
      this.sessionStore.setAvailableModelCatalog(models);
      await this.sendReplyToNormalized(normalized, `已刷新模型列表，共 ${models.length} 个。`);
      return;
    }

    const workspaceContext = await this.resolveWorkspaceContext(normalized, false);
    const catalog = this.sessionStore.getAvailableModelCatalog();
    const models = Array.isArray(catalog?.models) ? catalog.models : [];
    if (!requested) {
      const currentModel = workspaceContext
        ? this.getCodexParamsForWorkspace(workspaceContext.bindingKey, workspaceContext.workspaceRoot).model
        : "";
      const lines = [
        `当前模型: ${currentModel || "(default)"}`,
        "",
        "可用模型：",
      ];
      for (const model of models) {
        lines.push(`- ${model.model}${model.isDefault ? " (default)" : ""}`);
      }
      await this.sendReplyToNormalized(normalized, lines.join("\n"));
      return;
    }

    if (!workspaceContext) {
      await this.sendReplyToNormalized(normalized, "当前会话还未绑定项目，无法设置模型。");
      return;
    }

    const matched = findModelByQuery(models, requested);
    if (!matched) {
      await this.sendReplyToNormalized(normalized, `未找到模型: ${requested}`);
      return;
    }

    const currentParams = this.getCodexParamsForWorkspace(workspaceContext.bindingKey, workspaceContext.workspaceRoot);
    const currentEffort = currentParams.effort;
    const supported = matched.supportedReasoningEfforts || [];
    const nextEffort = supported.length && currentEffort && supported.includes(currentEffort)
      ? currentEffort
      : matched.defaultReasoningEffort || "";
    this.sessionStore.setCodexParamsForWorkspace(
      workspaceContext.bindingKey,
      workspaceContext.workspaceRoot,
      { model: matched.model, effort: nextEffort }
    );
    await this.sendReplyToNormalized(
      normalized,
      `已设置模型。\n\nworkspace: ${workspaceContext.workspaceRoot}\nmodel: ${matched.model}\neffort: ${nextEffort || "(default)"}`
    );
  }

  async handleEffortCommand(normalized) {
    const requested = extractEffortValue(normalized.text);
    const workspaceContext = await this.resolveWorkspaceContext(normalized, false);
    if (!workspaceContext) {
      await this.sendReplyToNormalized(normalized, "当前会话还未绑定项目，无法设置推理强度。");
      return;
    }

    const catalog = this.sessionStore.getAvailableModelCatalog();
    const models = Array.isArray(catalog?.models) ? catalog.models : [];
    const currentParams = this.getCodexParamsForWorkspace(workspaceContext.bindingKey, workspaceContext.workspaceRoot);
    const effectiveModel = resolveEffectiveModelForEffort(models, currentParams.model);
    const supported = effectiveModel?.supportedReasoningEfforts || [];
    if (!requested) {
      const lines = [
        `当前模型: ${effectiveModel?.model || currentParams.model || "(default)"}`,
        `当前推理强度: ${currentParams.effort || "(default)"}`,
      ];
      if (supported.length) {
        lines.push("", `可用推理强度: ${supported.join(", ")}`);
      }
      await this.sendReplyToNormalized(normalized, lines.join("\n"));
      return;
    }

    if (supported.length && !supported.includes(requested)) {
      await this.sendReplyToNormalized(
        normalized,
        `当前模型不支持该推理强度: ${requested}\n支持: ${supported.join(", ")}`
      );
      return;
    }

    this.sessionStore.setCodexParamsForWorkspace(
      workspaceContext.bindingKey,
      workspaceContext.workspaceRoot,
      { model: effectiveModel?.model || currentParams.model || "", effort: requested }
    );
    await this.sendReplyToNormalized(
      normalized,
      `已设置推理强度。\n\nworkspace: ${workspaceContext.workspaceRoot}\neffort: ${requested}`
    );
  }

  async handleApprovalCommand(normalized) {
    const { workspaceRoot, threadId } = this.getCurrentThreadContext(normalized);
    const approval = threadId ? this.pendingApprovalByThreadId.get(threadId) || null : null;
    if (!threadId || !approval) {
      await this.sendReplyToNormalized(normalized, "当前没有待处理的授权请求。");
      return;
    }

    const outcome = await this.applyApprovalDecision({
      threadId,
      approval,
      command: normalized.command,
      workspaceRoot,
      scope: codexMessageUtils.isWorkspaceApprovalCommand(normalized.text) ? "workspace" : "once",
    });
    if (outcome.error) {
      throw outcome.error;
    }
    if (outcome.ignoredAsDuplicate) {
      await this.sendReplyToNormalized(normalized, "该授权请求正在处理中，请稍后。");
      return;
    }
    const text = outcome.decision === "accept"
      ? (outcome.scope === "workspace" && codexMessageUtils.isCommandApprovalMethod(outcome.method)
        ? "已自动允许该命令，后续同工作区下相同前缀命令将自动放行。"
        : "已允许本次请求。")
      : "已拒绝本次请求。";
    await this.sendReplyToNormalized(normalized, text);
  }

  async handleRemoveCommand(normalized) {
    const target = extractRemoveWorkspacePath(normalized.text);
    if (!target) {
      await this.sendReplyToNormalized(normalized, "用法: `/codex remove /绝对路径`");
      return;
    }
    const bindingKey = this.sessionStore.buildBindingKey(normalized);
    const workspaceRoot = normalizeWorkspacePath(target);
    this.sessionStore.removeWorkspace(bindingKey, workspaceRoot);
    await this.sendReplyToNormalized(normalized, `已移除项目绑定: ${workspaceRoot}`);
  }

  async handleSendCommand(normalized) {
    const requestedPath = extractSendPath(normalized.text);
    if (!requestedPath) {
      await this.sendReplyToNormalized(normalized, "用法: `/codex send <相对文件路径>`");
      return;
    }

    const workspaceContext = await this.resolveWorkspaceContext(normalized);
    if (!workspaceContext) {
      return;
    }

    const resolvedPath = this.resolveWorkspaceFilePath(workspaceContext.workspaceRoot, requestedPath);
    if (!resolvedPath) {
      await this.sendReplyToNormalized(normalized, "只允许发送当前项目目录内的文件。");
      return;
    }

    let stats = null;
    try {
      stats = await fs.promises.stat(resolvedPath);
    } catch (error) {
      if (error?.code === "ENOENT") {
        await this.sendReplyToNormalized(normalized, `文件不存在: ${requestedPath}`);
        return;
      }
      throw error;
    }

    if (!stats.isFile()) {
      await this.sendReplyToNormalized(normalized, `只能发送文件，不能发送目录: ${requestedPath}`);
      return;
    }

    await sendWeixinMediaFile({
      filePath: resolvedPath,
      to: normalized.senderId,
      contextToken: normalized.contextToken || this.contextTokenByUserId.get(normalized.senderId) || "",
      baseUrl: this.account.baseUrl,
      token: this.account.token,
      cdnBaseUrl: this.config.cdnBaseUrl,
    });
  }

  async handleHelpCommand(normalized) {
    await this.sendReplyToNormalized(normalized, this.buildHelpText());
  }

  buildHelpText() {
    return [
      "可用命令：",
      "/codex bind /绝对路径",
      "/codex where",
      "/codex workspace",
      "/codex plan",
      "/codex plan status",
      "/codex plan show",
      "/codex execute",
      "/codex exit plan",
      "/codex preset list",
      "/codex preset add <别名> <绝对路径>",
      "/codex preset remove <别名>",
      "/codex use <序号|别名>",
      "/codex new",
      "/codex switch <threadId>",
      "/codex message",
      "/codex stop",
      "/codex model",
      "/codex model update",
      "/codex model <modelId>",
      "/codex effort",
      "/codex effort <low|medium|high|xhigh>",
      "/codex approve",
      "/codex approve workspace",
      "/codex reject",
      "/codex send <相对文件路径>",
      "/codex remove /绝对路径",
      "/codex help",
      "",
      "普通文本消息会直接发送给当前项目对应的 Codex 线程。",
    ].join("\n");
  }

  async resolveWorkspaceContext(normalized, sendMissingMessage = true) {
    const bindingKey = this.sessionStore.buildBindingKey(normalized);
    let workspaceRoot = this.sessionStore.getActiveWorkspaceRoot(bindingKey);
    if (!workspaceRoot && this.config.defaultWorkspaceRoot) {
      workspaceRoot = normalizeWorkspacePath(this.config.defaultWorkspaceRoot);
      this.applyDefaultCodexParamsOnBind(bindingKey, workspaceRoot);
      this.sessionStore.setActiveWorkspaceRoot(bindingKey, workspaceRoot);
    }

    if (!workspaceRoot) {
      if (sendMissingMessage) {
        await this.sendReplyToNormalized(
          normalized,
          "当前会话还未绑定项目。先发送 `/codex bind /绝对路径`，或配置 CODEX_WECHAT_DEFAULT_WORKSPACE。"
        );
      }
      return null;
    }
    return { bindingKey, workspaceRoot };
  }

  async validateWorkspaceRoot(rawWorkspaceRoot, normalized) {
    const workspaceRoot = normalizeWorkspacePath(rawWorkspaceRoot);
    if (!isAbsoluteWorkspacePath(workspaceRoot)) {
      await this.sendReplyToNormalized(normalized, "只支持绝对路径绑定。");
      return "";
    }
    if (!isWorkspaceAllowed(workspaceRoot, this.config.workspaceAllowlist)) {
      await this.sendReplyToNormalized(normalized, "该项目不在允许绑定的白名单中。");
      return "";
    }

    const workspaceStats = await this.resolveWorkspaceStats(workspaceRoot);
    if (!workspaceStats.exists) {
      await this.sendReplyToNormalized(normalized, `项目不存在: ${workspaceRoot}`);
      return "";
    }
    if (!workspaceStats.isDirectory) {
      await this.sendReplyToNormalized(normalized, `路径非法: ${workspaceRoot}`);
      return "";
    }
    return workspaceRoot;
  }

  async prepareIncomingMessageForCodex(normalized, workspaceRoot) {
    const attachments = Array.isArray(normalized.attachments) ? normalized.attachments : [];
    if (!attachments.length) {
      return normalized;
    }

    const persisted = await persistIncomingWeixinAttachments({
      attachments,
      workspaceRoot,
      cdnBaseUrl: this.config.cdnBaseUrl,
      messageId: normalized.messageId,
      receivedAt: normalized.receivedAt,
    });
    if (
      !persisted.saved.length
      && persisted.failed.length
      && !String(normalized.text || "").trim()
    ) {
      await this.sendReplyToNormalized(
        normalized,
        `Attachment transfer failed: ${persisted.failed.map((item) => item.reason).join("; ")}`
      );
      return null;
    }

    const text = buildCodexInboundText(normalized.text, persisted);
    if (!text) {
      await this.sendReplyToNormalized(
        normalized,
        `Attachment transfer failed: ${persisted.failed.map((item) => item.reason).join("; ")}`
      );
      return null;
    }

    return {
      ...normalized,
      originalText: normalized.text,
      text,
      attachments: persisted.saved,
      attachmentFailures: persisted.failed,
    };
  }

  getBindingContext(normalized) {
    const bindingKey = this.sessionStore.buildBindingKey(normalized);
    const workspaceRoot = this.sessionStore.getActiveWorkspaceRoot(bindingKey);
    return { bindingKey, workspaceRoot };
  }

  getCurrentThreadContext(normalized) {
    const { bindingKey, workspaceRoot } = this.getBindingContext(normalized);
    const threadId = workspaceRoot ? this.sessionStore.getThreadIdForWorkspace(bindingKey, workspaceRoot) : "";
    return { bindingKey, workspaceRoot, threadId };
  }

  applyDefaultCodexParamsOnBind(bindingKey, workspaceRoot) {
    const current = this.sessionStore.getCodexParamsForWorkspace(bindingKey, workspaceRoot);
    if (current.model || current.effort) {
      return;
    }

    const catalog = this.sessionStore.getAvailableModelCatalog();
    const models = Array.isArray(catalog?.models) ? catalog.models : [];
    const defaultModel = this.config.defaultCodexModel
      ? findModelByQuery(models, this.config.defaultCodexModel)
      : (models.find((item) => item.isDefault) || models[0] || null);
    const defaultEffort = this.config.defaultCodexEffort
      || defaultModel?.defaultReasoningEffort
      || "";

    this.sessionStore.setCodexParamsForWorkspace(bindingKey, workspaceRoot, {
      model: defaultModel?.model || this.config.defaultCodexModel || "",
      effort: defaultEffort,
    });
  }

  getCodexParamsForWorkspace(bindingKey, workspaceRoot) {
    const current = this.sessionStore.getCodexParamsForWorkspace(bindingKey, workspaceRoot);
    if (current.model || current.effort) {
      return current;
    }
    return {
      model: this.config.defaultCodexModel || "",
      effort: this.config.defaultCodexEffort || "",
    };
  }

  async resolveWorkspaceStats(workspaceRoot) {
    try {
      const stats = await fs.promises.stat(workspaceRoot);
      return {
        exists: true,
        isDirectory: stats.isDirectory(),
      };
    } catch (error) {
      if (error?.code === "ENOENT") {
        return { exists: false, isDirectory: false };
      }
      throw error;
    }
  }

  async resolveWorkspaceThreadState({ bindingKey, workspaceRoot, normalized, autoSelectThread = true }) {
    const threads = await this.refreshWorkspaceThreads(bindingKey, workspaceRoot, normalized);
    const hasPendingNewThread = this.sessionStore.hasPendingNewThreadForWorkspace(bindingKey, workspaceRoot);
    const selectedThreadId = this.sessionStore.getThreadIdForWorkspace(bindingKey, workspaceRoot);
    const threadId = hasPendingNewThread
      ? ""
      : (selectedThreadId || (autoSelectThread ? (threads[0]?.id || "") : ""));
    if (!selectedThreadId && threadId) {
      this.sessionStore.setThreadIdForWorkspace(
        bindingKey,
        workspaceRoot,
        threadId,
        codexMessageUtils.buildBindingMetadata(normalized)
      );
    }
    if (threadId) {
      this.bindingKeyByThreadId.set(threadId, bindingKey);
      this.workspaceRootByThreadId.set(threadId, workspaceRoot);
    }
    return { threads, threadId, selectedThreadId };
  }

  async refreshWorkspaceThreads(bindingKey, workspaceRoot, normalized) {
    try {
      const threads = await this.listCodexThreadsForWorkspace(workspaceRoot);
      const currentThreadId = this.sessionStore.getThreadIdForWorkspace(bindingKey, workspaceRoot);
      const shouldKeepCurrentThread = currentThreadId && this.resumedThreadIds.has(currentThreadId);
      if (currentThreadId && !shouldKeepCurrentThread && !threads.some((thread) => thread.id === currentThreadId)) {
        this.sessionStore.clearThreadIdForWorkspace(bindingKey, workspaceRoot);
      }
      return threads;
    } catch (error) {
      console.warn(`[codex-wechat] thread/list failed for workspace=${workspaceRoot}: ${error.message}`);
      return [];
    }
  }

  async listCodexThreadsForWorkspace(workspaceRoot) {
    const allThreads = [];
    const seenThreadIds = new Set();
    let cursor = null;

    for (let page = 0; page < 10; page += 1) {
      const response = await this.codex.listThreads({
        cursor,
        limit: 200,
        sortKey: "updated_at",
      });
      const pageThreads = codexMessageUtils.extractThreadsFromListResponse(response);
      for (const thread of pageThreads) {
        if (!THREAD_SOURCE_KINDS.has(thread.sourceKind)) {
          continue;
        }
        if (seenThreadIds.has(thread.id)) {
          continue;
        }
        seenThreadIds.add(thread.id);
        allThreads.push(thread);
      }

      const nextCursor = codexMessageUtils.extractThreadListCursor(response);
      if (!nextCursor || nextCursor === cursor) {
        break;
      }
      cursor = nextCursor;
      if (pageThreads.length === 0) {
        break;
      }
    }

    return filterThreadsByWorkspaceRoot(allThreads, workspaceRoot);
  }

  async ensureThreadAndSendMessage({ bindingKey, workspaceRoot, normalized, threadId }) {
    const codexParams = this.getCodexParamsForWorkspace(bindingKey, workspaceRoot);
    const mode = this.sessionStore.getWorkspaceMode(bindingKey, workspaceRoot);
    const requestedCollaborationMode = this.buildCollaborationModeForWorkspace(bindingKey, workspaceRoot, {
      model: codexParams.model || null,
      effort: codexParams.effort || null,
    });
    const outbound = this.buildOutboundPromptForWorkspace({
      bindingKey,
      workspaceRoot,
      normalized,
      mode,
      collaborationMode: requestedCollaborationMode,
    });

    if (!threadId) {
      const createdThreadId = await this.createWorkspaceThread({
        bindingKey,
        workspaceRoot,
        normalized,
      });
      this.pendingChatContextByThreadId.set(createdThreadId, normalized);
      await this.sendUserMessageWithPlanFallback({
        threadId: createdThreadId,
        bindingKey,
        workspaceRoot,
        normalized,
        text: outbound.text,
        model: codexParams.model || null,
        effort: codexParams.effort || null,
        accessMode: this.config.defaultCodexAccessMode,
        collaborationMode: outbound.collaborationMode,
      });
      this.bindingKeyByThreadId.set(createdThreadId, bindingKey);
      this.workspaceRootByThreadId.set(createdThreadId, workspaceRoot);
      return createdThreadId;
    }

    try {
      this.pendingChatContextByThreadId.set(threadId, normalized);
      await this.ensureThreadResumed(threadId);
      await this.sendUserMessageWithPlanFallback({
        threadId,
        bindingKey,
        workspaceRoot,
        normalized,
        text: outbound.text,
        model: codexParams.model || null,
        effort: codexParams.effort || null,
        accessMode: this.config.defaultCodexAccessMode,
        collaborationMode: outbound.collaborationMode,
      });
      this.bindingKeyByThreadId.set(threadId, bindingKey);
      this.workspaceRootByThreadId.set(threadId, workspaceRoot);
      return threadId;
    } catch (error) {
      if (!shouldRecreateThread(error)) {
        throw error;
      }
      this.resumedThreadIds.delete(threadId);
      this.sessionStore.clearThreadIdForWorkspace(bindingKey, workspaceRoot);
      const recreatedThreadId = await this.createWorkspaceThread({
        bindingKey,
        workspaceRoot,
        normalized,
      });
      await this.sendUserMessageWithPlanFallback({
        threadId: recreatedThreadId,
        bindingKey,
        workspaceRoot,
        normalized,
        text: outbound.text,
        model: codexParams.model || null,
        effort: codexParams.effort || null,
        accessMode: this.config.defaultCodexAccessMode,
        collaborationMode: outbound.collaborationMode,
      });
      this.bindingKeyByThreadId.set(recreatedThreadId, bindingKey);
      this.workspaceRootByThreadId.set(recreatedThreadId, workspaceRoot);
      return recreatedThreadId;
    }
  }

  buildOutboundPromptForWorkspace({ workspaceRoot, normalized, mode, collaborationMode }) {
    if (mode !== "plan") {
      return {
        text: normalized.text,
        collaborationMode,
      };
    }

    return {
      text: normalized.text,
      collaborationMode,
    };
  }

  buildCollaborationModeForWorkspace(bindingKey, workspaceRoot, options = {}) {
    const forceMode = typeof options.forceMode === "string" ? options.forceMode.trim() : "";
    const mode = forceMode || this.sessionStore.getWorkspaceMode(bindingKey, workspaceRoot);
    const codexParams = this.getCodexParamsForWorkspace(bindingKey, workspaceRoot);
    const model = options.model || codexParams.model || "";
    if (!model || mode !== "plan") {
      return null;
    }

    return {
      mode,
      settings: {
        model,
        reasoning_effort: options.effort || codexParams.effort || null,
      },
    };
  }

  async sendUserMessageWithPlanFallback({
    threadId,
    bindingKey,
    workspaceRoot,
    normalized,
    text,
    model,
    effort,
    accessMode,
    collaborationMode,
  }) {
    try {
      const response = await this.codex.sendUserMessage({
        threadId,
        text,
        model,
        effort,
        accessMode,
        workspaceRoot,
        collaborationMode,
      });
      this.persistActiveRunRecord({
        threadId,
        bindingKey,
        workspaceRoot,
        normalized,
        response,
      });
      return response;
    } catch (error) {
      if (
        !collaborationMode
        || collaborationMode.mode !== "plan"
        || !isUnsupportedCollaborationModeError(error)
      ) {
        throw error;
      }

      const response = await this.codex.sendUserMessage({
        threadId,
        text: buildPlanModePrompt({
          workspaceRoot,
          userText: normalized.text,
        }),
        model,
        effort,
        accessMode,
        workspaceRoot,
        collaborationMode: null,
      });
      this.persistActiveRunRecord({
        threadId,
        bindingKey,
        workspaceRoot,
        normalized,
        response,
      });
      return response;
    }
  }

  async createWorkspaceThread({ bindingKey, workspaceRoot, normalized }) {
    const response = await this.codex.startThread({ cwd: workspaceRoot });
    const threadId = codexMessageUtils.extractThreadId(response);
    if (!threadId) {
      throw new Error("thread/start did not return a thread id");
    }
    this.sessionStore.setPendingNewThreadForWorkspace(bindingKey, workspaceRoot, false);
    this.sessionStore.setThreadIdForWorkspace(
      bindingKey,
      workspaceRoot,
      threadId,
      codexMessageUtils.buildBindingMetadata(normalized)
    );
    this.resumedThreadIds.add(threadId);
    this.pendingChatContextByThreadId.set(threadId, normalized);
    this.bindingKeyByThreadId.set(threadId, bindingKey);
    this.workspaceRootByThreadId.set(threadId, workspaceRoot);
    return threadId;
  }

  async ensureThreadResumed(threadId) {
    const normalizedThreadId = typeof threadId === "string" ? threadId.trim() : "";
    if (!normalizedThreadId || this.resumedThreadIds.has(normalizedThreadId)) {
      return null;
    }

    const response = await this.codex.resumeThread({ threadId: normalizedThreadId });
    this.resumedThreadIds.add(normalizedThreadId);
    return response;
  }

  describeWorkspaceStatus(threadId) {
    if (!threadId) {
      return { code: "idle", label: "空闲" };
    }
    if (this.pendingApprovalByThreadId.has(threadId)) {
      return { code: "approval", label: "等待授权" };
    }
    if (this.activeTurnIdByThreadId.has(threadId)) {
      return { code: "running", label: "运行中" };
    }
    return { code: "idle", label: "空闲" };
  }

  async handleCompletedPlanRun({
    bindingKey,
    threadId,
    workspaceRoot,
    bufferedText,
    planState,
    planDeltaText,
    context,
  }) {
    const planId = createPlanId(threadId);
    const structuredPlanText = renderStructuredPlan(planState);
    const extractedPlan = extractPlanBody(bufferedText);
    const extractedDeltaPlan = extractPlanBody(planDeltaText);
    const finalPlanText = structuredPlanText || extractedPlan || extractedDeltaPlan || bufferedText || planDeltaText;
    const summaryText = buildPlanSummaryText(finalPlanText);
    const planFilePath = await this.persistDetailedPlanFile({
      workspaceRoot,
      threadId,
      planId,
      planText: finalPlanText,
      summaryText,
    });

    this.sessionStore.setPendingPlanForWorkspace(bindingKey, workspaceRoot, {
      planId,
      threadId,
      workspaceRoot,
      summaryText,
      planFilePath,
      createdAt: new Date().toISOString(),
      status: "ready",
    });
    this.sessionStore.setWorkspaceMode(bindingKey, workspaceRoot, "default");

    await this.sendReplyWithRetry(
      context.senderId,
      formatPlanCompletionReply({
        workspaceRoot,
        planFilePath,
        summaryText: summaryText || "暂无摘要。",
      }),
      context.contextToken,
      `plan completion reply thread=${threadId}`
    );
  }

  async persistDetailedPlanFile({ workspaceRoot, threadId, planId, planText, summaryText }) {
    const targetDir = path.join(workspaceRoot, PLAN_FILE_DIR);
    await fs.promises.mkdir(targetDir, { recursive: true });
    const fileName = `${planId}-${sanitizePlanThreadId(threadId)}.md`;
    const planFilePath = path.join(targetDir, fileName);
    const body = [
      "# Codex Plan",
      "",
      `- planId: ${planId}`,
      `- threadId: ${threadId || "(unknown)"}`,
      `- workspace: ${workspaceRoot}`,
      `- createdAt: ${new Date().toISOString()}`,
      "",
      "## Summary",
      "",
      summaryText || "(none)",
      "",
      "## Detailed Plan",
      "",
      planText || "(empty)",
      "",
    ].join("\n");
    await fs.promises.writeFile(planFilePath, body, "utf8");
    return planFilePath;
  }

  async sendReplyToNormalized(normalized, text) {
    return this.sendReplyToUser(normalized.senderId, text, normalized.contextToken);
  }

  async sendReplyWithRetry(userId, text, contextToken, label, options = {}) {
    for (let attempt = 1; attempt <= COMPLETION_REPLY_MAX_RETRIES; attempt++) {
      try {
        await this.sendReplyToUser(userId, text, contextToken, {
          allowLatestTokenFallback: true,
        });
        return { delivered: true, attempts: attempt };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (attempt < COMPLETION_REPLY_MAX_RETRIES) {
          console.error(
            `[codex-wechat] ${label} attempt ${attempt}/${COMPLETION_REPLY_MAX_RETRIES} failed: ${msg} — retrying in ${RETRY_DELAY_MS}ms`
          );
          await sleep(RETRY_DELAY_MS);
        } else {
          console.error(
            `[codex-wechat] ${label} all ${COMPLETION_REPLY_MAX_RETRIES} attempts failed: ${msg}`
          );
          if (options.onFinalFailure) {
            await options.onFinalFailure({
              attempts: attempt,
              error,
            });
          }
        }
      }
    }
    return { delivered: false, attempts: COMPLETION_REPLY_MAX_RETRIES };
  }

  buildReplyChunks(text) {
    const chunks = Array.isArray(text)
      ? text.filter((item) => typeof item === "string" && item.trim())
      : chunkReplyText(markdownToPlainText(text) || "已完成。");
    return chunks.length ? chunks : ["已完成。"];
  }

  isRetryableContextTokenError(error) {
    return this.deliveryRetryableContextErrorPattern.test(String(error?.message || ""));
  }

  async sendReplyChunksToUser(userId, chunks, contextToken) {
    const resolvedToken = String(contextToken || "").trim();
    if (!resolvedToken) {
      throw new Error(`缺少 context_token，无法回复用户 ${userId}`);
    }

    console.log(
      `[codex-wechat] prepared reply chunks to=${userId} count=${chunks.length} bytes=${chunks.map((chunk) => Buffer.byteLength(chunk, "utf8")).join(",")} token_source=context`
    );
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index];
      console.log(
        `[codex-wechat] sending reply chunk ${index + 1}/${chunks.length} to=${userId} bytes=${Buffer.byteLength(chunk, "utf8")}`
      );
      const response = await sendMessage({
        baseUrl: this.account.baseUrl,
        token: this.account.token,
        body: {
          msg: {
            client_id: crypto.randomUUID(),
            from_user_id: "",
            to_user_id: userId,
            message_type: 2,
            message_state: 2,
            item_list: [
              {
                type: 1,
                text_item: { text: chunk },
              },
            ],
            context_token: String(resolvedToken),
          },
        },
      });
      console.log(
        `[codex-wechat] send reply chunk ok ${index + 1}/${chunks.length} to=${userId} ret=${response?.ret ?? 0} errcode=${response?.errcode ?? 0}`
      );
      if (index < chunks.length - 1) {
        await sleep(CHUNK_SEND_DELAY_MS);
      }
    }
  }

  async sendReplyToUser(userId, text, contextToken = "", options = {}) {
    const effectiveChunks = this.buildReplyChunks(text);
    const preferredToken = String(contextToken || "").trim();
    if (preferredToken) {
      try {
        await this.sendReplyChunksToUser(userId, effectiveChunks, preferredToken);
        return;
      } catch (error) {
        if (!options.allowLatestTokenFallback || !this.isRetryableContextTokenError(error)) {
          throw error;
        }
        console.error(
          `[codex-wechat] send reply using stored context token failed for ${userId}: ${error.message} — retrying with latest context token`
        );
      }
    }

    const latestToken = this.getLatestContextTokenForUser(userId);
    if (!latestToken) {
      if (preferredToken) {
        throw new Error(`回复失败且当前没有可用的新 context_token: ${userId}`);
      }
      throw new Error(`缺少 context_token，无法回复用户 ${userId}`);
    }
    if (preferredToken && latestToken === preferredToken) {
      throw new Error(`sendMessage failed ret=-2 errcode=undefined errmsg= (context token invalid and no newer token available)`);
    }

    console.log(`[codex-wechat] retrying reply with latest context token for ${userId}`);
    await this.sendReplyChunksToUser(userId, effectiveChunks, latestToken);
  }

  async persistUndeliveredReply({ senderId, threadId, turnId, runKey, workspaceRoot, label, replyChunks, attempts, error }) {
    if (!this.account?.accountId) {
      return;
    }
    const reason = error instanceof Error ? error.message : String(error || "");
    persistUndeliveredReply(this.config, this.account.accountId, {
      senderId,
      threadId,
      turnId,
      runKey,
      workspaceRoot,
      label,
      replyChunks,
      attempts,
      reason,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    console.error(
      `[codex-wechat] persisted undelivered reply sender=${senderId} thread=${threadId} turn=${turnId} label=${label} attempts=${attempts} reason=${reason}`
    );
  }

  async flushUndeliveredRepliesForUser(userId, contextToken = "") {
    if (!this.account?.accountId) {
      return;
    }
    const normalizedUserId = String(userId || "").trim();
    const latestToken = String(contextToken || this.getLatestContextTokenForUser(normalizedUserId) || "").trim();
    if (!normalizedUserId || !latestToken) {
      return;
    }

    const undelivered = loadUndeliveredReplies(this.config, this.account.accountId)[normalizedUserId];
    if (!undelivered) {
      return;
    }

    const recoveryChunks = [
      `检测到上一条结果未送达，现补发如下。`,
      ...undelivered.replyChunks,
    ];
    try {
      await this.sendReplyChunksToUser(normalizedUserId, recoveryChunks, latestToken);
      clearUndeliveredReply(this.config, this.account.accountId, normalizedUserId);
      console.log(
        `[codex-wechat] flushed undelivered reply sender=${normalizedUserId} thread=${undelivered.threadId} turn=${undelivered.turnId}`
      );
    } catch (error) {
      console.error(
        `[codex-wechat] failed to flush undelivered reply sender=${normalizedUserId}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  resolveWorkspaceFilePath(workspaceRoot, requestedPath) {
    const normalizedWorkspaceRoot = normalizeWorkspacePath(workspaceRoot);
    const rawRequestedPath = String(requestedPath || "").trim();
    if (!normalizedWorkspaceRoot || !rawRequestedPath) {
      return "";
    }

    const candidatePath = path.resolve(normalizedWorkspaceRoot, rawRequestedPath);
    const normalizedCandidatePath = normalizeWorkspacePath(candidatePath);
    if (!pathMatchesWorkspaceRoot(normalizedCandidatePath, normalizedWorkspaceRoot)) {
      return "";
    }
    return candidatePath;
  }

  async sendAssistantAttachmentsForReply({ userId, contextToken, workspaceRoot, replyText }) {
    const filePaths = await extractAutoSendFilePathsFromReply(replyText, workspaceRoot);
    const sent = [];
    const failed = [];

    for (const filePath of filePaths) {
      try {
        const outcome = await sendWeixinMediaFile({
          filePath,
          to: userId,
          contextToken,
          baseUrl: this.account.baseUrl,
          token: this.account.token,
          cdnBaseUrl: this.config.cdnBaseUrl,
        });
        sent.push({
          filePath,
          kind: outcome.kind,
          fileName: outcome.fileName,
        });
      } catch (error) {
        failed.push({
          filePath,
          reason: error instanceof Error ? error.message : String(error || "unknown upload error"),
        });
      }
    }

    return { sent, failed };
  }

  persistActiveRunRecord({ threadId, bindingKey = "", workspaceRoot = "", normalized, response }) {
    if (!this.account?.accountId) {
      return;
    }
    const normalizedThreadId = String(threadId || "").trim();
    const senderId = String(normalized?.senderId || "").trim();
    const contextToken = String(normalized?.contextToken || this.contextTokenByUserId.get(senderId) || "").trim();
    if (!normalizedThreadId || !senderId || !contextToken) {
      return;
    }

    const turnId = String(response?.result?.turn?.id || "").trim();
    const runKey = codexMessageUtils.buildRunKey(normalizedThreadId, turnId || "pending");
    persistActiveRun(this.config, this.account.accountId, {
      threadId: normalizedThreadId,
      runKey,
      senderId,
      contextToken,
      workspaceRoot,
      bindingKey,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }

  clearPersistedActiveRun(threadId) {
    if (!this.account?.accountId) {
      return;
    }
    clearActiveRun(this.config, this.account.accountId, threadId);
  }

  async startTypingForThread(threadId, normalized) {
    if (!this.config.enableTyping || !threadId) {
      return;
    }

    await this.stopTypingForThread(threadId);
    const contextToken = normalized.contextToken || this.contextTokenByUserId.get(normalized.senderId) || "";
    if (!contextToken) {
      return;
    }

    const configResponse = await getConfig({
      baseUrl: this.account.baseUrl,
      token: this.account.token,
      ilinkUserId: normalized.senderId,
      contextToken,
    }).catch(() => null);
    const typingTicket = typeof configResponse?.typing_ticket === "string"
      ? configResponse.typing_ticket.trim()
      : "";
    if (!typingTicket) {
      return;
    }

    const sendStatus = async (status) => {
      await sendTyping({
        baseUrl: this.account.baseUrl,
        token: this.account.token,
        body: {
          ilink_user_id: normalized.senderId,
          typing_ticket: typingTicket,
          status,
        },
      });
    };

    await sendStatus(1).catch(() => {});
    const timer = setInterval(() => {
      sendStatus(1).catch(() => {});
    }, TYPING_KEEPALIVE_MS);

    this.typingStopByThreadId.set(threadId, async () => {
      clearInterval(timer);
      await sendStatus(2).catch(() => {});
    });
  }

  async stopTypingForThread(threadId) {
    const stop = this.typingStopByThreadId.get(threadId);
    if (!stop) {
      return;
    }
    this.typingStopByThreadId.delete(threadId);
    await stop();
  }

  async shutdown(reason = "service restart") {
    if (this.shutdownStarted) {
      return;
    }
    this.shutdownStarted = true;

    console.log(`[codex-wechat] shutdown started: ${reason}`);

    const threadIds = Array.from(this.typingStopByThreadId.keys());
    for (const threadId of threadIds) {
      try {
        await this.stopTypingForThread(threadId);
      } catch (error) {
        console.error(`[codex-wechat] stop typing failed during shutdown thread=${threadId}: ${error.message}`);
      }
    }

    const notifiedKeys = new Set();
    for (const context of this.pendingChatContextByThreadId.values()) {
      if (!context?.senderId) {
        continue;
      }
      const notificationKey = `${context.senderId}:${context.contextToken || ""}`;
      if (notifiedKeys.has(notificationKey)) {
        continue;
      }
      notifiedKeys.add(notificationKey);

      try {
        await this.sendReplyToUser(
          context.senderId,
          "本地 codex-wechat 服务刚刚重启，当前这轮任务已中断。请直接重发上一条消息。",
          context.contextToken
        );
      } catch (error) {
        console.error(
          `[codex-wechat] failed to send shutdown notice to=${context.senderId}: ${error.message}`
        );
      }
    }

    if (this.account?.accountId) {
      clearAllActiveRuns(this.config, this.account.accountId);
    }

    try {
      await this.codex.close();
    } catch (error) {
      console.error(`[codex-wechat] codex close failed during shutdown: ${error.message}`);
    }
  }

  async handleCodexMessage(message) {
    codexMessageUtils.trackRunningTurn(this.activeTurnIdByThreadId, message);
    codexMessageUtils.trackPendingApproval(this.pendingApprovalByThreadId, message);
    codexMessageUtils.trackRunKeyState(this.currentRunKeyByThreadId, this.activeTurnIdByThreadId, message);
    this.updatePlanStateBuffer(message);

    const outbound = codexMessageUtils.mapCodexMessageToImEvent(message);
    if (!outbound) {
      return;
    }

    const threadId = outbound.payload?.threadId || "";
    if (outbound.type === "im.agent_reply") {
      this.appendAssistantReplyBuffer(message, outbound);
      return;
    }

    if (outbound.type === "im.approval_request") {
      await this.handleApprovalRequest(threadId);
      return;
    }

    if (outbound.type === "im.run_state") {
      await this.handleRunState(outbound);
    }
  }

  updatePlanStateBuffer(message) {
    const planUpdate = codexMessageUtils.extractPlanUpdate(message);
    if (planUpdate) {
      const runKey = codexMessageUtils.buildRunKey(planUpdate.threadId, planUpdate.turnId);
      const current = this.planStateByRunKey.get(runKey) || {};
      this.planStateByRunKey.set(runKey, {
        explanation: planUpdate.explanation || current.explanation || "",
        plan: planUpdate.plan,
      });
    }

    const planDelta = codexMessageUtils.extractPlanDelta(message);
    if (!planDelta) {
      return;
    }

    const runKey = codexMessageUtils.buildRunKey(planDelta.threadId, planDelta.turnId);
    const current = this.planDeltaBufferByRunKey.get(runKey) || "";
    this.planDeltaBufferByRunKey.set(runKey, `${current}${planDelta.text}`);
  }

  appendAssistantReplyBuffer(message, outbound) {
    const threadId = outbound.payload.threadId || "";
    const turnId = outbound.payload.turnId || this.activeTurnIdByThreadId.get(threadId) || "";
    if (!threadId) {
      return;
    }
    const runKey = this.currentRunKeyByThreadId.get(threadId) || codexMessageUtils.buildRunKey(threadId, turnId);
    const current = this.replyBufferByRunKey.get(runKey) || "";
    const text = outbound.payload.text || "";
    if (!text) {
      return;
    }

    if (message?.method === "item/agentMessage/delta") {
      this.replyBufferByRunKey.set(runKey, `${current}${text}`);
      return;
    }

    if (message?.method === "item/completed") {
      this.replyBufferByRunKey.set(runKey, text);
      console.log(
        `[codex-wechat] finalized reply buffer thread=${threadId} turn=${turnId} bytes=${Buffer.byteLength(text, "utf8")}`
      );
      return;
    }

    if (!current) {
      this.replyBufferByRunKey.set(runKey, text);
    }
  }

  async handleApprovalRequest(threadId) {
    if (!threadId) {
      return;
    }
    const approval = this.pendingApprovalByThreadId.get(threadId);
    if (!approval) {
      return;
    }

    const workspaceRoot = this.workspaceRootByThreadId.get(threadId) || "";
    if (this.shouldAutoApproveRequest(workspaceRoot, approval)) {
      const outcome = await this.applyApprovalDecision({
        threadId,
        approval,
        command: "approve",
        workspaceRoot,
        scope: "once",
      });
      if (!outcome.error) {
        return;
      }
    }

    await this.stopTypingForThread(threadId);
    const context = this.pendingChatContextByThreadId.get(threadId);
    if (!context) {
      return;
    }
    const text = this.formatApprovalRequestReply(approval);
    await this.sendReplyToUser(context.senderId, text, context.contextToken);
  }

  formatApprovalRequestReply(approval) {
    const commandText = truncateForWechat(
      approval?.command || approval?.reason || "",
      APPROVAL_COMMAND_MAX_CHARS
    );
    const reasonText = truncateForWechat(
      approval?.justification || approval?.reason || "",
      APPROVAL_REASON_MAX_CHARS
    );
    const sandboxPermissions = truncateForWechat(
      approval?.sandboxPermissions || "",
      APPROVAL_PERMISSION_MAX_CHARS
    );
    const prefixRule = truncateForWechat(
      formatApprovalPrefixRule(approval?.prefixRule),
      APPROVAL_PREFIX_RULE_MAX_CHARS
    );
    const methodText = truncateForWechat(
      String(approval?.method || "").trim(),
      APPROVAL_METHOD_MAX_CHARS
    );

    if (!commandText && !reasonText && !sandboxPermissions && !prefixRule && !methodText) {
      return [
        "Codex 请求授权：",
        approval?.command || approval?.reason || "(unknown)",
        "",
        "回复以下命令继续：",
        "/codex approve",
        "/codex approve workspace",
        "/codex reject",
      ].join("\n");
    }

    const lines = [
      "Codex 请求授权",
      `类型: ${methodText || "未提供"}`,
      `权限: ${sandboxPermissions || "未提供"}`,
      `理由: ${reasonText || "未提供"}`,
      `命令: ${commandText || "未提供"}`,
    ];
    if (prefixRule) {
      lines.push(`前缀放行: ${prefixRule}`);
    }
    lines.push(
      "",
      "回复以下命令继续：",
      "/codex approve",
      "/codex approve workspace",
      "/codex reject"
    );
    return lines.join("\n");
  }

  shouldAutoApproveRequest(workspaceRoot, approval) {
    if (!workspaceRoot || !approval) {
      return false;
    }
    const cachedAllowlist = this.approvalAllowlistByWorkspaceRoot.get(workspaceRoot) || [];
    const allowlist = cachedAllowlist.length
      ? cachedAllowlist
      : this.sessionStore.getApprovalCommandAllowlistForWorkspace(workspaceRoot);
    if (allowlist.length && !cachedAllowlist.length) {
      this.approvalAllowlistByWorkspaceRoot.set(workspaceRoot, allowlist);
    }
    if (!allowlist.length) {
      return false;
    }
    return codexMessageUtils.matchesCommandPrefix(approval.commandTokens, allowlist);
  }

  rememberApprovalPrefixForWorkspace(workspaceRoot, commandTokens) {
    if (!workspaceRoot) {
      return;
    }
    this.sessionStore.rememberApprovalCommandPrefixForWorkspace(workspaceRoot, commandTokens);
    this.approvalAllowlistByWorkspaceRoot.set(
      workspaceRoot,
      this.sessionStore.getApprovalCommandAllowlistForWorkspace(workspaceRoot)
    );
  }

  async applyApprovalDecision({ threadId, approval, command, workspaceRoot = "", scope = "once" }) {
    const decision = command === "approve" ? "accept" : "decline";
    const isWorkspaceScope = scope === "workspace";
    const requestKey = `${threadId}:${String(approval.requestId || "").trim()}`;
    if (!requestKey || this.inFlightApprovalRequestKeys.has(requestKey)) {
      return {
        error: null,
        ignoredAsDuplicate: true,
        decision,
        scope: isWorkspaceScope ? "workspace" : "once",
        method: approval.method,
      };
    }
    this.inFlightApprovalRequestKeys.add(requestKey);

    try {
      if (
        decision === "accept"
        && isWorkspaceScope
        && codexMessageUtils.isCommandApprovalMethod(approval.method)
      ) {
        this.rememberApprovalPrefixForWorkspace(workspaceRoot, approval.commandTokens);
      }

      await this.codex.sendResponse(
        approval.requestId,
        codexMessageUtils.buildApprovalResponsePayload(decision)
      );
      this.pendingApprovalByThreadId.delete(threadId);
      return {
        error: null,
        ignoredAsDuplicate: false,
        decision,
        scope: isWorkspaceScope ? "workspace" : "once",
        method: approval.method,
      };
    } catch (error) {
      return {
        error,
        ignoredAsDuplicate: false,
        decision,
        scope: isWorkspaceScope ? "workspace" : "once",
        method: approval.method,
      };
    } finally {
      this.inFlightApprovalRequestKeys.delete(requestKey);
    }
  }

  async handleRunState(outbound) {
    const threadId = outbound.payload.threadId || "";
    const turnId = outbound.payload.turnId || this.activeTurnIdByThreadId.get(threadId) || "";
    const runKey = this.currentRunKeyByThreadId.get(threadId) || codexMessageUtils.buildRunKey(threadId, turnId);
    const bufferedText = this.replyBufferByRunKey.get(runKey) || "";
    const planState = this.planStateByRunKey.get(runKey) || null;
    const planDeltaText = this.planDeltaBufferByRunKey.get(runKey) || "";
    const context = this.pendingChatContextByThreadId.get(threadId);
    const workspaceRoot = this.workspaceRootByThreadId.get(threadId) || "";
    const bindingKey = this.bindingKeyByThreadId.get(threadId) || "";

    if (outbound.payload.state === "streaming") {
      await this.handleProgressNotice(outbound, runKey);
      return;
    }

    await this.stopTypingForThread(threadId);

    if (context && outbound.payload.state === "completed") {
      if (bindingKey && workspaceRoot && this.sessionStore.getWorkspaceMode(bindingKey, workspaceRoot) === "plan") {
        await this.handleCompletedPlanRun({
          bindingKey,
          threadId,
          workspaceRoot,
          bufferedText,
          planState,
          planDeltaText,
          context,
        });
        this.cleanupRunState(threadId, runKey);
        return;
      }

      const autoSent = await this.sendAssistantAttachmentsForReply({
        userId: context.senderId,
        contextToken: context.contextToken,
        workspaceRoot,
        replyText: bufferedText,
      });
      const hasPlainReplyText = !!markdownToPlainText(bufferedText);
      const promptDelivery = shouldUsePromptDelivery(bufferedText);
      console.log(
        `[codex-wechat] completed run thread=${threadId} turn=${turnId} buffered_bytes=${Buffer.byteLength(bufferedText || "", "utf8")} plain_bytes=${Buffer.byteLength(markdownToPlainText(bufferedText || ""), "utf8")} prompt_delivery=${promptDelivery} auto_sent=${autoSent.sent.length} auto_failed=${autoSent.failed.length}`
      );
      if (hasPlainReplyText || autoSent.sent.length || autoSent.failed.length) {
        const formattedReply = promptDelivery
          ? formatPromptDeliveryReply({
            workspaceRoot,
            replyText: bufferedText || "",
            autoSent: autoSent.sent,
            autoSendFailed: autoSent.failed,
          })
          : formatTaskCompletionReply({
            workspaceRoot,
            replyText: bufferedText || "",
            autoSent: autoSent.sent,
            autoSendFailed: autoSent.failed,
          });
        console.log(
          `[codex-wechat] formatted completion reply thread=${threadId} turn=${turnId} chunks=${formattedReply.length} bytes=${formattedReply.map((chunk) => Buffer.byteLength(chunk, "utf8")).join(",")}`
        );
        await this.sendReplyWithRetry(
          context.senderId,
          formattedReply,
          context.contextToken,
          `completion reply thread=${threadId} turn=${turnId}`,
          {
            onFinalFailure: async ({ attempts, error }) => {
              await this.persistUndeliveredReply({
                senderId: context.senderId,
                threadId,
                turnId,
                runKey,
                workspaceRoot,
                label: "completion",
                replyChunks: formattedReply,
                attempts,
                error,
              });
            },
          }
        );
      } else {
        const formattedReply = formatTaskCompletionReply({
          workspaceRoot,
          replyText: "",
          autoSent: autoSent.sent,
          autoSendFailed: autoSent.failed,
        });
        console.log(
          `[codex-wechat] formatted completion reply thread=${threadId} turn=${turnId} chunks=${formattedReply.length} bytes=${formattedReply.map((chunk) => Buffer.byteLength(chunk, "utf8")).join(",")}`
        );
        await this.sendReplyWithRetry(
          context.senderId,
          formattedReply,
          context.contextToken,
          `completion reply thread=${threadId} turn=${turnId}`,
          {
            onFinalFailure: async ({ attempts, error }) => {
              await this.persistUndeliveredReply({
                senderId: context.senderId,
                threadId,
                turnId,
                runKey,
                workspaceRoot,
                label: "completion",
                replyChunks: formattedReply,
                attempts,
                error,
              });
            },
          }
        );
      }

      this.cleanupRunState(threadId, runKey);
      return;
    }

    if (context) {
      if (outbound.payload.state === "completed") {
        const replyChunks = formatTaskCompletionReply({
          workspaceRoot,
          replyText: bufferedText || "已完成。",
          autoSent: [],
          autoSendFailed: [],
        });
        await this.sendReplyWithRetry(
          context.senderId,
          replyChunks,
          context.contextToken,
          `completion reply thread=${threadId} turn=${turnId}`,
          {
            onFinalFailure: async ({ attempts, error }) => {
              await this.persistUndeliveredReply({
                senderId: context.senderId,
                threadId,
                turnId,
                runKey,
                workspaceRoot,
                label: "completion",
                replyChunks,
                attempts,
                error,
              });
            },
          }
        );
      } else if (outbound.payload.state === "failed") {
        const replyChunks = formatTaskFailureReply({
          workspaceRoot,
          replyText: bufferedText,
          failureText: outbound.payload.text || "执行失败",
        });
        await this.sendReplyWithRetry(
          context.senderId,
          replyChunks,
          context.contextToken,
          `failure reply thread=${threadId} turn=${turnId}`,
          {
            onFinalFailure: async ({ attempts, error }) => {
              await this.persistUndeliveredReply({
                senderId: context.senderId,
                threadId,
                turnId,
                runKey,
                workspaceRoot,
                label: "failure",
                replyChunks,
                attempts,
                error,
              });
            },
          }
        );
      }
    }

    this.cleanupRunState(threadId, runKey);
  }

  cleanupRunState(threadId, runKey) {
    this.replyBufferByRunKey.delete(runKey);
    this.planStateByRunKey.delete(runKey);
    this.planDeltaBufferByRunKey.delete(runKey);
    this.progressNoticeByRunKey.delete(runKey);
    this.runStartTimeByRunKey.delete(runKey);
    this.activeTurnIdByThreadId.delete(threadId);
    this.pendingApprovalByThreadId.delete(threadId);
    if (this.account?.accountId) {
      clearActiveRun(this.config, this.account.accountId, threadId);
    }
  }

  async handleProgressNotice(outbound, runKey) {
    const threadId = outbound.payload?.threadId || "";
    const context = this.pendingChatContextByThreadId.get(threadId);
    const phase = typeof outbound.payload?.phase === "string" ? outbound.payload.phase.trim() : "";
    const text = typeof outbound.payload?.text === "string" ? outbound.payload.text.trim() : "";
    if (!threadId || !context || !phase || !text) {
      return;
    }

    const now = Date.now();
    if (phase === "started" || !this.runStartTimeByRunKey.has(runKey)) {
      this.runStartTimeByRunKey.set(runKey, now);
    }

    const startTime = this.runStartTimeByRunKey.get(runKey);
    if (!startTime) {
      return;
    }

    const progressState = this.progressNoticeByRunKey.get(runKey) || {
      longTaskNoticeSent: false,
      lastPhase: "",
      lastUpdatedAt: 0,
      lastNotifiedAt: 0,
    };
    progressState.lastPhase = phase;
    progressState.lastUpdatedAt = now;

    if (!progressState.longTaskNoticeSent && (now - startTime) >= LONG_TASK_NOTICE_DELAY_MS) {
      progressState.longTaskNoticeSent = true;
      progressState.lastNotifiedAt = now;
      this.progressNoticeByRunKey.set(runKey, progressState);

      try {
        await this.sendReplyToUser(
          context.senderId,
          `任务仍在运行（已运行 ${formatElapsed(now - startTime)}）`,
          context.contextToken,
          { allowLatestTokenFallback: true }
        );
      } catch (error) {
        console.error(
          `[codex-wechat] progress notice failed thread=${threadId} phase=${phase} error=${error instanceof Error ? error.message : String(error)}`
        );
      }
      return;
    }

    if (
      progressState.longTaskNoticeSent
      && (now - progressState.lastNotifiedAt) >= PERIODIC_PROGRESS_NOTICE_INTERVAL_MS
    ) {
      progressState.lastNotifiedAt = now;
      this.progressNoticeByRunKey.set(runKey, progressState);
      try {
        await this.sendReplyToUser(
          context.senderId,
          `任务仍在运行（阶段: ${phase}，已运行 ${formatElapsed(now - startTime)}）`,
          context.contextToken,
          { allowLatestTokenFallback: true }
        );
      } catch (error) {
        console.error(
          `[codex-wechat] periodic progress notice failed thread=${threadId} phase=${phase} error=${error instanceof Error ? error.message : String(error)}`
        );
      }
      return;
    }

    this.progressNoticeByRunKey.set(runKey, progressState);
  }
}

function buildPlanModePrompt({ workspaceRoot, userText }) {
  return [
    "You are in a simulated Plan Mode for the current Codex thread.",
    "Do not execute code changes or carry out mutating actions.",
    "You may inspect, analyze, and ask targeted clarification questions if needed.",
    "Produce the final plan only when it is decision-complete.",
    "Return the final plan inside a <proposed_plan> block.",
    "",
    `Workspace: ${workspaceRoot}`,
    "",
    "User request:",
    userText || "(empty)",
  ].join("\n");
}

function buildExecuteModePrompt({ workspaceRoot, planFilePath, planText }) {
  return [
    "Execute the approved plan below in the current thread.",
    "You are no longer in plan-only mode.",
    "Use the saved plan as the authoritative execution input.",
    "Carry the work through implementation and verification where feasible.",
    "",
    `Workspace: ${workspaceRoot}`,
    `Plan file: ${planFilePath}`,
    "",
    "Approved plan:",
    planText || "(empty)",
  ].join("\n");
}

function extractPlanBody(text) {
  const raw = String(text || "").trim();
  if (!raw) {
    return "";
  }
  const match = raw.match(/<proposed_plan>\s*([\s\S]*?)\s*<\/proposed_plan>/i);
  if (match) {
    return String(match[1] || "").trim();
  }
  return raw;
}

function renderStructuredPlan(planState) {
  if (!planState || typeof planState !== "object") {
    return "";
  }

  const steps = Array.isArray(planState.plan) ? planState.plan : [];
  const explanation = typeof planState.explanation === "string" ? planState.explanation.trim() : "";
  const lines = [];

  if (explanation) {
    lines.push(explanation, "");
  }

  if (steps.length) {
    lines.push("## Plan", "");
    for (const step of steps) {
      const text = typeof step?.step === "string" ? step.step.trim() : "";
      if (!text) {
        continue;
      }
      lines.push(`- [${normalizePlanStepStatus(step?.status)}] ${text}`);
    }
  }

  return lines.join("\n").trim();
}

function normalizePlanStepStatus(status) {
  const normalized = String(status || "").trim();
  if (normalized === "completed") {
    return "completed";
  }
  if (normalized === "inProgress") {
    return "in-progress";
  }
  return "pending";
}

function createPlanId(threadId) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const suffix = sanitizePlanThreadId(threadId).slice(-12) || crypto.randomUUID().slice(0, 12);
  return `${timestamp}-${suffix}`;
}

function sanitizePlanThreadId(threadId) {
  return String(threadId || "thread").replace(/[^a-zA-Z0-9_-]/g, "_");
}

function shouldRecreateThread(error) {
  const message = String(error?.message || "").toLowerCase();
  return message.includes("thread not found")
    || message.includes("unknown thread")
    || message.includes("no rollout found");
}

function isUnsupportedCollaborationModeError(error) {
  const message = String(error?.message || "").toLowerCase();
  return (
    message.includes("collaborationmode")
    || message.includes("collaboration mode")
    || (message.includes("unknown field") && message.includes("turn/start"))
    || message.includes("invalid params")
    || message.includes("unknown parameter")
  );
}

function isNoRolloutFoundError(error) {
  return String(error?.message || "").toLowerCase().includes("no rollout found");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatElapsed(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

async function extractAutoSendFilePathsFromReply(replyText, workspaceRoot) {
  const normalizedWorkspaceRoot = normalizeWorkspacePath(workspaceRoot);
  if (!normalizedWorkspaceRoot) {
    return [];
  }

  const candidates = collectAutoSendPathCandidates(replyText);
  const resolved = [];
  const seen = new Set();

  for (const candidate of candidates) {
    const filePath = await resolveAutoSendFilePath(candidate, normalizedWorkspaceRoot);
    if (!filePath) {
      continue;
    }
    const normalized = normalizeWorkspacePath(filePath);
    const dedupeKey = normalized.toLowerCase();
    if (seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);
    resolved.push(filePath);
  }

  return resolved;
}

function collectAutoSendPathCandidates(replyText) {
  const text = String(replyText || "");
  const candidates = [];
  const pushCandidate = (value) => {
    const normalized = normalizeTextValue(value);
    if (normalized) {
      candidates.push(normalized);
    }
  };

  const markdownLinkPattern = /!?\[[^\]]*]\(([^)\n]+)\)/g;
  let match = null;
  while ((match = markdownLinkPattern.exec(text)) !== null) {
    pushCandidate(match[1]);
  }

  const backtickPathPattern = /`([^`\n]+)`/g;
  while ((match = backtickPathPattern.exec(text)) !== null) {
    pushCandidate(match[1]);
  }

  return candidates;
}

async function resolveAutoSendFilePath(candidate, workspaceRoot) {
  const normalizedCandidate = stripAutoSendCandidateDecorations(candidate);
  if (!normalizedCandidate) {
    return "";
  }

  const normalizedAbsoluteCandidate = normalizeWorkspacePath(normalizedCandidate);
  const candidatePath = isAbsoluteWorkspacePath(normalizedCandidate)
    ? path.resolve(normalizedAbsoluteCandidate)
    : path.resolve(workspaceRoot, normalizedCandidate);
  const normalizedPath = normalizeWorkspacePath(candidatePath);
  if (!normalizedPath || !pathMatchesWorkspaceRoot(normalizedPath, workspaceRoot)) {
    return "";
  }

  try {
    const stats = await fs.promises.stat(candidatePath);
    if (!stats.isFile()) {
      return "";
    }
  } catch {
    return "";
  }

  const mime = getMimeFromFilename(candidatePath);
  if (!mime || mime === "application/octet-stream") {
    return "";
  }

  return candidatePath;
}

function stripAutoSendCandidateDecorations(candidate) {
  let value = normalizeTextValue(candidate);
  if (!value) {
    return "";
  }

  if (value.startsWith("<") && value.endsWith(">")) {
    value = value.slice(1, -1).trim();
  }

  const hashIndex = value.indexOf("#L");
  if (hashIndex >= 0) {
    value = value.slice(0, hashIndex).trim();
  }

  const lineSuffixMatch = value.match(/^(.*\.[A-Za-z0-9_-]+):\d+(?::\d+)?$/);
  if (lineSuffixMatch) {
    value = lineSuffixMatch[1];
  }

  return value;
}

function normalizeTextValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function formatApprovalPrefixRule(prefixRule) {
  const normalized = Array.isArray(prefixRule)
    ? prefixRule
      .map((token) => (typeof token === "string" ? token.trim() : ""))
      .filter(Boolean)
    : [];
  if (!normalized.length) {
    return "";
  }
  return normalized.map((token) => (token.includes(" ") ? JSON.stringify(token) : token)).join(" ");
}

function truncateForWechat(text, maxChars) {
  const normalized = typeof text === "string" ? text.trim() : "";
  if (!normalized) {
    return "";
  }
  if (!Number.isFinite(maxChars) || maxChars <= 0 || normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(1, maxChars - 15)).trimEnd()}... (truncated)`;
}

function buildCodexInboundText(originalText, persisted) {
  const text = String(originalText || "").trim();
  const saved = Array.isArray(persisted?.saved) ? persisted.saved : [];
  const failed = Array.isArray(persisted?.failed) ? persisted.failed : [];
  const lines = [];

  if (text) {
    lines.push(text);
  }

  if (saved.length) {
    if (lines.length) {
      lines.push("");
    }
    lines.push(text
      ? "WeChat attachment(s) saved into the current workspace:"
      : "User sent WeChat attachment(s). They were saved into the current workspace:");
    for (const item of saved) {
      const suffix = item.sourceFileName ? ` (original: ${item.sourceFileName})` : "";
      lines.push(`- [${item.kind}] ${item.relativePath}${suffix}`);
    }
    lines.push("Open the saved workspace path(s) when you need to inspect the attachment contents.");
  }

  if (failed.length) {
    if (lines.length) {
      lines.push("");
    }
    lines.push("Attachment transfer issue(s):");
    for (const item of failed) {
      const label = item.sourceFileName || item.kind || "attachment";
      lines.push(`- ${label}: ${item.reason}`);
    }
  }

  return lines.join("\n").trim();
}

module.exports = { WechatRuntime };
